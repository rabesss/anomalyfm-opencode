import { test, expect } from "bun:test";
import { resolveOptions, DEFAULTS, MIN_POLL_INTERVAL_MS } from "../src/config.ts";

test("defaults applied for empty / non-object input", () => {
  for (const input of [undefined, null, "string", 42]) {
    const o = resolveOptions(input);
    expect(o.pollIntervalMs).toBe(DEFAULTS.pollIntervalMs);
    expect(o.streamUrl).toBe(DEFAULTS.streamUrl);
    expect(o.statusUrl).toBe(DEFAULTS.statusUrl);
  }
});

test("valid http(s) URLs pass through", () => {
  const o = resolveOptions({
    streamUrl: "http://localhost:8000/radio",
    statusUrl: "https://example.com/feed/status.json",
  });
  expect(o.streamUrl).toBe("http://localhost:8000/radio");
  expect(o.statusUrl).toBe("https://example.com/feed/status.json");
});

test("surrounding whitespace/control chars are normalized away via href", () => {
  // new URL() strips leading/trailing whitespace + embedded tab/newline for
  // parsing only; returning the raw input would let those reach mpv. href
  // returns the cleaned form.
  expect(resolveOptions({ streamUrl: "  https://anomaly.fm/radio  " }).streamUrl).toBe(
    "https://anomaly.fm/radio",
  );
  expect(resolveOptions({ streamUrl: "https://anomaly.fm/\tradio" }).streamUrl).toBe(
    "https://anomaly.fm/radio",
  );
});

test("non-http(s) streamUrl falls back to default (mpv flag-injection guard)", () => {
  // A streamUrl beginning with "--" would be read as an mpv option without the
  // "--" argv separator + this validation; both defenses reject it.
  expect(resolveOptions({ streamUrl: "--malicious-flag" }).streamUrl).toBe(DEFAULTS.streamUrl);
  expect(resolveOptions({ streamUrl: "ftp://host/radio" }).streamUrl).toBe(DEFAULTS.streamUrl);
  expect(resolveOptions({ streamUrl: "not a url" }).streamUrl).toBe(DEFAULTS.streamUrl);
  expect(resolveOptions({ streamUrl: "" }).streamUrl).toBe(DEFAULTS.streamUrl);
});

test("non-http(s) statusUrl falls back to default", () => {
  expect(resolveOptions({ statusUrl: "file:///etc/passwd" }).statusUrl).toBe(DEFAULTS.statusUrl);
  expect(resolveOptions({ statusUrl: "javascript:alert(1)" }).statusUrl).toBe(DEFAULTS.statusUrl);
});

test("pollIntervalMs is floored at the minimum", () => {
  expect(resolveOptions({ pollIntervalMs: 100 }).pollIntervalMs).toBe(MIN_POLL_INTERVAL_MS);
  expect(resolveOptions({ pollIntervalMs: 1 }).pollIntervalMs).toBe(MIN_POLL_INTERVAL_MS);
  expect(resolveOptions({ pollIntervalMs: MIN_POLL_INTERVAL_MS }).pollIntervalMs).toBe(MIN_POLL_INTERVAL_MS);
});

test("a valid pollIntervalMs above the floor passes through", () => {
  expect(resolveOptions({ pollIntervalMs: 5000 }).pollIntervalMs).toBe(5000);
});

test("non-finite / non-number pollIntervalMs falls back to default", () => {
  expect(resolveOptions({ pollIntervalMs: NaN }).pollIntervalMs).toBe(DEFAULTS.pollIntervalMs);
  expect(resolveOptions({ pollIntervalMs: Infinity }).pollIntervalMs).toBe(DEFAULTS.pollIntervalMs);
  expect(resolveOptions({ pollIntervalMs: "15000" }).pollIntervalMs).toBe(DEFAULTS.pollIntervalMs);
});
