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
  private readonly pollIntervalMs: number;
  private readonly statusUrl: string;
  private readonly icecastUrl: string;
  private readonly onUpdate?: (snap: StatusSnapshot) => void;
  private readonly log: (level: "warn" | "error", msg: string) => void;

  private latest: StatusSnapshot = emptySnapshot();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<void> = Promise.resolve();

  /** Track which error classes we've already logged (one log per class). */
  private loggedNet = false;
  private loggedHttp = false;
  private loggedParse = false;
  private loggedIce = false;

  constructor(opts: StatusPollerOptions = {}) {
    this.fetchImpl = opts.fetch ?? ((globalThis.fetch as unknown) as FetchLike);
    this.now = opts.now ?? Date.now;
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

  /** Begin polling. First GET fires immediately. Idempotent. */
  start(): void {
    if (this.timer !== null) return;
    // Fire the first poll immediately, then schedule the cadence.
    this.inflight = this.pollOnce().finally(() => {
      this.timer = setInterval(() => {
        this.inflight = this.pollOnce();
      }, this.pollIntervalMs);
    });
  }

  /** Stop polling. Idempotent. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Poll once now, regardless of cadence. Used by tests + the watchdog. */
  async pollOnce(): Promise<void> {
    try {
      const res = await this.fetchImpl(this.statusUrl, { cache: "no-store" });
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
        listeners = await this.icecastListenersWithLogging();
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
      // Network / DNS / connection reset. Keep last-known; log once.
      if (!this.loggedNet) {
        this.loggedNet = true;
        this.log("warn", `status.json fetch failed (${describe(err)}); keeping last-known`);
      }
      this.publish();
    }
  }

  /** Resolve when the in-flight poll (if any) settles. For tests. */
  async idle(): Promise<void> {
    await this.inflight;
  }

  /* ---------- internals ---------- */

  private async icecastListenersWithLogging(): Promise<number | null> {
    try {
      const res = await this.fetchImpl(this.icecastUrl, { cache: "no-store" });
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
