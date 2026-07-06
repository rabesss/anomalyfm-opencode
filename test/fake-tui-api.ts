/**
 * A minimal fake of opencode's `TuiPluginApi` for the plugin integration test
 * (test/plugin.test.ts). It implements ONLY the surface that `src/index.tsx`
 * actually touches — `renderer.terminalWidth`, `slots.register`,
 * `keymap.registerLayer`, `lifecycle.onDispose` — and records each call so the
 * test can assert on the wiring (slot registered with `order: 1000`,
 * `radio.toggle` command present, dispose fn installed).
 *
 * `lifecycle.signal` is a real `AbortSignal` (the plugin never reads it, but it
 * is on the `TuiLifecycle` type, tui.d.ts:413-416). `onDispose` collects the
 * teardown callbacks; `_runDispose()` invokes them in registration order to
 * simulate plugin unload.
 *
 * NOT a general-purpose opencode mock: extend it only if `tui()` grows new
 * surface. The real types live in `@opencode-ai/plugin/tui`.
 */

/** The recorded `slots.register` payload: { order, slots: { app_bottom } }. */
export interface RecordedSlot {
  order?: number;
  slots: Record<string, unknown>;
}

/** The recorded `keymap.registerLayer` payload. */
export interface RecordedKeymapLayer {
  commands: Array<{ name: string; run: (ctx?: unknown) => unknown }>;
  bindings?: Array<{ key: string; cmd?: string; desc?: string }>;
}

export interface FakeTuiApi {
  /** The only renderer property the slot render reads (live, each render). */
  renderer: { terminalWidth: number };
  slots: { register(plugin: RecordedSlot): string };
  keymap: { registerLayer(layer: RecordedKeymapLayer): () => void };
  lifecycle: {
    readonly signal: AbortSignal;
    onDispose(fn: () => void | Promise<void>): () => void;
  };
  /** Inspection surface for assertions. */
  readonly _recorded: {
    slots: RecordedSlot[];
    keymapLayers: RecordedKeymapLayer[];
    disposeFns: Array<() => void | Promise<void>>;
  };
  /** Invoke every registered onDispose fn, in order (simulate unload). */
  _runDispose(): void;
}

export function fakeTuiApi(): FakeTuiApi {
  const slots: RecordedSlot[] = [];
  const keymapLayers: RecordedKeymapLayer[] = [];
  const disposeFns: Array<() => void | Promise<void>> = [];

  return {
    renderer: { terminalWidth: 80 },
    slots: {
      // opencode returns a string id from register(); mirror that contract.
      register(plugin: RecordedSlot): string {
        slots.push(plugin);
        return "slot-anomalyfm";
      },
    },
    keymap: {
      // registerLayer returns a disposer; the plugin captures + calls it on
      // teardown. The fake's disposer is a no-op (the real one unregisters the
      // layer, which we don't need to model).
      registerLayer(layer: RecordedKeymapLayer): () => void {
        keymapLayers.push(layer);
        return () => {};
      },
    },
    lifecycle: {
      signal: new AbortController().signal,
      onDispose(fn: () => void | Promise<void>): () => void {
        disposeFns.push(fn);
        return () => {};
      },
    },
    get _recorded() {
      return { slots, keymapLayers, disposeFns };
    },
    _runDispose(): void {
      for (const fn of disposeFns) fn();
    },
  };
}
