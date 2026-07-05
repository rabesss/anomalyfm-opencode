/**
 * MpvStreamPlayer — mpv-subprocess backend for the anomaly.fm opencode TUI plugin.
 *
 * Strategy: spawn `mpv` against the live Icecast MP3 mount and watch its stdout
 * log to know when playback has actually started. `play()` resolves once mpv
 * reports an audio output is open AND the audio position is advancing — the most
 * direct possible signal that real audio is flowing. `pause()` is a hard
 * teardown: SIGKILL the process and await its exit so that, on return, there is
 * no mpv process, no decode work, and no open `/radio` socket.
 *
 * Why stdout parsing (not IPC)?
 *   We tried `--input-ipc-server` (JSON unix socket) first — it's the textbook
 *   approach. Under `Bun.spawn`, mpv connects to the stream and runs, but
 *   *never creates the IPC socket file* in this environment (mpv 0.41.0,
 *   Bun 1.3.14, Linux). It also never creates it under `--no-terminal` even
 *   from a shell. Removing `--no-terminal` and reading mpv's own progress log
 *   (`AO:` = audio device opened; `A: 00:00:0X` = position advancing) is fully
 *   reliable and needs no second channel. mpv detects it has no TTY (its stdio
 *   is piped) so it never tries to render a curses UI.
 *
 * Ground truth respected (see docs/superpowers/specs/ground-truth-findings.md):
 *  - Stream: https://anomaly.fm/radio, Icecast 2.4.4, MP3 48kHz mono 96kbps.
 *  - Icecast rejects HEAD; we never probe — mpv opens with GET internally.
 *  - No ICY in-band metadata; we don't parse any.
 *  - mpv has native network reconnect (`--stream-lavf-o=reconnect=1,...`); we
 *    rely on it rather than rolling our own.
 */

export type PlayerState =
  | "PAUSED"
  | "CONNECTING"
  | "PLAYING"
  | "ERROR"
  | "UNSUPPORTED";

export interface StreamPlayer {
  play(): Promise<void>; // open the stream + start playback
  pause(): void; // TEAR DOWN: kill process, free resources
  readonly state: PlayerState;
  readonly error?: string;
}

/** Default stream — anomaly.fm live Icecast MP3 mount. */
export const ANOMALY_STREAM_URL = "https://anomaly.fm/radio";

/**
 * The exact mpv invocation. Each flag is load-bearing for a live radio stream:
 *  --no-video             audio-only demux path (mount is audio/mpeg anyway)
 *  --profile=low-latency  mpv builtin: tiny cache, no readahead → fast live start
 *  --stream-lavf-o=...    ffmpeg-level reconnect: on network drop, retry forever
 *                         capped at a 10s backoff, on the SAME url. This is the
 *                         only reconnect layer; we do not implement our own.
 *  --msg-level=cplayer=v  emit verbose cplayer lines to stdout so we can detect
 *                         playback start (AO: + A: positions). Verbose is fine:
 *                         the volume is a few lines/sec.
 *
 * Deliberately NOT used:
 *  --no-terminal          In this env it suppresses ALL stdout/stderr AND blocks
 *                         IPC socket creation. We pipe stdio instead, which gives
 *                         us the logs AND keeps mpv from touching the TTY.
 *
 * NOTE: no `--` separator before the URL is needed here because mpv accepts the
 * URL as the final positional argument; we keep the array minimal.
 */
export const MPV_ARGS = (url: string): string[] => [
  "--no-video",
  "--profile=low-latency",
  "--stream-lavf-o=reconnect=1,reconnect_streamed=1,reconnect_delay_max=10",
  "--msg-level=cplayer=v",
  url,
];

const MPV_BIN = "mpv";

/** Small bounded sleeper: rejects if `deadlineMs` elapses first. */
function withTimeout<T>(p: Promise<T>, deadlineMs: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), deadlineMs);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export interface MpvStreamPlayerOptions {
  url?: string;
  /** Timeout (ms) to wait for playback start after spawn. */
  playTimeoutMs?: number;
  /** Logger; defaults to no-op. */
  log?: (...args: unknown[]) => void;
  /**
   * Injectable spawn for testing. Defaults to `Bun.spawn`. Tests pass a mock
   * that returns a fake child process so the spawn/kill contract can be locked
   * down without mpv installed and without real audio.
   */
  spawn?: typeof Bun.spawn;
}

// Regexes for the two stdout signals we care about. mpv lines look like:
//   AO: [pipewire] 48000Hz mono 1ch floatp
//   A: 00:00:04 / 00:00:09 (44%) Cache: 5.4s/182KB
// "audio output opened" + "audio position advancing past zero" = playing.
const RE_AO_OPEN = /^AO:\s/;
// `A: hh:mm:ss` advancing line; require a non-zero second or any sub-second
// advance to be sure it's actually flowing (not parked at 00:00:00).
const RE_A_ADVANCE = /^A:\s00:00:0[1-9]/;

/**
 * StreamPlayer backed by a child `mpv` process.
 *
 * One process per `play()`; `pause()` destroys it. Each toggle is a fresh mpv
 * cold start (~200-400ms to first audio on this stream) — acceptable for a TUI
 * radio widget.
 */
export class MpvStreamPlayer implements StreamPlayer {
  private _state: PlayerState = "PAUSED";
  private _error: string | undefined;
  private readonly url: string;
  private readonly log: (...a: unknown[]) => void;
  private readonly playTimeoutMs: number;
  /** Injectable spawn (defaults to Bun.spawn) — exercised by contract tests. */
  private readonly spawn: typeof Bun.spawn;

  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private stdoutParser: ((line: string) => void) | null = null;
  /** Drains mpv stdout for the process's entire lifetime. See startStdoutDrain. */
  private drainHandle: Promise<void> | null = null;

  constructor(opts: MpvStreamPlayerOptions = {}) {
    this.url = opts.url ?? ANOMALY_STREAM_URL;
    this.log = opts.log ?? (() => {});
    this.playTimeoutMs = opts.playTimeoutMs ?? 20_000;
    this.spawn = opts.spawn ?? Bun.spawn;

    // Detect missing binary eagerly and once, at construction.
    if (!Bun.which(MPV_BIN)) {
      this._state = "UNSUPPORTED";
      this._error =
        `mpv binary not found on PATH (need '${MPV_BIN}'). ` +
        `Install mpv to enable audio playback.`;
    }
  }

  get state(): PlayerState {
    return this._state;
  }
  get error(): string | undefined {
    return this._error;
  }
  /** PID of the live mpv child, or null when not running. */
  get pid(): number | null {
    return this.proc?.pid ?? null;
  }

  private setState(s: PlayerState, err?: string) {
    if (this._state === s && this._error === err) return;
    this._state = s;
    if (err !== undefined) this._error = err;
    this.log(`[mpv] state -> ${s}${err ? ` (${err})` : ""}`);
  }

  async play(): Promise<void> {
    // StreamPlayer contract: surface unavailability via state, not by throwing.
    // If mpv was already determined to be missing (constructor `which` check or
    // a prior spawn ENOENT), report UNSUPPORTED silently — callers (e.g. the
    // radio controller) treat this as "audio unavailable, toggle is a no-op".
    if (this._state === "UNSUPPORTED") {
      return;
    }
    if (this.proc && this._state !== "ERROR") {
      // Already started this session; if playing, nothing to do.
      if (this._state === "PLAYING") return;
    }

    this.setState("CONNECTING");
    this._error = undefined;

    const args = MPV_ARGS(this.url);
    this.log(`[mpv] spawn: ${MPV_BIN} ${args.join(" ")}`);

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = this.spawn([MPV_BIN, ...args], {
        stdin: "ignore",
        stdout: "pipe", // mpv writes progress here; we parse it
        stderr: "pipe", // captured for error diagnostics, not parsed
      });
    } catch (e) {
      // A missing binary surfaces here as an ENOENT-style error. That's an
      // environment/availability problem, not a runtime playback fault —
      // classify it UNSUPPORTED (no-op) rather than ERROR (loud), matching the
      // constructor's `Bun.which` path. Resolves silently per the contract.
      const code = (e as NodeJS.ErrnoException).code;
      const msg = (e as Error).message;
      if (code === "ENOENT" || /not found|no such file/i.test(msg)) {
        this.setState(
          "UNSUPPORTED",
          `mpv binary not found (spawn failed: ${msg}). ` +
            `Install mpv to enable audio playback.`,
        );
        return;
      }
      this.setState("ERROR", `failed to spawn mpv: ${msg}`);
      throw e;
    }
    this.proc = proc;

    // Surface mpv stderr (fatal errors etc.) into our log for debuggability.
    this.pumpStderr(proc);

    // CRITICAL: drain mpv stdout for the process's ENTIRE lifetime. mpv writes
    // progress lines (A: ...) continuously while playing; if nothing reads the
    // pipe, its kernel buffer (~64KiB) fills within seconds and mpv BLOCKS on
    // write — which looks like a hang or causes Bun to tear it down. The drain
    // feeds each line to `stdoutParser`, which observers (awaitPlaying, and
    // later a status poller) can swap in.
    this.drainHandle = this.startStdoutDrain(proc);

    try {
      await withTimeout(
        this.awaitPlaying(proc),
        this.playTimeoutMs,
        `mpv did not reach PLAYING within ${this.playTimeoutMs}ms`,
      );
    } catch (e) {
      const msg = (e as Error).message;
      this.log(`[mpv] play() failed: ${msg}`);
      await this.teardown(); // best-effort cleanup before propagating
      this.setState("ERROR", msg);
      throw e;
    }
  }

  /** Pump mpv stderr to our log without blocking; surface fatal lines. */
  private pumpStderr(proc: ReturnType<typeof Bun.spawn>) {
    const dec = new TextDecoder();
    let buf = "";
    // We spawn with stderr: "pipe", so proc.stderr is a ReadableStream. Bun's
    // Subprocess type still unions `number | undefined` for other stdio modes,
    // which trips tsc's async-iterable check; narrow once at the use site.
    const stderr = proc.stderr as ReadableStream<Uint8Array>;
    (async () => {
      try {
        for await (const chunk of stderr) {
          buf += dec.decode(chunk);
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line) this.log(`[mpv:stderr] ${line}`);
          }
        }
      } catch {
        /* process likely gone */
      }
    })();
  }

  /**
   * Drain mpv stdout for the process's entire lifetime, feeding each line to
   * `this.stdoutParser` (which observers may install/swap). Lives until stdout
   * closes (process exit). Returns a promise that resolves when the drain ends.
   *
   * This MUST keep running after play() resolves: mpv writes `A:` progress
   * continuously, and an unread pipe buffer (~64KiB) would back-pressure mpv
   * to a stall within seconds.
   */
  private startStdoutDrain(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    const dec = new TextDecoder();
    let buf = "";
    // See pumpStderr: we spawn with stdout: "pipe" so this is a ReadableStream.
    const stdout = proc.stdout as ReadableStream<Uint8Array>;
    return (async () => {
      try {
        for await (const chunk of stdout) {
          buf += dec.decode(chunk);
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            this.stdoutParser?.(line);
          }
        }
      } catch {
        /* process likely gone */
      }
    })();
  }

  /**
   * Resolve once mpv's stdout shows audio is open AND the position has advanced
   * past zero. Registers an observer on the (already-running) stdout drain.
   * Rejects if the process exits before playback starts.
   */
  private awaitPlaying(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let aoOpened = false;
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        // Detach THIS observer; the drain keeps running for the lifetime.
        if (this.stdoutParser === observer) this.stdoutParser = null;
        err ? reject(err) : resolve();
      };
      const observer = (line: string) => {
        if (RE_AO_OPEN.test(line)) {
          aoOpened = true;
          this.log(`[mpv] audio output opened`);
        }
        if (aoOpened && RE_A_ADVANCE.test(line)) {
          this.setState("PLAYING");
          this.log(`[mpv] playback advancing: ${line.trim()}`);
          finish();
        }
      };
      this.stdoutParser = observer;

      // If the process dies during connect, reject loudly.
      proc.exited.then(() => {
        if (!settled) {
          finish(
            new Error(
              `mpv exited (code=${proc.exitCode}, signal=${proc.signalCode}) before playback started`,
            ),
          );
        }
      });
    });
  }

  pause(): void {
    // TEAR DOWN, not silence. Kill the process and free everything.
    // Synchronous contract: on return, the mpv process must be DEAD.
    this.teardownSync();
  }

  /** Synchronous teardown: SIGKILL + brief bounded reap wait. */
  private teardownSync() {
    const proc = this.proc;
    this.stdoutParser = null;
    this.drainHandle = null;
    if (!proc) {
      this.setState("PAUSED");
      return;
    }

    // SIGKILL — unconditional. mpv has no graceful "stop and release the socket"
    // path that's faster or safer than this for our teardown contract. The
    // kernel closes the TCP socket and frees the file table THE INSTANT SIGKILL
    // is delivered, so the load-bearing resource contract (no socket, no RSS)
    // is satisfied before we even return — independent of reap timing.
    try {
      proc.kill("SIGKILL");
    } catch {}

    // Best-effort reap wait. The load-bearing resource contract (no socket, no
    // RSS, no decode) is satisfied the instant SIGKILL is delivered. We only
    // spin briefly to let Bun's async reap catch up so `/proc/<pid>` is gone,
    // which makes the "process is dead" claim observable. We can't `await`
    // (pause() is void), so we cap this at a short window: if Bun hasn't reaped
    // by return, the process is nonetheless DEAD (a zombie runs no code and
    // holds no resources — its socket/RSS were freed at SIGKILL time).
    const start = Date.now();
    const deadline = start + 500;
    while (Date.now() < deadline) {
      if (!procExists(proc.pid)) break;
      // small synchronous sleep to avoid a hard CPU spin
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    const gone = !procExists(proc.pid);
    this.log(
      `[mpv] teardown: SIGKILL'd; ${gone ? `reaped in ${Date.now() - start}ms` : `not yet reaped (zombie, ${Date.now() - start}ms) — DEAD, holds no resources`}`,
    );

    this.proc = null;
    this.setState("PAUSED");
  }

  /** Async teardown used by play()'s error path. */
  private async teardown() {
    const proc = this.proc;
    this.stdoutParser = null;
    this.drainHandle = null;
    if (!proc) {
      this.setState("PAUSED");
      return;
    }
    try {
      proc.kill("SIGKILL");
    } catch {}
    try {
      await withTimeout(proc.exited, 3000, "exit timeout");
    } catch {}
    this.proc = null;
    this.setState("PAUSED");
  }
}

/**
 * True iff a /proc entry for `pid` still exists. Vanishes once the process is
 * reaped. Unlike kill(pid,0), this returns false for an unreaped zombie's
 * eventual cleanup — but more importantly it's the right signal for "gone from
 * the system". On non-Linux this falls back to kill(pid,0).
 */
function procExists(pid: number | undefined | null): boolean {
  if (!pid) return false;
  try {
    // accessSync throws if /proc/<pid> is gone (reaped).
    require("node:fs").accessSync(`/proc/${pid}`);
    return true;
  } catch {
    // Fallback for non-Linux: signal-0 probe (note: also true for zombies).
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
