import { test, expect } from "bun:test";
import { renderLine, bulletToken, glyphToken, GLYPH } from "../src/statusline.tsx";
import type { StationStatus } from "../src/types.ts";
import type { ControllerState } from "../src/controller.ts";

const base: StationStatus = {
  station: "anomaly.fm", live: true, humans: 0, members: [], memberIds: [],
  rerun: null, listeners: 12, sources: { web: 11, youtube: 1 },
  updated: "2026-07-05T12:00:00.000Z",
};

test("ON AIR with host shows member + listeners", () => {
  const s = { ...base, humans: 1, members: ["ryan"] };
  expect(renderLine(s, "PLAYING", 80))
    .toBe("◆ anomaly.fm · ON AIR · ryan · 12 live · ▶");
});

test("ON AIR with no member name falls back to count", () => {
  const s = { ...base, humans: 2, members: [] };
  expect(renderLine(s, "PAUSED", 80))
    .toBe("◆ anomaly.fm · ON AIR · 2 in booth · 12 live · ⏸");
});

test("RERUN shows rerun label", () => {
  const s = { ...base, humans: 0, rerun: "Jul 2 | 6:54 PM | David, vogel" };
  expect(renderLine(s, "PLAYING", 80))
    .toBe("◆ anomaly.fm · RERUN: Jul 2 | 6:54 PM | David, vogel · 12 live · ▶");
});

test("INTERMISSION", () => {
  expect(renderLine(base, "PAUSED", 80))
    .toBe("◆ anomaly.fm · INTERMISSION · 12 live · ⏸");
});

test("OFF AIR", () => {
  expect(renderLine({ ...base, live: false }, "PAUSED", 80))
    .toBe("◆ anomaly.fm · OFF AIR · 12 live · ⏸");
});

test("null listeners → ? live", () => {
  expect(renderLine({ ...base, listeners: null }, "PAUSED", 80))
    .toBe("◆ anomaly.fm · INTERMISSION · ? live · ⏸");
});

test("ERROR → ⚠ glyph", () => {
  expect(renderLine(base, "ERROR", 80))
    .toBe("◆ anomaly.fm · INTERMISSION · 12 live · ⚠");
});

test("UNSUPPORTED → ⚠ glyph", () => {
  expect(renderLine(base, "UNSUPPORTED", 80))
    .toBe("◆ anomaly.fm · INTERMISSION · 12 live · ⚠");
});

test("narrow width truncates the line, never breaks the glyph", () => {
  const s = { ...base, humans: 1, members: ["ryan"] };
  const line = renderLine(s, "PLAYING", 30);
  expect(line.length).toBeLessThanOrEqual(30);
  expect(line).toMatch(/[▶⏸⚠]$/); // glyph preserved at the tail
});

// Width here is terminal COLUMNS, not JS length. A CJK host name occupies 2
// cells per ideograph; an emoji host name occupies 2 cells per pictograph.
function displayWidth(str: string): number {
  let w = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x1100 && cp <= 0x115f) { w += 2; continue; }
    if (cp >= 0x2e80 && cp <= 0xa4cf) { w += 2; continue; }
    if (cp >= 0xac00 && cp <= 0xd7a3) { w += 2; continue; }
    if (cp >= 0xf900 && cp <= 0xfaff) { w += 2; continue; }
    if (cp >= 0xfe30 && cp <= 0xfe4f) { w += 2; continue; }
    if (cp >= 0xff00 && cp <= 0xff60) { w += 2; continue; }
    if (cp >= 0xffe0 && cp <= 0xffe6) { w += 2; continue; }
    if (cp >= 0x1f000 && cp <= 0x1faff) { w += 2; continue; }
    if (cp >= 0x20000 && cp <= 0x3fffd) { w += 2; continue; }
    if (cp >= 0x0300 && cp <= 0x036f) continue;
    if (cp >= 0x200b && cp <= 0x200f) continue;
    w += 1;
  }
  return w;
}

test("CJK host name truncates by display width, never breaks the glyph", () => {
  const s = { ...base, humans: 1, members: ["田中太郎"] }; // 4 ideographs = 8 cells
  const line = renderLine(s, "PLAYING", 40);
  expect(displayWidth(line)).toBeLessThanOrEqual(40);
  expect(line).toMatch(/[▶⏸⚠]$/);
  expect(line.startsWith("◆")).toBe(true);
});

test("emoji host name truncates by display width, no split surrogate", () => {
  const s = { ...base, humans: 1, members: ["🎵🎧radio"] };
  const line = renderLine(s, "PLAYING", 36);
  expect(displayWidth(line)).toBeLessThanOrEqual(36);
  expect(line).toMatch(/[▶⏸⚠]$/);
  // No lone half of a surrogate pair (a split would produce U+FFFD on encode).
  expect(Buffer.from(line, "utf8").toString("utf8")).toBe(line);
});

// --- bulletToken: accent only when a human is actually on air -----------------
test("bulletToken: ON AIR (humans present) → accent", () => {
  expect(bulletToken({ ...base, humans: 1, members: ["ryan"] })).toBe("accent");
  expect(bulletToken({ ...base, humans: 2, members: [] })).toBe("accent");
});

test("bulletToken: RERUN → muted (not live, just playback)", () => {
  expect(bulletToken({ ...base, humans: 0, rerun: "Jul 2 | David, vogel" }))
    .toBe("textMuted");
});

test("bulletToken: INTERMISSION → muted", () => {
  expect(bulletToken({ ...base, live: true })).toBe("textMuted");
});

test("bulletToken: OFF AIR → muted", () => {
  expect(bulletToken({ ...base, live: false })).toBe("textMuted");
});

test("bulletToken: no snapshot yet → muted", () => {
  expect(bulletToken(null)).toBe("textMuted");
});

// --- glyphToken: muted unless the player is in trouble -----------------------
test("glyphToken: ERROR and UNSUPPORTED → warning", () => {
  expect(glyphToken("ERROR")).toBe("warning");
  expect(glyphToken("UNSUPPORTED")).toBe("warning");
});

test("glyphToken: healthy states → muted", () => {
  const healthy: ControllerState[] = ["PLAYING", "PAUSED", "CONNECTING"];
  for (const s of healthy) expect(glyphToken(s)).toBe("textMuted");
});

test("every glyph is a single BMP code unit (truncate/index code-unit safety)", () => {
  // Guards the GLYPH invariant: truncate() slices the trailing " "+glyph by
  // code unit (slice(-2)) and index.tsx indexes line[line.length-1], so an
  // astral/emoji glyph would split a surrogate pair. If this fails, make the
  // whole render path code-point-aware rather than just widening the glyph.
  for (const g of Object.values(GLYPH)) {
    expect(g.length).toBe(1); // one UTF-16 code unit == BMP
  }
});
