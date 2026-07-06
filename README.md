# anomalyfm-opencode

An [opencode](https://opencode.ai) TUI plugin that tunes in to [anomaly.fm](https://anomaly.fm) — a statusline showing who's on air, plus audio playback via mpv.

## What you get

A thin line at the bottom of your opencode session:

    ◆ anomaly.fm · ON AIR · ryan · 12 live · ▶

Status reflects the station's own state: **ON AIR** when someone's in the Discord booth, **RERUN** when a past session replays, **INTERMISSION** (music through the static) when the bot is up but the booth is empty, **OFF AIR** otherwise. Listener count is the combined web + YouTube audience.

Audio plays via `mpv` (the same engine serious internet-radio clients use). Hitting `radio.toggle` again **truly pauses** — the mpv process is killed and the stream socket closed, so a paused radio costs zero CPU and zero bandwidth. If `mpv` isn't installed, the statusline still works (with a `⚠` glyph); open `https://anomaly.fm` in a browser to listen.

## Requirements

- opencode **v1.17.x** (developed against `1.17.13`)
- Bun ≥ 1.3 (opencode's runtime)
- `mpv` on `$PATH` (optional — enables audio)

## Install

In your opencode config directory, edit `tui.json` (create it if absent):

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "anomalyfm-opencode"
  ]
}
```

Or install via opencode's plugin manager:

```
:plugins install anomalyfm-opencode
```

## Trigger playback

Press **`leader>f`** (mnemonic: radio **f**requency) to tune in. Press it again to pause. The statusline glyph flips `⏸ → ▶` while playing and `▶ → ⏸` when paused.

> **Why a plugin-side binding?** opencode's `tui.json` `keybinds` section accepts only the built-in action names from its closed schema (e.g. `app_exit`, `command_list`, `session_new`) — an entry like `"radio.toggle"` would be silently dropped at startup as an unknown key. So the binding is wired into the plugin itself (via `api.keymap.registerLayer`'s `bindings` field). `leader>f` was chosen to avoid colliding with opencode's built-in leader chords (`1-9, a, b, c, e, g, h, l, m, n, q, r, s, t, u, x, y`).

## Options

Pass options as a `[spec, options]` tuple in `tui.json`:

```json
{
  "plugin": [
    ["anomalyfm-opencode", { "pollIntervalMs": 30000 }]
  ]
}
```

| Option | Default | Description |
|---|---|---|
| `pollIntervalMs` | `15000` | How often to refresh the statusline (matches the reference web player). |
| `streamUrl` | `https://anomaly.fm/radio` | Override the stream URL. |
| `statusUrl` | `https://anomaly.fm/feed/status.json` | Override the status endpoint. |

## Verify pause is true pause

```bash
bun run verify-pause
```

Samples CPU/RAM/network across three windows (start-paused / playing / paused-after) and asserts the paused-after window matches the start-paused baseline with zero stream bytes/sec.
