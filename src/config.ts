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
} as const;

export function resolveOptions(raw: unknown): PluginOptions & typeof DEFAULTS {
  const opts = (raw && typeof raw === "object" ? raw : {}) as Partial<PluginOptions>;
  return {
    ...DEFAULTS,
    pollIntervalMs: clampPositiveInt(opts.pollIntervalMs, DEFAULTS.pollIntervalMs),
    streamUrl: typeof opts.streamUrl === "string" ? opts.streamUrl : DEFAULTS.streamUrl,
    statusUrl: typeof opts.statusUrl === "string" ? opts.statusUrl : DEFAULTS.statusUrl,
  };
}

function clampPositiveInt(v: unknown, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : dflt;
}
