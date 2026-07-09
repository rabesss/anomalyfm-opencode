/**
 * StatusPoller — fetches anomaly.fm/feed/status.json every 15s, applies the
 * Icecast listener-count fallback, and exposes the latest status + a stale
 * flag. This is the reusable core the other three backends import verbatim.
 *
 * Design rules (verified against the station's own `radio-core.js`):
 *   - GET only. Icecast rejects HEAD with 400 on mounts.
 *   - Poll every 15s; first GET immediately on start.
 *   - Never throws: network/parse errors keep last-known and log once per
 *     error class (so a flapping endpoint doesn't spam).
 *   - Injectable `fetch` + `now` for deterministic tests.
 *   - Stale flag when `updated` is older than STALE_AFTER_MS (~60s).
 */

import {
  deriveAirState,
  icecastListeners,
  parseStationStatus,
  type AirState,
  type FetchLike,
  type StationStatus,
} from "./types.ts";

export const POLL_INTERVAL_MS = 15_000;
export const STALE_AFTER_MS = 60_000;
/**
 * Per-poll fetch timeout. Bounds the status + Icecast fetches so a hung
 * connection (open socket, no response) can't stall the sequential cadence —
 * the next poll arms only in the current poll's `.finally`, so without this a
 * never-settling fetch would freeze polling forever. Kept < POLL_INTERVAL_MS.
 */
export const FETCH_TIMEOUT_MS = 10_000;
const STATUS_URL = "https://anomaly.fm/feed/status.json";
const ICECAST_URL = "https://anomaly.fm/status-json.xsl";

/** The poller's published view of the station. */
export interface StatusSnapshot {
  status: StationStatus | null;
  air: AirState | null;
  /** listener count after the Icecast fallback has been attempted. */
  listeners: number | null;
  /** true if status.json `updated` is older than STALE_AFTER_MS (or no data). */
  stale: boolean;
  /** ms since the bot last wrote status.json (null if never seen). */
  ageMs: number | null;
  updatedAt: number | null;
}

export interface StatusPollerOptions {
  fetch?: FetchLike;
  /** override clock for tests. */
  now?: () => number;
  /** override scheduler for tests (default: real setTimeout). */
  setTimeout?: (fn: () => void, ms: number) => () => void;
  pollIntervalMs?: number;
  statusUrl?: string;
  icecastUrl?: string;
  /** called whenever the published snapshot changes. */
  onUpdate?: (snap: StatusSnapshot) => void;
  /** default logger; stderr so it never collides with the statusline on stdout. */
  log?: (level: "warn" | "error", msg: string) => void;
}

export class StatusPoller {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly _setTimeout: (fn: () => void, ms: number) => () => void;
  private readonly pollIntervalMs: number;
  private readonly statusUrl: string;
  private readonly icecastUrl: string;
  private readonly onUpdate?: (snap: StatusSnapshot) => void;
  private readonly log: (level: "warn" | "error", msg: string) => void;

  private latest: StatusSnapshot = emptySnapshot();
  private running = false;
  /**
   * Monotonic generation token, bumped on every start(). A poll begun in an
   * earlier start()/stop() cycle checks this in its `.finally` before
   * rescheduling, so a start→stop→start while a fetch is pending can't arm a
   * second cadence loop off the stale poll.
   */
  private generation = 0;
  private timerDispose: (() => void) | null = null;
  private inflight: Promise<void> = Promise.resolve();

  /** Track which error classes we've already logged (one log per class). */
  private loggedNet = false;
  private loggedHttp = false;
  private loggedParse = false;
  private loggedIce = false;

  constructor(opts: StatusPollerOptions = {}) {
    this.fetchImpl = opts.fetch ?? ((globalThis.fetch as unknown) as FetchLike);
    this.now = opts.now ?? Date.now;
    this._setTimeout = opts.setTimeout ?? ((fn, ms) => armTimer(fn, ms));
    this.pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.statusUrl = opts.statusUrl ?? STATUS_URL;
    this.icecastUrl = opts.icecastUrl ?? ICECAST_URL;
    this.onUpdate = opts.onUpdate;
    this.log = opts.log ?? defaultLog;
  }

  /** The most recently published snapshot (never throws). */
  get snapshot(): StatusSnapshot {
    return this.latest;
  }

  /**
   * Begin polling. First GET fires immediately, then a sequential cadence:
   * the next poll is armed only after the current one settles, so polls can
   * never overlap. Idempotent while running.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.generation += 1;
    this.runCycle(this.generation);
  }

  /**
   * Run one poll cycle for `gen`, then arm the next one `pollIntervalMs` after
   * it settles. A generation guard in both the `.finally` and the timeout
   * callback ensures only the live generation reschedules: a start→stop→start
   * during a pending fetch bumps `generation`, so the stale poll's `.finally`
   * is a no-op and can't arm a second cadence loop.
   */
  private runCycle(gen: number): void {
    this.inflight = this.pollOnce().finally(() => {
      if (!this.running || this.generation !== gen) return;
      this.timerDispose = this._setTimeout(() => {
        this.timerDispose = null;
        if (!this.running || this.generation !== gen) return;
        this.runCycle(gen);
      }, this.pollIntervalMs);
    });
  }

  /** Stop polling. Idempotent. In-flight fetch is left to settle. */
  stop(): void {
    this.running = false;
    if (this.timerDispose !== null) {
      this.timerDispose();
      this.timerDispose = null;
    }
  }

  /** Poll once now, regardless of cadence. Used by tests. */
  async pollOnce(): Promise<void> {
    const { signal, cancel } = this.armFetchTimeout();
    try {
      const res = await this.fetchImpl(this.statusUrl, { cache: "no-store", signal });
      if (!res.ok) {
        if (!this.loggedHttp) {
          this.loggedHttp = true;
          this.log("warn", `status.json HTTP ${res.status}; keeping last-known`);
        }
        this.publish();
        return;
      }
      const json = await res.json();
      const status = parseStationStatus(json);

      // Listener fallback: only when status.json says unknown.
      let listeners = status.listeners;
      if (listeners === null) {
        listeners = await this.icecastListenersWithLogging(signal);
      }

      const ageMs = this.ageMs(status.updated);
      const stale = ageMs > STALE_AFTER_MS;
      // A successful refresh resets the per-class "log once" latches so a
      // recurrence of the same error logs again next time.
      this.loggedNet = this.loggedHttp = this.loggedParse = this.loggedIce = false;

      this.latest = {
        status,
        air: deriveAirState(status),
        listeners,
        stale,
        ageMs,
        updatedAt: Date.parse(status.updated) || null,
      };
      this.publish();
    } catch (err) {
      // Network / DNS / connection reset / fetch-timeout abort. Keep
      // last-known; log once. The abort is what lets a hung connection settle
      // so the sequential cadence can arm its next poll.
      if (!this.loggedNet) {
        this.loggedNet = true;
        this.log("warn", `status.json fetch failed (${describe(err)}); keeping last-known`);
      }
      this.publish();
    } finally {
      cancel();
    }
  }

  /** Resolve when the in-flight poll (if any) settles. For tests. */
  async idle(): Promise<void> {
    await this.inflight;
  }

  /* ---------- internals ---------- */

  /**
   * Abort this poll's fetches after FETCH_TIMEOUT_MS so a hung connection (open
   * socket, never responding) can't stall the sequential cadence. Returns a
   * dispose fn that clears the timeout — call it in pollOnce's `finally`.
   */
  private armFetchTimeout(): { signal: AbortSignal; cancel: () => void } {
    const controller = new AbortController();
    const cancel = this._setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    return { signal: controller.signal, cancel };
  }

  private async icecastListenersWithLogging(signal: AbortSignal): Promise<number | null> {
    try {
      const res = await this.fetchImpl(this.icecastUrl, { cache: "no-store", signal });
      if (!res.ok) return null;
      const parsed = await res.json();
      return icecastListeners(parsed);
    } catch (err) {
      if (!this.loggedIce) {
        this.loggedIce = true;
        this.log("warn", `status-json.xsl fallback failed (${describe(err)}); listeners unknown`);
      }
      return null;
    }
  }

  private ageMs(updatedIso: string): number {
    const t = Date.parse(updatedIso);
    if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
    return Math.max(0, this.now() - t);
  }

  private publish(): void {
    // Re-derive staleness on every publish using the live clock — important
    // for the renderer, which recomputes "stale" between polls too.
    if (this.latest.status) {
      const ageMs = this.ageMs(this.latest.status.updated);
      this.latest = { ...this.latest, ageMs, stale: ageMs > STALE_AFTER_MS };
    }
    this.onUpdate?.(this.latest);
  }
}

function emptySnapshot(): StatusSnapshot {
  return { status: null, air: null, listeners: null, stale: true, ageMs: null, updatedAt: null };
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function defaultLog(level: "warn" | "error", msg: string): void {
  const stream = level === "error" ? process.stderr : process.stderr;
  stream.write(`[statuspoller] ${level}: ${msg}\n`);
}

/** setTimeout wrapper returning a dispose fn, mirroring controller.ts. */
function armTimer(fn: () => void, ms: number): () => void {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
}
