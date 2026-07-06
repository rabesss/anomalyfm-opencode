import { test, expect, mock } from "bun:test";
import { MpvStreamPlayer } from "../src/mpv-player.ts";

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

test("play() spawns mpv with the documented args (incl. --no-terminal)", async () => {
  const proc = fakeMpvChild();
  const spawn = mock(() => proc);
  const player = new MpvStreamPlayer({
    spawn: spawn as never,
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
  expect(args).toContain("--no-terminal"); // silences the A: progress spam
  expect(args).toContain("https://anomaly.fm/radio");

  // play() resolves by surviving the settle window — no AO/A lines to emit.
  await playP;
  expect(player.state).toBe("PLAYING");

  player.pause();
  proc.exit(0);
});

test("pause() kills the process; state returns to PAUSED", async () => {
  const proc = fakeMpvChild();
  const spawn = mock(() => proc);
  const player = new MpvStreamPlayer({
    spawn: spawn as never,
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
  // A spawn that fails like Bun.spawn does when the binary is missing.
  const enoent = new Error("spawn: mpv not found") as Error & { code: string };
  enoent.code = "ENOENT";
  const spawn = mock(() => {
    throw enoent;
  });
  const player = new MpvStreamPlayer({ spawn: spawn as never });

  // Per Option A: play() resolves (does NOT throw); state stays UNSUPPORTED.
  await player.play();
  expect(player.state).toBe("UNSUPPORTED");
  expect(player.error).toMatch(/mpv/);
});

test("mpv exits during the settle window → ERROR", async () => {
  const proc = fakeMpvChild();
  const spawn = mock(() => proc);
  const player = new MpvStreamPlayer({
    spawn: spawn as never,
    playSettleMs: 5_000, // long settle so the exit() below wins the race
  });

  const playP = player.play();
  // mpv fails to open the stream and exits non-zero before the settle elapses.
  proc.exit(1);

  await expect(playP).rejects.toThrow(/exited before playback settled/);
  expect(player.state).toBe("ERROR");
  expect(player.error).toMatch(/exited before playback settled/);
});
