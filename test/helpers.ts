import type { FetchLike } from "../src/types.ts";

/** A fake fetch that serves canned responses per-URL. */
export interface FakeFetch extends FetchLike {
  /** call counts per URL (lowercased). */
  calls: Record<string, number>;
  /** program the next response for a URL. */
  set(url: string, res: FakeResponse): void;
}

export interface FakeResponse {
  ok?: boolean;
  status?: number;
  body?: unknown; // served as JSON; if it's a string, served as-is and json() throws
  jsonThrows?: boolean;
  throw?: Error; // simulate a network failure
}

export function makeFetch(map: Record<string, FakeResponse> = {}): FakeFetch {
  const calls: Record<string, number> = {};
  const responses = new Map<string, FakeResponse>();
  for (const [k, v] of Object.entries(map)) responses.set(k.toLowerCase(), v);

  const f: FakeFetch = Object.assign(
    async (input: string) => {
      const key = input.toLowerCase();
      calls[key] = (calls[key] ?? 0) + 1;
      const r = responses.get(key);
      if (!r) throw new Error(`unexpected fetch ${input}`);
      if (r.throw) throw r.throw;
      const ok = r.ok ?? true;
      const status = r.status ?? (ok ? 200 : 500);
      return {
        ok,
        status,
        json: async () => {
          if (r.jsonThrows) throw new Error("malformed json");
          if (typeof r.body === "string") throw new Error("not json");
          return r.body as unknown;
        },
        text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)),
      };
    },
    {
      calls,
      set(url: string, res: FakeResponse) {
        responses.set(url.toLowerCase(), res);
      },
    },
  );
  return f;
}

/** A status.json payload with a freshness-controllable `updated`. */
export function freshStatus(over: Partial<Record<string, unknown>> = {}): unknown {
  return {
    station: "anomaly.fm",
    live: false,
    humans: 0,
    members: [],
    memberIds: [],
    rerun: null,
    listeners: null,
    sources: { web: null, youtube: null },
    updated: new Date().toISOString(),
    ...over,
  };
}
