import { expect, test, describe } from "bun:test";
import {
  deriveAirState,
  icecastListeners,
  onAirLine,
  parseStationStatus,
  type StationStatus,
} from "../src/types.ts";

describe("deriveAirState — authoritative 4-state precedence", () => {
  const base: StationStatus = {
    station: "anomaly.fm",
    live: false,
    humans: 0,
    members: [],
    memberIds: [],
    rerun: null,
    listeners: null,
    sources: { web: null, youtube: null },
    updated: "2026-07-05T13:00:00.000Z",
  };

  test("humans > 0 → ON_AIR (wins over rerun + live)", () => {
    expect(deriveAirState({ ...base, humans: 3, members: ["a", "b"], live: true, rerun: "x" })).toBe(
      "ON_AIR",
    );
  });

  test("humans === 0 + rerun → RERUN (wins over live)", () => {
    expect(deriveAirState({ ...base, humans: 0, live: true, rerun: "Jul 2 | 6:54 PM | David" })).toBe(
      "RERUN",
    );
  });

  test("humans === 0 + no rerun + live → INTERMISSION", () => {
    expect(deriveAirState({ ...base, humans: 0, live: true, rerun: null })).toBe("INTERMISSION");
  });

  test("humans === 0 + no rerun + not live → OFF_AIR", () => {
    expect(deriveAirState({ ...base, humans: 0, live: false, rerun: null })).toBe("OFF_AIR");
  });

  test("empty-string rerun is falsy → falls through to INTERMISSION/OFF_AIR", () => {
    expect(deriveAirState({ ...base, humans: 0, live: true, rerun: "" })).toBe("INTERMISSION");
    expect(deriveAirState({ ...base, humans: 0, live: false, rerun: "" })).toBe("OFF_AIR");
  });
});

describe("onAirLine — renders exactly like radio-core.js", () => {
  const base: StationStatus = {
    station: "anomaly.fm",
    live: false,
    humans: 0,
    members: [],
    memberIds: [],
    rerun: null,
    listeners: null,
    sources: { web: null, youtube: null },
    updated: "2026-07-05T13:00:00.000Z",
  };

  test("ON AIR — members joined by comma-space", () => {
    expect(onAirLine({ ...base, humans: 2, members: ["ryan", "david"], live: true })).toBe(
      "ON AIR — ryan, david",
    );
  });

  test("RERUN — rerun label", () => {
    expect(onAirLine({ ...base, humans: 0, live: true, rerun: "Jul 2 show" })).toBe(
      "RERUN — Jul 2 show",
    );
  });

  test("INTERMISSION — fixed string", () => {
    expect(onAirLine({ ...base, humans: 0, live: true })).toBe(
      "INTERMISSION — music through the static",
    );
  });

  test("OFF AIR — fixed string", () => {
    expect(onAirLine({ ...base, humans: 0, live: false })).toBe("OFF AIR — static");
  });
});

describe("icecastListeners — /status-json.xsl fallback parser", () => {
  test("single source object (live station serves this shape)", () => {
    expect(
      icecastListeners({
        icestats: { source: { listenurl: "http://anomaly.fm:8000/radio", listeners: 10 } },
      }),
    ).toBe(10);
  });

  test("source array — picks the /radio mount, ignores others", () => {
    expect(
      icecastListeners({
        icestats: {
          source: [
            { listenurl: "http://anomaly.fm:8000/station/fallback.mp3", listeners: 3 },
            { listenurl: "http://anomaly.fm:8000/radio", listeners: 7 },
          ],
        },
      }),
    ).toBe(7);
  });

  test("endsWith('/radio') — must match the mount exactly", () => {
    expect(
      icecastListeners({
        icestats: { source: { listenurl: "http://anomaly.fm:8000/radio-archive", listeners: 99 } },
      }),
    ).toBeNull();
  });

  test("missing listeners field → null", () => {
    expect(
      icecastListeners({ icestats: { source: { listenurl: "http://x/radio" } } }),
    ).toBeNull();
  });

  test("no source at all → null", () => {
    expect(icecastListeners({ icestats: {} })).toBeNull();
    expect(icecastListeners({})).toBeNull();
  });
});

describe("parseStationStatus — defensive validation", () => {
  test("happy path — passes fields through", () => {
    const raw = {
      station: "anomaly.fm",
      live: true,
      humans: 3,
      members: ["a", "b"],
      memberIds: ["1", "2"],
      rerun: null,
      listeners: 12,
      sources: { web: 12, youtube: null },
      updated: "2026-07-05T13:00:00.000Z",
    };
    const s = parseStationStatus(raw);
    expect(s.humans).toBe(3);
    expect(s.members).toEqual(["a", "b"]);
    expect(s.listeners).toBe(12);
    expect(s.sources.web).toBe(12);
  });

  test("missing fields default safely (no crash)", () => {
    const s = parseStationStatus({});
    expect(s.humans).toBe(0);
    expect(s.live).toBe(false);
    expect(s.members).toEqual([]);
    expect(s.rerun).toBeNull();
    expect(s.listeners).toBeNull();
  });

  test("non-object root throws (caller keeps last-known)", () => {
    expect(() => parseStationStatus("nope")).toThrow();
    expect(() => parseStationStatus(null)).toThrow();
    expect(() => parseStationStatus(42)).toThrow();
  });

  test("garbage fields coerce defensively", () => {
    const s = parseStationStatus({ humans: "oops", members: "not-an-array", listeners: "x" });
    expect(s.humans).toBe(0);
    expect(s.members).toEqual([]);
    expect(s.listeners).toBeNull();
  });
});
