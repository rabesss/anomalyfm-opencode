#!/usr/bin/env bun
/**
 * verify-pause.ts — proves the TRUE-PAUSE resource contract for the
 * anomaly.fm opencode plugin, by sampling the opencode host process and its
 * mpv child (if any) across three windows.
 *
 * Usage (normally invoked via the wrapper scripts/verify-pause.sh):
 *   bun run scripts/verify-pause.ts [opencode-pid]
 *
 * If no PID is passed, the host is auto-discovered via:
 *   pgrep -af opencode | grep -v verify-pause | grep -v grep | head -1
 *
 * ---------------------------------------------------------------------------
 * PASS CONDITION (true-pause contract):
 *
 *   Window C (paused-after-playing) MUST show:
 *     (a) no mpv process   — the mpv child must have been SIGKILL'd.
 *     (b) zero TCP bytes/sec to anomaly.fm (IP resolved at startup).
 *     (c) host opencode process RSS/CPU within noise of Window A's baseline.
 *
 *   Concrete "within noise" thresholds:
 *     - RSS delta  |rss_C_avg − rss_A_avg| < 5 MB (5120 KiB)
 *     - CPU delta  |cpu_C_avg − cpu_A_avg| < 0.5 % (absolute)
 *     - Socket     sock_B/s_avg in C ≤ 256 B/s (status JSON keep-alive allowed)
 *
 *   Status JSON polling IS allowed in both A and C (it produces negligible,
 *   non-streaming socket traffic well under 256 B/s when averaged over 30s).
 *
 *   If any of (a)/(b)/(c) fail, the script exits non-zero with a printed
 *   diagnostic. Task 8 runs this end-to-end against a real opencode.
 * ---------------------------------------------------------------------------
 *
 * Sampling mechanics ported verbatim (logic-preserving) from the prototype
 * `backends/mpv/measure.ts`, which already does /proc + ss sampling correctly.
 * The only differences vs the prototype:
 *   - Target is a PID passed as arg (the opencode host) rather than a
 *     self-spawned MpvStreamPlayer.
 *   - The mpv child is discovered per-window via `pgrep -P <host> mpv`
 *     (with a fallback to `pgrep mpv` filtered to descendants).
 *   - The host's own RSS/CPU is ALSO sampled (window A/C host-delta check).
 *   - RSS/CPU deltas are checked across windows A↔C (the contract), not
 *     reported only.
 */

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { lookup } from "node:dns/promises";

const ANOMALY_HOST = "anomaly.fm";
/** anomaly.fm IPs — resolved from DNS at startup (override via ANOMALY_IP env). */
let ANOMALY_IPS: string[] = [];

/** Resolve anomaly.fm's addresses; honor an ANOMALY_IP override (comma-sep). */
async function resolveAnomalyIps(): Promise<string[]> {
  const override = process.env.ANOMALY_IP;
  if (override) return override.split(",").map((s) => s.trim()).filter(Boolean);
  try {
    const res = await lookup(ANOMALY_HOST, { all: true, family: 4 });
    const ips = res.map((r) => r.address).filter(Boolean);
    if (ips.length) return ips;
  } catch {
    // DNS failed — caller decides whether to abort (empty list => no socket match).
  }
  return [];
}
// SANITY=1 (e.g. `SANITY=1 bash scripts/verify-pause.sh $$`) skips the
// operator Enter-prompts between windows AND defaults to short windows so the
// script can be smoke-run against any pid without a real opencode plugin.
const SANITY = process.env.SANITY === "1";
const WINDOW_SEC = Number(
  process.env.WINDOW_SEC ?? (SANITY ? 4 : 30),
);
const SAMPLE_HZ = Number(process.env.SAMPLE_HZ ?? 2);
const SAMPLE_MS = Math.round(1000 / SAMPLE_HZ);

// PASS thresholds — see docstring above.
const PASS_RSS_DELTA_KIB = 5120; // 5 MB
const PASS_CPU_DELTA_PCT = 0.5;
const PASS_C_SOCK_BPS_AVG = 256; // status JSON keep-alive tolerance

const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
const log = (...a: unknown[]) => console.log(`[${ts()}]`, ...a);

interface HostSample {
  t_ms: number;
  window: "A_paused_baseline" | "B_playing" | "C_paused_after";
  host_alive: number;
  host_rss_kib: number;
  host_cpu_pct: number;
  mpv_alive: number;
  mpv_rss_kib: number;
  mpv_cpu_pct: number;
  sock_bytes_per_sec: number;
}
const samples: HostSample[] = [];

// ---------------------------------------------------------------------------
// PID discovery
// ---------------------------------------------------------------------------

/** Find the opencode host PID: arg > env > pgrep. Throws if nothing usable. */
function resolveHostPid(argPid: number | null): number {
  if (argPid && argPid > 0) return argPid;
  const env = process.env.OPENCODE_PID;
  if (env && Number(env) > 0) return Number(env);
  try {
    const r = spawnSync("pgrep", ["-af", "opencode"], { encoding: "utf8" });
    if (r.stdout) {
      for (const line of r.stdout.split("\n")) {
        if (!line.trim()) continue;
        if (line.includes("verify-pause")) continue;
        if (line.includes("grep")) continue;
        const m = line.match(/^(\d+)\s/);
        if (m) {
          log(`resolveHostPid: auto-picked '${line.trim()}'`);
          return Number(m[1]);
        }
      }
    }
  } catch {
    /* ignore */
  }
  throw new Error(
    "verify-pause: no opencode host PID. Start opencode with the anomaly.fm " +
      "plugin loaded, then run: bash scripts/verify-pause.sh <opencode-pid>",
  );
}

/** Find the mpv child of a host pid. Returns null if none. */
function findMpvChild(hostPid: number): number | null {
  // Preferred: direct child via -P (parent).
  try {
    const r = spawnSync("pgrep", ["-P", String(hostPid), "mpv"], {
      encoding: "utf8",
    });
    if (r.stdout) {
      for (const line of r.stdout.split("\n")) {
        const m = line.match(/^(\d+)/);
        if (m) return Number(m[1]);
      }
    }
  } catch {
    /* ignore */
  }
  // Fallback: any mpv whose parent chain reaches hostPid.
  try {
    const r = spawnSync("pgrep", ["mpv"], { encoding: "utf8" });
    if (r.stdout) {
      for (const line of r.stdout.split("\n")) {
        const pid = Number(line);
        if (!pid) continue;
        if (isDescendantOf(pid, hostPid)) return pid;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Walk /proc/<pid>/stat ppid chains to see if `pid` descends from `root`. */
function isDescendantOf(pid: number, root: number): boolean {
  let cur = pid;
  const seen = new Set<number>();
  for (let i = 0; i < 64; i++) {
    if (cur === root) return true;
    if (seen.has(cur)) return false; // cycle guard
    seen.add(cur);
    let ppid = 0;
    try {
      const r = spawnSync("cat", [`/proc/${cur}/stat`], { encoding: "utf8" });
      const txt = r.stdout ?? "";
      const lp = txt.lastIndexOf(")");
      if (lp < 0) return false;
      const f = txt.slice(lp + 2).trim().split(/\s+/);
      ppid = Number(f[1] ?? 0);
    } catch {
      return false;
    }
    if (ppid <= 0 || ppid === cur) return false;
    cur = ppid;
  }
  return false;
}

// ---------------------------------------------------------------------------
// /proc-based process metrics — ported verbatim from backends/mpv/measure.ts.
// ---------------------------------------------------------------------------

const CLK_TCK = 100; // sysconf(_SC_CLK_TCK) on essentially all Linux/glibc.

function readProc(
  pid: number,
): { alive: boolean; rss_kib: number; utime: number; stime: number } {
  function tryRead(path: string): string | null {
    try {
      const r = spawnSync("cat", [path], { encoding: "utf8" });
      if (r.status !== 0 || r.stdout == null) return null;
      return r.stdout;
    } catch {
      return null;
    }
  }
  const status = tryRead(`/proc/${pid}/status`);
  if (status === null) return { alive: false, rss_kib: 0, utime: 0, stime: 0 };
  let rss_kib = 0;
  for (const line of status.split("\n")) {
    if (line.startsWith("VmRSS:")) {
      const m = line.match(/(\d+)\s+kB/);
      if (m) rss_kib = Number(m[1]);
    }
  }
  const stat = tryRead(`/proc/${pid}/stat`);
  let utime = 0;
  let stime = 0;
  if (stat) {
    // comm (field 2) may contain spaces/parens; trim from the LAST ')'.
    const lp = stat.lastIndexOf(")");
    const tail = lp >= 0 ? stat.slice(lp + 2) : stat;
    const f = tail.trim().split(/\s+/);
    // After comm: state=f[0], ppid=f[1], ... utime=f[11], stime=f[12].
    utime = Number(f[11] ?? 0);
    stime = Number(f[12] ?? 0);
  }
  return { alive: true, rss_kib, utime, stime };
}

/**
 * Sum bytes_received across sockets owned by the mpv child (pid) whose peer is
 * an anomaly.fm IP (ANOMALY_IPS). Ported verbatim from measure.ts: `ss -tnp`
 * → ports of mpv→anomaly.fm (filtered by `pid=${pid},`), then `ss -tni` → sum.
 *
 * The pid filter is essential here: the opencode host process ALSO polls
 * status JSON over HTTPS at https://anomaly.fm/radio/status.json, and that
 * domain resolves to the SAME IP(s) as the streaming socket (resolved at
 * startup; override via ANOMALY_IP). An IP-only filter would
 * therefore count the host's own status-poll bytes, which the prototype
 * deliberately excluded. Scoping to the mpv child's pid measures ONLY the
 * streaming socket.
 *
 * Returns total bytes_received across all mpv-child→anomaly.fm sockets, or -1
 * if none (e.g. when mpv is dead in window C — the correct "no streaming
 * socket" verdict).
 */
function readSocketBytesToAnomaly(pid: number | null): number {
  if (!pid) return -1;
  // 1. local ports OWNED BY THIS mpv pid that connect to an anomaly.fm IP.
  let out = "";
  try {
    const r = spawnSync("ss", ["-tnp"], { encoding: "utf8" });
    out = r.stdout ?? "";
  } catch {
    return -1;
  }
  const ports = new Set<string>();
  for (const line of out.split("\n")) {
    if (!line.includes(`pid=${pid},`)) continue;
    if (!ANOMALY_IPS.some((ip) => line.includes(ip))) continue;
    const m = line.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d+)/);
    if (m) ports.add(m[2]);
  }
  if (ports.size === 0) return -1;

  // 2. bytes_received for those local ports via ss -tni.
  let iout = "";
  try {
    const r = spawnSync("ss", ["-tni"], { encoding: "utf8" });
    iout = r.stdout ?? "";
  } catch {
    return -1;
  }
  let total = 0;
  let found = false;
  let curPort: string | null = null;
  for (let i = 0; i < iout.length; ) {
    const nl = iout.indexOf("\n", i);
    const line = nl < 0 ? iout.slice(i) : iout.slice(i, nl);
    i = nl < 0 ? iout.length : nl + 1;
    const lm = line.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d+)/);
    if (lm) {
      curPort = ports.has(lm[2]) ? lm[2] : null;
      if (curPort) found = true;
    } else if (curPort) {
      const bm = line.match(/bytes_received:(\d+)/);
      if (bm) total += Number(bm[1]);
      curPort = null;
    }
  }
  return found ? total : -1;
}

// ---------------------------------------------------------------------------
// Sampling loop (ported from measure.ts; extended for host+mpv).
// ---------------------------------------------------------------------------

let lastHostCpu: { sticks: number; t: number } | null = null;
let lastMpvCpu: { sticks: number; t: number } | null = null;
let lastSock: { bytes: number; t: number } | null = null;

function sample(
  window: HostSample["window"],
  hostPid: number,
): HostSample {
  const now = Date.now();

  const hostProc = readProc(hostPid);
  const hostSticks = hostProc.utime + hostProc.stime;
  let host_cpu_pct = 0;
  if (lastHostCpu) {
    const dt = (now - lastHostCpu.t) / 1000;
    const d = hostSticks - lastHostCpu.sticks;
    if (dt > 0) host_cpu_pct = (d / CLK_TCK / dt) * 100;
  }
  lastHostCpu = hostProc.alive ? { sticks: hostSticks, t: now } : null;

  const mpvPid = findMpvChild(hostPid);
  let mpv_rss_kib = 0;
  let mpv_cpu_pct = 0;
  let mpv_alive = 0;
  if (mpvPid) {
    const mpvProc = readProc(mpvPid);
    mpv_alive = mpvProc.alive ? 1 : 0;
    mpv_rss_kib = mpvProc.rss_kib;
    const sticks = mpvProc.utime + mpvProc.stime;
    if (lastMpvCpu) {
      const dt = (now - lastMpvCpu.t) / 1000;
      // Clamp the delta ≥ 0: a freshly-spawned mpv (after death/rebirth) can
      // have LOWER cumulative ticks than the previous sample's mpv, which
      // would otherwise yield a spurious negative CPU%. Mirrors the sock clamp.
      const d = Math.max(0, sticks - lastMpvCpu.sticks);
      if (dt > 0) mpv_cpu_pct = (d / CLK_TCK / dt) * 100;
    }
    lastMpvCpu = mpvProc.alive ? { sticks, t: now } : null;
  } else {
    lastMpvCpu = null;
  }

  // Pass the mpv child's pid so the socket filter measures ONLY the mpv-child
  // streaming socket (not the host's status-JSON poll, which goes to the same IP).
  const sockBytes = readSocketBytesToAnomaly(mpvPid);
  let sock_bps = 0;
  if (sockBytes >= 0 && lastSock && lastSock.bytes >= 0) {
    const dt = (now - lastSock.t) / 1000;
    if (dt > 0) sock_bps = Math.max(0, (sockBytes - lastSock.bytes) / dt);
  }
  lastSock = { bytes: sockBytes, t: now };

  const s: HostSample = {
    t_ms: now - t0,
    window,
    host_alive: hostProc.alive ? 1 : 0,
    host_rss_kib: hostProc.rss_kib,
    host_cpu_pct: Number(host_cpu_pct.toFixed(2)),
    mpv_alive,
    mpv_rss_kib,
    mpv_cpu_pct: Number(mpv_cpu_pct.toFixed(2)),
    sock_bytes_per_sec: Math.round(sock_bps),
  };
  samples.push(s);
  return s;
}

function summarize(window: HostSample["window"]) {
  const w = samples.filter((s) => s.window === window);
  if (w.length === 0) return null;
  const avg = (f: (s: HostSample) => number) =>
    w.reduce((a, s) => a + f(s), 0) / w.length;
  const max = (f: (s: HostSample) => number) => Math.max(...w.map(f));
  return {
    n: w.length,
    mpv_alive_max: max((s) => s.mpv_alive),
    host_rss_avg_kib: Math.round(avg((s) => s.host_rss_kib)),
    host_cpu_avg_pct: Number(avg((s) => s.host_cpu_pct).toFixed(2)),
    mpv_rss_avg_kib: Math.round(avg((s) => s.mpv_rss_kib)),
    mpv_cpu_avg_pct: Number(avg((s) => s.mpv_cpu_pct).toFixed(2)),
    sock_bps_avg: Math.round(avg((s) => s.sock_bytes_per_sec)),
    sock_bps_max: max((s) => s.sock_bytes_per_sec),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runWindow(
  name: HostSample["window"],
  durSec: number,
  hostPid: number,
) {
  log(`=== WINDOW ${name} (${durSec}s) ===`);
  // Reset per-window deltas so CPU/sock rates are clean.
  lastHostCpu = null;
  lastMpvCpu = null;
  lastSock = null;
  const nSamples = Math.max(1, Math.round((durSec * 1000) / SAMPLE_MS));
  for (let i = 0; i < nSamples; i++) {
    const s = sample(name, hostPid);
    if (i % Math.round(SAMPLE_HZ * 5) === 0 || i === nSamples - 1) {
      log(
        `  host{alive=${s.host_alive} rss=${s.host_rss_kib}KiB cpu=${s.host_cpu_pct}%} ` +
          `mpv{alive=${s.mpv_alive} rss=${s.mpv_rss_kib}KiB cpu=${s.mpv_cpu_pct}%} ` +
          `sock=${s.sock_bytes_per_sec}B/s`,
      );
    }
    await sleep(SAMPLE_MS);
  }
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

function verdict(): { allPass: boolean; checks: Check[] } {
  const A = summarize("A_paused_baseline");
  const C = summarize("C_paused_after");
  const checks: Check[] = [];

  if (!A || !C) {
    checks.push({
      name: "windows_present",
      pass: false,
      detail: `missing window summary (A=${!!A}, C=${!!C})`,
    });
    return { allPass: false, checks };
  }

  // (a) no mpv process in C.
  checks.push({
    name: "C_mpv_dead",
    pass: C.mpv_alive_max === 0,
    detail: `mpv_alive_max in C = ${C.mpv_alive_max} (must be 0)`,
  });

  // (b) zero anomaly.fm socket bytes/sec in C (tolerance for status JSON).
  checks.push({
    name: "C_zero_socket",
    pass: C.sock_bps_avg <= PASS_C_SOCK_BPS_AVG,
    detail: `sock_B/s_avg in C = ${C.sock_bps_avg} (must be ≤ ${PASS_C_SOCK_BPS_AVG})`,
  });

  // (c1) host RSS within noise A↔C.
  const rssDelta = Math.abs(C.host_rss_avg_kib - A.host_rss_avg_kib);
  checks.push({
    name: "C_host_rss_within_noise",
    pass: rssDelta < PASS_RSS_DELTA_KIB,
    detail: `|rss_C(${C.host_rss_avg_kib}) − rss_A(${A.host_rss_avg_kib})| = ${rssDelta} KiB (must be < ${PASS_RSS_DELTA_KIB})`,
  });

  // (c2) host CPU within noise A↔C.
  const cpuDelta = Math.abs(C.host_cpu_avg_pct - A.host_cpu_avg_pct);
  checks.push({
    name: "C_host_cpu_within_noise",
    pass: cpuDelta < PASS_CPU_DELTA_PCT,
    detail: `|cpu_C(${C.host_cpu_avg_pct}) − cpu_A(${A.host_cpu_avg_pct})| = ${cpuDelta}% (must be < ${PASS_CPU_DELTA_PCT})`,
  });

  return { allPass: checks.every((c) => c.pass), checks };
}

function writeResults() {
  const header =
    "t_ms,window,host_alive,host_rss_kib,host_cpu_pct,mpv_alive,mpv_rss_kib,mpv_cpu_pct,sock_bytes_per_sec\n";
  const rows = samples
    .map((s) =>
      [
        s.t_ms,
        s.window,
        s.host_alive,
        s.host_rss_kib,
        s.host_cpu_pct,
        s.mpv_alive,
        s.mpv_rss_kib,
        s.mpv_cpu_pct,
        s.sock_bytes_per_sec,
      ].join(","),
    )
    .join("\n");
  writeFileSync("results-verify-pause.csv", header + rows + "\n");

  console.log("\n================ SUMMARY ================");
  console.log(
    [
      "window".padEnd(22),
      "mpv_alive",
      "host_rss_avg",
      "host_cpu_avg%",
      "mpv_rss_avg",
      "mpv_cpu_avg%",
      "sock_B/s_avg",
      "sock_B/s_max",
    ].join("  "),
  );
  for (const wname of [
    "A_paused_baseline",
    "B_playing",
    "C_paused_after",
  ] as const) {
    const s = summarize(wname);
    if (!s) continue;
    console.log(
      [
        wname.padEnd(22),
        String(s.mpv_alive_max).padStart(9),
        (s.host_rss_avg_kib + "KiB").padStart(11),
        String(s.host_cpu_avg_pct).padStart(11),
        (s.mpv_rss_avg_kib + "KiB").padStart(11),
        String(s.mpv_cpu_avg_pct).padStart(11),
        String(s.sock_bps_avg).padStart(13),
        String(s.sock_bps_max).padStart(13),
      ].join("  "),
    );
  }
  console.log("CSV → results-verify-pause.csv");

  console.log("\n================ VERDICT ================");
  const v = verdict();
  for (const c of v.checks) {
    console.log(`  [${c.pass ? "PASS" : "FAIL"}] ${c.name}: ${c.detail}`);
  }
  console.log(`\nOVERALL: ${v.allPass ? "PASS — true-pause contract holds" : "FAIL — true-pause contract violated"}`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const argPid = process.argv[2] ? Number(process.argv[2]) : null;
  let hostPid: number;
  try {
    hostPid = resolveHostPid(argPid);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(msg.startsWith("verify-pause:") ? msg : `verify-pause: ${msg}`);
    process.exit(2);
  }
  log(`verify-pause: host opencode pid = ${hostPid}`);
  log(`  WINDOW_SEC=${WINDOW_SEC} SAMPLE_HZ=${SAMPLE_HZ}`);
  ANOMALY_IPS = await resolveAnomalyIps();
  log(`  anomaly.fm → ${ANOMALY_IPS.join(", ") || "(unresolved)"}`);
  // An empty IP list would make readSocketBytesToAnomaly() return -1 (no socket
  // found) → 0 B/s → a FALSE PASS on the streaming-socket check. Abort unless
  // SANITY mode is smoke-running without a real plugin/socket.
  if (ANOMALY_IPS.length === 0 && !SANITY) {
    console.error(
      "verify-pause: could not resolve anomaly.fm and ANOMALY_IP is not set.\n" +
        "  Run `dig anomaly.fm +short`, then re-run with ANOMALY_IP=<ip>.",
    );
    process.exit(2);
  }

  // Confirm the host is alive before we burn 3 windows.
  const probe = readProc(hostPid);
  if (!probe.alive) {
    console.error(
      `verify-pause: pid ${hostPid} is not alive (no /proc/${hostPid}/status). ` +
        "Start opencode with the anomaly.fm plugin loaded first.",
    );
    process.exit(2);
  }
  log(`  host alive; rss=${probe.rss_kib}KiB at probe`);

  // (A) baseline — plugin loaded, never toggled.
  //     User runs this BEFORE first pressing radio.toggle.
  await runWindow("A_paused_baseline", WINDOW_SEC, hostPid);

  if (!SANITY) {
    // (B) playing — user has pressed radio.toggle to start playback.
    //     The script waits here so the operator can press the key.
    console.log(
      "\n>>> WINDOW B (playing): press radio.toggle in opencode to START playback,\n" +
        ">>> then press Enter here once the stream is playing. <<<",
    );
    await waitForEnter();
  } else {
    log("SANITY: skipping Enter prompt before window B");
  }
  await runWindow("B_playing", WINDOW_SEC, hostPid);

  if (!SANITY) {
    // (C) paused-after — user has pressed radio.toggle again to pause.
    console.log(
      "\n>>> WINDOW C (paused-after): press radio.toggle in opencode to PAUSE,\n" +
        ">>> then press Enter here once playback has stopped. <<<",
    );
    await waitForEnter();
  } else {
    log("SANITY: skipping Enter prompt before window C");
  }
  await runWindow("C_paused_after", WINDOW_SEC, hostPid);

  writeResults();

  const v = verdict();
  process.exit(v.allPass ? 0 : 1);
}

function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", () => {
      process.stdin.pause();
      resolve();
    });
  });
}

main().catch((e) => {
  console.error("[verify-pause fatal]", e);
  process.exit(2);
});
