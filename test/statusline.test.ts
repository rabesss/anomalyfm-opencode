import { test, expect } from "bun:test";
import { renderLine, bulletToken, glyphToken } from "../src/statusline.tsx";
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
