import { expect, test, describe } from "bun:test";
import { StatusPoller, STALE_AFTER_MS, type StatusSnapshot } from "../src/poller.ts";
import { makeFetch, freshStatus } from "./helpers.ts";

const STATUS = "https://anomaly.fm/feed/status.json";
const ICE = "https://anomaly.fm/status-json.xsl";

describe("StatusPoller", () => {
  test("happy path — first GET publishes immediately, never throws", async () => {
    const fetch = makeFetch({ [STATUS]: { body: freshStatus({ live: true, listeners: 8 }) } });
    const snaps: StatusSnapshot[] = [];
    const poller = new StatusPoller({ fetch, onUpdate: (s) => snaps.push(s) });

    await poller.pollOnce();
    const snap = poller.snapshot;
    expect(snap.status?.live).toBe(true);
    expect(snap.air).toBe("INTERMISSION");
    expect(snap.listeners).toBe(8);
    expect(snap.stale).toBe(false);
    expect(snaps.length).toBe(1);
  });

  test("ON AIR precedence — humans > 0", async () => {
    const fetch = makeFetch({
      [STATUS]: { body: freshStatus({ humans: 2, members: ["ryan", "david"], live: true }) },
    });
    const poller = new StatusPoller({ fetch });
    await poller.pollOnce();
    expect(poller.snapshot.air).toBe("ON_AIR");
    expect(poller.snapshot.status?.members).toEqual(["ryan", "david"]);
  });

  test("RERUN precedence — humans 0, rerun set", async () => {
    const fetch = makeFetch({
      [STATUS]: { body: freshStatus({ humans: 0, live: true, rerun: "Jul 2 show" }) },
    });
    const poller = new StatusPoller({ fetch });
    await poller.pollOnce();
    expect(poller.snapshot.air).toBe("RERUN");
  });

  test("INTERMISSION precedence — humans 0, no rerun, live", async () => {
    const fetch = makeFetch({ [STATUS]: { body: freshStatus({ humans: 0, live: true }) } });
    const poller = new StatusPoller({ fetch });
    await poller.pollOnce();
    expect(poller.snapshot.air).toBe("INTERMISSION");
  });

  test("OFF AIR precedence — humans 0, no rerun, not live", async () => {
    const fetch = makeFetch({ [STATUS]: { body: freshStatus({ humans: 0, live: false }) } });
    const poller = new StatusPoller({ fetch });
    await poller.pollOnce();
    expect(poller.snapshot.air).toBe("OFF_AIR");
  });

  test("listeners fallback — status.json listeners null → GET status-json.xsl (single source)", async () => {
    const fetch = makeFetch({
      [STATUS]: { body: freshStatus({ listeners: null }) },
      [ICE]: {
        body: { icestats: { source: { listenurl: "http://anomaly.fm:8000/radio", listeners: 10 } } },
      },
    });
    const poller = new StatusPoller({ fetch });
    await poller.pollOnce();
    expect(fetch.calls[ICE]).toBe(1);
    expect(poller.snapshot.listeners).toBe(10);
  });

  test("listeners fallback — handles source ARRAY shape too", async () => {
    const fetch = makeFetch({
      [STATUS]: { body: freshStatus({ listeners: null }) },
      [ICE]: {
        body: {
          icestats: {
            source: [
              { listenurl: "http://anomaly.fm:8000/station/fallback.mp3", listeners: 3 },
              { listenurl: "http://anomaly.fm:8000/radio", listeners: 22 },
            ],
          },
        },
      },
    });
    const poller = new StatusPoller({ fetch });
    await poller.pollOnce();
    expect(poller.snapshot.listeners).toBe(22);
  });

  test("listeners NOT null → icecast endpoint is NOT hit", async () => {
    const fetch = makeFetch({
      [STATUS]: { body: freshStatus({ listeners: 5 }) },
      [ICE]: { body: { icestats: { source: { listeners: 999 } } } },
    });
    const poller = new StatusPoller({ fetch });
    await poller.pollOnce();
    expect(fetch.calls[ICE] ?? 0).toBe(0);
    expect(poller.snapshot.listeners).toBe(5);
  });

  test("both fallbacks fail → listeners stays null (rendered as '?')", async () => {
    const fetch = makeFetch({
      [STATUS]: { body: freshStatus({ listeners: null }) },
      [ICE]: { body: { icestats: {} } },
    });
    const poller = new StatusPoller({ fetch });
    await poller.pollOnce();
    expect(poller.snapshot.listeners).toBeNull();
  });

  test("malformed JSON → keeps last-known, does not throw, updates remain valid", async () => {
    const fetch = makeFetch({
      [STATUS]: { body: freshStatus({ humans: 2, members: ["ryan"], listeners: 4 }) },
    });
    const poller = new StatusPoller({ fetch });
    await poller.pollOnce();
    const knownStatus = poller.snapshot.status;
    expect(poller.snapshot.air).toBe("ON_AIR");

    // Now corrupt the response.
    fetch.set(STATUS, { jsonThrows: true });
    await poller.pollOnce(); // must not throw
    // "keeps last-known" = the last StationStatus object is retained by reference
    // (publish() rebuilds the snapshot wrapper but preserves .status).
    expect(poller.snapshot.status).toBe(knownStatus);
    expect(poller.snapshot.air).toBe("ON_AIR");
    expect(poller.snapshot.listeners).toBe(4);
  });

  test("network error → keeps last-known, does not throw", async () => {
    const fetch = makeFetch({
      [STATUS]: { body: freshStatus({ humans: 1, members: ["david"], listeners: 3 }) },
    });
    const poller = new StatusPoller({ fetch });
    await poller.pollOnce();
    const knownStatus = poller.snapshot.status;

    fetch.set(STATUS, { throw: new Error("ENOTFOUND") });
    await poller.pollOnce(); // must not throw
    expect(poller.snapshot.status).toBe(knownStatus);
    expect(poller.snapshot.status?.humans).toBe(1);
  });

  test("non-2xx HTTP → keeps last-known, does not throw", async () => {
    const fetch = makeFetch({ [STATUS]: { body: freshStatus({ listeners: 7 }) } });
    const poller = new StatusPoller({ fetch });
    await poller.pollOnce();

    fetch.set(STATUS, { ok: false, status: 502 });
    await poller.pollOnce();
    expect(poller.snapshot.listeners).toBe(7); // last-known retained
  });

  test("stale flag — updated older than threshold", async () => {
    const stale = new Date(Date.now() - (STALE_AFTER_MS + 30_000)).toISOString();
    const fetch = makeFetch({
      [STATUS]: { body: freshStatus({ listeners: 5, updated: stale }) },
    });
    const poller = new StatusPoller({ fetch });
    await poller.pollOnce();
    expect(poller.snapshot.stale).toBe(true);
    expect(poller.snapshot.ageMs).toBeGreaterThan(STALE_AFTER_MS);
  });

  test("no data yet → snapshot is the empty default (stale: true)", () => {
    const fetch = makeFetch({});
    const poller = new StatusPoller({ fetch });
    expect(poller.snapshot.status).toBeNull();
    expect(poller.snapshot.stale).toBe(true);
    expect(poller.snapshot.listeners).toBeNull();
  });

  test("log-once-per-error-class — repeated network failures log once", async () => {
    const logs: string[] = [];
    const fetch = makeFetch({ [STATUS]: { throw: new Error("ECONNRESET") } });
    const poller = new StatusPoller({
      fetch,
      log: (_lvl, msg) => logs.push(msg),
    });
    await poller.pollOnce();
    await poller.pollOnce();
    await poller.pollOnce();
    const netLogs = logs.filter((m) => m.includes("fetch failed"));
    expect(netLogs.length).toBe(1); // only the first
  });

  test("successful poll resets the log latch so the next failure logs again", async () => {
    const logs: string[] = [];
    const fetch = makeFetch({});
    const poller = new StatusPoller({ fetch, log: (_lvl, msg) => logs.push(msg) });

    fetch.set(STATUS, { throw: new Error("ECONNRESET") });
    await poller.pollOnce();
    fetch.set(STATUS, { body: freshStatus({ listeners: 1 }) });
    await poller.pollOnce(); // recovery resets latch
    fetch.set(STATUS, { throw: new Error("ECONNRESET") });
    await poller.pollOnce();

    const netLogs = logs.filter((m) => m.includes("fetch failed"));
    expect(netLogs.length).toBe(2);
  });

  test("start() schedules the 15s cadence + fires first GET immediately", async () => {
    const fetch = makeFetch({ [STATUS]: { body: freshStatus({ listeners: 1 }) } });
    const poller = new StatusPoller({ fetch, pollIntervalMs: 25 });
    poller.start();
    await poller.idle(); // first poll resolves
    expect(fetch.calls[STATUS]).toBeGreaterThanOrEqual(1);
    poller.stop();
  });
});
