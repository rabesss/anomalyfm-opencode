/**
 * Plugin options as the 2nd element of a `[spec, options]` tuple in tui.json.
 * All optional; sensible defaults match the reference web player.
 */
export interface PluginOptions {
  /** Override the status.json poll interval (default 15000ms). */
  pollIntervalMs?: number;
  /** Override the stream URL (default https://anomaly.fm/radio). */
  streamUrl?: string;
  /** Override the status URL (default https://anomaly.fm/feed/status.json). */
  statusUrl?: string;
}

export const DEFAULTS = {
  pollIntervalMs: 15_000,
  streamUrl: "https://anomaly.fm/radio",
  statusUrl: "https://anomaly.fm/feed/status.json",
};

/** Floor on poll interval — anything tighter hammers the status endpoint. */
export const MIN_POLL_INTERVAL_MS = 1_000;

export function resolveOptions(raw: unknown): PluginOptions & typeof DEFAULTS {
  const opts = (raw && typeof raw === "object" ? raw : {}) as Partial<PluginOptions>;
  return {
    ...DEFAULTS,
    pollIntervalMs: clampPollInterval(opts.pollIntervalMs, DEFAULTS.pollIntervalMs),
    streamUrl: httpUrl(opts.streamUrl, DEFAULTS.streamUrl),
    statusUrl: httpUrl(opts.statusUrl, DEFAULTS.statusUrl),
  };
}

function clampPollInterval(v: unknown, dflt: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return dflt;
  return Math.max(MIN_POLL_INTERVAL_MS, Math.floor(v));
}

/**
 * Accept only http(s) URLs and fall back to the default otherwise — including a
 * streamUrl that starts with "--", which mpv would otherwise read as a flag.
 * Returns the parsed `href` (not the raw input): WHATWG URL parsing strips
 * leading/trailing whitespace and embedded tab/newline/CR *for parsing only*,
 * so returning the raw string would let those contaminants reach mpv.
 */
function httpUrl(v: unknown, dflt: string): string {
  if (typeof v !== "string") return dflt;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : dflt;
  } catch {
    return dflt;
  }
}
