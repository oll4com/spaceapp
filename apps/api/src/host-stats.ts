import { readFile } from "node:fs/promises";
import { cpus } from "node:os";
import type { CodexEnvironment } from "@space/contracts";

export type HostStats = NonNullable<CodexEnvironment["hostStats"]>;
export type HostStatsProvider = () => Promise<HostStats>;

export interface ProcCpuSample {
  idle: number;
  total: number;
}

export interface CliHostStatsSource {
  hostId: string;
  enabled: boolean;
  health: () => Promise<unknown>;
}

export interface CliHostStatsResult {
  hostId: string;
  ok: boolean;
  health: unknown;
}

export interface HostStatsProviderOptions {
  apiStartedAt: string;
  cliHosts: CliHostStatsSource[];
  timeoutMs?: number;
  cacheTtlMs?: number;
  readMeminfo?: () => Promise<string>;
  readProcStat?: () => Promise<string>;
  now?: () => Date;
  coreCount?: number | null;
}

const defaultHostStatsTimeoutMs = 250;
const defaultHostStatsCacheTtlMs = 10_000;
const kib = 1024;

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 100);
}

function roundPercent(value: number): number {
  return Math.round(clampPercent(value) * 10) / 10;
}

function percentOrNull(usedBytes: number | null, totalBytes: number | null): number | null {
  if (usedBytes === null || totalBytes === null || totalBytes <= 0) return null;
  return roundPercent((usedBytes / totalBytes) * 100);
}

export function parseMeminfo(raw: string): Pick<HostStats, "memory" | "swap"> {
  const values = new Map<string, number>();
  for (const line of raw.split("\n")) {
    const match = /^([A-Za-z_()]+):\s+(\d+)\s+kB\b/.exec(line.trim());
    if (!match) continue;
    values.set(match[1] ?? "", Number.parseInt(match[2] ?? "0", 10) * kib);
  }
  const memTotal = values.get("MemTotal") ?? null;
  const memAvailable = values.get("MemAvailable") ?? null;
  const memoryUsed = memTotal !== null && memAvailable !== null ? Math.max(memTotal - memAvailable, 0) : null;
  const swapTotal = values.get("SwapTotal") ?? null;
  const swapFree = values.get("SwapFree") ?? null;
  const swapUsed = swapTotal !== null && swapFree !== null ? Math.max(swapTotal - swapFree, 0) : null;
  return {
    memory: {
      totalBytes: memTotal,
      usedBytes: memoryUsed,
      usagePercent: percentOrNull(memoryUsed, memTotal)
    },
    swap: {
      totalBytes: swapTotal,
      usedBytes: swapUsed,
      usagePercent: percentOrNull(swapUsed, swapTotal)
    }
  };
}

export function parseProcStat(raw: string): ProcCpuSample {
  const cpuLine = raw.split("\n").find((line) => line.startsWith("cpu "));
  if (!cpuLine) return { idle: 0, total: 0 };
  const fields = cpuLine.trim().split(/\s+/).slice(1).map((value) => Number.parseInt(value, 10)).filter(Number.isFinite);
  const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
  const total = fields.reduce((sum, value) => sum + value, 0);
  return { idle, total };
}

export function calculateCpuUsagePercent(previous: ProcCpuSample, next: ProcCpuSample): number | null {
  const totalDelta = next.total - previous.total;
  const idleDelta = next.idle - previous.idle;
  if (totalDelta <= 0 || idleDelta < 0) return null;
  return roundPercent(((totalDelta - idleDelta) / totalDelta) * 100);
}

function isSessionSummary(value: unknown): value is { status: string; attachmentCount: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { status?: unknown }).status === "string" &&
    typeof (value as { attachmentCount?: unknown }).attachmentCount === "number"
  );
}

function sessionsFromHealth(health: unknown): Array<{ status: string; attachmentCount: number }> {
  const sessions = (health as { sessions?: unknown } | null)?.sessions;
  if (!Array.isArray(sessions)) return [];
  return sessions.filter(isSessionSummary);
}

export function summarizeCliHostStats(results: CliHostStatsResult[]): HostStats["cliSessions"] {
  const runningSessions = results.flatMap((result) => (result.ok ? sessionsFromHealth(result.health) : [])).filter((session) => session.status === "RUNNING");
  return {
    active: runningSessions.length,
    attached: runningSessions.filter((session) => session.attachmentCount > 0).length,
    detached: runningSessions.filter((session) => session.attachmentCount <= 0).length,
    status: results.some((result) => !result.ok) ? "PARTIAL" : "OK"
  };
}

async function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await promise };
  } catch {
    return { ok: false };
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Timed out collecting host stats.")), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function emptyMemory(): Pick<HostStats, "memory" | "swap"> {
  return {
    memory: { usedBytes: null, totalBytes: null, usagePercent: null },
    swap: { usedBytes: null, totalBytes: null, usagePercent: null }
  };
}

export function createHostStatsProvider(options: HostStatsProviderOptions): HostStatsProvider {
  const timeoutMs = Math.max(Math.trunc(options.timeoutMs ?? defaultHostStatsTimeoutMs), 1);
  const cacheTtlMs = Math.max(Math.trunc(options.cacheTtlMs ?? defaultHostStatsCacheTtlMs), 0);
  const readMeminfo = options.readMeminfo ?? (() => readFile("/proc/meminfo", "utf8"));
  const readProcStat = options.readProcStat ?? (() => readFile("/proc/stat", "utf8"));
  const now = options.now ?? (() => new Date());
  const coreCount = options.coreCount === undefined ? Math.max(cpus().length, 1) : options.coreCount;
  let previousCpu: ProcCpuSample | null = null;
  let cached: { value: HostStats; expiresAt: number } | null = null;
  let inFlight: Promise<HostStats> | null = null;

  async function collect(): Promise<HostStats> {
    const [memoryResult, cpuResult, cliResults] = await Promise.all([
      settle(readMeminfo().then(parseMeminfo)),
      settle(readProcStat().then(parseProcStat)),
      Promise.all(
        options.cliHosts
          .filter((host) => host.enabled)
          .map(async (host) => {
            const result = await settle(withTimeout(host.health(), timeoutMs));
            return { hostId: host.hostId, ok: result.ok, health: result.ok ? result.value : null };
          })
      )
    ]);
    const memory = memoryResult.ok ? memoryResult.value : emptyMemory();
    const currentCpu = cpuResult.ok ? cpuResult.value : null;
    const cpuUsage = currentCpu && previousCpu ? calculateCpuUsagePercent(previousCpu, currentCpu) : null;
    if (currentCpu) previousCpu = currentCpu;
    return {
      cliSessions: summarizeCliHostStats(cliResults),
      cpu: {
        usagePercent: cpuUsage,
        coreCount
      },
      ...memory,
      apiStartedAt: options.apiStartedAt,
      sampledAt: now().toISOString()
    };
  }

  function refresh(): Promise<HostStats> {
    if (inFlight) return inFlight;
    const request = collect().then((value) => {
      cached = { value, expiresAt: now().getTime() + cacheTtlMs };
      return value;
    });
    inFlight = request;
    const clearIfCurrent = () => {
      if (inFlight === request) inFlight = null;
    };
    void request.then(clearIfCurrent, clearIfCurrent);
    return request;
  }

  return async () => {
    const nowMs = now().getTime();
    if (cached && cached.expiresAt > nowMs) return cached.value;
    if (cached) {
      void refresh().catch(() => undefined);
      return cached.value;
    }
    return refresh();
  };
}
