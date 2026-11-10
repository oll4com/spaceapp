import { execFile } from "../safe-child-process.js";
import { readFile } from "node:fs/promises";
import { cpus, loadavg, totalmem } from "node:os";
import { promisify } from "node:util";
import type { MonitoringCollectorConfig, MonitoringSeries, PaneCliSession, SystemHealthHistory } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import { createMonitoringCollector, type MonitoringCollector } from "../monitoring-copilot/collector.js";

/**
 * The server's load as Nous reads it (plan clipboard:VZEewZRaodZR step R1): OVERLOADED only while the physical host's swap is past 90%,
 * otherwise CALM (operator 3/11, nous_msg:7c17475390c842e8bdbf485e). public-host's own numbers (the SYSTEM_HEALTH sampler averaged over five
 * minutes, the processes and their panes) are shown as diagnostics and hold nothing.
 */

export type NousLoadLevel = "CALM" | "BUSY" | "OVERLOADED";
export interface NousLoadProcess { pid: number; command: string; cpuPercent: number; rssBytes: number; pane: string | null }
export interface NousLoadState {
  level: NousLoadLevel;
  reasons: string[];
  cpuPercent: number | null;
  load1: number;
  load5: number;
  cores: number;
  memAvailableBytes: number | null;
  memTotalBytes: number;
  /** This VM's swap (diagnostics: public-host's 16 GiB zram reads 100% while pve has room). */
  swapPercent: number | null;
  /** The physical host's swap: the one number that decides the level. */
  host: HostSwap;
  /** This VM's health samples averaged; 0: none retained yet. */
  samples: number;
  topCpu: NousLoadProcess[];
  topMemory: NousLoadProcess[];
  sampledAt: string;
}

const GiB = 1024 ** 3;
const WINDOW_MS = 5 * 60_000;

/** The physical host's swap (operator 3/11 «το overload ειναι το συνολικο swap του σερωερ να ειναι πανω απο 90%»). */
export interface HostSwap {
  /** Percent in use; null without a fresh reading, which holds nothing (never read as 100). */
  percent: number | null;
  /** Whose swap: the collector's node_name for the host ("pve"), or "this machine" on an install without a collector. */
  host: string;
  /** When the source measured it; null without a reading. */
  at: string | null;
  /** Why there is no reading. */
  error: string | null;
}

/** The physical host's swap samples in the collector's last 2 minutes, for the install's SPACE_LOAD_HOST_SELECTOR matchers. */
export const hostSwapQuery = (matchers: string) => `{__name__=~"node_memory_Swap(Total|Free)_bytes",${matchers}}[2m]`;
const SWAP_TOTAL = "node_memory_SwapTotal_bytes", SWAP_FREE = "node_memory_SwapFree_bytes";
/** Technical: older than 2 minutes (8 missed 15 s scrapes) or over a minute ahead of this clock is no reading. */
const HOST_SWAP_MAX_AGE_MS = 120_000, HOST_SWAP_MAX_AHEAD_MS = 60_000;
/** Display only; the level compares the full value. */
const percentText = (value: number) => value.toFixed(2);

/** Only the physical host's swap past 90% is OVERLOADED (operator 3/11: «πανω απο 90%», so exactly 90 is not); nothing else holds work. */
export function classifyLoad(input: { swapPercent: number | null; host?: string }): { level: NousLoadLevel; reasons: string[] } {
  const swap = input.swapPercent;
  return swap !== null && swap > 90 ? { level: "OVERLOADED", reasons: [`${input.host ?? "host"} swap ${percentText(swap)}%`] } : { level: "CALM", reasons: [] };
}

/** /proc/meminfo's MemAvailable and swap use, null where the file cannot be read. */
export function parseMeminfo(text: string): { memAvailableBytes: number | null; swapPercent: number | null } {
  const field = (name: string) => { const match = new RegExp(`^${name}:\\s+(\\d+) kB`, "m").exec(text); return match ? Number(match[1]) * 1024 : null; };
  const available = field("MemAvailable");
  const swapTotal = field("SwapTotal");
  const swapFree = field("SwapFree");
  return { memAvailableBytes: available, swapPercent: swapTotal && swapFree !== null ? (100 * (swapTotal - swapFree)) / swapTotal : swapTotal === 0 ? 0 : null };
}

/**
 * The one host's swap from the collector's answer: exactly one SwapTotal and one SwapFree of the same label set, finite, free ≤ total,
 * measured within 2 minutes of `now`. Anything else (a missing half, two hosts, an unknown series, a bad or stale value) is unknown,
 * never a sum or a guess.
 */
export function hostSwapOf(series: MonitoringSeries[], now: number): HostSwap {
  const unknown = (error: string): HostSwap => ({ percent: null, host: "host", at: null, error });
  const hosts = new Map<string, { labels: Record<string, string>; total?: [number, number]; free?: [number, number] }>();
  for (const { labels, points } of series) {
    const { __name__: name, ...identity } = labels;
    if (name !== SWAP_TOTAL && name !== SWAP_FREE) return unknown(`the collector answered an unexpected series ${name ?? "without a name"}`);
    const last = points.at(-1), value = Number(last?.[1]);
    if (!last || !Number.isFinite(value) || value < 0 || !Number.isFinite(last[0])) return unknown(`${name} has no valid sample`);
    const key = JSON.stringify(Object.entries(identity).sort(([left], [right]) => left.localeCompare(right)));
    const entry = hosts.get(key) ?? { labels: identity };
    const slot = name === SWAP_TOTAL ? "total" : "free";
    if (entry[slot]) return unknown(`two ${name} series for one host`);
    entry[slot] = [value, last[0] * 1000];
    hosts.set(key, entry);
  }
  if (!hosts.size) return unknown("the collector has no host swap sample from the last 2 minutes");
  if (hosts.size > 1) return unknown(`SPACE_LOAD_HOST_SELECTOR matches ${hosts.size} hosts; it must name one`);
  const { labels, total, free } = [...hosts.values()][0]!;
  const host = labels.node_name || labels.instance || "host";
  if (!total || !free) return { ...unknown(`the collector has only ${total ? "SwapTotal" : "SwapFree"} for ${host}`), host };
  if (free[0] > total[0]) return { ...unknown(`${host}'s SwapFree exceeds its SwapTotal`), host };
  const at = Math.min(total[1], free[1]);
  if (now - at > HOST_SWAP_MAX_AGE_MS || Math.max(total[1], free[1]) - now > HOST_SWAP_MAX_AHEAD_MS) {
    return { ...unknown(`${host}'s swap sample is from ${new Date(at).toISOString().slice(11, 19)} UTC, not within 2 minutes of now`), host };
  }
  return { percent: total[0] > 0 ? (100 * (total[0] - free[0])) / total[0] : 0, host, at: new Date(at).toISOString(), error: null };
}

export interface HostSwapReader { read(): Promise<HostSwap> }

/**
 * Reads the host's swap at most every 30 s: with a SPACE_LOAD_HOST_SELECTOR, that host from the collector's Prometheus (public-host: pve,
 * read-only, no secret); without one (an install without a hypervisor), this machine's /proc/meminfo. A collector that does not
 * answer, or answers something hostSwapOf refuses, is no reading, never this VM's swap in its place.
 */
export function createHostSwap(input: { collectorConfig?: MonitoringCollectorConfig | null; hostSelector?: string | null; collector?: Pick<MonitoringCollector, "promQuery">; meminfo?(): Promise<string>; now?(): number }): HostSwapReader {
  const now = input.now ?? Date.now;
  const prometheusUrl = input.collectorConfig?.defaults?.prometheusUrl || null;
  const collector = input.collector ?? createMonitoringCollector({ network: input.collectorConfig?.network ?? null });
  let cached: { at: number; value: Promise<HostSwap> } | null = null;
  async function sample(): Promise<HostSwap> {
    if (!input.hostSelector) {
      const { swapPercent } = parseMeminfo(await (input.meminfo ?? (() => readFile("/proc/meminfo", "utf8")))().catch(() => ""));
      return { percent: swapPercent, host: "this machine", at: swapPercent === null ? null : new Date(now()).toISOString(), error: swapPercent === null ? "/proc/meminfo could not be read" : null };
    }
    if (!prometheusUrl) return { percent: null, host: "host", at: null, error: "SPACE_LOAD_HOST_SELECTOR is set without a collector (SPACE_MONITORING_COLLECTOR_HOST)" };
    try {
      return hostSwapOf((await collector.promQuery(prometheusUrl, { query: hostSwapQuery(input.hostSelector) })).series, now());
    } catch (error) {
      return { percent: null, host: "host", at: null, error: `the collector did not answer (${error instanceof Error ? error.message.slice(0, 200) : "error"})` };
    }
  }
  return {
    read() {
      if (!cached || now() - cached.at >= 30_000) cached = { at: now(), value: sample() };
      return cached.value;
    }
  };
}

/** "pve swap 44.13% (12 s old)" or "host swap unknown (why)": the source and its freshness, as the world and the Load tab show it. */
export function hostSwapText(host: HostSwap, at: number = Date.now()): string {
  if (host.percent === null) return `${host.host} swap unknown (${host.error ?? "no reading"}; holds nothing)`;
  const age = host.at ? Math.max(0, Math.round((at - Date.parse(host.at)) / 1000)) : null;
  return `${host.host} swap ${percentText(host.percent)}%${age === null ? "" : ` (${age} s old)`}`;
}

/** The mean of a health series over the window, or null without points in it. */
function windowMean(history: SystemHealthHistory, id: string, since: number): { value: number | null; points: number } {
  const points = history.series.find((series) => series.id === id)?.points.filter((point) => Date.parse(point.at) >= since) ?? [];
  return { value: points.length ? points.reduce((sum, point) => sum + point.avg, 0) / points.length : null, points: points.length };
}

export interface PsRow { pid: number; ppid: number; cpuPercent: number; rssBytes: number; command: string }

/** `ps -eo pid=,ppid=,pcpu=,rss=,comm=` output (rss in KiB). */
export function parsePs(text: string): PsRow[] {
  return text.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), cpuPercent: Number(match[3]), rssBytes: Number(match[4]) * 1024, command: match[5]! }] : [];
  });
}

/** The heaviest processes by CPU and by memory, each named with the pane whose CLI session it runs under (its parent chain). */
export function topProcesses(rows: PsRow[], paneRoots: ReadonlyMap<number, string>, limit = 5): { topCpu: NousLoadProcess[]; topMemory: NousLoadProcess[] } {
  const parent = new Map(rows.map((row) => [row.pid, row.ppid]));
  const paneOf = (pid: number) => {
    for (let current: number | undefined = pid, hops = 0; current && hops < 32; current = parent.get(current), hops++) {
      const pane = paneRoots.get(current);
      if (pane) return pane;
    }
    return null;
  };
  const view = (row: PsRow): NousLoadProcess => ({ pid: row.pid, command: row.command, cpuPercent: row.cpuPercent, rssBytes: row.rssBytes, pane: paneOf(row.pid) });
  return {
    topCpu: [...rows].sort((left, right) => right.cpuPercent - left.cpuPercent).slice(0, limit).map(view),
    topMemory: [...rows].sort((left, right) => right.rssBytes - left.rssBytes).slice(0, limit).map(view)
  };
}

const LEVEL_HINT: Record<NousLoadLevel, string> = {
  CALM: "",
  BUSY: " BUSY: start no new work in panes now: open no new panes and send new work with when \"calm\" (it goes once the server allows); answers, stops and closes go at once.",
  OVERLOADED: " OVERLOADED: start no new work in panes now: open no new panes, send work only with when \"calm\" (urgent only for what cannot wait) and start nothing heavy; answers, stops and closes go at once."
};

/** One line for the world and the heartbeat, then the processes that load the server. */
export function renderServerLoad(state: NousLoadState): string {
  const gib = (bytes: number | null) => bytes === null ? "?" : (bytes / GiB).toFixed(0);
  const head = `Server: ${state.level}${state.reasons.length ? ` (${state.reasons.join(", ")})` : ""} · ${hostSwapText(state.host, Date.parse(state.sampledAt))}, OVERLOADED only past 90%`
    + ` · this VM (diagnostics, holds nothing): CPU ${state.cpuPercent === null ? "?" : Math.round(state.cpuPercent)}%`
    + ` · load ${state.load1.toFixed(1)}/${state.load5.toFixed(1)} on ${state.cores} cores · RAM available ${gib(state.memAvailableBytes)} of ${gib(state.memTotalBytes)} GiB`
    + ` · swap ${state.swapPercent === null ? "?" : Math.round(state.swapPercent)}%${state.samples ? " (5 min average)" : " (no samples yet)"}.${LEVEL_HINT[state.level]}`;
  const name = (process: NousLoadProcess) => `${process.command}${process.pane ? ` (${process.pane})` : ""}`;
  const top = [
    state.topCpu.length ? `Top CPU: ${state.topCpu.map((process) => `${name(process)} ${Math.round(process.cpuPercent)}%`).join(", ")}.` : "",
    state.topMemory.length ? `Top memory: ${state.topMemory.map((process) => `${name(process)} ${(process.rssBytes / GiB).toFixed(1)} GiB`).join(", ")}.` : ""
  ].filter(Boolean).join(" ");
  return top ? `${head}\n${top}` : head;
}

export interface ServerLoadDeps {
  health: { history(range: "10m"): Promise<SystemHealthHistory> };
  /** The physical host's swap, which alone decides the level. */
  hostSwap: HostSwapReader;
  /** "room/pane" of each running CLI session by its root process. */
  paneRoots(): Promise<ReadonlyMap<number, string>>;
  ps?(): Promise<string>;
  loadavg?(): number[];
  cores?: number;
  memTotalBytes?: number;
  now?(): number;
}

/** "Room/Pane" of every running CLI session by its root process, across the live rooms. */
export function paneRootsFrom(store: Pick<SpaceStore, "listRooms" | "listPanes" | "getActivePaneCliSession">,
  sessionPids: (sessions: readonly PaneCliSession[]) => Promise<ReadonlyMap<string, number>>) {
  return async (): Promise<ReadonlyMap<number, string>> => {
    const rooms = (await store.listRooms()).filter((room) => !room.archivedAt);
    const panes = (await Promise.all(rooms.map(async (room) => (await store.listPanes(room.id)).filter((pane) => !pane.isClosed)
      .map((pane) => ({ pane, label: `${room.name}/${pane.paneName ?? pane.title}` }))))).flat();
    const sessions = (await Promise.all(panes.map(async (entry) => ({ ...entry, session: await store.getActivePaneCliSession(entry.pane.id) }))))
      .filter((entry): entry is typeof entry & { session: PaneCliSession } => Boolean(entry.session?.isActive));
    const pids = await sessionPids(sessions.map((entry) => entry.session));
    return new Map(sessions.flatMap((entry) => { const pid = pids.get(entry.session.sessionId); return pid ? [[pid, entry.label] as const] : []; }));
  };
}

const runPs = async () => (await promisify(execFile)("ps", ["-eo", "pid=,ppid=,pcpu=,rss=,comm="], { maxBuffer: 4 * 1024 * 1024, timeout: 5_000 })).stdout;

/** Reads the load at most every 30 s (Nous's world, its heartbeat and held dispatch all ask). */
export function createServerLoad(deps: ServerLoadDeps) {
  const now = deps.now ?? Date.now;
  let cached: { at: number; state: Promise<NousLoadState> } | null = null;
  async function sample(): Promise<NousLoadState> {
    const at = now();
    const [history, host, rows, roots] = await Promise.all([
      deps.health.history("10m").catch(() => null),
      deps.hostSwap.read().catch((error: unknown): HostSwap => ({ percent: null, host: "host", at: null, error: String(error) })),
      // shortcut: ps pcpu is the process's lifetime average, not the last seconds; read /proc twice if spikes matter.
      // The sampling ps reports itself at hundreds of percent (lifetime pcpu of a fresh process): drop its row, as System Analytics does.
      (deps.ps ?? runPs)().then(parsePs).then((rows) => rows.filter((row) => !(row.command === "ps" && row.ppid === process.pid))).catch(() => []),
      deps.paneRoots().catch(() => new Map<number, string>())
    ]);
    const since = at - WINDOW_MS;
    const mean = (id: string) => history ? windowMean(history, id, since) : { value: null, points: 0 };
    const cpu = mean("cpu"), swap = mean("swap"), ram = mean("memory-available");
    const [load1 = 0, load5 = 0] = (deps.loadavg ?? loadavg)();
    const numbers = {
      cpuPercent: cpu.value, load1, load5, cores: deps.cores ?? cpus().length,
      memAvailableBytes: ram.value, memTotalBytes: deps.memTotalBytes ?? totalmem(), swapPercent: swap.value, host
    };
    return { ...numbers, ...classifyLoad({ swapPercent: host.percent, host: host.host }), samples: Math.min(cpu.points, swap.points, ram.points), ...topProcesses(rows, roots), sampledAt: new Date(at).toISOString() };
  }
  return {
    read(): Promise<NousLoadState> {
      if (!cached || now() - cached.at >= 30_000) {
        const state = sample();
        cached = { at: now(), state };
        state.catch(() => { if (cached?.state === state) cached = null; });
      }
      return cached.state;
    }
  };
}

export type ServerLoad = ReturnType<typeof createServerLoad>;
