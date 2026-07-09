# anomalyfm-opencode

An [opencode](https://opencode.ai) TUI plugin that tunes in to [anomaly.fm](https://anomaly.fm) — a statusline showing who's on air, plus audio playback through `mpv`.

```
◆ anomaly.fm · ON AIR · ryan · 12 live · ▶
```

## What it does

A thin line at the bottom of your opencode session reflects the station's own state:

- **ON AIR** — someone is in the Discord booth
- **RERUN** — a past session is replaying
- **INTERMISSION** — the bot is up but the booth is empty (music through the static)
- **OFF AIR** — otherwise

Listener count is the combined web + YouTube audience.

Audio plays through `mpv`. Toggling playback off **truly pauses** — the `mpv` process is killed and the stream socket closed, so a paused radio costs zero CPU and zero bandwidth. If `mpv` isn't installed the statusline still works (with a `⚠` glyph); open `https://anomaly.fm` in a browser to listen.

## Requirements

- opencode **1.17.13** (the plugin pins `engines.opencode` to `>=1.17.13 <1.18.0`)
- Bun ≥ 1.3.14 (opencode's runtime)
- `mpv` on `$PATH` (optional — enables audio)

## Install

Not published to npm — install a pinned release straight from GitHub. `opencode plugin` clones it, reads the plugin manifest, installs the package into opencode's config dir, and adds the entry to `tui.json` for you. (At runtime opencode provides the host packages — `@opencode-ai/plugin`, `@opentui/solid`, `solid-js`.)

```bash
# user-wide (global config):
opencode plugin -g github:rabesss/anomalyfm-opencode#v0.2.0
# per-project (.opencode/tui.json):
opencode plugin    github:rabesss/anomalyfm-opencode#v0.2.0
```

Pin to a tag so a checkout never tracks moving `master`. To move to a later release, change the tag and re-run.

<details>
<summary>Offline / no package machinery — local path in <code>tui.json</code></summary>

If you'd rather not use the installer, clone the release and point `tui.json` at the directory with an absolute path or `file://` URL (opencode does no `~` expansion):

```bash
git clone --branch v0.2.0 https://github.com/rabesss/anomalyfm-opencode /home/you/src/anomalyfm-opencode
```

```jsonc
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["file:///home/you/src/anomalyfm-opencode"]
}
```

Update by fetching tags and checking out a newer release (a tag checkout is a detached HEAD, so plain `git pull` won't move it): `git fetch --tags && git checkout v0.2.1`.

</details>

## Trigger playback

Open the command palette with **`Ctrl+P`**, search **"anomaly"**, and select **anomaly.fm: toggle playback** to tune in. Select it again to pause. The statusline glyph flips `⏸ → ▶` while playing and `▶ → ⏸` when paused.

The plugin only adds a palette entry — it doesn't rebind or remove any of your existing shortcuts. opencode's `tui.json` `keybinds` schema accepts only built-in action names, so a direct chord isn't possible from config; a dedicated keybinding would require a `bindings` entry in the plugin's own keymap layer.

## Options

Pass options as a `[spec, options]` tuple in `tui.json` — the `spec` must match the entry `opencode plugin` recorded (for a GitHub install that's the full spec):

```jsonc
{
  "plugin": [["github:rabesss/anomalyfm-opencode#v0.2.0", { "pollIntervalMs": 30000 }]]
}
```

| Option           | Default                                  | Description                                                  |
| ---------------- | ---------------------------------------- | ------------------------------------------------------------ |
| `pollIntervalMs` | `15000`                                  | How often to refresh the statusline (floored at 1000ms).     |
| `streamUrl`      | `https://anomaly.fm/radio`               | Override the stream URL (must be `http(s):`).                |
| `statusUrl`      | `https://anomaly.fm/feed/status.json`    | Override the status endpoint (must be `http(s):`).           |

## Development

```bash
bun install
bun test ./test        # unit suite (no network / no mpv)
bun x tsc --noEmit     # typecheck
```

The pause contract is verified manually — it needs a live opencode pid, network, and `mpv`:

```bash
bun run verify-pause
```

Samples CPU/RAM/network across three windows (start-paused / playing / paused-after) and asserts the paused-after window matches the start-paused baseline with zero stream bytes/sec.
