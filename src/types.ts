/**
 * Verified status schema + on-air precedence for anomaly.fm.
 *
 * Authoritative sources (the station's own code, in `ground-truth/discord.fm`):
 *   - `bot/src/feed.ts:134-151`  → StationStatus JSON shape written to status.json
 *   - `web/radio-core.js:189-201` → the 4-state precedence the reference web player uses
 *
 * This module is the shared core that the other three audio backends import
 * verbatim. Keep it pure (no I/O, no timers, no globals) so it is trivially
 * testable and portable across runtimes (Bun now; opencode TUI later).
 */

/**
 * The 4 air-states of the station, in display order.
 * Mirrors the CSS air-state classes in radio-core.js.
 */
export type AirState = "ON_AIR" | "RERUN" | "INTERMISSION" | "OFF_AIR";

/**
 * status.json — the static file written by the station's Discord bot.
 * Field semantics verified from `bot/src/feed.ts`.
 */
export interface StationStatus {
  station: string;
  /** true iff bot is CONNECTED to a voice channel (NOT "transmitting"). */
  live: boolean;
  /** count of NON-BOT channel members. humans > 0 is the ON AIR trigger. */
  humans: number;
  /** display names of channel occupants (parallel to memberIds). */
  members: string[];
  /** Discord user IDs (parallel to members; ignorable for a statusline). */
  memberIds?: string[];
  /** label of the recording replaying, or null. Only set when humans === 0. */
  rerun: string | null;
  /** combined web+YouTube audience, or null if unknown (≠ 0). */
  listeners: number | null;
  /** additive breakdown of `listeners`. */
  sources: { web: number | null; youtube: number | null };
  /** ISO timestamp of the last status.json write (for staleness). */
  updated: string;
}

/** Minimal fetch type (global fetch fits). Injectable for tests. */
export type FetchLike = (
  input: string,
  init?: { cache?: string; headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/** Icecast `/status-json.xsl` shape (only what we read). */
interface IceStats {
  icestats?: {
    /** source can be a single object OR an array — handle both. */
    source?: IceSource | IceSource[] | null;
  };
}
interface IceSource {
  listenurl?: string;
  listeners?: number;
}

/**
 * Apply the authoritative 4-state precedence (radio-core.js:189-201, verbatim):
 *   humans > 0      → ON_AIR
 *   else if rerun   → RERUN
 *   else if live    → INTERMISSION
 *   else            → OFF_AIR
 *
 * Pure function — same input → same output, no side effects.
 */
export function deriveAirState(s: StationStatus): AirState {
  if (s.humans > 0) return "ON_AIR";
  if (s.rerun) return "RERUN";
  if (s.live) return "INTERMISSION";
  return "OFF_AIR";
}

/**
 * The human-readable on-air line, exactly as the web player renders it
 * (radio-core.js uses the em-dash — we keep it for fidelity).
 */
export function onAirLine(s: StationStatus): string {
  switch (deriveAirState(s)) {
    case "ON_AIR":
      return `ON AIR — ${(s.members ?? []).join(", ")}`;
    case "RERUN":
      return `RERUN — ${s.rerun ?? ""}`;
    case "INTERMISSION":
      return "INTERMISSION — music through the static";
    case "OFF_AIR":
      return "OFF AIR — static";
  }
}

/**
 * Icecast listener-count fallback (radio-core.js:211-218).
 * Called only when status.json.listeners === null.
 *
 * Reads `icestats.source[]` (which may be a single object OR an array),
 * finds the mount whose `listenurl` endsWith `/radio`, returns its `.listeners`.
 * Returns null if anything is missing/malformed — caller renders that as "?".
 *
 * Pure parser: pass the parsed JSON. Fetching is the poller's job.
 */
export function icecastListeners(parsed: unknown): number | null {
  const ice = parsed as IceStats;
  const raw = ice?.icestats?.source;
  if (raw == null) return null;
  const sources = Array.isArray(raw) ? raw : [raw];
  const mount = sources.find(
    (x) => x && typeof x === "object" && typeof x.listenurl === "string" && x.listenurl.endsWith("/radio"),
  );
  const n = mount?.listeners;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * Validate + narrow an unknown JSON value into a StationStatus, applying
 * defensive defaults so a malformed write never crashes the statusline.
 * Throws on fundamentally unusable input (so the poller can keep last-known).
 */
export function parseStationStatus(raw: unknown): StationStatus {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("status.json root is not an object");
  }
  const o = raw as Record<string, unknown>;

  const live = o["live"] === true;
  const humans = toNonNegInt(o["humans"]);
  const members = toStringArray(o["members"]);
  const memberIds = Array.isArray(o["memberIds"]) ? toStringArray(o["memberIds"]) : undefined;
  const rerun = typeof o["rerun"] === "string" && o["rerun"].length > 0 ? o["rerun"] : null;
  const listeners = toNullableNumber(o["listeners"]);
  const sourcesRaw = o["sources"];
  const sources =
    typeof sourcesRaw === "object" && sourcesRaw !== null
      ? {
          web: toNullableNumber((sourcesRaw as Record<string, unknown>)["web"]),
          youtube: toNullableNumber((sourcesRaw as Record<string, unknown>)["youtube"]),
        }
      : { web: null, youtube: null };
  const station = typeof o["station"] === "string" ? o["station"] : "anomaly.fm";
  const updated = typeof o["updated"] === "string" ? o["updated"] : new Date(0).toISOString();

  return { station, live, humans, members, memberIds, rerun, listeners, sources, updated };
}

/* ---------- internal helpers ---------- */

function toNonNegInt(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function toNullableNumber(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return v;
}
