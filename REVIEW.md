# REVIEW.md

Shared review standard for `rabesss/anomalyfm-opencode`. Kilo Code Reviews reads
this file from the **base branch**; CodeRabbit and Pullfrog ingest it via
`AGENTS.md` / their own configs. One source of truth — the tool-specific files
point here, they don't duplicate policy.

## What this repository is

An opencode TUI plugin (default-exports `{ id, tui }`) that renders the
anomaly.fm station status into opencode's `app_bottom` slot and plays the live
Icecast MP3 stream via an `mpv` subprocess. Host: opencode v1.17.13 + Bun,
JSX via `@opentui/solid`, reactivity via Solid signals. ~7 source files; small
and deliberate — treat every line as load-bearing until proven otherwise.

## Invariants that must be preserved

- **True-pause is the core contract.** `pause()`/teardown SIGKILLs the mpv
  child and the `_state` must be `PAUSED` on return, with no open `/radio`
  socket and no decode work. A change that leaves mpv alive, draining, or
  consuming CPU while "paused" is a Critical regression — the whole point of
  this plugin is near-zero resource use when paused.
- **mpv must be spawned with `--no-terminal`.** This silences the ~14
  progress-lines/sec stdout spam that an earlier design parsed in the JS event
  loop (~35% sustained host CPU). Playback is detected by **liveness** (mpv
  alive past the settle window → `PLAYING`), not stdout parsing. Do not
  reintroduce stdout/stderr parsing or `--msg-level` verbosity.
- **`renderLine` output strings are the pinned spec.** `test/statusline.test.ts`
  pins the exact copy (`◆ anomaly.fm · ON AIR · <host> · <n> live · <glyph>`,
  the `RERUN: <label>` form, the `? live` fallback, the trailing-glyph
  invariant under truncation). Visual restyling belongs in `index.tsx`'s render
  wrapper (bullet/glyph coloring via theme tokens) — never change `renderLine`
  output without updating those tests in the same PR.
- **`radio.toggle` has no default key binding** — it's surfaced through
  opencode's Ctrl+P palette via `namespace: "palette"`. The `tui.json`
  `keybinds` schema is closed to built-in action names; a plugin command can't
  be bound from user config. Don't add a binding in `tui.json`.
- **The `StreamPlayer` interface is the seam.** `RadioController` talks only to
  `play()/pause()/state/error`; the mpv backend is below it. Detection-mechanism
  changes (stdout → liveness, etc.) must not leak above this interface.

## Severity calibration

- **Critical:** breaks true-pause (mpv alive while PAUSED), reintroduces the
  verbose-stdout drain, leaks network sockets/timers on dispose, or changes a
  pinned `renderLine` string without updating its test.
- **Warning:** missing error handling around `Bun.spawn`, a state machine that
  can wedge (e.g. CONNECTING with no path out), untested new branch, theme-token
  lookup that could throw on an unknown token.
- **Do not flag:** formatting (none enforced here yet — don't impose one),
  dependency versions (Dependabot owns these), missing JSDoc on trivial code,
  the `Atomics.wait` busy-reap in `teardownSync` (intentional, bounded, commented).

## Verification expectations

- `bun test` is the gate. New behavior needs a test. Pure helpers
  (`renderLine`, `bulletToken`, `glyphToken`, `deriveAirState`) get unit tests
  with exact-output assertions; the mpv/controller layer gets tests using the
  injectable fake `spawn` / fake player.
- `bun x tsc --noEmit` must be clean. The project uses
  `jsxImportSource: "@opentui/solid"` — JSX intrinsic types (`<text>`, `<span>`)
  come from there, not DOM types.
- A change to resource cost while playing (CPU/RSS/socket count) should be
  measured, not asserted — there's a sampler pattern at
  `/tmp/anomalyfm-monitor/sample.sh` (ephemeral) and `scripts/verify-pause.sh`
  (tracked) for the pause contract.

## Review style

Be concise. Lead with severity. Link the specific line. Don't propose
speculative refactors — this codebase is small and every file has a documented
reason for its shape. If something looks odd, assume it's load-bearing and check
the code comment / test before flagging.

## Agent-maintained review memory

Agents opening PRs update this section only when review history shows a durable
repeated pattern (not one-off commentary). Keep the whole file under 10,000
characters; summarize old bullets rather than growing indefinitely.

- 2026-07-06: The mpv `--no-terminal` + liveness-detection change (PR TBD) was
  driven by a measured ~35%→~1% host-CPU reduction. Flag any reintroduction of
  mpv stdout/stderr parsing, `--msg-level` verbosity, or a continuous JS drain
  loop over mpv output — these regress the exact cost this PR fixed.
