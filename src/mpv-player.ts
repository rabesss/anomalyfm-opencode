/**
 * MpvStreamPlayer — mpv-subprocess backend for the anomaly.fm opencode TUI plugin.
 *
 * Strategy: spawn `mpv` against the live Icecast MP3 mount in `--no-terminal`
 * mode and treat liveness as the playback signal. `play()` resolves once mpv
 * has stayed alive past a short settle window — if mpv couldn't open the
 * stream it exits within a couple seconds, so survival past the settle means
 * audio is flowing. `pause()` is a hard teardown: SIGKILL the process and await
 * its exit so that, on return, there is no mpv process, no decode work, and no
 * open `/radio` socket.
 *
 * Why --no-terminal (not stdout parsing, not IPC)?
 *   Earlier versions parsed mpv's verbose stdout (`AO:` = audio output opened;
 *   `A:` = position advancing) to detect playback start. That required keeping
 *   mpv verbose, and mpv emits ~14 `A:` progress lines/sec for its entire
 *   lifetime. Decoding + splitting every one of those lines in our JS event
 *   loop cost ~35% sustained CPU in the opencode host process while playing.
 *   `--no-terminal` makes mpv emit ZERO bytes while audio still plays
 *   (measured: 0 lines / 6s). That eliminates the drain work entirely; the
 *   cost of playing collapses to mpv's own ~1% decode + our near-idle poller.
 *   We pay for it with a ~4s "CONNECTING" settle window before the glyph flips
 *   to PLAYING, which is the right trade for a 35x CPU reduction.
 *
 *   We also tried `--input-ipc-server` (JSON unix socket) earlier — under
 *   Bun.spawn, mpv connects and runs but never creates the socket file in this
 *   environment (mpv 0.41.0, Bun 1.3.14, Linux). IPC is off the table.
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
 *  --no-terminal          CRITICAL for resource use: tells mpv it has no
 *                         terminal, so it emits NO status output. Without this,
 *                         mpv spams ~14 `A:` progress lines/sec for its whole
 *                         lifetime, which our (now-removed) stdout drain had to
 *                         decode line-by-line — costing ~35% host CPU. With it,
 *                         stdout/stderr stay empty and we detect playback by
 *                         liveness instead. See class docstring.
 *
 * NOTE: no `--` separator before the URL is needed here because mpv accepts the
 * URL as the final positional argument; we keep the array minimal.
 */
export const MPV_ARGS = (url: string): string[] => [
  "--no-video",
  "--profile=low-latency",
  "--stream-lavf-o=reconnect=1,reconnect_streamed=1,reconnect_delay_max=10",
  "--no-terminal",
  url,
];

const MPV_BIN = "mpv";

/** Default settle window: mpv must survive this long after spawn to count as playing. */
const DEFAULT_PLAY_SETTLE_MS = 4_000;
/** Hard ceiling on how long play() will wait (belt-and-suspenders over the settle). */
const DEFAULT_PLAY_TIMEOUT_MS = 20_000;

export interface MpvStreamPlayerOptions {
  url?: string;
  /** Settle window (ms): if mpv is still alive at this point, declare PLAYING. */
  playSettleMs?: number;
  /** Hard ceiling (ms) on the whole play() wait. Defaults to 20s. */
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
  private readonly playSettleMs: number;
  private readonly playTimeoutMs: number;
  /** Injectable spawn (defaults to Bun.spawn) — exercised by contract tests. */
  private readonly spawn: typeof Bun.spawn;

  private proc: ReturnType<typeof Bun.spawn> | null = null;
  /** Disposer for the pending settle timer; cleared on resolve/teardown. */
  private settleDispose: (() => void) | null = null;
  /** Disposer for the hard-timeout ceiling; cleared on resolve/teardown. */
  private timeoutDispose: (() => void) | null = null;
  /** Watcher on proc.exited that flips PLAYING→ERROR if mpv dies mid-playback. */
  private exitWatcherDispose: (() => void) | null = null;

  constructor(opts: MpvStreamPlayerOptions = {}) {
    this.url = opts.url ?? ANOMALY_STREAM_URL;
    this.log = opts.log ?? (() => {});
    this.playSettleMs = opts.playSettleMs ?? DEFAULT_PLAY_SETTLE_MS;
    this.playTimeoutMs = opts.playTimeoutMs ?? DEFAULT_PLAY_TIMEOUT_MS;
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
        stdout: "pipe", // --no-terminal → mpv writes nothing; pipe never read
        stderr: "pipe", // captured but not parsed; stays empty under --no-terminal
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

    // Detection by liveness: race proc.exited against the settle timer. If mpv
    // exits before the settle elapses, it couldn't open the stream → ERROR. If
    // it survives the settle, audio is flowing → PLAYING. The hard timeout is a
    // ceiling so a pathological mpv that neither plays nor exits can't hang us.
    try {
      await this.awaitSettled(proc);
    } catch (e) {
      const msg = (e as Error).message;
      this.log(`[mpv] play() failed: ${msg}`);
      await this.teardown(); // best-effort cleanup before propagating
      this.setState("ERROR", msg);
      throw e;
    }

    // Once playing, watch for mid-playback death (e.g. network drops mpv after
    // the settle window). Flips PLAYING→ERROR so the controller can retry.
    this.exitWatcherDispose = () => {
      this.exitWatcherDispose = null;
    };
    proc.exited.then((code) => {
      if (this.proc === proc && this._state === "PLAYING") {
        this.setState(
          "ERROR",
          `mpv exited mid-playback (code=${proc.exitCode}, signal=${proc.signalCode} code=${code})`,
        );
      }
      this.exitWatcherDispose?.();
    });
  }

  /**
   * Resolve once mpv has survived the settle window. Reject if mpv exits first
   * (couldn't open the stream) or if the hard timeout elapses.
   */
  private awaitSettled(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        this.settleDispose?.();
        this.settleDispose = null;
        this.timeoutDispose?.();
        this.timeoutDispose = null;
        err ? reject(err) : resolve();
      };

      // Settle timer: mpv survived long enough → declare PLAYING.
      this.settleDispose = realTimer(() => {
        if (this.proc !== proc) return; // torn down concurrently
        this.setState("PLAYING");
        this.log(`[mpv] playback settled (alive past ${this.playSettleMs}ms)`);
        finish();
      }, this.playSettleMs);

      // Hard ceiling: if neither settle nor exit fired, fail loudly.
      this.timeoutDispose = realTimer(() => {
        finish(
          new Error(`mpv did not settle within ${this.playTimeoutMs}ms`),
        );
      }, this.playTimeoutMs);

      // If mpv exits before the settle, it failed to open the stream.
      proc.exited.then((code) => {
        if (settled) return;
        finish(
          new Error(
            `mpv exited before playback settled (code=${proc.exitCode}, signal=${proc.signalCode} exitValue=${code})`,
          ),
        );
      });
    });
  }

  pause(): void {
    // TEAR DOWN, not silence. Kill the process and free everything.
    // Synchronous contract: on return, the mpv process must be DEAD.
    this.teardownSync();
  }

  /** Synchronous teardown: cancel timers + SIGKILL + brief bounded reap wait. */
  private teardownSync() {
    const proc = this.proc;
    // Cancel any pending settle/timeout so a late fire can't flip state after kill.
    this.settleDispose?.();
    this.settleDispose = null;
    this.timeoutDispose?.();
    this.timeoutDispose = null;
    this.exitWatcherDispose?.();
    this.exitWatcherDispose = null;
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
    this.settleDispose?.();
    this.settleDispose = null;
    this.timeoutDispose?.();
    this.timeoutDispose = null;
    this.exitWatcherDispose?.();
    this.exitWatcherDispose = null;
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

/** Minimal setTimeout wrapper returning a dispose fn, mirroring controller.ts. */
function realTimer(fn: () => void, ms: number): () => void {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
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
