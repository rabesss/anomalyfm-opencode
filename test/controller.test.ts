import { expect, test, describe } from "bun:test";
import { RadioController } from "../src/controller.ts";
import type { PlayerState, StreamPlayer } from "../src/player.ts";

/** A controllable fake player with no timers of its own. */
class FakePlayer implements StreamPlayer {
  state: PlayerState = "PAUSED";
  error: string | undefined;
  playCalls = 0;
  pauseCalls = 0;
  /** wall-clock time (via injected now()) of each play() call. */
  playTimes: number[] = [];
  /** what state should play() land in? default UNSUPPORTED (no-audio). */
  landOnPlay: PlayerState = "UNSUPPORTED";
  /** optional clock for recording play timestamps. */
  now: (() => number) | undefined;

  async play(): Promise<void> {
    this.playCalls += 1;
    this.playTimes.push((this.now ?? Date.now)());
    this.state = this.landOnPlay;
  }
  pause(): void {
    this.pauseCalls += 1;
    this.state = "PAUSED";
  }
}

/** A fake clock: setTimeout queues fns keyed by deadline; advance runs them. */
class FakeClock {
  private t = 0;
  private queue: { deadline: number; fn: () => void; alive: boolean }[] = [];

  now = () => this.t;

  setTimeout = (fn: () => void, ms: number) => {
    const entry = { deadline: this.t + ms, fn, alive: true };
    this.queue.push(entry);
    return () => {
      entry.alive = false;
    };
  };

  advance(ms: number): void {
    const target = this.t + ms;
    // run due timers in deadline order until the clock reaches `target`.
    for (;;) {
      const due = this.queue.filter((e) => e.alive && e.deadline <= target);
      if (due.length === 0) break;
      due.sort((a, b) => a.deadline - b.deadline);
      const next = due[0]!;
      this.t = next.deadline;
      next.alive = false;
      next.fn();
    }
    this.t = target;
  }

  pendingCount(): number {
    return this.queue.filter((e) => e.alive).length;
  }
}

/**
 * Drain the microtask queue. Needed because the retry timer fires
 * `void invokePlay()` (not awaited) and invokePlay's post-`await` body —
 * which schedules the NEXT retry — runs on the microtask queue. A single
 * advance therefore needs a flush before the next retry is armed.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("RadioController — FSM transitions", () => {
  test("no-audio player: toggle → CONNECTING → UNSUPPORTED", async () => {
    const player = new FakePlayer(); // landOnPlay = UNSUPPORTED
    const states: PlayerState[] = [];
    const ctrl = new RadioController(player, { onState: (s) => states.push(s) });

    await ctrl.toggle();
    expect(player.playCalls).toBe(1);
    expect(ctrl.state).toBe("UNSUPPORTED");
    expect(states).toEqual(["CONNECTING", "UNSUPPORTED"]);
  });

  test("real-ish player: toggle → CONNECTING → PLAYING", async () => {
    const player = new FakePlayer();
    player.landOnPlay = "PLAYING";
    const ctrl = new RadioController(player);
    await ctrl.toggle();
    expect(ctrl.state).toBe("PLAYING");
  });

  test("toggle off → PAUSED, player.pause() called", async () => {
    const player = new FakePlayer();
    player.landOnPlay = "PLAYING";
    const ctrl = new RadioController(player);
    await ctrl.toggle(); // on
    ctrl.toggle(); // off (sync)
    expect(player.pauseCalls).toBe(1);
    expect(ctrl.state).toBe("PAUSED");
  });

  test("ERROR player schedules a backoff retry; pause cancels it", async () => {
    const clock = new FakeClock();
    const player = new FakePlayer();
    player.landOnPlay = "ERROR"; // every play attempt errors
    const states: PlayerState[] = [];
    const ctrl = new RadioController(player, {
      setTimeout: clock.setTimeout,
      onState: (s) => states.push(s),
    });

    await ctrl.toggle(); // CONNECTING → ERROR → scheduleRetry → CONNECTING (retry armed)
    expect(clock.pendingCount()).toBeGreaterThanOrEqual(1); // retry armed
    expect(ctrl.state).toBe("CONNECTING"); // retry armed shows CONNECTING

    // first backoff ~3000ms
    clock.advance(3000);
    await flush();
    expect(player.playCalls).toBe(2); // retried once → ERROR again
    expect(clock.pendingCount()).toBeGreaterThanOrEqual(1); // next retry armed (6s)

    // pause cancels the pending retry
    ctrl.stop();
    expect(clock.pendingCount()).toBe(0);
    expect(ctrl.state).toBe("PAUSED");
  });

  test("backoff is capped at maxBackoffMs (radio-core.js min(3000*n,15000))", async () => {
    const clock = new FakeClock();
    const player = new FakePlayer();
    player.now = clock.now;
    player.landOnPlay = "ERROR";
    const ctrl = new RadioController(player, {
      setTimeout: clock.setTimeout,
      maxBackoffMs: 15_000,
    });
    await ctrl.toggle(); // play #1 at t=0, then arms 1st retry at +3s

    // Advance one step at a time so each play is timestamped precisely.
    // flush() lets the (un-awaited) invokePlay() microtask arm the next retry.
    clock.advance(3000);
    await flush(); // → play #2 at t=3000, arms retry at +6s
    clock.advance(6000);
    await flush(); // → play #3 at t=9000, arms retry at +9s
    clock.advance(9000);
    await flush(); // → play #4 at t=18000, arms retry at +12s
    clock.advance(12000);
    await flush(); // → play #5 at t=30000, arms retry at +15s (capped)
    clock.advance(15000);
    await flush(); // → play #6 at t=45000

    expect(player.playCalls).toBe(6);
    const gaps = player.playTimes.slice(1).map((t, i) => t - player.playTimes[i]!);
    expect(gaps).toEqual([3000, 6000, 9000, 12000, 15000]);
    ctrl.stop();
  });

  test("ERROR → successful retry lands in PLAYING and resets attempts", async () => {
    const clock = new FakeClock();
    const player = new FakePlayer();
    player.landOnPlay = "ERROR";
    const ctrl = new RadioController(player, {
      setTimeout: clock.setTimeout,
    });
    await ctrl.toggle();
    // After an ERROR land, scheduleRetry immediately moves us to CONNECTING
    // (retry armed) — mirrors radio-core.js's scheduleReconnect.
    expect(ctrl.state).toBe("CONNECTING");
    const armed = clock.pendingCount();
    expect(armed).toBeGreaterThanOrEqual(1);

    // Now the player recovers; fire the pending retry.
    player.landOnPlay = "PLAYING";
    clock.advance(3000);
    await flush();
    expect(player.playCalls).toBe(2);
    expect(ctrl.state).toBe("PLAYING");
    ctrl.stop();
  });

  test("dispose stops everything (no dangling timers)", async () => {
    const clock = new FakeClock();
    const player = new FakePlayer();
    player.landOnPlay = "ERROR";
    const ctrl = new RadioController(player, { setTimeout: clock.setTimeout });
    await ctrl.toggle();
    expect(clock.pendingCount()).toBeGreaterThan(0);
    ctrl.dispose();
    expect(clock.pendingCount()).toBe(0);
  });

  test("explicit start()/stop() mirror toggle()", async () => {
    const player = new FakePlayer();
    player.landOnPlay = "PLAYING";
    const ctrl = new RadioController(player);
    await ctrl.start();
    expect(ctrl.state).toBe("PLAYING");
    ctrl.stop();
    expect(ctrl.state).toBe("PAUSED");
  });

  test("healthy PLAYING schedules no spurious retries (no watchdog)", async () => {
    // Guards the watchdog removal: a timestamp-based watchdog with no progress
    // feed would force a reconnect ~15s into healthy playback. There is none.
    const clock = new FakeClock();
    const player = new FakePlayer();
    player.landOnPlay = "PLAYING";
    const ctrl = new RadioController(player, { setTimeout: clock.setTimeout });
    await ctrl.toggle();
    expect(player.playCalls).toBe(1);
    // Advance well past the former 15s stall threshold; nothing should fire.
    clock.advance(60_000);
    await flush();
    expect(player.playCalls).toBe(1); // no reconnect attempt
    expect(clock.pendingCount()).toBe(0); // no timers armed during PLAYING
    ctrl.stop();
  });
});
