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
 * Fit `line` into `width` terminal columns without ever breaking the trailing
 * glyph. Truncation is by DISPLAY width, not JS string length: a CJK or emoji
 * host name occupies 2 cells per code point, so a length-based slice would
 * overflow the budget (or split a surrogate pair). Rule: reserve the trailing
 * 2 cells (" " + glyph), fit the longest display-width prefix of the body into
 * the remaining budget, then re-append the kept tail. trimEnd avoids a dangling
 * separator when the cut lands mid-token. The leading `◆ anomaly.fm ·` and the
 * final glyph are always preserved.
 */
function truncate(line: string, width: number): string {
  if (displayWidth(line) <= width) return line;
  // The tail is always " " + glyph; both are BMP (1 cell each) so slice(-2) is
  // a safe code-unit cut that never splits a surrogate pair.
  const keep = line.slice(-2);
  const budget = Math.max(0, width - displayWidth(keep));
  const prefix = sliceByWidth(line.slice(0, -2), budget).trimEnd();
  return prefix + keep;
}

/**
 * Display width of a string in terminal cells, iterating by code point so
 * surrogate pairs (emoji) are counted once. Pragmatic, not a full wcwidth:
 * covers combining marks / zero-width joiners (0), CJK + fullwidth + common
 * emoji (2), everything else (1). Sufficient for host names; deliberately
 * small rather than pulling in a dependency.
 */
function displayWidth(str: string): number {
  let w = 0;
  for (const ch of str) w += charWidth(ch.codePointAt(0)!);
  return w;
}

/** Longest prefix of `str` whose display width is ≤ `maxWidth`. */
function sliceByWidth(str: string, maxWidth: number): string {
  let w = 0;
  let out = "";
  for (const ch of str) {
    const cw = charWidth(ch.codePointAt(0)!);
    if (w + cw > maxWidth) break;
    w += cw;
    out += ch;
  }
  return out;
}

function charWidth(cp: number): number {
  if (isZeroWidth(cp)) return 0;
  if (isWide(cp)) return 2;
  return 1;
}

function isZeroWidth(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) || // combining diacritics
    (cp >= 0x0483 && cp <= 0x0489) ||
    (cp >= 0x0591 && cp <= 0x05bd) ||
    cp === 0x05bf ||
    (cp >= 0x05c1 && cp <= 0x05c2) ||
    (cp >= 0x05c4 && cp <= 0x05c5) ||
    cp === 0x05c7 ||
    (cp >= 0x0610 && cp <= 0x061a) ||
    (cp >= 0x064b && cp <= 0x065f) ||
    cp === 0x0670 ||
    (cp >= 0x06d6 && cp <= 0x06dc) ||
    (cp >= 0x06df && cp <= 0x06e4) ||
    (cp >= 0x06e7 && cp <= 0x06e8) ||
    (cp >= 0x06ea && cp <= 0x06ed) ||
    cp === 0x0711 ||
    (cp >= 0x0730 && cp <= 0x074a) ||
    (cp >= 0x200b && cp <= 0x200f) || // ZWSP / ZWNJ / ZWJ / LRM / RLM
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2064) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
    cp === 0xfeff
  );
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals / Kangxi
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana / Katakana / CJK symbols
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK Compatibility Forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || // Emoji & pictographs
    (cp >= 0x1f000 && cp <= 0x1f02f) || // Mahjong / dominoes
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Ext B+
  );
}
