import { test, expect, mock } from "bun:test";
import { MpvStreamPlayer } from "../src/mpv-player.ts";

/**
 * Fake mpv child process mimicking the bits of `ReturnType<typeof Bun.spawn>`
 * that MpvStreamPlayer actually touches: a `stdout`/`stderr` ReadableStream the
 * drain reads, a `kill(sig)` method, a `pid`, and an `exited` Promise plus
 * `exitCode`/`signalCode` for the early-exit rejection path in `awaitPlaying`.
 *
 * Lines queued via `emit()` are pushed into the stdout stream the first time
 * something reads it (the player's drain). Call `exit()` to resolve `exited`.
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

  // The streams are constructed lazily-pull: Bun.spawn returns streams that
  // emit nothing until produced. We push queued lines on first pull so the
  // order (spawn -> emit -> drain reads) is robust to microtask timing.
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      stdoutController = controller;
    },
    pull(controller) {
      // Flush anything queued then idle; more can arrive via emit().
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
      // If the controller is active, enqueue directly (covers lines emitted
      // after the drain has started pulling).
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

test("play() spawns mpv with the documented args", async () => {
  const proc = fakeMpvChild();
  const spawn = mock(() => proc);
  const player = new MpvStreamPlayer({ spawn: spawn as never });
  const playP = player.play();

  // play() doesn't resolve until AO: + A: advance appear on stdout.
  // Yield once so the constructor's state checks and spawn call settle.
  await Promise.resolve();
  expect(spawn).toHaveBeenCalledTimes(1);

  // spawn is typed as a zero-arg mock, so .calls is [][]; the first call did
  // pass args ([mpvBin, ...mpvArgs], opts) — read the args array via unknown
  // (tsc-safe). calls[0] = [argsArray, opts]; calls[0][0] = the args array.
  const args = (spawn.mock.calls as unknown as unknown[][])[0][0] as string[];
  expect(args[0]).toBe("mpv");
  expect(args).toContain("--no-video");
  expect(args).toContain("--profile=low-latency");
  expect(args.some((a) => a.startsWith("--stream-lavf-o=reconnect="))).toBe(true);
  expect(args).toContain("https://anomaly.fm/radio");

  // Resolve play(): emit the two lines awaitPlaying watches for.
  proc.emit("AO: [pipewire] 48000Hz mono 1ch floatp\n");
  proc.emit("A: 00:00:01\n");
  await playP;
  expect(player.state).toBe("PLAYING");

  // Tear down so the stdout drain doesn't keep the test alive.
  proc.exit(0);
  player.pause();
});

test("pause() kills the process; state returns to PAUSED", async () => {
  const proc = fakeMpvChild();
  const spawn = mock(() => proc);
  const player = new MpvStreamPlayer({ spawn: spawn as never });

  const playP = player.play();
  proc.emit("AO: [pipewire] 48000Hz mono 1ch floatp\n");
  proc.emit("A: 00:00:02\n");
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
