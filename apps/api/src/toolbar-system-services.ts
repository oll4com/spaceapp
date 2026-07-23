import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { z } from "zod";
import {
  cliSessionStatsSchema,
  codexUsageAccountListSchema,
  hostMemoryDetailsSchema,
  type CliSessionStats,
  type CodexUsageAccountList,
  type HostMemoryDetails
} from "@space/contracts";
import type { MemoryReclaimResponse } from "@space/contracts";

const execFileAsync = promisify(execFile);
const kib = 1024;
const usageCacheTtlMs = 60_000;
const usageStaleFallbackMs = 10 * 60_000;
const cliCleanupGraceMs = 5 * 60_000;
const memoryCacheTtlMs = 10_000;
const minimumDropCacheBytes = 256 * 1024 * 1024;
const genericUsageError = "Usage data is temporarily unavailable.";

const codexUsageSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.literal("vm214-codex-lb"),
  accounts: z.array(z.object({
    id: z.string().min(1).max(160),
    label: z.string().min(1).max(200),
    fiveHourRemainingPercent: z.number().min(0).max(100).nullable(),
    weeklyRemainingPercent: z.number().min(0).max(100).nullable(),
    sampledAt: z.string().datetime().nullable()
  }).strict()).max(100)
}).strict();

export interface InvalidatableProvider<T> {
  (): Promise<T>;
  invalidate(): void;
}

export type KernelCacheReclaimResult = MemoryReclaimResponse["kernelCache"];

export const MEMORY_RECLAIM_COMMAND = {
  command: "/usr/bin/sudo",
  args: ["-n", "/opt/spaceapp/bin/space-memory-reclaim"] as const
};

export const CODEX_USAGE_COMMAND = {
  command: "/usr/bin/sudo",
  args: ["-n", "/opt/spaceapp/bin/space-codex-account-usage"] as const
};

const kernelCacheReclaimResultSchema = z.object({
  status: z.enum(["CLEARED", "SKIPPED_LOW_PRESSURE", "SKIPPED_SMALL_CACHE", "SKIPPED_COOLDOWN", "FAILED"]),
  reclaimedBytes: z.number().int().min(0),
  message: z.string().min(1).max(500).nullable()
}).strict();

type ToolbarHostId = "main" | "root";

interface ToolbarHostHealth {
  sessions?: unknown;
}

interface ToolbarSessionInput {
  cliSessionId?: unknown;
  paneId?: unknown;
  roomId?: unknown;
  runtimeId?: unknown;
  pid?: unknown;
  status?: unknown;
  attachmentCount?: unknown;
  startedAt?: unknown;
  detachedAt?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validIso(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function percentOrNull(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(parsed)) return null;
  return Math.min(Math.max(Math.round(parsed * 10) / 10, 0), 100);
}

function byteCount(value: number): number {
  return Number.isFinite(value) ? Math.max(Math.trunc(value), 0) : 0;
}

function page(totalItems: number) {
  return { page: 1, pageSize: 100, totalItems, totalPages: totalItems ? 1 : 0 };
}

export function parseCodexUsageAccounts(raw: string, checkedAt: Date): CodexUsageAccountList {
  const snapshot = codexUsageSnapshotSchema.parse(JSON.parse(raw) as unknown);
  const data = snapshot.accounts.map((account) => ({
    id: account.id,
    label: account.label,
    fiveHourRemainingPercent: percentOrNull(account.fiveHourRemainingPercent),
    weeklyRemainingPercent: percentOrNull(account.weeklyRemainingPercent),
    sampledAt: validIso(account.sampledAt)
  }));
  return codexUsageAccountListSchema.parse({
    data,
    pagination: page(data.length),
    source: snapshot.source,
    isStale: false,
    error: null,
    checkedAt: checkedAt.toISOString()
  });
}

export function createCodexUsageRemoteReader(options: {
  timeoutMs?: number;
} = {}): () => Promise<string> {
  const timeoutMs = Math.max(Math.min(Math.trunc(options.timeoutMs ?? 5_000), 5_000), 250);
  return async () => {
    const { stdout } = await execFileAsync(
      CODEX_USAGE_COMMAND.command,
      [...CODEX_USAGE_COMMAND.args],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 }
    );
    return String(stdout);
  };
}

export function createCodexUsageAccountProvider(options: {
  readUsage: () => Promise<string>;
  now?: () => Date;
}): () => Promise<CodexUsageAccountList> {
  const now = options.now ?? (() => new Date());
  let cached: { value: CodexUsageAccountList; collectedAtMs: number } | null = null;
  let inFlight: Promise<CodexUsageAccountList> | null = null;

  function unavailable(): CodexUsageAccountList {
    const current = now();
    if (cached && current.getTime() - cached.collectedAtMs <= usageStaleFallbackMs) {
      return codexUsageAccountListSchema.parse({
        ...cached.value,
        isStale: true,
        error: genericUsageError,
        checkedAt: current.toISOString()
      });
    }
    return codexUsageAccountListSchema.parse({
      data: [],
      pagination: page(0),
      source: "vm214-codex-lb",
      isStale: true,
      error: genericUsageError,
      checkedAt: current.toISOString()
    });
  }

  function refresh(): Promise<CodexUsageAccountList> {
    if (inFlight) return inFlight;
    const request = options.readUsage().then((raw) => {
      const collectedAt = now();
      const value = parseCodexUsageAccounts(raw, collectedAt);
      cached = { value, collectedAtMs: collectedAt.getTime() };
      return value;
    }).catch(() => unavailable());
    inFlight = request;
    const clear = () => {
      if (inFlight === request) inFlight = null;
    };
    void request.then(clear, clear);
    return request;
  }

  return async () => {
    const nowMs = now().getTime();
    if (cached && nowMs - cached.collectedAtMs <= usageCacheTtlMs) return cached.value;
    return refresh();
  };
}

function parseRunningSession(value: unknown): ToolbarSessionInput | null {
  if (!isRecord(value) || value.status !== "RUNNING") return null;
  if (
    typeof value.cliSessionId !== "string" ||
    typeof value.paneId !== "string" ||
    typeof value.roomId !== "string" ||
    typeof value.runtimeId !== "string" ||
    !Number.isInteger(value.pid) ||
    (value.pid as number) <= 0 ||
    !Number.isInteger(value.attachmentCount) ||
    (value.attachmentCount as number) < 0 ||
    !validIso(value.startedAt)
  ) return null;
  return value;
}

export async function readProcessRssBytes(pid: number): Promise<number> {
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    return match ? Number.parseInt(match[1] ?? "0", 10) * kib : 0;
  } catch {
    return 0;
  }
}

export async function collectCliSessionStats(options: {
  hosts: Array<{ hostId: ToolbarHostId; health: ToolbarHostHealth }>;
  readRssBytes?: (pid: number) => Promise<number>;
  now?: () => Date;
}): Promise<CliSessionStats> {
  const now = options.now?.() ?? new Date();
  const nowMs = now.getTime();
  const readRss = options.readRssBytes ?? readProcessRssBytes;
  const running = options.hosts.flatMap(({ hostId, health }) => {
    const sessions = Array.isArray(health.sessions) ? health.sessions : [];
    return sessions.flatMap((value) => {
      const session = parseRunningSession(value);
      return session ? [{ hostId, session }] : [];
    });
  });
  const details = await Promise.all(running.slice(0, 500).map(async ({ hostId, session }) => {
    const detachedAt = validIso(session.detachedAt);
    const attachmentCount = session.attachmentCount as number;
    const cleanupEligible = attachmentCount === 0 && detachedAt !== null && nowMs - Date.parse(detachedAt) >= cliCleanupGraceMs;
    return {
      sessionId: session.cliSessionId as string,
      hostId,
      runtimeId: session.runtimeId as string,
      roomId: session.roomId as string,
      paneId: session.paneId as string,
      pid: session.pid as number,
      status: "RUNNING" as const,
      attachmentCount,
      startedAt: validIso(session.startedAt)!,
      detachedAt,
      rssBytes: byteCount(await readRss(session.pid as number)),
      cleanupEligible
    };
  }));
  return cliSessionStatsSchema.parse({
    summary: {
      running: running.length,
      attached: running.filter(({ session }) => (session.attachmentCount as number) > 0).length,
      detached: running.filter(({ session }) => (session.attachmentCount as number) === 0).length,
      cleanupEligible: details.filter((session) => session.cleanupEligible).length
    },
    sessions: details,
    sampledAt: now.toISOString()
  });
}

export function createCliSessionStatsProvider(options: {
  collect: () => Promise<CliSessionStats>;
  now?: () => Date;
  cacheTtlMs?: number;
}): InvalidatableProvider<CliSessionStats> {
  const now = options.now ?? (() => new Date());
  const cacheTtlMs = Math.max(Math.trunc(options.cacheTtlMs ?? 5_000), 0);
  let cached: { value: CliSessionStats; expiresAtMs: number } | null = null;
  let inFlight: Promise<CliSessionStats> | null = null;
  const provider = (async () => {
    if (cached && cached.expiresAtMs > now().getTime()) return cached.value;
    if (inFlight) return inFlight;
    const request = options.collect().then((value) => {
      cached = { value, expiresAtMs: now().getTime() + cacheTtlMs };
      return value;
    });
    inFlight = request;
    const clear = () => {
      if (inFlight === request) inFlight = null;
    };
    void request.then(clear, clear);
    return request;
  }) as InvalidatableProvider<CliSessionStats>;
  provider.invalidate = () => {
    cached = null;
  };
  return provider;
}

function parseMeminfoValues(raw: string): Map<string, number> {
  const values = new Map<string, number>();
  for (const line of raw.split("\n")) {
    const match = /^([A-Za-z_()]+):\s+(\d+)\s+kB\b/.exec(line.trim());
    if (match) values.set(match[1] ?? "", Number.parseInt(match[2] ?? "0", 10) * kib);
  }
  return values;
}

function roundedPercent(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.min(Math.max(Math.round((numerator / denominator) * 1_000) / 10, 0), 100);
}

function safeProcessName(value: string): string {
  const sanitized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return (sanitized || "unknown").slice(0, 120);
}

function parseProcessTable(raw: string) {
  return raw.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match) return [];
    const pid = Number.parseInt(match[1] ?? "0", 10);
    const rssBytes = Number.parseInt(match[2] ?? "0", 10) * kib;
    const cpu = Number.parseFloat(match[3] ?? "0");
    if (!Number.isInteger(pid) || pid <= 0) return [];
    return [{
      pid,
      name: safeProcessName(match[5] ?? "unknown"),
      rssBytes: byteCount(rssBytes),
      cpuPercent: Number.isFinite(cpu) ? Math.min(Math.max(Math.round(cpu * 10) / 10, 0), 100) : null,
      state: (match[4] ?? "?").slice(0, 16)
    }];
  }).slice(0, 10);
}

async function defaultProcessTable(): Promise<string> {
  const { stdout } = await execFileAsync(
    "ps",
    ["-eo", "pid=,rss=,pcpu=,stat=,comm=", "--sort=-rss"],
    { timeout: 2_000, maxBuffer: 512 * 1024 }
  );
  return String(stdout);
}

export function createHostMemoryDetailsProvider(options: {
  cliSessions: () => Promise<Pick<CliSessionStats, "summary"> & { sessions: Array<{ pid: number; cleanupEligible: boolean }> }>;
  readMeminfo?: () => Promise<string>;
  readProcessTable?: () => Promise<string>;
  now?: () => Date;
  cacheTtlMs?: number;
}): InvalidatableProvider<HostMemoryDetails> {
  const now = options.now ?? (() => new Date());
  const readMeminfo = options.readMeminfo ?? (() => readFile("/proc/meminfo", "utf8"));
  const readProcessTable = options.readProcessTable ?? defaultProcessTable;
  const cacheTtlMs = Math.max(Math.trunc(options.cacheTtlMs ?? memoryCacheTtlMs), 0);
  let cached: { value: HostMemoryDetails; expiresAtMs: number } | null = null;
  let inFlight: Promise<HostMemoryDetails> | null = null;

  function refresh(): Promise<HostMemoryDetails> {
    if (inFlight) return inFlight;
    const request = Promise.all([readMeminfo(), readProcessTable(), options.cliSessions()]).then(([meminfo, ps, cli]) => {
      const sampled = now();
      const values = parseMeminfoValues(meminfo);
      const totalBytes = values.get("MemTotal") ?? 0;
      const availableBytes = values.get("MemAvailable") ?? 0;
      const usedBytes = Math.max(totalBytes - availableBytes, 0);
      const pageCacheBytes = Math.max((values.get("Cached") ?? 0) - (values.get("Shmem") ?? 0), 0);
      const swapTotalBytes = values.get("SwapTotal") ?? 0;
      const swapUsedBytes = Math.max(swapTotalBytes - (values.get("SwapFree") ?? 0), 0);
      const availablePercent = roundedPercent(availableBytes, totalBytes);
      const isUnderPressure = totalBytes > 0 && availablePercent <= 20;
      const managedByPid = new Map(cli.sessions.map((session) => [session.pid, session.cleanupEligible]));
      const value = hostMemoryDetailsSchema.parse({
        memory: {
          totalBytes,
          usedBytes,
          availableBytes,
          usagePercent: roundedPercent(usedBytes, totalBytes),
          pageCacheBytes,
          reclaimableBytes: pageCacheBytes
        },
        swap: {
          totalBytes: swapTotalBytes,
          usedBytes: swapUsedBytes,
          usagePercent: roundedPercent(swapUsedBytes, swapTotalBytes)
        },
        pressure: {
          isUnderPressure,
          availablePercent,
          canDropPageCache: isUnderPressure && pageCacheBytes >= minimumDropCacheBytes
        },
        topProcesses: parseProcessTable(ps).map((process) => ({
          ...process,
          isSpaceManaged: managedByPid.has(process.pid),
          cleanupEligible: managedByPid.get(process.pid) === true
        })),
        sampledAt: sampled.toISOString()
      });
      cached = { value, expiresAtMs: sampled.getTime() + cacheTtlMs };
      return value;
    });
    inFlight = request;
    const clear = () => {
      if (inFlight === request) inFlight = null;
    };
    void request.then(clear, clear);
    return request;
  }

  const provider = (async () => {
    if (cached && cached.expiresAtMs > now().getTime()) return cached.value;
    return refresh();
  }) as InvalidatableProvider<HostMemoryDetails>;
  provider.invalidate = () => {
    cached = null;
  };
  return provider;
}

export async function runKernelCacheReclaim(): Promise<KernelCacheReclaimResult> {
  try {
    const { stdout } = await execFileAsync(MEMORY_RECLAIM_COMMAND.command, [...MEMORY_RECLAIM_COMMAND.args], {
      timeout: 15_000,
      maxBuffer: 32 * 1024
    });
    return kernelCacheReclaimResultSchema.parse(JSON.parse(String(stdout).trim()));
  } catch {
    return {
      status: "FAILED",
      reclaimedBytes: 0,
      message: "Safe memory reclaim helper failed."
    };
  }
}
