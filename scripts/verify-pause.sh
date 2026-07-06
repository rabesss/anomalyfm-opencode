#!/usr/bin/env bash
# scripts/verify-pause.sh — proves the TRUE-PAUSE resource contract for the
# anomaly.fm opencode plugin. Thin wrapper around scripts/verify-pause.ts.
#
# Usage:
#   bash scripts/verify-pause.sh [opencode-pid]
#   npm run verify-pause                 # auto-discovers the opencode pid
#   WINDOW_SEC=10 SAMPLE_HZ=2 bash scripts/verify-pause.sh <pid>
#
# If no pid is passed, the host is auto-discovered via
#   pgrep -af opencode | grep -v verify-pause | grep -v grep | head -1
#
# ---------------------------------------------------------------------------
# PASS CONDITION (true-pause contract). Window C (paused-after-playing) MUST
# show:
#   (a) no mpv process   — the mpv child must have been SIGKILL'd.
#   (b) zero TCP bytes/sec to anomaly.fm (161.210.92.14). Tolerance 256 B/s
#       avg to allow the status-JSON keep-alive poll (status JSON polling IS
#       allowed in both A and C — it is non-streaming and well under 256 B/s).
#   (c) host opencode process RSS/CPU within noise of Window A's baseline:
#         |rss_C_avg − rss_A_avg| < 5 MB (5120 KiB)
#         |cpu_C_avg − cpu_A_avg| < 0.5 % (absolute)
#
# Exit code 0 = contract holds, 1 = violated, 2 = environment/prereq error.
# Run with mpv installed and an audio device available. Not in CI
# (needs network + audio + a live opencode plugin instance).
#
# Sanity (no real opencode needed):
#   SANITY=1 bash scripts/verify-pause.sh $$   # auto-runs 3 short windows vs $$.
# ---------------------------------------------------------------------------

set -euo pipefail

# Locate repo root (this script lives in scripts/).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Hand control to the TS sampler. SANITY=1 makes it skip the Enter-prompted
# operator handoff so it can be smoke-run against any pid (e.g. $$).
exec bun run "${SCRIPT_DIR}/verify-pause.ts" "$@"
