/**
 * Statusline rendering — pure string helper.
 *
 * Task 3 scope: `renderLine` + `truncate` only. The `@opentui/solid`
 * component that paints this string into opencode's `app_bottom` slot arrives
 * in Task 4 (hence the `.tsx` extension, kept ready for JSX).
 *
 * `renderLine` is pure (no I/O, no globals): given a station snapshot, a
 * controller state, and a terminal width, produce the exact statusline string.
 * The producer copy rules are pinned by the snapshot tests in
 * `test/statusline.test.ts` — those are the spec; this code conforms to them.
 *
 * `bulletToken`/`glyphToken` name which opencode theme token (see TuiTheme in
 * @opencode-ai/plugin/tui) the host should use to paint the leading bullet and
 * the trailing glyph. They return a token *name* (not an RGBA) so this module
 * stays free of any opencode/@opentui import — the host (src/index.tsx) resolves
 * the name to a live color via `api.theme.current`. Color policy, not copy:
 * only the bullet and glyph carry meaning; the body is always muted.
 */

import { deriveAirState, type StationStatus } from "./types.ts";
import type { ControllerState } from "./controller.ts";

/**
 * The subset of opencode theme tokens the statusline paints with. These are
 * keys on `TuiThemeCurrent` (all `RGBA`); the host indexes into that object.
 */
export type StatusToken = "accent" | "warning" | "textMuted";

/** Trailing glyph per controller state. CONNECTING shares PAUSED's ⏸. */
const GLYPH: Record<ControllerState, string> = {
  PAUSED: "⏸",
  CONNECTING: "⏸",
  PLAYING: "▶",
  ERROR: "⚠",
  UNSUPPORTED: "⚠",
};

/**
 * Bullet color policy: muted by default, lighting up with the accent token only
 * when a human is actually on air (deriveAirState === "ON_AIR"). This is the one
 * state worth pulling the eye to; every other air-state stays ambient.
 */
export function bulletToken(s: StationStatus | null): StatusToken {
  if (s && deriveAirState(s) === "ON_AIR") return "accent";
  return "textMuted";
}

/**
 * Glyph color policy: muted unless the player is in trouble, then warning —
 * matching opencode's own "needs attention" tone (the Tip badge).
 */
export function glyphToken(state: ControllerState): StatusToken {
  return state === "ERROR" || state === "UNSUPPORTED" ? "warning" : "textMuted";
}

/**
 * Render the one-line status strip. Layout:
 *   `◆ anomaly.fm · <status>[ · <host>] · <listeners> live · <glyph>`
 *
 * `<status>` is derived from the station's air-state, but rendered with the
 * statusline's own copy (NOT `onAirLine` from types.ts): the statusline uses
 * bare labels (`ON AIR`, `INTERMISSION`, `OFF AIR`) and a colon form for
 * reruns (`RERUN: <label>`), whereas `onAirLine` emits the web player's
 * em-dash form (`ON AIR — names`). The snapshot tests pin the statusline form.
 *
 * `<host>` is appended only when ON AIR: the first member's name, or — if no
 * display name is present — a `N in booth` count fallback.
 */
export function renderLine(
  s: StationStatus | null,
  state: ControllerState,
  width: number,
): string {
  const glyph = GLYPH[state];
  if (!s) return truncate(`◆ anomaly.fm · connecting… · ${glyph}`, width);

  const air = deriveAirState(s);
  const status =
    air === "ON_AIR" ? "ON AIR"
    : air === "RERUN" ? `RERUN: ${s.rerun ?? ""}`
    : air === "INTERMISSION" ? "INTERMISSION"
    : "OFF AIR";

  const host =
    air === "ON_AIR" ? ` · ${s.members[0] ?? `${s.humans} in booth`}` : "";

  const listeners = s.listeners === null ? "?" : String(s.listeners);

  return truncate(
    `◆ anomaly.fm · ${status}${host} · ${listeners} live · ${glyph}`,
    width,
  );
}

/**
 * Fit `line` into `width` columns without ever breaking the trailing glyph.
 * Rule: when too long, drop interior characters from the right of the kept
 * prefix, but always preserve the leading `◆ anomaly.fm ·` and the final
 * two characters (space + glyph). The slice already starts at the prefix, so
 * truncation only ever eats status/host/listeners detail — never the brand or
 * the glyph.
 */
function truncate(line: string, width: number): string {
  if (line.length <= width) return line;
  // Keep the trailing 2 chars verbatim (space + glyph). `keep` already carries
  // its own leading space, so we splice it directly onto the trimmed prefix —
  // NOT `prefix + " " + keep`, which would overshoot `width` by one. trimEnd
  // guards against the slice landing mid-token (e.g. on a ` · ` boundary),
  // keeping the result ≤ width and free of dangling separators.
  const keep = line.slice(-2);
  return line.slice(0, Math.max(0, width - 2)).trimEnd() + keep;
}
