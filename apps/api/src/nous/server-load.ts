import { execFile } from "../safe-child-process.js";
import { cpus, loadavg, totalmem } from "node:os";
import { promisify } from "node:util";
import type { PaneCliSession, SystemHealthHistory } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";

/**
 * The server's load as Nous reads it (plan clipboard:VZEewZRaodZR step R1): CALM, BUSY or OVERLOADED from the SYSTEM_HEALTH
 * sampler averaged over the last five minutes (one busy sample never decides), with the processes that load the VM and the
 * pane each belongs to, so Nous waits for a calm server before it gives the next task.
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
  swapPercent: number | null;
  /** Health samples averaged; 0: none retained yet, only the load average decides. */
  samples: number;
  topCpu: NousLoadProcess[];
  topMemory: NousLoadProcess[];
  sampledAt: string;
}

const GiB = 1024 ** 3;
const WINDOW_MS = 5 * 60_000;

/** Thresholds v1 (operator plan 2026-10-17, tune with data); load uses the 5-minute average, itself smoothed. */
export function classifyLoad(input: Pick<NousLoadState, "cpuPercent" | "load5" | "cores" | "memAvailableBytes" | "swapPercent">): { level: NousLoadLevel; reasons: string[] } {
  const { cpuPercent: cpu, load5, cores, memAvailableBytes: ram, swapPercent: swap } = input;
  const over = [
    cpu !== null && cpu >= 90 ? `CPU ${Math.round(cpu)}%` : null,
    load5 >= 1.5 * cores ? `load ${load5.toFixed(1)} on ${cores} cores` : null,
    ram !== null && ram < 4 * GiB ? `RAM available ${(ram / GiB).toFixed(1)} GiB` : null,
    swap !== null && swap >= 60 ? `swap ${Math.round(swap)}%` : null
  ].filter((reason): reason is string => reason !== null);
  if (over.length) return { level: "OVERLOADED", reasons: over };
  // Swap alone is never BUSY: swapped pages stay out after memory frees (stable 2026-10-17: swap 43% with 17 GiB free held
  // Nous's work for an hour); RAM available measures real pressure.
  const busy = [
    cpu !== null && cpu >= 75 ? `CPU ${Math.round(cpu)}%` : null,
    ram !== null && ram < 8 * GiB ? `RAM available ${(ram / GiB).toFixed(1)} GiB` : null
  ].filter((reason): reason is string => reason !== null);
  return busy.length ? { level: "BUSY", reasons: busy } : { level: "CALM", reasons: [] };
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
  const head = `Server: ${state.level}${state.reasons.length ? ` (${state.reasons.join(", ")})` : ""} · CPU ${state.cpuPercent === null ? "?" : Math.round(state.cpuPercent)}%`
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
    const [history, rows, roots] = await Promise.all([
      deps.health.history("10m").catch(() => null),
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
      // Without retained samples (the API's first 10 s) only the load average decides.
      cpuPercent: cpu.value, load1, load5, cores: deps.cores ?? cpus().length,
      memAvailableBytes: ram.value, memTotalBytes: deps.memTotalBytes ?? totalmem(), swapPercent: swap.value
    };
    return { ...numbers, ...classifyLoad(numbers), samples: Math.min(cpu.points, swap.points, ram.points), ...topProcesses(rows, roots), sampledAt: new Date(at).toISOString() };
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
