import { test, expect } from "bun:test";
import { renderLine } from "../src/statusline.tsx";
import type { StationStatus } from "../src/types.ts";

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
