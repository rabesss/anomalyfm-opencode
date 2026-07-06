# AGENTS.md

Hub for AI coding/review agents working on `rabesss/anomalyfm-opencode`. Read by
**OpenAI Codex, Jules, Devin, Pullfrog, Kilo Code Reviews**; ingested as a
guideline by **CodeRabbit**. The review *policy* lives in [`REVIEW.md`](./REVIEW.md)
— this file covers architecture, commands, and the reviewer→config map.

## What this is

An [opencode](https://opencode.ai) v1.17.13 TUI plugin that surfaces the
[anomaly.fm](https://anomaly.fm) internet radio station inside the opencode
terminal UI: a colored one-line status in the `app_bottom` slot plus optional
audio playback of the live Icecast MP3 mount via a child `mpv` process.

- **Runtime:** Bun ≥ 1.3.14. **JSX:** `@opentui/solid` (Zig-native OpenTUI + Solid
  bindings). **Reactivity:** Solid `createSignal` accessors read inside the slot
  render; opencode's reconciler re-renders on change.
- **Audio:** `mpv` subprocess, spawned with `--no-terminal`. Playback detected by
  liveness (mpv survives a settle window → `PLAYING`); never by parsing stdout.
  Pause = SIGKILL + bounded reap. Falls back to `NoAudioStreamPlayer` (statusline
  only) when `mpv` isn't on `PATH`.

## Architecture (data flow)

```
StatusPoller ──(15s)──▶ StatusSnapshot ──▶ renderLine() ──▶ <text> (app_bottom slot)
   https://anomaly.fm/feed/status.json           │                  ▲
                                                 ▼                  │
                                          deriveAirState()    bulletToken/glyphToken
                                          (ON_AIR/RERUN/       (theme-token names)
                                           INTERMISSION/OFF_AIR)

RadioController ──▶ MpvStreamPlayer ──▶ child `mpv --no-terminal https://anomaly.fm/radio`
   (toggle/FSM)        (StreamPlayer)         │
                                          SIGKILL on pause
```

Key seams:
- **`StreamPlayer` interface** (`src/player.ts`): `play()/pause()/state/error`.
  `RadioController` depends only on this — swap backends below it freely.
- **`renderLine`** (`src/statusline.tsx`): pure `string`-out, no I/O, pinned by
  snapshot tests. Coloring (`bulletToken`/`glyphToken`) returns token *names*
  resolved to RGBA by the host via `api.theme.current`.
- **Plugin entry** (`src/index.tsx`): the one opencode-coupled file. Registers
  the slot + the `radio.toggle` palette command, wires poller→controller→player.

## Commands

```bash
bun test                 # run the full suite (bun:test)
bun x tsc --noEmit       # typecheck — must be clean
bash scripts/verify-pause.sh   # verify the true-pause contract (mpv killed on pause)
```

No build step — opencode loads `src/index.tsx` directly via the `./tui` export.

## Reviewer → config-file map

| Reviewer | Reads from | Config file |
|---|---|---|
| Kilo Code Reviews | **base branch** (`master`) | `REVIEW.md` (this dir, uppercase) |
| CodeRabbit | PR source branch | `.coderabbit.yaml` |
| Qodo Merge / PR-Agent | repo | `.pr_agent.toml` (not configured) |
| Gemini Code Assist | repo | `.gemini/config.yaml` (not configured) |
| Pullfrog | runs in GitHub Actions; honors `AGENTS.md` | dashboard-configured (BYOK) |
| Codex / Jules / Devin | repo | `AGENTS.md` (this file) |

**Branching nuance:** Kilo's `REVIEW.md` must be on `master` to judge a PR, so
review-policy changes land on the base branch first. CodeRabbit's config takes
effect within the same PR.

## Conventions

- **TypeScript:** `strict`, `moduleResolution: "bundler"`,
  `jsxImportSource: "@opentui/solid"`, `allowImportingTsExtensions`.
  Imports use the `.ts`/`.tsx` extension explicitly.
- **Tests:** `bun:test`. Pure helpers get exact-output unit tests; the player/
  controller layers use injectable fakes (`spawn`, fake player, fake clock) — no
  real mpv/network in tests.
- **No secrets in any committed file.** `docs/superpowers/` is gitignored
  internal workflow material and must never be committed.
