import { test, expect, mock } from "bun:test";
import { MpvStreamPlayer, MPV_ARGS } from "../src/mpv-player.ts";

/**
 * Fake mpv child process mimicking the bits of `ReturnType<typeof Bun.spawn>`
 * that MpvStreamPlayer actually touches under the liveness-detection design:
 * a `stdout`/`stderr` (present but never read under --no-terminal), a
 * `kill(sig)` method, a `pid`, and an `exited` Promise plus `exitCode`/
 * `signalCode` for the settle-window detection.
 *
 * Detection is now liveness-based: `play()` resolves once mpv survives a settle
 * window, and rejects if the proc exits first. So the test driver is the
 * real `setTimeout` behind `playSettleMs` plus `proc.exit()` — no stdout lines
 * to emit. The `emit()` helper is retained only for shape compatibility.
 */
interface FakeProc {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  pid: number;
  exitCode: number | null;
  signalCode: string | null;
  kill: (sig?: string) => void;
  exited: Promise<number | null>;
  // --- test-side controls (not part of Bun.spawn's shape) ---
  emit(line: string): void;
  exit(code: number | null): void;
  killCalls: string[];
}

function fakeMpvChild(): FakeProc {
  const encoder = new TextEncoder();
  const queued: string[] = [];
  let stdoutController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let stderrController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let exitResolve: ((code: number | null) => void) | null = null;
  const killCalls: string[] = [];

  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      stdoutController = controller;
    },
    pull(controller) {
      for (const line of queued.splice(0)) {
        controller.enqueue(encoder.encode(line));
      }
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      stderrController = controller;
    },
  });

  return {
    stdout,
    stderr,
    pid: 4242,
    exitCode: null,
    signalCode: null,
    killCalls,
    kill: (sig: string = "SIGKILL") => {
      killCalls.push(sig);
    },
    exited: new Promise<number | null>((resolve) => {
      exitResolve = resolve;
    }),
    emit(line: string) {
      const encoded = encoder.encode(line);
      if (stdoutController) {
        stdoutController.enqueue(encoded);
      } else {
        queued.push(line);
      }
    },
    exit(code: number | null) {
      this.exitCode = code;
      try {
        stdoutController?.close();
        stderrController?.close();
      } catch {}
      exitResolve?.(code);
    },
  };
}

// Tiny settle window so liveness-based play() resolves fast in tests, while
// still exercising the real setTimeout → PLAYING path. Short enough to keep the
// suite snappy, long enough that a concurrently-scheduled exit() wins the race.
const FAST_SETTLE_MS = 40;

// Stub for the injectable `which` option: returns truthy so the constructor
// proceeds to the spawn path regardless of whether mpv is installed on the
// host machine. Makes the spawn/kill tests hermetic (AGENTS.md: no real mpv).
const WHICH_FOUND = (_bin: string) => "/fake/path/mpv";

test("play() spawns mpv with the documented args (incl. --no-terminal)", async () => {
  const proc = fakeMpvChild();
  const spawn = mock(() => proc);
  const player = new MpvStreamPlayer({
    spawn: spawn as never,
    which: WHICH_FOUND,
    playSettleMs: FAST_SETTLE_MS,
  });
  const playP = player.play();

  await Promise.resolve();
  expect(spawn).toHaveBeenCalledTimes(1);

  const args = (spawn.mock.calls as unknown as unknown[][])[0][0] as string[];
  expect(args[0]).toBe("mpv");
  expect(args).toContain("--no-video");
  expect(args).toContain("--profile=low-latency");
  expect(args.some((a) => a.startsWith("--stream-lavf-o=reconnect="))).toBe(true);
  expect(args).toContain("--network-timeout=3"); // false-PLAYING connect cap
  expect(args).toContain("--ytdl=no"); // disables yt-dlp on_load_fail mask
  expect(args).toContain("--no-terminal"); // silences the A: progress spam
  expect(args).toContain("https://anomaly.fm/radio");

  // play() resolves by surviving the settle window — no AO/A lines to emit.
  await playP;
  expect(player.state).toBe("PLAYING");

  player.pause();
  proc.exit(0);
});

test("MPV_ARGS carries the false-PLAYING connect-cap + ytdl flags", () => {
  // Regression guard: against an unreachable-from-start stream,
  // mpv blocks in connect() for ~120s, and its built-in ytdl_hook re-resolves
  // the URL via yt-dlp on load failure — both keep mpv "alive" past the 4s
  // settle window and fire a false PLAYING. --network-timeout=3 (< settle)
  // bounds the connect phase; --ytdl=no disables the masking retry. Measured:
  // blackhole exits non-zero in ~3.1s only when BOTH are present. This test
  // pins the flags so a future refactor can't silently drop them. (A real
  // blackhole integration test belongs in scripts/, not the unit suite, since
  // the fake-spawn harness can't simulate an OS-level connect() block.)
  const args = MPV_ARGS("https://anomaly.fm/radio");
  expect(args).toContain("--network-timeout=3");
  expect(args).toContain("--ytdl=no");
  // The URL is a positional arg preceded by `--` so a streamUrl starting with
  // "--" is never read as an mpv option. Pin both the separator and position.
  expect(args.at(-2)).toBe("--");
  expect(args.at(-1)).toBe("https://anomaly.fm/radio");
  // The invariant that makes the cap work: network-timeout value < settle window.
  const cap = args
    .find((a) => a.startsWith("--network-timeout="))
    ?.match(/^--network-timeout=(\d+)$/)?.[1];
  expect(cap).toBeDefined();
  expect(Number(cap)).toBeLessThan(4); // < DEFAULT_PLAY_SETTLE_MS (4s)
});

test("pause() kills the process; state returns to PAUSED", async () => {
  const proc = fakeMpvChild();
  const spawn = mock(() => proc);
  const player = new MpvStreamPlayer({
    spawn: spawn as never,
    which: WHICH_FOUND,
    playSettleMs: FAST_SETTLE_MS,
  });

  const playP = player.play();
  await playP;
  expect(player.state).toBe("PLAYING");

  // pause() is the teardown contract: SIGKILL the child.
  player.pause();
  expect(proc.killCalls).toContain("SIGKILL");
  expect(player.state).toBe("PAUSED");

  proc.exit(0);
});

test("missing mpv → state UNSUPPORTED without throwing", async () => {
  // which() returns null → constructor flips UNSUPPORTED before spawn is touched.
  const spawn = mock(() => fakeMpvChild());
  const player = new MpvStreamPlayer({
    spawn: spawn as never,
    which: () => null,
  });

  // Per Option A: play() resolves (does NOT throw); state stays UNSUPPORTED.
  await player.play();
  expect(player.state).toBe("UNSUPPORTED");
  expect(player.error).toMatch(/mpv/);
  expect(spawn).not.toHaveBeenCalled();
});

test("mpv exits during the settle window → ERROR", async () => {
  const proc = fakeMpvChild();
  const spawn = mock(() => proc);
  const player = new MpvStreamPlayer({
    spawn: spawn as never,
    which: WHICH_FOUND,
    playSettleMs: 5_000, // long settle so the exit() below wins the race
  });

  const playP = player.play();
  // mpv fails to open the stream and exits non-zero before the settle elapses.
  proc.exit(1);

  await expect(playP).rejects.toThrow(/exited before playback settled/);
  expect(player.state).toBe("ERROR");
  expect(player.error).toMatch(/exited before playback settled/);
});

test("pause() during the settle window → PAUSED (not ERROR)", async () => {
  // Regression guard for the pause-during-settle race: toggling off while
  // CONNECTING SIGKILLs mpv, which resolves proc.exited and (without the
  // identity guard) would reject play() and flip state to ERROR after the
  // PAUSED teardown set. The fake's kill() here mirrors real Bun.spawn by also
  // resolving exited on SIGKILL — the existing fake only recorded the signal.
  const encoder = new TextEncoder();
  let stdoutController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let exitResolve: ((code: number | null) => void) | null = null;
  const killCalls: string[] = [];
  const proc = {
    stdout: new ReadableStream<Uint8Array>({ start(c) { stdoutController = c; } }),
    stderr: new ReadableStream<Uint8Array>(),
    pid: 4242,
    exitCode: null as number | null,
    signalCode: null as string | null,
    killCalls,
    kill: (sig: string = "SIGKILL") => {
      killCalls.push(sig);
      // Real SIGKILL reaps the process → proc.exited resolves. This is the
      // behavior the recorded-signal-only fake above does NOT model, and it's
      // exactly what triggers the race this test pins down.
      proc.exitCode = null;
      proc.signalCode = sig;
      try { stdoutController?.close(); } catch {}
      exitResolve?.(null);
    },
    exited: new Promise<number | null>((resolve) => { exitResolve = resolve; }),
  };

  const spawn = mock(() => proc as never);
  const player = new MpvStreamPlayer({
    spawn: spawn as never,
    which: WHICH_FOUND,
    playSettleMs: 5_000, // long settle so pause() lands inside it
  });

  const playP = player.play();
  // Let play() reach CONNECTING + awaitSettled armed (settle timer pending).
  await Promise.resolve();

  // Toggle off mid-settle: SIGKILLs (resolving proc.exited), sets PAUSED.
  player.pause();
  expect(killCalls).toContain("SIGKILL");

  // play() must resolve cleanly (not reject) and state must stay PAUSED — NOT
  // flip to ERROR from the exit handler firing on the deliberate kill.
  await expect(playP).resolves.toBeUndefined();
  expect(player.state).toBe("PAUSED");
});

test("mpv exits AFTER the settle window (mid-playback) → ERROR", async () => {
  // Symmetric to the settle-window exit test, but exercises the post-settle
  // watcher (the proc.exited.then armed at the tail of play()) that flips
  // PLAYING→ERROR when mpv dies AFTER audio was already flowing — e.g. a
  // network drop. This is the path that lets RadioController schedule a retry.
  const proc = fakeMpvChild();
  const spawn = mock(() => proc);
  const player = new MpvStreamPlayer({
    spawn: spawn as never,
    which: WHICH_FOUND,
    playSettleMs: FAST_SETTLE_MS,
  });

  // Let play() fully settle to PLAYING — the mid-playback watcher only arms
  // once play() resolves.
  await player.play();
  expect(player.state).toBe("PLAYING");

  // mpv dies mid-stream. proc.exited is the SAME promise used during settle,
  // but the settle handler already short-circuited via `if (settled) return`,
  // so this fires the watcher armed at the tail of play().
  proc.exit(1);
  await proc.exited; // let the .then callback run

  expect(player.state).toBe("ERROR");
  expect(player.error).toMatch(/exited mid-playback/);

  player.pause();
});

test("post-settle exit watcher is inert after teardown", async () => {
  // Regression guard for the dropped exitWatcherDispose: after
  // pause() tears the process down, a late proc.exited must NOT flip state
  // back to ERROR. The `this.proc === proc` identity guard is the protection.
  const proc = fakeMpvChild();
  const spawn = mock(() => proc);
  const player = new MpvStreamPlayer({
    spawn: spawn as never,
    which: WHICH_FOUND,
    playSettleMs: FAST_SETTLE_MS,
  });

  await player.play();
  expect(player.state).toBe("PLAYING");

  player.pause();
  expect(player.state).toBe("PAUSED");

  // Late exit fires after teardown — must be a no-op.
  proc.exit(1);
  await proc.exited;

  expect(player.state).toBe("PAUSED");
});
