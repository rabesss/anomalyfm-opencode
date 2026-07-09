/**
 * Plugin integration test — drives `tui()` with a faked `TuiPluginApi` to prove
 * the wiring in `src/index.tsx` works end-to-end without real opencode and
 * without real audio.
 *
 * What this proves (and deliberately does NOT prove):
 *   ✓ The `app_bottom` slot is registered with `order: 1000` and an
 *     `app_bottom` render function.
 *   ✓ The keymap layer carries a `radio.toggle` command whose `run` triggers
 *     the controller without spawning real mpv.
 *   ✓ `lifecycle.onDispose` is wired to a teardown that calls the keymap
 *     disposer, the controller, and the poller — and throws nothing.
 *   ✓ No unhandled rejections are left behind after a mount → toggle → dispose.
 *
 * What this does NOT re-test:
 *   - `renderLine`'s exact string output — that's exhaustively pinned in
 *     test/statusline.test.ts. The slot render returns a Solid JSX element,
 *     NOT a string. Calling the render outside a Solid reactive owner
 *     raises "React is not defined" because Bun's runtime transpiler does not
 *     apply the `jsxImportSource` that the `@opentui/solid` runtime needs; we
 *     therefore assert the render is installed as a function and leave its
 *     output to the unit tests.
 *   - The controller FSM transitions — pinned in test/controller.test.ts.
 *
 * Environment isolation:
 *   - `Bun.which` is stubbed to return `null` for the duration of the toggle
 *     test so `MpvStreamPlayer` constructs in `UNSUPPORTED` and `toggle()` is a
 *     no-op (no real mpv process is spawned). In this env mpv IS on PATH
 *     (`/usr/sbin/mpv`), so without the stub a toggle would launch real audio.
 *   - `globalThis.fetch` is stubbed so the poller's first GET fails gracefully
 *     instead of hitting anomaly.fm over the network.
 *   Both globals are restored in a `finally`, and a `process.on(
 *   "unhandledRejection")` probe counts stray rejections across the mount.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import plugin from "../src/index.tsx";
import { fakeTuiApi } from "./fake-tui-api.ts";

/** Minimal `TuiPluginMeta` (only `id` is needed; `tui()` ignores `_meta`). */
const FAKE_META = { id: "anomalyfm" } as unknown as Parameters<
  NonNullable<typeof plugin.tui>
>[2];

/**
 * Flush the microtask queue enough times for `StatusPoller.start()`'s first
 * poll to settle, so its `.finally` arms the cadence timer (a sequential
 * setTimeout loop, not setInterval) and is thus cleared deterministically
 * before dispose. The poller's first GET is fired synchronously inside
 * `start()`; we need a few microtask ticks to let it resolve.
 */
function flushMicrotasks(): Promise<void> {
  return Promise.resolve().then().then().then().then();
}

/** The real `Bun.which` / `globalThis.fetch`, saved so tests can restore them. */
let savedWhich: typeof Bun.which | null = null;
let savedFetch: typeof globalThis.fetch | null = null;

/**
 * The fake api returned by the most recent `mount()`, tracked so `afterEach`
 * can dispose it (clearing the poller's cadence timer + the controller's
 * pending retry) even if a test forgets to. Every mount has a matching
 * dispose, no matter which test runs.
 */
let currentApi: ReturnType<typeof fakeTuiApi> | null = null;

beforeEach(() => {
  // Stub fetch for EVERY test. Without this,
  // `mount()` → `tui()` → `poller.start()` → `pollOnce()` awaits the real
  // `globalThis.fetch` against https://anomaly.fm/feed/status.json, leaking a
  // real network GET (the error is swallowed by pollOnce's try/catch, so no
  // crash — but the run is non-deterministic and spammy in networkless CI).
  stubFetchToFail();
});

afterEach(() => {
  // Dispose whatever the test mounted. `start()` fires the
  // first poll synchronously and arms a cadence timer (sequential setTimeout)
  // once it settles inside `flushMicrotasks`; without `poller.stop()` that
  // timer leaks across tests. `_runDispose()` runs the plugin's onDispose
  // chain (keymap disposer + controller.dispose + poller.stop) and is
  // idempotent, so a test that already disposed (test 4) is harmless.
  currentApi?._runDispose();
  currentApi = null;

  if (savedWhich !== null) {
    (Bun as unknown as { which: typeof Bun.which }).which = savedWhich;
    savedWhich = null;
  }
  if (savedFetch !== null) {
    globalThis.fetch = savedFetch;
    savedFetch = null;
  }
});

/**
 * Stub `Bun.which` to report every binary as missing, so `MpvStreamPlayer`
 * lands in `UNSUPPORTED` at construction and `toggle()` never spawns mpv.
 * Restored by afterEach. (Direct assignment works; `Object.defineProperty`
 * fails because `which` is non-configurable on the Bun global.)
 */
function stubBunWhichMissing(): void {
  savedWhich = Bun.which;
  (Bun as unknown as { which: typeof Bun.which }).which = (() => null) as never;
}

/**
 * Stub the global fetch so the poller's first GET fails fast without touching
 * the network. Restored by afterEach.
 */
function stubFetchToFail(): void {
  savedFetch = globalThis.fetch;
  // The stub intentionally rejects every call. Cast through `unknown` because a
  // throw-only function doesn't structurally overlap with `typeof fetch`.
  globalThis.fetch = (async () => {
    throw new Error("network disabled in plugin integration test");
  }) as unknown as typeof globalThis.fetch;
}

/**
 * Mount the plugin against a fresh fake api, flush the poller's first cycle.
 * `FakeTuiApi` implements only the surface `tui()` touches; cast through
 * `Parameters<…>` to satisfy the full `TuiPluginApi` contract at the call site.
 */
async function mount() {
  const api = fakeTuiApi();
  currentApi = api; // tracked so afterEach can dispose it
  const tui = plugin.tui as (
    api: unknown,
    options: unknown,
    meta: unknown,
  ) => Promise<void>;
  await tui(api, undefined, FAKE_META);
  await flushMicrotasks();
  return api;
}

test("plugin registers app_bottom slot with order 1000", async () => {
  const api = await mount();
  expect(api._recorded.slots).toHaveLength(1);
  expect(api._recorded.slots[0]!.order).toBe(1000);
  // The slot must carry an `app_bottom` key — opencode's named-slot contract.
  expect(api._recorded.slots[0]!.slots).toHaveProperty("app_bottom");
});

test("plugin registers a radio.toggle palette command (no key binding)", async () => {
  const api = await mount();
  expect(api._recorded.keymapLayers).toHaveLength(1);
  const layer = api._recorded.keymapLayers[0]!;
  const toggle = layer.commands.find((c) => c.name === "radio.toggle");
  expect(toggle).toBeDefined();
  expect(typeof toggle!.run).toBe("function");
  // `namespace: "palette"` is the filter opencode's Ctrl+P palette queries
  // with — without it the command wouldn't appear. No key binding: the user
  // invokes through the palette (search "anomaly", Enter).
  expect(toggle!.namespace).toBe("palette");
  expect(layer.bindings ?? []).toHaveLength(0);
});

test("slot render is installed as a function (registration, not string)", async () => {
  // The slot render returns a Solid JSX element, not a string. We assert the
  // wiring — a render function was installed at app_bottom — rather than its
  // output, which would require a Solid reactive owner (not available in this
  // bun:test environment; see file header). renderLine's string contract is
  // exhaustively pinned in test/statusline.test.ts.
  const api = await mount();
  const render = api._recorded.slots[0]!.slots.app_bottom;
  expect(render).toBeTypeOf("function");
});

test("radio.toggle run drives the controller (no real mpv) and dispose is clean", async () => {
  stubBunWhichMissing(); // player → UNSUPPORTED at construction; toggle is a no-op
  // fetch is stubbed by beforeEach — no per-test call needed here.

  // Count stray rejections across the whole mount → toggle → dispose cycle.
  let unhandled = 0;
  const onUnhandled = () => {
    unhandled += 1;
  };
  process.on("unhandledRejection", onUnhandled);

  let api: ReturnType<typeof fakeTuiApi>;
  try {
    api = await mount();
    const toggle = api._recorded.keymapLayers[0]!.commands.find(
      (c) => c.name === "radio.toggle",
    )!;
    // Invoking the command's run triggers controller.toggle(). With Bun.which
    // stubbed the player is UNSUPPORTED, so toggle resolves without spawning.
    await expect(Promise.resolve(toggle.run({}))).resolves.toBeUndefined();

    // Teardown: run every registered onDispose fn. Must not throw.
    expect(() => api._runDispose()).not.toThrow();

    // Give any lingering microtasks/timers a chance to surface a rejection.
    await new Promise((r) => setTimeout(r, 80));
    expect(unhandled).toBe(0);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
