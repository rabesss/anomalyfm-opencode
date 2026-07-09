/**
 * RadioController — the small FSM that owns user intent ("tuned in?") and
 * drives a StreamPlayer. Identical across backends; only the player impl
 * differs.
 *
 * States: PAUSED ↔ CONNECTING ↔ PLAYING, plus ERROR and UNSUPPORTED.
 * - toggle(): flips intent. On tune-in, calls player.play() and tracks the
 *   resulting state. On tune-out, calls player.pause() and cancels any
 *   pending retry.
 * - Retry: when a tune-in lands in ERROR (a real player's fetch failed), we
 *   back off and retry, matching radio-core.js's `min(3000*attempts, 15000)`.
 *   A pause() always cancels the pending retry.
 * - Reconnect: there is NO in-process watchdog. mpv owns network reconnect
 *   (--stream-lavf-o=reconnect=1,...) for transient drops, and the
 *   StreamPlayer contract reports state by liveness with no progress feed,
 *   so a timestamp-based watchdog would misfire on healthy playback. A
 *   mid-playback mpv exit flips the player's OWN state to ERROR, but the
 *   controller has no error callback to observe that — recovery today is
 *   mpv's native reconnect; an observable onState path is a known gap.
 *
 * Injectable timer + player for deterministic tests.
 */

import type { PlayerState, StreamPlayer } from "./player.ts";

export type ControllerState = PlayerState;

export interface RadioControllerOptions {
  /** default: real setTimeout/clearTimeout. Override in tests. */
  setTimeout?: (fn: () => void, ms: number) => () => void;
  /** default max backoff; matches radio-core.js. */
  maxBackoffMs?: number;
  /** called on every state transition. */
  onState?: (s: ControllerState, error?: string) => void;
}

export class RadioController {
  private readonly player: StreamPlayer;
  private readonly _setTimeout: (fn: () => void, ms: number) => () => void;
  private readonly maxBackoffMs: number;
  private readonly onState?: (s: ControllerState, error?: string) => void;

  private _state: ControllerState = "PAUSED";
  private wantPlaying = false;
  private retryTicket: (() => void) | null = null; // dispose fn for pending retry
  private attempts = 0;

  constructor(player: StreamPlayer, opts: RadioControllerOptions = {}) {
    this.player = player;
    this._setTimeout = opts.setTimeout ?? ((fn, ms) => realTimer(fn, ms));
    this.maxBackoffMs = opts.maxBackoffMs ?? 15_000;
    this.onState = opts.onState;
  }

  get state(): ControllerState {
    return this._state;
  }

  /** User pressed the toggle key. Tune in if off; tune out if on. */
  async toggle(): Promise<void> {
    if (this.wantPlaying) {
      this.stop();
    } else {
      await this.start();
    }
  }

  /** Explicit tune-in (used by tests + the renderer's "press to tune"). */
  async start(): Promise<void> {
    this.wantPlaying = true;
    this.attempts = 0;
    this.setState("CONNECTING");
    await this.invokePlay();
  }

  /** Explicit tune-out. Cancels the pending retry. */
  stop(): void {
    this.wantPlaying = false;
    this.cancelRetry();
    try {
      this.player.pause();
    } catch {
      // a player must never throw on pause, but be defensive
    }
    this.setState("PAUSED");
  }

  /** Tear everything down (plugin dispose). */
  dispose(): void {
    this.stop();
  }

  /* ---------- internals ---------- */

  private async invokePlay(): Promise<void> {
    try {
      await this.player.play();
      // The player is the source of truth for state after play() resolves.
      const next = this.player.state;
      if (next === "PLAYING") {
        this.attempts = 0;
      }
      this.setState(next, this.player.error);
      // If the real player errored, schedule a retry (radio-core.js pattern).
      if (next === "ERROR" && this.wantPlaying) {
        this.scheduleRetry();
      }
    } catch (err) {
      // A player should surface errors via its `state`, not by throwing, but
      // handle it defensively: treat as ERROR and retry.
      this.setState("ERROR", err instanceof Error ? err.message : String(err));
      if (this.wantPlaying) this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.retryTicket !== null) return; // already pending
    this.attempts += 1;
    this.setState("CONNECTING");
    const delay = Math.min(3_000 * this.attempts, this.maxBackoffMs);
    const dispose = this._setTimeout(() => {
      this.retryTicket = null;
      if (!this.wantPlaying) return;
      void this.invokePlay();
    }, delay);
    this.retryTicket = dispose;
  }

  private cancelRetry(): void {
    if (this.retryTicket !== null) {
      this.retryTicket();
      this.retryTicket = null;
    }
    this.attempts = 0;
  }

  private setState(s: ControllerState, error?: string): void {
    this._state = s;
    this.onState?.(s, error);
  }
}

/* ---------- timer adapter ---------- */
//
// radio-core.js uses setTimeout; we keep the same primitive but expose a
// dispose-fn return so tests can drive a fake clock. Real backends pass the
// real clock; the opencode TUI version will pass its own scheduler.
function realTimer(fn: () => void, ms: number): () => void {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
}
