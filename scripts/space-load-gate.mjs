#!/usr/bin/env node
// space-load-gate: runs one heavy agent command (a full test suite, a typecheck, a build, a Playwright or browser proof)
// only while the server is not OVERLOADED, and at most 3 heavy commands at once (plan clipboard:VZEewZRaodZR R3).
// Light commands (scoped tests, reads, git) run directly, never through it.
//
//   node scripts/space-load-gate.mjs -- <command> [args...]        e.g.  -- npm test   |   -- sh -c "npm run build && npm test"
//
// OVERLOADED is Nous's rule (apps/api/src/nous/server-load.ts; apps/api/tests/space-load-gate-thresholds.test.ts keeps them
// equal): only the physical host's swap past 90% (operator 3/11), read from the monitoring collector the API is configured
// with and the host its SPACE_LOAD_HOST_SELECTOR names; without a selector (no hypervisor) this machine's /proc/meminfo. CPU,
// RAM and the load average hold nothing.
// It waits at most 10 minutes and then runs anyway; when the load cannot be read it does not wait for it. Its own lines
// start with "space-load-gate:" on stderr; the command's exit code is its exit code.
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

export const GATE_DEFAULTS = { slots: 3, maxWaitMs: 10 * 60_000, pollMs: 20_000, dir: process.env.SPACE_LOAD_GATE_DIR || "/tmp/space-load-gate" };
/** The stable API's installed unit (root-owned, world-readable): it holds the install's settings, which CLI panes' environments do not. */
const API_UNIT = "/etc/systemd/system/space-api.service";
const SWAP_TOTAL = "node_memory_SwapTotal_bytes", SWAP_FREE = "node_memory_SwapFree_bytes";
/** server-load.ts's bounds: older than 2 minutes or over a minute ahead of this clock is no reading. */
const MAX_AGE_MS = 120_000, MAX_AHEAD_MS = 60_000;

/** Why the server is OVERLOADED (server-load.ts's classifyLoad): the host's swap past 90%, compared at full precision; empty when it is not. */
export function overloadReasons({ swapPercent, host = "host" }) {
  return typeof swapPercent === "number" && swapPercent > 90 ? [`${host} swap ${swapPercent.toFixed(2)}%`] : [];
}

const meminfo = (text, key) => {
  const kib = Number(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, "m").exec(text)?.[1]);
  return Number.isFinite(kib) ? kib * 1024 : null;
};

/** One of the API's settings: this process's environment, else the installed API unit's Environment= line; null without one. */
export function installedSetting(name, { env = process.env, read = (path) => readFileSync(path, "utf8") } = {}) {
  const set = env[name]?.trim();
  if (set) return set;
  try { return new RegExp(`^Environment="?${name}=([^"\\s]+)"?\\s*$`, "m").exec(read(API_UNIT))?.[1] ?? null; } catch { return null; }
}

/** config.ts's parseLoadHostSelector: label=value pairs as PromQL matchers; null when unset; throws when malformed. */
export function parseLoadHostSelector(raw) {
  const value = raw?.trim();
  if (!value) return null;
  const pairs = value.split(",").map((pair) => /^([A-Za-z_][A-Za-z0-9_]{0,63})=([A-Za-z0-9_.:-]{1,128})$/.exec(pair.trim()));
  if (pairs.some((match) => !match || match[1] === "__name__")) throw new Error("SPACE_LOAD_HOST_SELECTOR must be label=value pairs such as job=proxmox_host,instance=192.0.2.1:9100.");
  return pairs.map((match) => `${match[1]}="${match[2]}"`).join(",");
}

/** server-load.ts's hostSwapQuery. */
export const hostSwapQuery = (matchers) => `{__name__=~"node_memory_Swap(Total|Free)_bytes",${matchers}}[2m]`;

/** server-load.ts's hostSwapOf on Prometheus' raw `result`: one host's paired, valid, fresh SwapTotal and SwapFree, or it throws. */
export function hostSwapOfResult(result, now) {
  const hosts = new Map();
  for (const series of Array.isArray(result) ? result : []) {
    const { __name__: name, ...identity } = series?.metric ?? {};
    if (name !== SWAP_TOTAL && name !== SWAP_FREE) throw new Error(`the collector answered an unexpected series ${name ?? "without a name"}`);
    const last = Array.isArray(series.values) ? series.values.at(-1) : undefined, value = Number(last?.[1]), at = Number(last?.[0]) * 1000;
    if (!last || !Number.isFinite(value) || value < 0 || !Number.isFinite(at)) throw new Error(`${name} has no valid sample`);
    const key = JSON.stringify(Object.entries(identity).sort(([left], [right]) => left.localeCompare(right)));
    const entry = hosts.get(key) ?? { labels: identity };
    const slot = name === SWAP_TOTAL ? "total" : "free";
    if (entry[slot]) throw new Error(`two ${name} series for one host`);
    entry[slot] = [value, at];
    hosts.set(key, entry);
  }
  if (!hosts.size) throw new Error("the collector has no host swap sample from the last 2 minutes");
  if (hosts.size > 1) throw new Error(`SPACE_LOAD_HOST_SELECTOR matches ${hosts.size} hosts; it must name one`);
  const { labels, total, free } = [...hosts.values()][0];
  const host = labels.node_name || labels.instance || "host";
  if (!total || !free) throw new Error(`the collector has only ${total ? "SwapTotal" : "SwapFree"} for ${host}`);
  if (free[0] > total[0]) throw new Error(`${host}'s SwapFree exceeds its SwapTotal`);
  const at = Math.min(total[1], free[1]);
  if (now - at > MAX_AGE_MS || Math.max(total[1], free[1]) - now > MAX_AHEAD_MS) throw new Error(`${host}'s swap sample is from ${new Date(at).toISOString().slice(11, 19)} UTC, not within 2 minutes of now`);
  return { host, swapPercent: total[0] > 0 ? (100 * (total[0] - free[0])) / total[0] : 0 };
}

/** The host's swap: with a SPACE_LOAD_HOST_SELECTOR, that host from the collector's Prometheus; without one, this machine's /proc/meminfo. */
export async function readLoad({ env = process.env, read = (path) => readFileSync(path, "utf8"), get = fetch, now = Date.now } = {}) {
  const matchers = parseLoadHostSelector(installedSetting("SPACE_LOAD_HOST_SELECTOR", { env, read }));
  if (!matchers) {
    const memory = read("/proc/meminfo");
    const swapTotal = meminfo(memory, "SwapTotal"), swapFree = meminfo(memory, "SwapFree");
    return { host: "this machine", swapPercent: swapTotal ? 100 * (swapTotal - (swapFree ?? swapTotal)) / swapTotal : null };
  }
  const collector = installedSetting("SPACE_MONITORING_COLLECTOR_HOST", { env, read });
  if (!collector || !/^\d{1,3}(\.\d{1,3}){3}$/.test(collector)) throw new Error("SPACE_LOAD_HOST_SELECTOR is set without a collector (SPACE_MONITORING_COLLECTOR_HOST)");
  const response = await get(`http://${collector}:9090/api/v1/query?${new URLSearchParams({ query: hostSwapQuery(matchers) })}`, { redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`the collector answered HTTP ${response.status}`);
  return hostSwapOfResult((await response.json())?.data?.result, now());
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };

/**
 * Takes one of the slot files (exclusive create, holding this process's pid); a slot whose process is gone is taken over.
 * Returns the slot's release, or null when every slot is held.
 * shortcut: two gates may both take over the same stale slot for a moment; use flock if exactness ever matters.
 */
export function takeSlot({ dir = GATE_DEFAULTS.dir, slots = GATE_DEFAULTS.slots, pid = process.pid } = {}) {
  mkdirSync(dir, { recursive: true });
  for (let index = 0; index < slots; index++) {
    const path = join(dir, `slot-${index}.pid`);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(path, "wx", 0o644);
        writeSync(fd, String(pid));
        closeSync(fd);
        return () => { try { if (readFileSync(path, "utf8").trim() === String(pid)) unlinkSync(path); } catch {} };
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        let holder = Number.NaN;
        try { holder = Number(readFileSync(path, "utf8").trim()); } catch {}
        if (Number.isInteger(holder) && holder > 0 && alive(holder)) break;
        try { unlinkSync(path); } catch {}
      }
    }
  }
  return null;
}

/** Runs the command with this terminal, passes Ctrl-C and SIGTERM on, and resolves with its exit code. */
export function runCommand([file, ...args], { log = () => {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: "inherit" });
    const forward = (signal) => child.kill(signal);
    process.on("SIGINT", forward);
    process.on("SIGTERM", forward);
    const done = (code) => { process.off("SIGINT", forward); process.off("SIGTERM", forward); resolve(code); };
    child.on("error", (error) => { log(`could not run ${file}: ${error.message}`); done(127); });
    child.on("exit", (code, signal) => done(code ?? 128 + (constants.signals[signal] ?? 15)));
  });
}

export async function main(argv, deps = {}) {
  const log = deps.log ?? ((line) => process.stderr.write(`space-load-gate: ${line}\n`));
  const options = { ...GATE_DEFAULTS, ...deps.options };
  const split = argv.indexOf("--");
  const command = split >= 0 ? argv.slice(split + 1) : argv;
  if (!command.length) throw new Error("Usage: space-load-gate -- <command> [args...]");
  const now = deps.now ?? Date.now, wait = deps.wait ?? delay;
  const until = now() + options.maxWaitMs;
  let release = null, said = "";
  for (;;) {
    let reasons = [];
    try {
      reasons = overloadReasons(await (deps.readLoad ?? readLoad)());
    } catch (error) {
      log(`the server load could not be read (${error.message}); not waiting for it.`);
    }
    if (!reasons.length) {
      try {
        release = takeSlot({ dir: options.dir, slots: options.slots });
      } catch (error) {
        log(`the slots in ${options.dir} could not be used (${error.message}); running now.`);
        break;
      }
      if (release) break;
    }
    if (now() >= until) {
      log(`still ${reasons.length ? "OVERLOADED" : `${options.slots} heavy commands running`} after ${Math.round(options.maxWaitMs / 60_000)} min; running anyway.`);
      break;
    }
    const line = reasons.length ? `the server is OVERLOADED (${reasons.join(", ")}); waiting.` : `${options.slots} heavy commands are running; waiting for a slot.`;
    if (line !== said) log(line);
    said = line;
    await wait(options.pollMs);
  }
  try {
    return await (deps.run ?? runCommand)(command, { log });
  } finally {
    release?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
    process.stderr.write(`space-load-gate: ${error.message}\n`);
    process.exit(2);
  });
}
