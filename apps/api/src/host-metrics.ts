import { readFileSync, readdirSync } from "node:fs";
import type { CliHostHealth } from "@space/cli-host";
import type { BrowserHostHealth } from "@space/browser-host";
import { apiDomainMetrics } from "./api-metrics.js";

/**
 * Host metrics observed from the API, so the CLI and Browser Hosts need no
 * metrics endpoint of their own (a normal deploy never restarts them). Values
 * come from each host's health response, plus /proc for the host process when
 * its command line proves it is that host. Labels are fixed host names and
 * session statuses only.
 */
const hostUp = apiDomainMetrics.gauge("space_host_up",
  "1 when the API's latest health check reached the host, otherwise 0.", ["host"]);
const hostStart = apiDomainMetrics.gauge("space_host_start_time_seconds",
  "Unix time the host process reported as its start.", ["host"]);
const hostObserved = apiDomainMetrics.gauge("space_host_observed_timestamp_seconds",
  "Unix time of the API's latest health check of the host; the other host gauges are as fresh as this.", ["host"]);
const hostMemory = apiDomainMetrics.gauge("space_host_resident_memory_bytes",
  "Resident memory of the host process from /proc, when its command line identifies the host.", ["host"]);
const hostCpu = apiDomainMetrics.gauge("space_host_cpu_seconds",
  "User plus system CPU seconds the host process has used, from /proc (a monotonic value within one host process).", ["host"]);
const cliSessions = apiDomainMetrics.gauge("space_cli_host_sessions",
  "Terminal sessions the CLI host reported, by status.", ["host", "status"]);
const cliAttachments = apiDomainMetrics.gauge("space_cli_host_attachments",
  "Attached clients across the CLI host's sessions.", ["host"]);
const browserSessions = apiDomainMetrics.gauge("space_browser_host_sessions",
  "Active managed browser sessions and the host's limit.", ["kind"]);
const browserLiveWorkloads = apiDomainMetrics.gauge("space_browser_host_live_workloads",
  "Active live-streaming browser workloads and the host's limit.", ["kind"]);

export type MemoryWorkerName = "memory-maintenance" | "memory-mutation";
export type HostName = "cli-main" | "cli-admin" | "browser" | MemoryWorkerName;

const hostCommandPatterns: Record<HostName, RegExp> = {
  "cli-main": /(^|\/)packages\/cli-host\/dist\/main\.js$/,
  "cli-admin": /(^|\/)packages\/cli-host\/dist\/main\.js$/,
  browser: /(^|\/)apps\/api\/dist\/browser-host-main\.js$/,
  "memory-maintenance": /(^|\/)apps\/worker\/dist\/memory-maintenance-worker\.js$/,
  "memory-mutation": /(^|\/)apps\/worker\/dist\/memory-mutation-worker\.js$/
};

// Linux x86-64 and arm64 defaults; the values only scale the two /proc gauges.
const pageSizeBytes = 4096;
const clockTicksPerSecond = 100;

export interface HostProcessStats { residentBytes: number; cpuSeconds: number }

/** /proc statistics for a host PID, or null when the PID is not that host (or unreadable). */
export function readHostProcessStats(
  host: HostName,
  pid: number,
  read: (path: string) => string = (path) => readFileSync(path, "utf8")
): HostProcessStats | null {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    const argv = read(`/proc/${pid}/cmdline`).split("\0").filter(Boolean);
    if (!argv.some((arg) => hostCommandPatterns[host].test(arg))) return null;
    const residentPages = Number(read(`/proc/${pid}/statm`).trim().split(/\s+/)[1]);
    const stat = read(`/proc/${pid}/stat`);
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    // Fields after the command: state is index 0, so utime and stime are 11 and 12.
    const cpuTicks = Number(fields[11]) + Number(fields[12]);
    if (!Number.isFinite(residentPages) || !Number.isFinite(cpuTicks)) return null;
    return { residentBytes: residentPages * pageSizeBytes, cpuSeconds: cpuTicks / clockTicksPerSecond };
  } catch {
    return null;
  }
}

function recordCommon(host: HostName, health: { hostPid: number; startedAt: string } | null,
  stats: (host: HostName, pid: number) => HostProcessStats | null, now: number) {
  hostObserved.set({ host }, now / 1000);
  hostUp.set({ host }, health ? 1 : 0);
  if (!health) return;
  const startedAt = Date.parse(health.startedAt);
  if (Number.isFinite(startedAt)) hostStart.set({ host }, startedAt / 1000);
  const process = stats(host, health.hostPid);
  if (process) {
    hostMemory.set({ host }, process.residentBytes);
    hostCpu.set({ host }, process.cpuSeconds);
  }
}

export function recordCliHostHealth(host: "cli-main" | "cli-admin", health: CliHostHealth | null,
  stats: (host: HostName, pid: number) => HostProcessStats | null = readHostProcessStats, now = Date.now()): void {
  recordCommon(host, health, stats, now);
  if (!health) return;
  const counts = { RUNNING: 0, EXITED: 0, ERROR: 0 };
  let attachments = 0;
  for (const session of health.sessions) {
    if (session.status in counts) counts[session.status] += 1;
    attachments += Math.max(0, session.attachmentCount || 0);
  }
  for (const [status, count] of Object.entries(counts)) cliSessions.set({ host, status }, count);
  cliAttachments.set({ host }, attachments);
}

export function recordBrowserHostHealth(health: BrowserHostHealth | null,
  stats: (host: HostName, pid: number) => HostProcessStats | null = readHostProcessStats, now = Date.now()): void {
  recordCommon("browser", health, stats, now);
  if (!health?.capacity) return;
  browserSessions.set({ kind: "active" }, health.capacity.activeSessions);
  browserSessions.set({ kind: "max" }, health.capacity.maxSessions);
  browserLiveWorkloads.set({ kind: "active" }, health.capacity.activeLiveWorkloads);
  browserLiveWorkloads.set({ kind: "max" }, health.capacity.maxLiveWorkloads);
}

const memoryWorkers: MemoryWorkerName[] = ["memory-maintenance", "memory-mutation"];
const memoryWorkerScanIntervalMs = 15_000;
let lastMemoryWorkerScan = 0;

/**
 * The memory workers have no health endpoint, and a normal deploy does not
 * restart them, so the API finds them in /proc by command line (at most every
 * 15 s, when /metrics is read). A worker that is not running reads as down; in
 * an instance with its own PID namespace (dev) both always read as down.
 */
export function observeMemoryWorkers({
  listPids = () => readdirSync("/proc").filter((name) => /^\d+$/.test(name)).map(Number),
  read = (path: string) => readFileSync(path, "utf8"),
  now = Date.now(),
  force = false
}: { listPids?: () => number[]; read?: (path: string) => string; now?: number; force?: boolean } = {}): void {
  if (!force && now - lastMemoryWorkerScan < memoryWorkerScanIntervalMs) return;
  lastMemoryWorkerScan = now;
  const found = new Map<MemoryWorkerName, { pid: number; stats: HostProcessStats }>();
  let pids: number[] = [];
  try { pids = listPids(); } catch { pids = []; }
  for (const pid of pids) {
    if (found.size === memoryWorkers.length) break;
    for (const worker of memoryWorkers) {
      if (found.has(worker)) continue;
      const stats = readHostProcessStats(worker, pid, read);
      if (stats) found.set(worker, { pid, stats });
    }
  }
  let bootSeconds: number | null = null;
  for (const worker of memoryWorkers) {
    const process = found.get(worker);
    hostObserved.set({ host: worker }, now / 1000);
    hostUp.set({ host: worker }, process ? 1 : 0);
    if (!process) continue;
    hostMemory.set({ host: worker }, process.stats.residentBytes);
    hostCpu.set({ host: worker }, process.stats.cpuSeconds);
    try {
      bootSeconds ??= Number(/^btime (\d+)$/m.exec(read("/proc/stat"))?.[1]);
      const stat = read(`/proc/${process.pid}/stat`);
      // Field 22 of /proc/<pid>/stat (index 19 after the command) is the start time in clock ticks since boot.
      const startTicks = Number(stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19]);
      if (Number.isFinite(bootSeconds) && Number.isFinite(startTicks)) {
        hostStart.set({ host: worker }, bootSeconds + startTicks / clockTicksPerSecond);
      }
    } catch {
      // Start time is optional; memory, CPU and availability are already recorded.
    }
  }
}
