/**
 * Plugin entry — the one opencode-coupled file. Default-exports
 * `{ id, tui }`, where `tui()` mounts the statusline in opencode's
 * `app_bottom` slot, registers the `radio.toggle` keymap command, wires the
 * StatusPoller → RadioController → MpvStreamPlayer (with a NoAudio fallback),
 * and disposes all of it via `api.lifecycle.onDispose`.
 *
 * This module is verified against the installed @opencode-ai/plugin@1.17.13
 * types (node_modules/@opencode-ai/plugin/dist/tui.d.ts) and the @opentui/solid
 * 0.4.3 JSX runtime — it must typecheck cleanly against those (see Task 4
 * report). It does NOT depend on actually loading inside opencode; that's Task 8.
 *
 * Re-render model: the slot render function runs inside a Solid reactive owner
 * (opencode's @opentui/solid reconciler sets up a root per slot). Reading the
 * `snapshot`/`controllerState` signal accessors inside the JSX establishes a
 * dependency, so Solid re-renders the <text> element automatically whenever the
 * poller or controller updates them. No manual invalidate/requestRender needed.
 */

import { createSignal } from "solid-js";

import { StatusPoller, type StatusSnapshot } from "./poller.ts";
import { RadioController, type ControllerState } from "./controller.ts";
import { MpvStreamPlayer } from "./mpv-player.ts";
import { NoAudioStreamPlayer } from "./player.ts";
import { renderLine, bulletToken, glyphToken, type StatusToken } from "./statusline.tsx";
import { resolveOptions } from "./config.ts";

// Ambient opencode plugin types come from the @opencode-ai/plugin peer dep,
// which provides the host context at runtime. Importing the precise types keeps
// the contract pinned to the installed package version.
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginMeta,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui";
import type { PluginOptions } from "@opencode-ai/plugin";
import type { StreamPlayer } from "./player.ts";

const ID = "anomalyfm";

/**
 * Left indent (columns) for the statusline. Aligns the line with opencode's chat
 * input box content padding rather than the terminal's col 0, so the statusline
 * reads as part of the same UI system as the chat area instead of a stray strip
 * hugging the left edge. Measured against opencode v1.17.13: the input box's
 * "Ask anything..." text starts at col 7; with no indent our line starts at col 1.
 */
const INDENT_COLS = 6;

/**
 * Pick the audio backend: mpv if its binary is on PATH (detected eagerly inside
 * the constructor), otherwise the statusline-only no-op player. Constructing
 * MpvStreamPlayer never throws — the UNSUPPORTED state is set internally — but
 * the try/catch is belt-and-suspenders for any unexpected construction error.
 *
 * CORRECTION #2 vs. the brief: the real MpvStreamPlayer option is `url`
 * (src/mpv-player.ts:137), NOT `streamUrl`.
 */
async function pickPlayer(streamUrl: string): Promise<StreamPlayer> {
  try {
    return new MpvStreamPlayer({ url: streamUrl });
  } catch {
    return new NoAudioStreamPlayer();
  }
}

const plugin: TuiPluginModule = {
  id: ID,
  async tui(api: TuiPluginApi, options: PluginOptions | undefined, _meta: TuiPluginMeta): Promise<void> {
    const opts = resolveOptions(options);

    // --- reactive state read by the slot render ---
    // The slot's JSX reads these accessors, so updates here trigger a
    // re-render of the statusline. The signals live in whatever reactive owner
    // opencode runs the `tui()` call under; the @opentui/solid reconciler
    // establishes a per-slot reactive root, and reading the accessors inside
    // the slot render is what wires the dependency.
    const [getSnapshot, setSnapshot] = createSignal<StatusSnapshot | null>(null);
    const [getControllerState, setControllerState] = createSignal<ControllerState>("PAUSED");
    // The width is read live from the renderer on each render (terminal may
    // resize), so it stays a plain read rather than a signal.
    const width = () => api.renderer?.terminalWidth ?? process.stdout.columns ?? 80;

    // --- construct the units ---
    const poller = new StatusPoller({
      pollIntervalMs: opts.pollIntervalMs,
      statusUrl: opts.statusUrl,
      onUpdate: (snap) => setSnapshot(snap),
    });

    const player = await pickPlayer(opts.streamUrl);
    const controller = new RadioController(player, {
      onState: (s) => setControllerState(s),
    });

    // --- register the statusline slot (app_bottom, order 1000) ---
    // CORRECTION #3 vs. the brief: TuiSlotPlugin is Omit<SolidPlugin,"id"> &
    // { id?: never } (tui.d.ts:398-400), so the registration object must NOT
    // carry an `id` — opencode assigns one internally and returns it.
    //
    // Coloring: renderLine returns a flat string, but its shape is guaranteed —
    // first char is always `◆`, last two are always ` ` + glyph (see truncate).
    // We exploit that to paint three colored chunks via nested <span> children
    // inside one <text>: the bullet (accent only when ON AIR, else muted), the
    // body (always muted), and the glyph (warning on ERROR/UNSUPPORTED, else
    // muted). Colors come from api.theme.current (live RGBA per the user's
    // selected theme — no hardcoded hex), read lazily inside the render so a
    // theme switch is picked up on the next poll/state change. Left-aligned: a
    // status bar belongs at the left edge; wrapping in a
    // <box justifyContent="flex-end"> would float it off into empty space.
    //
    // IMPLEMENTATION NOTE: the color MUST go via `style={{ fg }}`, not a bare
    // `fg={...}` prop. The @opentui/solid reconciler silently drops `fg` on a
    // <span> (isTextNodeRenderable early-return) and `SpanProps`'s TS type
    // doesn't enumerate it either — but the `style` handler runs the span's
    // fg through parseColor and renders correctly. Don't "simplify" this to
    // <span fg={...}>; it will both fail tsc and render uncolored at runtime.
    // And never use <text content={StyledText}>: the reconciler's `content`
    // case coerces via template string, and StyledText has no toString(), so
    // it renders the literal "[object Object]".
    api.slots.register({
      order: 1000,
      slots: {
        app_bottom: () => {
          const snap = getSnapshot()?.status ?? null;
          const state = getControllerState();
          // Left-indent the statusline so it aligns with opencode's chat input
          // box content (the rounded-border padding), not the terminal's col 0.
          // Measured: the input box's "Ask anything..." text starts at col 7;
          // our raw line renders at col 1, so a 6-space indent lands us under
          // it. The indent is subtracted from renderLine's width budget so the
          // truncation invariant (preserve bullet + trailing glyph) still holds
          // and the line never overflows on a narrow terminal.
          const line = renderLine(snap, state, width() - INDENT_COLS);
          const cur = api.theme.current;
          const resolve = (tok: StatusToken) => cur[tok];
          const indent = " ".repeat(INDENT_COLS);
          return (
            <text>
              <span style={{ fg: cur.textMuted }}>{indent}</span>
              <span style={{ fg: resolve(bulletToken(snap)) }}>{line[0]}</span>
              <span style={{ fg: cur.textMuted }}>{line.slice(1, -1)}</span>
              <span style={{ fg: resolve(glyphToken(state)) }}>{line[line.length - 1]}</span>
            </text>
          );
        },
      },
    });

    // --- register the radio.toggle keymap command (appears in the Ctrl+P palette) ---
    // The command is surfaced in opencode's existing command palette (Ctrl+P) via
    // `namespace: "palette"` — the filter the palette queries with. No default
    // key binding: the user invokes through the palette (search "anomaly", Enter),
    // which adds an entry without removing or rebinding any existing palette item.
    // tui.json's top-level `keybinds` schema is closed to built-in names, so a
    // dedicated chord (if ever wanted) would also have to be wired here, not in
    // user config.
    const disposeKeymap = api.keymap.registerLayer({
      commands: [
        {
          name: "radio.toggle",
          namespace: "palette",
          title: "anomaly.fm: toggle playback",
          desc: "Tune in to / pause anomaly.fm",
          category: "anomaly.fm",
          run: () => {
            void controller.toggle();
          },
        },
      ],
    });

    // --- start the poller (audio stays PAUSED until the first toggle) ---
    poller.start();

    // --- teardown ---
    // The slot registration auto-disposes with the plugin; the keymap layer and
    // the poller/controller we own and must stop ourselves. CORRECTION #1 vs.
    // the brief: the real StatusPoller API is start()/stop() — there is no
    // dispose() (src/poller.ts:90,101).
    api.lifecycle.onDispose(() => {
      disposeKeymap();
      controller.dispose(); // stops the player, cancels retry + watchdog
      poller.stop(); // clears the interval; in-flight fetch is left to settle
    });
  },
};

export default plugin;
