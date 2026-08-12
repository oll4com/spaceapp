import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { cpus } from "node:os";
import { promisify } from "node:util";
import {
  cliToggleRuntimeIds,
  systemAnalyticsCliSessionsResponseSchema,
  systemAnalyticsModelsResponseSchema,
  systemAnalyticsOverviewResponseSchema,
  systemAnalyticsProcessesResponseSchema,
  systemAnalyticsResourcesResponseSchema,
  type Pane,
  type PaneCliSession,
  type Room,
  type SystemAnalyticsBackfill,
  type SystemAnalyticsCliSession,
  type SystemAnalyticsCliSessionsResponse,
  type SystemAnalyticsCoverage,
  type SystemAnalyticsModel,
  type SystemAnalyticsModelsResponse,
  type SystemAnalyticsOverviewResponse,
  type SystemAnalyticsProcess,
  type SystemAnalyticsProcessesResponse,
  type SystemAnalyticsProvider,
  type SystemAnalyticsRange,
  type SystemAnalyticsResourceEntity,
  type SystemAnalyticsResourcesResponse,
  type SystemAnalyticsSeries
} from "@space/contracts";
import type {
  SystemAnalyticsModelEventRecord,
  SystemAnalyticsRepository,
  SystemAnalyticsResourceBucket,
  SystemAnalyticsResourceSample
} from "@space/db";
import type { SpaceStore } from "@space/runtime";
import { calculateCpuUsagePercent, parseMeminfo, parseProcStat, type ProcCpuSample } from "./host-stats.js";
import { cliRuntimeDescriptors, findCliRuntimeDescriptor } from "./cli-runtime-descriptors.js";
import { readOpenCodeNativeSessionId } from "./opencode-native-session.js";
import {
  readCodexRolloutTail,
  readOpenCodeModelRows,
  resolveCodexRolloutPaths,
  type OpenCodeDbRow
} from "./toolbar-model-stats.js";

const execFileAsync = promisify(execFile);
const kib = 1024;
const processTableTimeoutMs = 5_000;
const processTableMaxBuffer = 8 * 1024 * 1024;
const cleanupGraceMs = 5 * 60_000;
const modelIngestIntervalMs = 30_000;
const metadataCacheMs = 10_000;
const historyCacheMs = 30_000;
const modelErrorsMax = 20;

const rangeSettings: Record<SystemAnalyticsRange, { durationMs: number; resolutionSeconds: 10 | 60 | 900 }> = {
  "10m": { durationMs: 10 * 60_000, resolutionSeconds: 10 },
  "1h": { durationMs: 60 * 60_000, resolutionSeconds: 10 },
  "7d": { durationMs: 7 * 24 * 60 * 60_000, resolutionSeconds: 900 },
  "30d": { durationMs: 30 * 24 * 60 * 60_000, resolutionSeconds: 900 }
};

export interface SystemAnalyticsLiveSession {
  cliSessionId: string;
  paneId: string;
  roomId: string;
  runtimeId: string;
  codexThreadId: string | null;
  modelId: string | null;
  reasoningEffort: string | null;
  pid: number;
  status: "RUNNING" | "EXITED" | "ERROR";
  attachmentCount: number;
  startedAt: string;
  detachedAt: string | null;
  endedAt: string | null;
}

export interface SystemAnalyticsProcessRow {
  pid: number;
  parentPid: number;
  rssBytes: number;
  virtualBytes: number;
  swapBytes: number;
  uptimeSeconds: number;
  threadCount: number;
  cpuOneCorePercent: number;
  state: string;
  name: string;
  commandLine: string;
}

interface SessionIdentity {
  session: PaneCliSession | null;
  live: SystemAnalyticsLiveSession;
  room: Room | null;
  pane: Pane | null;
  runtimeName: string;
  providerId: string;
  modelId: string | null;
}

interface EntitySnapshot {
  sample: SystemAnalyticsResourceSample;
  pids: Set<number>;
}

interface CurrentSnapshot {
  sampledAt: string;
  coreCount: number;
  memoryTotalBytes: number;
  memoryUsedBytes: number;
  memoryAvailableBytes: number;
  memoryUsagePercent: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
  swapUsagePercent: number;
  pageCacheBytes: number;
  pressure: boolean;
  cpuUsagePercent: number;
  processes: SystemAnalyticsProcess[];
  entities: Map<string, EntitySnapshot>;
  sessions: SessionIdentity[];
}

interface MetadataSnapshot {
  rooms: Map<string, Room>;
  panes: Map<string, Pane>;
  activeSessions: Map<string, PaneCliSession>;
  expiresAt: number;
}

interface CodexNativeTurn {
  turnId: string;
  providerId: string;
  modelId: string;
  status: "RUNNING" | "COMPLETED" | "ABORTED";
  startedAt: string;
  endedAt: string | null;
  tokensIn: number;
  tokensOut: number;
  tokensReasoning: number;
  ttftMs: number | null;
  durationMs: number | null;
}

interface NativeAggregate {
  source: "codex" | "opencode";
  runtimeId: string;
  providerId: string;
  modelId: string;
  roomId: string | null;
  paneId: string | null;
  sessionId: string | null;
  status: "RUNNING" | "COMPLETED" | "ABORTED";
  coverage: "NATIVE";
  turnCount: number;
  startedAt: string;
  endedAt: string | null;
  tokensIn: number;
  tokensOut: number;
  tokensReasoning: number;
  ttftSum: number;
  ttftCount: number;
  durationSum: number;
  durationCount: number;
}

export interface SystemAnalyticsServiceOptions {
  repository: SystemAnalyticsRepository;
  store: SpaceStore;
  liveSessions: () => Promise<SystemAnalyticsLiveSession[]>;
  now?: () => Date;
  readProcessTable?: () => Promise<SystemAnalyticsProcessRow[]>;
  readMeminfo?: () => Promise<string>;
  readProcStat?: () => Promise<string>;
  stateRoot?: string;
  codexHome?: string;
  coreCount?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegativeInt(value: unknown): number {
  const parsed = numberValue(value);
  return parsed === null ? 0 : Math.max(Math.trunc(parsed), 0);
}

function safeText(value: string, fallback = "unknown", max = 120): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return (normalized || fallback).slice(0, max);
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.round(value * 10) / 10, 0), 100);
}

function byteCount(value: number): number {
  return Number.isFinite(value) ? Math.max(Math.trunc(value), 0) : 0;
}

function ratioPercent(used: number, total: number): number {
  return total > 0 ? clampPercent((used / total) * 100) : 0;
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function eventTimestampMs(record: Record<string, unknown>, payload: Record<string, unknown>): number | null {
  for (const value of [payload.completed_at, payload.started_at]) {
    const numeric = numberValue(value);
    if (numeric !== null) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }
  for (const value of [record.timestamp, payload.timestamp]) {
    const iso = isoTimestamp(value);
    if (iso) return Date.parse(iso);
  }
  return null;
}

export function parseCodexNativeTurns(content: string, sinceMs: number, nowMs: number): CodexNativeTurn[] {
  const modelByTurn = new Map<string, { providerId: string; modelId: string }>();
  const turns = new Map<string, Omit<CodexNativeTurn, "turnId" | "providerId" | "modelId">>();
  const tokensByTurn = new Map<string, Pick<CodexNativeTurn, "tokensIn" | "tokensOut" | "tokensReasoning">>();
  let currentTurn: string | null = null;
  let currentProviderId = "codex";

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = isRecord(parsed) ? parsed : null;
    const payload = record && isRecord(record.payload) ? record.payload : null;
    if (!record || !payload) continue;
    const type = stringValue(record.type);
    if (type === "session_meta") {
      currentProviderId = stringValue(payload.model_provider) || currentProviderId;
      continue;
    }
    if (type === "turn_context") {
      const turnId = stringValue(payload.turn_id);
      const modelId = stringValue(payload.model);
      if (turnId) {
        currentTurn = turnId;
        if (modelId) {
          modelByTurn.set(turnId, {
            providerId: stringValue(payload.model_provider) || currentProviderId,
            modelId
          });
        }
      }
      continue;
    }
    if (type !== "event_msg") continue;
    const eventType = stringValue(payload.type);
    if (eventType === "task_started") {
      const turnId = stringValue(payload.turn_id) || currentTurn;
      if (!turnId) continue;
      currentTurn = turnId;
      const startedAtMs = eventTimestampMs(record, payload) ?? nowMs;
      turns.set(turnId, {
        status: "RUNNING",
        startedAt: new Date(startedAtMs).toISOString(),
        endedAt: null,
        tokensIn: 0,
        tokensOut: 0,
        tokensReasoning: 0,
        ttftMs: null,
        durationMs: null
      });
      continue;
    }
    if (eventType === "token_count" && isRecord(payload.info)) {
      const usage = isRecord(payload.info.last_token_usage) ? payload.info.last_token_usage : null;
      const turnId = stringValue(payload.turn_id) || currentTurn;
      if (!usage || !turnId) continue;
      const next = {
        tokensIn: nonNegativeInt(usage.input_tokens),
        tokensOut: nonNegativeInt(usage.output_tokens),
        tokensReasoning: nonNegativeInt(usage.reasoning_output_tokens)
      };
      const prior = tokensByTurn.get(turnId);
      if (!prior || prior.tokensIn + prior.tokensOut < next.tokensIn + next.tokensOut) tokensByTurn.set(turnId, next);
      continue;
    }
    if (eventType !== "task_complete" && eventType !== "turn_aborted") continue;
    const turnId = stringValue(payload.turn_id) || currentTurn;
    if (!turnId) continue;
    currentTurn = turnId;
    const endedAtMs = eventTimestampMs(record, payload);
    if (endedAtMs === null) continue;
    const prior = turns.get(turnId);
    const durationMs = numberValue(payload.duration_ms) ?? (
      prior ? Math.max(endedAtMs - Date.parse(prior.startedAt), 0) : null
    );
    turns.set(turnId, {
      status: eventType === "turn_aborted" ? "ABORTED" : "COMPLETED",
      startedAt: prior?.startedAt ?? new Date(Math.max(endedAtMs - (durationMs ?? 0), 0)).toISOString(),
      endedAt: new Date(endedAtMs).toISOString(),
      tokensIn: 0,
      tokensOut: 0,
      tokensReasoning: 0,
      ttftMs: numberValue(payload.time_to_first_token_ms),
      durationMs
    });
  }

  return [...turns.entries()].flatMap(([turnId, turn]) => {
    const identity = modelByTurn.get(turnId);
    const endedAtMs = turn.endedAt ? Date.parse(turn.endedAt) : null;
    if (!identity || (turn.status !== "RUNNING" && (endedAtMs === null || endedAtMs < sinceMs))) return [];
    const tokens = tokensByTurn.get(turnId) ?? { tokensIn: 0, tokensOut: 0, tokensReasoning: 0 };
    return [{ turnId, ...identity, ...turn, ...tokens }];
  });
}

function processLine(line: string): SystemAnalyticsProcessRow | null {
  const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line);
  if (!match) return null;
  const pid = Number.parseInt(match[1] ?? "0", 10);
  const parentPid = Number.parseInt(match[2] ?? "0", 10);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(parentPid) || parentPid < 0) return null;
  return {
    pid,
    parentPid,
    rssBytes: byteCount(Number.parseInt(match[3] ?? "0", 10) * kib),
    virtualBytes: byteCount(Number.parseInt(match[4] ?? "0", 10) * kib),
    swapBytes: 0,
    uptimeSeconds: nonNegativeInt(match[5]),
    threadCount: nonNegativeInt(match[6]),
    cpuOneCorePercent: Math.max(numberValue(match[7]) ?? 0, 0),
    state: safeText(match[8] ?? "?", "?", 16),
    name: safeText(match[9] ?? "unknown"),
    commandLine: safeText(match[10] ?? match[9] ?? "unknown", "unknown", 2_000)
  };
}

async function readSwapBytes(pid: number): Promise<number> {
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const match = /^VmSwap:\s+(\d+)\s+kB$/m.exec(status);
    return match ? byteCount(Number.parseInt(match[1] ?? "0", 10) * kib) : 0;
  } catch {
    return 0;
  }
}

export async function readSystemAnalyticsProcessTable(): Promise<SystemAnalyticsProcessRow[]> {
  const { stdout } = await execFileAsync(
    "/bin/ps",
    ["-ww", "-eo", "pid=,ppid=,rss=,vsz=,etimes=,nlwp=,pcpu=,stat=,comm=,args="],
    {
      env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" },
      timeout: processTableTimeoutMs,
      maxBuffer: processTableMaxBuffer
    }
  );
  const rows = String(stdout).split("\n").map(processLine).filter((row): row is SystemAnalyticsProcessRow => row !== null);
  const swaps = await Promise.all(rows.map((row) => readSwapBytes(row.pid)));
  return rows.map((row, index) => ({ ...row, swapBytes: swaps[index] ?? 0 }));
}

function descendantPids(rootPid: number, children: Map<number, number[]>): Set<number> {
  const result = new Set<number>();
  const pending = [rootPid];
  while (pending.length > 0) {
    const pid = pending.pop()!;
    if (result.has(pid)) continue;
    result.add(pid);
    for (const child of children.get(pid) ?? []) pending.push(child);
  }
  return result;
}

function runtimeForSharedProcess(row: SystemAnalyticsProcessRow): string | null {
  if (/chrome[_-]devtools[_-]mcp/i.test(row.commandLine)) return null;
  const processName = row.name.toLocaleLowerCase();
  const executableTokens = row.commandLine.trim().split(/\s+/).slice(0, 8).map((token) => {
    const unquoted = token.replace(/^["']|["']$/g, "");
    const base = unquoted.split(/[\\/]/).at(-1)?.toLocaleLowerCase() ?? "";
    return base.replace(/\.(?:cjs|mjs|js|exe)$/i, "");
  });
  for (const descriptor of cliRuntimeDescriptors) {
    if (row.commandLine.includes(descriptor.commandName)) return descriptor.id;
    if (processName === descriptor.key || processName === descriptor.commandName.toLocaleLowerCase()) {
      return descriptor.id;
    }
    if (executableTokens.includes(descriptor.key) || executableTokens.includes(descriptor.commandName.toLocaleLowerCase())) {
      return descriptor.id;
    }
  }
  return null;
}

function aggregateProcessValues(rows: SystemAnalyticsProcessRow[]) {
  return {
    processCount: rows.length,
    rssBytes: byteCount(rows.reduce((sum, row) => sum + row.rssBytes, 0)),
    cpuOneCorePercent: Math.max(Math.round(rows.reduce((sum, row) => sum + row.cpuOneCorePercent, 0) * 10) / 10, 0)
  };
}

function coverageRank(coverage: SystemAnalyticsCoverage): number {
  return coverage === "NATIVE" ? 2 : coverage === "SESSION_ONLY" ? 1 : 0;
}

function modelKey(providerId: string, modelId: string): string {
  return `${providerId}\u0000${modelId}`;
}

function boundedError(error: unknown): string {
  return safeText(error instanceof Error ? error.message : String(error), "collection failed", 500);
}

export class SystemAnalyticsService {
  private readonly repository: SystemAnalyticsRepository;
  private readonly store: SpaceStore;
  private readonly liveSessionsProvider: () => Promise<SystemAnalyticsLiveSession[]>;
  private readonly now: () => Date;
  private readonly readProcessTable: () => Promise<SystemAnalyticsProcessRow[]>;
  private readonly readMeminfo: () => Promise<string>;
  private readonly readProcStat: () => Promise<string>;
  private readonly stateRoot: string;
  private readonly codexHome: string;
  private readonly coreCount: number;
  private sampleInFlight: Promise<void> | null = null;
  private modelIngestInFlight: Promise<void> | null = null;
  private backfillInFlight: Promise<void> | null = null;
  private metadata: MetadataSnapshot | null = null;
  private historyCache: { sessions: PaneCliSession[]; rooms: Map<string, Room>; panes: Map<string, Pane>; expiresAt: number } | null = null;
  private current: CurrentSnapshot | null = null;
  private previousCpu: ProcCpuSample | null = null;
  private lastModelIngestAt = 0;
  private disposed = false;

  constructor(options: SystemAnalyticsServiceOptions) {
    this.repository = options.repository;
    this.store = options.store;
    this.liveSessionsProvider = options.liveSessions;
    this.now = options.now ?? (() => new Date());
    this.readProcessTable = options.readProcessTable ?? readSystemAnalyticsProcessTable;
    this.readMeminfo = options.readMeminfo ?? (() => readFile("/proc/meminfo", "utf8"));
    this.readProcStat = options.readProcStat ?? (() => readFile("/proc/stat", "utf8"));
    this.stateRoot = options.stateRoot ?? "/var/lib/spaceapp-user/.codex/space-opencode/state";
    this.codexHome = options.codexHome ?? "/var/lib/spaceapp-user/.codex";
    this.coreCount = Math.max(Math.trunc(options.coreCount ?? cpus().length), 1);
  }

  async sample(): Promise<void> {
    if (this.disposed) return;
    if (this.sampleInFlight) return this.sampleInFlight;
    const request = this.collectSample();
    this.sampleInFlight = request;
    try {
      await request;
    } finally {
      if (this.sampleInFlight === request) this.sampleInFlight = null;
    }
  }

  private async collectSample(): Promise<void> {
    const [rawMeminfo, rawProcStat, processRows, liveSessions, metadata] = await Promise.all([
      this.readMeminfo(),
      this.readProcStat(),
      this.readProcessTable(),
      this.liveSessionsProvider(),
      this.loadMetadata()
    ]);
    const sampledAt = this.now().toISOString();
    const sampledAtMs = Date.parse(sampledAt);
    const memory = parseMeminfo(rawMeminfo);
    const memValues = new Map<string, number>();
    for (const line of rawMeminfo.split("\n")) {
      const match = /^([A-Za-z_()]+):\s+(\d+)\s+kB\b/.exec(line.trim());
      if (match) memValues.set(match[1] ?? "", Number.parseInt(match[2] ?? "0", 10) * kib);
    }
    const memoryTotalBytes = memory.memory.totalBytes ?? 0;
    const memoryUsedBytes = memory.memory.usedBytes ?? 0;
    const memoryAvailableBytes = Math.max(memoryTotalBytes - memoryUsedBytes, 0);
    const swapTotalBytes = memory.swap.totalBytes ?? 0;
    const swapUsedBytes = memory.swap.usedBytes ?? 0;
    const pageCacheBytes = Math.max((memValues.get("Cached") ?? 0) - (memValues.get("Shmem") ?? 0), 0);
    const memoryUsagePercent = ratioPercent(memoryUsedBytes, memoryTotalBytes);
    const swapUsagePercent = ratioPercent(swapUsedBytes, swapTotalBytes);
    const pressure = memoryTotalBytes > 0 && ratioPercent(memoryAvailableBytes, memoryTotalBytes) <= 20;
    const nextCpu = parseProcStat(rawProcStat);
    const processCpuEstimate = processRows.reduce((sum, row) => sum + row.cpuOneCorePercent, 0) / this.coreCount;
    const cpuUsagePercent = this.previousCpu
      ? calculateCpuUsagePercent(this.previousCpu, nextCpu) ?? clampPercent(processCpuEstimate)
      : clampPercent(processCpuEstimate);
    this.previousCpu = nextCpu;

    const children = new Map<number, number[]>();
    const processByPid = new Map(processRows.map((row) => [row.pid, row]));
    for (const row of processRows) {
      const siblings = children.get(row.parentPid) ?? [];
      siblings.push(row.pid);
      children.set(row.parentPid, siblings);
    }

    const usedPids = new Set<number>();
    const entitySnapshots = new Map<string, EntitySnapshot>();
    const sessionIdentities: SessionIdentity[] = [];
    const processOwnership = new Map<number, {
      ownership: "SPACE_CLI" | "SPACE_SHARED";
      roomName: string | null;
      paneTitle: string | null;
      runtimeId: string | null;
      sessionId: string | null;
    }>();

    for (const live of liveSessions.filter((session) => session.status === "RUNNING")) {
      const stored = metadata.activeSessions.get(live.cliSessionId) ?? null;
      const room = metadata.rooms.get(live.roomId) ?? null;
      const pane = metadata.panes.get(live.paneId) ?? null;
      const descriptor = findCliRuntimeDescriptor(live.runtimeId);
      const identity: SessionIdentity = {
        session: stored,
        live,
        room,
        pane,
        runtimeName: descriptor?.agentName ?? safeText(live.runtimeId, "CLI runtime", 160),
        providerId: stored?.providerId ?? descriptor?.providerId ?? "unknown",
        modelId: stored?.modelId ?? live.modelId ?? pane?.modelId ?? descriptor?.defaultModelId ?? null
      };
      sessionIdentities.push(identity);
      const pids = descendantPids(live.pid, children);
      const members = [...pids].flatMap((pid) => {
        const row = processByPid.get(pid);
        return row ? [row] : [];
      });
      for (const pid of pids) {
        usedPids.add(pid);
        processOwnership.set(pid, {
          ownership: "SPACE_CLI",
          roomName: room?.name ?? null,
          paneTitle: pane?.title ?? null,
          runtimeId: live.runtimeId,
          sessionId: live.cliSessionId
        });
      }
      const totals = aggregateProcessValues(members);
      const sample: SystemAnalyticsResourceSample = {
        sampledAt,
        entityType: "CLI_SESSION",
        entityId: live.cliSessionId,
        roomId: live.roomId,
        roomName: room?.name ?? `Room ${live.roomId.slice(0, 8)}`,
        paneId: live.paneId,
        paneTitle: pane?.title ?? `Pane ${live.paneId.slice(0, 8)}`,
        sessionId: live.cliSessionId,
        runtimeId: live.runtimeId,
        runtimeName: identity.runtimeName,
        providerId: identity.providerId,
        modelId: identity.modelId,
        ...totals,
        memoryTotalBytes: null,
        memoryAvailableBytes: null,
        swapTotalBytes: null,
        swapUsedBytes: null,
        pageCacheBytes: null,
        pressure: null
      };
      entitySnapshots.set(`CLI_SESSION\u0000${live.cliSessionId}`, { sample, pids });
    }

    const sharedByRuntime = new Map<string, SystemAnalyticsProcessRow[]>();
    for (const row of processRows) {
      if (usedPids.has(row.pid)) continue;
      const runtimeId = runtimeForSharedProcess(row);
      if (!runtimeId) continue;
      const members = sharedByRuntime.get(runtimeId) ?? [];
      members.push(row);
      sharedByRuntime.set(runtimeId, members);
      processOwnership.set(row.pid, {
        ownership: "SPACE_SHARED",
        roomName: null,
        paneTitle: null,
        runtimeId,
        sessionId: null
      });
    }
    for (const [runtimeId, members] of sharedByRuntime) {
      const descriptor = findCliRuntimeDescriptor(runtimeId);
      const sample: SystemAnalyticsResourceSample = {
        sampledAt,
        entityType: "SHARED_RUNTIME",
        entityId: `shared:${runtimeId}`,
        roomId: null,
        roomName: null,
        paneId: null,
        paneTitle: null,
        sessionId: null,
        runtimeId,
        runtimeName: descriptor?.agentName ?? safeText(runtimeId, "Shared CLI runtime", 160),
        providerId: descriptor?.providerId ?? null,
        modelId: descriptor?.defaultModelId ?? null,
        ...aggregateProcessValues(members),
        memoryTotalBytes: null,
        memoryAvailableBytes: null,
        swapTotalBytes: null,
        swapUsedBytes: null,
        pageCacheBytes: null,
        pressure: null
      };
      entitySnapshots.set(`SHARED_RUNTIME\u0000shared:${runtimeId}`, {
        sample,
        pids: new Set(members.map((row) => row.pid))
      });
    }

    const hostSample: SystemAnalyticsResourceSample = {
      sampledAt,
      entityType: "HOST",
      entityId: "host",
      roomId: null,
      roomName: null,
      paneId: null,
      paneTitle: null,
      sessionId: null,
      runtimeId: null,
      runtimeName: null,
      providerId: null,
      modelId: null,
      processCount: processRows.length,
      cpuOneCorePercent: cpuUsagePercent,
      rssBytes: memoryUsedBytes,
      memoryTotalBytes,
      memoryAvailableBytes,
      swapTotalBytes,
      swapUsedBytes,
      pageCacheBytes,
      pressure
    };

    const processes: SystemAnalyticsProcess[] = processRows.map((row) => {
      const owner = processOwnership.get(row.pid);
      return {
        pid: row.pid,
        parentPid: row.parentPid,
        name: safeText(row.name),
        state: safeText(row.state, "?", 16),
        threadCount: row.threadCount,
        uptimeSeconds: row.uptimeSeconds,
        rssBytes: row.rssBytes,
        virtualBytes: row.virtualBytes,
        swapBytes: row.swapBytes,
        cpuOneCorePercent: Math.max(Math.round(row.cpuOneCorePercent * 10) / 10, 0),
        cpuHostPercent: clampPercent(row.cpuOneCorePercent / this.coreCount),
        ownership: owner?.ownership ?? "OTHER",
        roomName: owner?.roomName ?? null,
        paneTitle: owner?.paneTitle ?? null,
        runtimeId: owner?.runtimeId ?? null,
        sessionId: owner?.sessionId ?? null
      };
    });

    this.current = {
      sampledAt,
      coreCount: this.coreCount,
      memoryTotalBytes,
      memoryUsedBytes,
      memoryAvailableBytes,
      memoryUsagePercent,
      swapTotalBytes,
      swapUsedBytes,
      swapUsagePercent,
      pageCacheBytes,
      pressure,
      cpuUsagePercent,
      processes,
      entities: entitySnapshots,
      sessions: sessionIdentities
    };
    await this.repository.insertResourceSamples([hostSample, ...[...entitySnapshots.values()].map((entity) => entity.sample)]);
    if (sampledAtMs - this.lastModelIngestAt >= modelIngestIntervalMs) {
      void this.ingestModels().catch(() => undefined);
    }
  }

  private async loadMetadata(force = false): Promise<MetadataSnapshot> {
    const nowMs = this.now().getTime();
    if (!force && this.metadata && this.metadata.expiresAt > nowMs) return this.metadata;
    const rooms = await this.store.listRooms();
    const panes = (await Promise.all(rooms.map((room) => this.store.listPanes(room.id, true)))).flat();
    const active = (await Promise.all(
      cliToggleRuntimeIds.map((runtimeId) => Promise.resolve(this.store.listActivePaneCliSessions(runtimeId)).catch(() => []))
    )).flat();
    this.metadata = {
      rooms: new Map(rooms.map((room) => [room.id, room])),
      panes: new Map(panes.map((pane) => [pane.id, pane])),
      activeSessions: new Map(active.map((session) => [session.sessionId, session])),
      expiresAt: nowMs + metadataCacheMs
    };
    return this.metadata;
  }

  private async loadSessionHistory(force = false): Promise<{
    sessions: PaneCliSession[];
    rooms: Map<string, Room>;
    panes: Map<string, Pane>;
  }> {
    const nowMs = this.now().getTime();
    if (!force && this.historyCache && this.historyCache.expiresAt > nowMs) return this.historyCache;
    const metadata = await this.loadMetadata(force);
    const sessions = (await Promise.all(
      [...metadata.panes.values()].map((pane) => Promise.resolve(this.store.listPaneCliSessions(pane.id, 100)).catch(() => []))
    )).flat();
    const result = {
      sessions,
      rooms: metadata.rooms,
      panes: metadata.panes,
      expiresAt: nowMs + historyCacheMs
    };
    this.historyCache = result;
    return result;
  }

  async ingestModels(windowMinutes = 65): Promise<void> {
    if (this.disposed) return;
    if (this.modelIngestInFlight) return this.modelIngestInFlight;
    const request = this.collectModels(windowMinutes, false).then(async (events) => {
      if (events.length > 0) await this.repository.upsertModelEvents(events);
      this.lastModelIngestAt = this.now().getTime();
    });
    this.modelIngestInFlight = request;
    try {
      await request;
    } finally {
      if (this.modelIngestInFlight === request) this.modelIngestInFlight = null;
    }
  }

  private sessionEvent(session: PaneCliSession, descriptorModel: string | null): SystemAnalyticsModelEventRecord {
    return {
      eventKey: `session:${session.sessionId}`,
      source: "session",
      runtimeId: session.runtimeId,
      providerId: session.providerId || findCliRuntimeDescriptor(session.runtimeId)?.providerId || "unknown",
      modelId: session.modelId || descriptorModel || "unknown",
      roomId: session.roomId,
      paneId: session.paneId,
      sessionId: session.sessionId,
      turnId: null,
      status: "SESSION",
      coverage: "SESSION_ONLY",
      turnCount: 0,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      tokensIn: null,
      tokensOut: null,
      tokensReasoning: null,
      ttftMs: null,
      durationMs: session.endedAt ? Math.max(Date.parse(session.endedAt) - Date.parse(session.startedAt), 0) : null,
      updatedAt: session.updatedAt
    };
  }

  private nativeEvent(input: {
    source: "codex" | "opencode";
    runtimeId: string;
    providerId: string;
    modelId: string;
    roomId: string | null;
    paneId: string | null;
    sessionId: string | null;
    turnId: string;
    status: "RUNNING" | "COMPLETED" | "ABORTED";
    startedAt: string;
    endedAt: string | null;
    tokensIn: number;
    tokensOut: number;
    tokensReasoning: number;
    ttftMs: number | null;
    durationMs: number | null;
  }): SystemAnalyticsModelEventRecord {
    return {
      eventKey: `${input.source}:${input.sessionId ?? "global"}:${input.turnId}`,
      source: input.source,
      runtimeId: input.runtimeId,
      providerId: input.providerId || "unknown",
      modelId: input.modelId || "unknown",
      roomId: input.roomId,
      paneId: input.paneId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      status: input.status,
      coverage: "NATIVE",
      turnCount: 1,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      tokensIn: input.tokensIn,
      tokensOut: input.tokensOut,
      tokensReasoning: input.tokensReasoning,
      ttftMs: input.ttftMs,
      durationMs: input.durationMs,
      updatedAt: this.now().toISOString()
    };
  }

  private async collectModels(windowMinutes: number, includeHistory: boolean): Promise<SystemAnalyticsModelEventRecord[]> {
    const sessions = includeHistory
      ? (await this.loadSessionHistory(true)).sessions
      : [...(await this.loadMetadata(true)).activeSessions.values()];
    const normalSessions = sessions.filter((session) => session.purpose === "NORMAL");
    const events = normalSessions.map((session) => this.sessionEvent(
      session,
      findCliRuntimeDescriptor(session.runtimeId)?.defaultModelId ?? null
    ));
    const sinceMs = this.now().getTime() - Math.max(windowMinutes, 1) * 60_000;

    const codexSessions = normalSessions.filter((session) => session.runtimeId === "cli:codex" && session.codexThreadId);
    if (codexSessions.length > 0) {
      const paths = await resolveCodexRolloutPaths(
        codexSessions.flatMap((session) => session.codexThreadId ? [session.codexThreadId] : []),
        this.codexHome
      );
      for (const session of codexSessions) {
        const path = session.codexThreadId ? paths.get(session.codexThreadId) : null;
        if (!path) continue;
        try {
          const turns = parseCodexNativeTurns(await readCodexRolloutTail(path), sinceMs, this.now().getTime());
          for (const turn of turns) {
            events.push(this.nativeEvent({
              source: "codex",
              runtimeId: session.runtimeId,
              roomId: session.roomId,
              paneId: session.paneId,
              sessionId: session.sessionId,
              ...turn
            }));
          }
        } catch {
          // A missing or rotating rollout only removes native detail for this session.
        }
      }
    }

    const openCodeSessions = normalSessions.filter((session) => session.runtimeId === "cli:opencode");
    if (openCodeSessions.length > 0) {
      const nativeBySession = new Map<string, string>();
      for (const session of openCodeSessions) {
        const nativeId = await readOpenCodeNativeSessionId(session.sessionId, this.stateRoot).catch(() => null);
        if (nativeId) nativeBySession.set(session.sessionId, nativeId);
      }
      if (nativeBySession.size > 0) {
        const internalByNative = new Map([...nativeBySession].map(([internal, native]) => [native, internal]));
        const sessionById = new Map(openCodeSessions.map((session) => [session.sessionId, session]));
        const rows = await readOpenCodeModelRows({
          nativeSessionIds: [...nativeBySession.values()],
          windowMinutes,
          now: this.now,
          stateRoot: this.stateRoot
        }).catch(() => []);
        events.push(...this.openCodeEvents(rows, internalByNative, sessionById));
      }
    }
    return events;
  }

  private openCodeEvents(
    rows: OpenCodeDbRow[],
    internalByNative: Map<string, string>,
    sessionById: Map<string, PaneCliSession>
  ): SystemAnalyticsModelEventRecord[] {
    const messages = new Map<string, {
      nativeSessionId: string;
      messageId: string;
      providerId: string;
      modelId: string;
      createdAtMs: number;
      tokensIn: number;
      tokensOut: number;
      tokensReasoning: number;
      stepStartedAtMs: number | null;
      firstOutputAtMs: number | null;
      stepFinishedAtMs: number | null;
    }>();
    for (const row of rows) {
      const nativeSessionId = stringValue(row.sessionId);
      const messageId = stringValue(row.messageId);
      const modelId = stringValue(row.modelID);
      const createdAtMs = numberValue(row.msgCreated);
      if (!nativeSessionId || !messageId || !modelId || createdAtMs === null) continue;
      const key = `${nativeSessionId}\u0000${messageId}`;
      const entry = messages.get(key) ?? {
        nativeSessionId,
        messageId,
        providerId: stringValue(row.providerID) || "opencode",
        modelId,
        createdAtMs,
        tokensIn: nonNegativeInt(row.msgTokensIn),
        tokensOut: nonNegativeInt(row.msgTokensOut),
        tokensReasoning: nonNegativeInt(row.msgTokensReasoning),
        stepStartedAtMs: null,
        firstOutputAtMs: null,
        stepFinishedAtMs: null
      };
      const partType = stringValue(row.partType);
      const partTime = numberValue(row.partTime);
      if (partType === "step-start" && partTime !== null) entry.stepStartedAtMs ??= partTime;
      if ((partType === "text" || partType === "reasoning") && partTime !== null) entry.firstOutputAtMs ??= partTime;
      if (partType === "step-finish" && partTime !== null) entry.stepFinishedAtMs = partTime;
      messages.set(key, entry);
    }
    return [...messages.values()].flatMap((message) => {
      const internalSessionId = internalByNative.get(message.nativeSessionId);
      const session = internalSessionId ? sessionById.get(internalSessionId) : null;
      if (!internalSessionId || !session) return [];
      const startedAtMs = message.stepStartedAtMs ?? message.createdAtMs;
      const endedAtMs = message.stepFinishedAtMs;
      const status = endedAtMs === null && session.isActive ? "RUNNING" : "COMPLETED";
      return [this.nativeEvent({
        source: "opencode",
        runtimeId: session.runtimeId,
        providerId: message.providerId,
        modelId: message.modelId,
        roomId: session.roomId,
        paneId: session.paneId,
        sessionId: session.sessionId,
        turnId: message.messageId,
        status,
        startedAt: new Date(startedAtMs).toISOString(),
        endedAt: endedAtMs === null ? null : new Date(endedAtMs).toISOString(),
        tokensIn: message.tokensIn,
        tokensOut: message.tokensOut,
        tokensReasoning: message.tokensReasoning,
        ttftMs: message.firstOutputAtMs === null ? null : Math.max(message.firstOutputAtMs - startedAtMs, 0),
        durationMs: endedAtMs === null ? null : Math.max(endedAtMs - startedAtMs, 0)
      })];
    });
  }

  async backfill(): Promise<void> {
    if (this.disposed) return;
    if (this.backfillInFlight) return this.backfillInFlight;
    const request = this.runBackfill();
    this.backfillInFlight = request;
    try {
      await request;
    } finally {
      if (this.backfillInFlight === request) this.backfillInFlight = null;
    }
  }

  private async runBackfill(): Promise<void> {
    const existing = await this.repository.getBackfill();
    if (existing.status === "COMPLETE") return;
    await this.repository.setBackfill({ ...existing, status: "RUNNING", errors: [] });
    const errors: string[] = [];
    try {
      const events = await this.collectModels(30 * 24 * 60, true);
      const chunkSize = 250;
      for (let index = 0; index < events.length; index += chunkSize) {
        await this.repository.upsertModelEvents(events.slice(index, index + chunkSize));
      }
      const activityTimes = events.flatMap((event) => [event.startedAt, ...(event.endedAt ? [event.endedAt] : [])]).sort();
      await this.repository.setBackfill({
        status: errors.length > 0 ? "PARTIAL" : "COMPLETE",
        earliestAt: activityTimes[0] ?? null,
        latestAt: activityTimes.at(-1) ?? null,
        errors: errors.slice(0, modelErrorsMax)
      });
    } catch (error) {
      errors.push(boundedError(error));
      await this.repository.setBackfill({
        status: "FAILED",
        earliestAt: existing.earliestAt,
        latestAt: existing.latestAt,
        errors: errors.slice(0, modelErrorsMax)
      });
      throw error;
    }
  }

  private async ensureFresh(): Promise<CurrentSnapshot> {
    if (!this.current || this.now().getTime() - Date.parse(this.current.sampledAt) > 15_000) await this.sample();
    if (!this.current) throw new Error("System analytics have not produced a host sample yet.");
    return this.current;
  }

  private since(range: SystemAnalyticsRange): string {
    return new Date(this.now().getTime() - rangeSettings[range].durationMs).toISOString();
  }

  private async backfillStatus(): Promise<SystemAnalyticsBackfill> {
    return this.repository.getBackfill();
  }

  async models(range: SystemAnalyticsRange): Promise<SystemAnalyticsModelsResponse> {
    const current = await this.ensureFresh();
    if (this.now().getTime() - this.lastModelIngestAt >= modelIngestIntervalMs) await this.ingestModels();
    const [events, backfill] = await Promise.all([
      this.repository.listModelEvents(this.since(range)),
      this.backfillStatus()
    ]);
    const currentSessionIds = new Set(current.sessions.map((identity) => identity.live.cliSessionId));
    const visibleEvents = events.filter(
      (event) => event.status !== "RUNNING" || Boolean(event.sessionId && currentSessionIds.has(event.sessionId))
    );
    const nativeIdentityBySession = new Map<string, { providerId: string; modelId: string }>();
    for (const event of visibleEvents) {
      if (!event.sessionId || !currentSessionIds.has(event.sessionId) || event.coverage !== "NATIVE") continue;
      if (event.status === "RUNNING" || !nativeIdentityBySession.has(event.sessionId)) {
        nativeIdentityBySession.set(event.sessionId, { providerId: event.providerId, modelId: event.modelId });
      }
    }
    const activeSessionsByModel = new Map<string, Set<string>>();
    for (const identity of current.sessions) {
      const native = nativeIdentityBySession.get(identity.live.cliSessionId);
      const providerId = native?.providerId ?? identity.providerId;
      const modelId = native?.modelId ?? identity.modelId ?? "unknown";
      const key = modelKey(providerId, modelId);
      const sessions = activeSessionsByModel.get(key) ?? new Set<string>();
      sessions.add(identity.live.cliSessionId);
      activeSessionsByModel.set(key, sessions);
    }

    const aggregates = new Map<string, {
      providerId: string;
      modelId: string;
      runtimeIds: Set<string>;
      coverage: SystemAnalyticsCoverage;
      activeTurns: number;
      completedTurns: number;
      abortedTurns: number;
      tokensIn: number;
      tokensOut: number;
      tokensReasoning: number;
      hasTokensIn: boolean;
      hasTokensOut: boolean;
      hasTokensReasoning: boolean;
      ttftSum: number;
      ttftCount: number;
      durationSum: number;
      durationCount: number;
      firstActivityAt: string | null;
      lastActivityAt: string | null;
    }>();
    for (const event of visibleEvents) {
      const key = modelKey(event.providerId, event.modelId);
      const entry = aggregates.get(key) ?? {
        providerId: event.providerId,
        modelId: event.modelId,
        runtimeIds: new Set<string>(),
        coverage: event.coverage,
        activeTurns: 0,
        completedTurns: 0,
        abortedTurns: 0,
        tokensIn: 0,
        tokensOut: 0,
        tokensReasoning: 0,
        hasTokensIn: false,
        hasTokensOut: false,
        hasTokensReasoning: false,
        ttftSum: 0,
        ttftCount: 0,
        durationSum: 0,
        durationCount: 0,
        firstActivityAt: null,
        lastActivityAt: null
      };
      entry.runtimeIds.add(event.runtimeId);
      if (coverageRank(event.coverage) > coverageRank(entry.coverage)) entry.coverage = event.coverage;
      const count = Math.max(event.turnCount, 0);
      if (event.status === "RUNNING" && (!event.sessionId || currentSessionIds.has(event.sessionId))) entry.activeTurns += count;
      if (event.status === "COMPLETED") entry.completedTurns += count;
      if (event.status === "ABORTED") entry.abortedTurns += count;
      if (event.tokensIn !== null) {
        entry.tokensIn += event.tokensIn;
        entry.hasTokensIn = true;
      }
      if (event.tokensOut !== null) {
        entry.tokensOut += event.tokensOut;
        entry.hasTokensOut = true;
      }
      if (event.tokensReasoning !== null) {
        entry.tokensReasoning += event.tokensReasoning;
        entry.hasTokensReasoning = true;
      }
      if (event.coverage === "NATIVE" && event.ttftMs !== null) {
        entry.ttftSum += event.ttftMs * Math.max(count, 1);
        entry.ttftCount += Math.max(count, 1);
      }
      if (event.coverage === "NATIVE" && event.durationMs !== null) {
        entry.durationSum += event.durationMs * Math.max(count, 1);
        entry.durationCount += Math.max(count, 1);
      }
      const lastAt = event.endedAt ?? event.updatedAt ?? event.startedAt;
      if (!entry.firstActivityAt || event.startedAt < entry.firstActivityAt) entry.firstActivityAt = event.startedAt;
      if (!entry.lastActivityAt || lastAt > entry.lastActivityAt) entry.lastActivityAt = lastAt;
      aggregates.set(key, entry);
    }
    for (const [key, sessions] of activeSessionsByModel) {
      if (aggregates.has(key)) continue;
      const separator = key.indexOf("\u0000");
      const providerId = key.slice(0, separator);
      const modelId = key.slice(separator + 1);
      const identity = current.sessions.find((candidate) => sessions.has(candidate.live.cliSessionId));
      aggregates.set(key, {
        providerId,
        modelId,
        runtimeIds: new Set(identity ? [identity.live.runtimeId] : []),
        coverage: "SESSION_ONLY",
        activeTurns: 0,
        completedTurns: 0,
        abortedTurns: 0,
        tokensIn: 0,
        tokensOut: 0,
        tokensReasoning: 0,
        hasTokensIn: false,
        hasTokensOut: false,
        hasTokensReasoning: false,
        ttftSum: 0,
        ttftCount: 0,
        durationSum: 0,
        durationCount: 0,
        firstActivityAt: identity?.live.startedAt ?? null,
        lastActivityAt: current.sampledAt
      });
    }

    const models: SystemAnalyticsModel[] = [...aggregates.entries()].map(([key, entry]) => ({
      providerId: entry.providerId,
      modelId: entry.modelId,
      runtimeIds: [...entry.runtimeIds].sort(),
      coverage: entry.coverage,
      activeSessions: activeSessionsByModel.get(key)?.size ?? 0,
      activeTurns: entry.activeTurns,
      completedTurns: entry.completedTurns,
      abortedTurns: entry.abortedTurns,
      tokensIn: entry.hasTokensIn ? entry.tokensIn : null,
      tokensOut: entry.hasTokensOut ? entry.tokensOut : null,
      tokensReasoning: entry.hasTokensReasoning ? entry.tokensReasoning : null,
      avgTtftMs: entry.ttftCount > 0 ? Math.round(entry.ttftSum / entry.ttftCount) : null,
      avgDurationMs: entry.durationCount > 0 ? Math.round(entry.durationSum / entry.durationCount) : null,
      avgTokPerSec: entry.durationSum > 0 && entry.tokensOut > 0
        ? Math.round((entry.tokensOut / (entry.durationSum / 1000)) * 10) / 10
        : null,
      firstActivityAt: entry.firstActivityAt,
      lastActivityAt: entry.lastActivityAt
    })).sort((left, right) =>
      right.activeSessions - left.activeSessions ||
      right.activeTurns - left.activeTurns ||
      right.completedTurns - left.completedTurns ||
      left.providerId.localeCompare(right.providerId) ||
      left.modelId.localeCompare(right.modelId)
    ).slice(0, 500);
    const providerMap = new Map<string, SystemAnalyticsProvider>();
    for (const model of models) {
      const provider = providerMap.get(model.providerId) ?? {
        providerId: model.providerId,
        modelCount: 0,
        activeSessions: 0,
        completedTurns: 0,
        tokensIn: null,
        tokensOut: null,
        lastActivityAt: null
      };
      provider.modelCount += 1;
      provider.activeSessions += model.activeSessions;
      provider.completedTurns += model.completedTurns;
      if (model.tokensIn !== null) provider.tokensIn = (provider.tokensIn ?? 0) + model.tokensIn;
      if (model.tokensOut !== null) provider.tokensOut = (provider.tokensOut ?? 0) + model.tokensOut;
      if (model.lastActivityAt && (!provider.lastActivityAt || model.lastActivityAt > provider.lastActivityAt)) {
        provider.lastActivityAt = model.lastActivityAt;
      }
      providerMap.set(model.providerId, provider);
    }
    return systemAnalyticsModelsResponseSchema.parse({
      range,
      sampledAt: current.sampledAt,
      providers: [...providerMap.values()].sort((left, right) => right.activeSessions - left.activeSessions || right.completedTurns - left.completedTurns),
      models,
      backfill
    });
  }

  private downsampleSeries(series: SystemAnalyticsSeries): SystemAnalyticsSeries {
    if (series.points.length <= 720) return series;
    const size = Math.ceil(series.points.length / 720);
    const points: SystemAnalyticsSeries["points"] = [];
    for (let index = 0; index < series.points.length; index += size) {
      const group = series.points.slice(index, index + size);
      points.push({
        at: group.at(-1)!.at,
        min: Math.min(...group.map((point) => point.min)),
        avg: Math.round((group.reduce((sum, point) => sum + point.avg, 0) / group.length) * 10) / 10,
        max: Math.max(...group.map((point) => point.max))
      });
    }
    return { ...series, points };
  }

  private resourceSeries(buckets: SystemAnalyticsResourceBucket[]): SystemAnalyticsSeries[] {
    const host = buckets.filter((bucket) => bucket.entityType === "HOST" && bucket.entityId === "host");
    const series: SystemAnalyticsSeries[] = [
      {
        id: "host-cpu",
        label: "Host CPU",
        unit: "PERCENT",
        points: host.map((bucket) => ({
          at: bucket.bucketAt,
          min: clampPercent(bucket.cpuMin),
          avg: clampPercent(bucket.cpuSum / Math.max(bucket.sampleCount, 1)),
          max: clampPercent(bucket.cpuMax)
        }))
      },
      {
        id: "host-memory-used",
        label: "RAM used",
        unit: "BYTES",
        points: host.map((bucket) => ({
          at: bucket.bucketAt,
          min: byteCount(bucket.rssMin),
          avg: byteCount(bucket.rssSum / Math.max(bucket.sampleCount, 1)),
          max: byteCount(bucket.rssMax)
        }))
      },
      {
        id: "host-memory-available",
        label: "RAM available",
        unit: "BYTES",
        points: host.map((bucket) => ({
          at: bucket.bucketAt,
          min: byteCount(bucket.memoryAvailableBytes ?? 0),
          avg: byteCount(bucket.memoryAvailableBytes ?? 0),
          max: byteCount(bucket.memoryAvailableBytes ?? 0)
        }))
      },
      {
        id: "host-swap-used",
        label: "Swap used",
        unit: "BYTES",
        points: host.map((bucket) => ({
          at: bucket.bucketAt,
          min: byteCount(bucket.swapUsedBytes ?? 0),
          avg: byteCount(bucket.swapUsedBytes ?? 0),
          max: byteCount(bucket.swapUsedBytes ?? 0)
        }))
      },
      {
        id: "host-page-cache",
        label: "Page cache",
        unit: "BYTES",
        points: host.map((bucket) => ({
          at: bucket.bucketAt,
          min: byteCount(bucket.pageCacheBytes ?? 0),
          avg: byteCount(bucket.pageCacheBytes ?? 0),
          max: byteCount(bucket.pageCacheBytes ?? 0)
        }))
      }
    ];
    return series.map((entry) => this.downsampleSeries(entry));
  }

  private aggregateEntities(
    buckets: SystemAnalyticsResourceBucket[],
    current: CurrentSnapshot
  ): SystemAnalyticsResourceEntity[] {
    const grouped = new Map<string, {
      latest: SystemAnalyticsResourceBucket;
      sampleCount: number;
      cpuSum: number;
      cpuMax: number;
      rssSum: number;
      rssMax: number;
    }>();
    for (const bucket of buckets) {
      if (bucket.entityType === "HOST") continue;
      const key = `${bucket.entityType}\u0000${bucket.entityId}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.latest = bucket.bucketAt >= existing.latest.bucketAt ? bucket : existing.latest;
        existing.sampleCount += bucket.sampleCount;
        existing.cpuSum += bucket.cpuSum;
        existing.cpuMax = Math.max(existing.cpuMax, bucket.cpuMax);
        existing.rssSum += bucket.rssSum;
        existing.rssMax = Math.max(existing.rssMax, bucket.rssMax);
      } else {
        grouped.set(key, {
          latest: bucket,
          sampleCount: bucket.sampleCount,
          cpuSum: bucket.cpuSum,
          cpuMax: bucket.cpuMax,
          rssSum: bucket.rssSum,
          rssMax: bucket.rssMax
        });
      }
    }
    for (const [key, entity] of current.entities) {
      if (grouped.has(key)) continue;
      const sample = entity.sample;
      grouped.set(key, {
        latest: {
          ...sample,
          resolutionSeconds: 10,
          bucketAt: sample.sampledAt,
          sampleCount: 1,
          cpuMin: sample.cpuOneCorePercent,
          cpuSum: sample.cpuOneCorePercent,
          cpuMax: sample.cpuOneCorePercent,
          rssMin: sample.rssBytes,
          rssSum: sample.rssBytes,
          rssMax: sample.rssBytes
        },
        sampleCount: 1,
        cpuSum: sample.cpuOneCorePercent,
        cpuMax: sample.cpuOneCorePercent,
        rssSum: sample.rssBytes,
        rssMax: sample.rssBytes
      });
    }
    return [...grouped.entries()].map(([key, aggregate]) => {
      const currentSample = current.entities.get(key)?.sample;
      const latest = currentSample ?? {
        sampledAt: aggregate.latest.bucketAt,
        entityType: aggregate.latest.entityType,
        entityId: aggregate.latest.entityId,
        roomId: aggregate.latest.roomId,
        roomName: aggregate.latest.roomName,
        paneId: aggregate.latest.paneId,
        paneTitle: aggregate.latest.paneTitle,
        sessionId: aggregate.latest.sessionId,
        runtimeId: aggregate.latest.runtimeId,
        runtimeName: aggregate.latest.runtimeName,
        providerId: aggregate.latest.providerId,
        modelId: aggregate.latest.modelId,
        processCount: aggregate.latest.processCount,
        cpuOneCorePercent: aggregate.latest.cpuSum / Math.max(aggregate.latest.sampleCount, 1),
        rssBytes: aggregate.latest.rssSum / Math.max(aggregate.latest.sampleCount, 1),
        memoryTotalBytes: aggregate.latest.memoryTotalBytes,
        memoryAvailableBytes: aggregate.latest.memoryAvailableBytes,
        swapTotalBytes: aggregate.latest.swapTotalBytes,
        swapUsedBytes: aggregate.latest.swapUsedBytes,
        pageCacheBytes: aggregate.latest.pageCacheBytes,
        pressure: aggregate.latest.pressure
      };
      return {
        entityType: latest.entityType as "CLI_SESSION" | "SHARED_RUNTIME",
        entityId: latest.entityId,
        roomId: latest.roomId,
        roomName: latest.roomName,
        paneId: latest.paneId,
        paneTitle: latest.paneTitle,
        sessionId: latest.sessionId,
        runtimeId: latest.runtimeId,
        runtimeName: latest.runtimeName,
        providerId: latest.providerId,
        modelId: latest.modelId,
        processCount: latest.processCount,
        cpuOneCorePercent: Math.max(Math.round(latest.cpuOneCorePercent * 10) / 10, 0),
        cpuHostPercent: clampPercent(latest.cpuOneCorePercent / current.coreCount),
        rssBytes: byteCount(latest.rssBytes),
        avgCpuOneCorePercent: Math.max(Math.round((aggregate.cpuSum / Math.max(aggregate.sampleCount, 1)) * 10) / 10, 0),
        maxCpuOneCorePercent: Math.max(Math.round(aggregate.cpuMax * 10) / 10, 0),
        avgRssBytes: byteCount(aggregate.rssSum / Math.max(aggregate.sampleCount, 1)),
        maxRssBytes: byteCount(aggregate.rssMax)
      };
    }).sort((left, right) =>
      right.rssBytes - left.rssBytes ||
      right.cpuOneCorePercent - left.cpuOneCorePercent ||
      (left.paneTitle ?? left.runtimeName ?? left.entityId).localeCompare(right.paneTitle ?? right.runtimeName ?? right.entityId)
    ).slice(0, 500);
  }

  async resources(range: SystemAnalyticsRange): Promise<SystemAnalyticsResourcesResponse> {
    const current = await this.ensureFresh();
    const settings = rangeSettings[range];
    const [buckets, backfill] = await Promise.all([
      this.repository.listResourceBuckets({ since: this.since(range), resolutionSeconds: settings.resolutionSeconds }),
      this.backfillStatus()
    ]);
    return systemAnalyticsResourcesResponseSchema.parse({
      range,
      sampledAt: current.sampledAt,
      current: {
        cpuUsagePercent: current.cpuUsagePercent,
        coreCount: current.coreCount,
        memoryTotalBytes: current.memoryTotalBytes,
        memoryUsedBytes: current.memoryUsedBytes,
        memoryAvailableBytes: current.memoryAvailableBytes,
        memoryUsagePercent: current.memoryUsagePercent,
        swapTotalBytes: current.swapTotalBytes,
        swapUsedBytes: current.swapUsedBytes,
        swapUsagePercent: current.swapUsagePercent,
        pageCacheBytes: current.pageCacheBytes,
        pressure: current.pressure
      },
      series: this.resourceSeries(buckets),
      entities: this.aggregateEntities(buckets, current),
      backfill
    });
  }

  async processes(input: {
    page: number;
    pageSize: number;
    sort: "rss" | "cpu" | "pid" | "uptime" | "name";
    direction: "asc" | "desc";
    query?: string;
    ownership?: "ALL" | "SPACE_CLI" | "SPACE_SHARED" | "OTHER";
  }): Promise<SystemAnalyticsProcessesResponse> {
    const current = await this.ensureFresh();
    const query = input.query?.trim().toLocaleLowerCase() ?? "";
    const filtered = current.processes.filter((process) => {
      if (input.ownership && input.ownership !== "ALL" && process.ownership !== input.ownership) return false;
      if (!query) return true;
      return [process.name, process.roomName, process.paneTitle, process.runtimeId, process.sessionId]
        .some((value) => value?.toLocaleLowerCase().includes(query));
    });
    const value = (process: SystemAnalyticsProcess): number | string => {
      if (input.sort === "rss") return process.rssBytes;
      if (input.sort === "cpu") return process.cpuOneCorePercent;
      if (input.sort === "uptime") return process.uptimeSeconds;
      if (input.sort === "name") return process.name.toLocaleLowerCase();
      return process.pid;
    };
    filtered.sort((left, right) => {
      const a = value(left);
      const b = value(right);
      const compared = typeof a === "string" && typeof b === "string" ? a.localeCompare(b) : Number(a) - Number(b);
      return input.direction === "asc" ? compared : -compared;
    });
    const totalItems = filtered.length;
    const totalPages = totalItems > 0 ? Math.ceil(totalItems / input.pageSize) : 0;
    const page = totalPages > 0 ? Math.min(input.page, totalPages) : 1;
    const start = (page - 1) * input.pageSize;
    return systemAnalyticsProcessesResponseSchema.parse({
      data: filtered.slice(start, start + input.pageSize),
      pagination: { page, pageSize: input.pageSize, totalItems, totalPages },
      sampledAt: current.sampledAt
    });
  }

  async cliSessions(range: SystemAnalyticsRange): Promise<SystemAnalyticsCliSessionsResponse> {
    const current = await this.ensureFresh();
    const history = await this.loadSessionHistory();
    const sinceMs = Date.parse(this.since(range));
    const liveBySession = new Map(current.sessions.map((identity) => [identity.live.cliSessionId, identity]));
    const buckets = await this.repository.listResourceBuckets({
      since: this.since(range),
      resolutionSeconds: rangeSettings[range].resolutionSeconds
    });
    const resources = new Map<string, { count: number; cpuSum: number; cpuMax: number; rssSum: number; rssMax: number }>();
    for (const bucket of buckets) {
      if (bucket.entityType !== "CLI_SESSION" || !bucket.sessionId) continue;
      const entry = resources.get(bucket.sessionId) ?? { count: 0, cpuSum: 0, cpuMax: 0, rssSum: 0, rssMax: 0 };
      entry.count += bucket.sampleCount;
      entry.cpuSum += bucket.cpuSum;
      entry.cpuMax = Math.max(entry.cpuMax, bucket.cpuMax);
      entry.rssSum += bucket.rssSum;
      entry.rssMax = Math.max(entry.rssMax, bucket.rssMax);
      resources.set(bucket.sessionId, entry);
    }
    const seen = new Set<string>();
    const allSessions = [...history.sessions, ...current.sessions.flatMap((identity) => identity.session ? [identity.session] : [])]
      .filter((session) => {
        if (seen.has(session.sessionId)) return false;
        seen.add(session.sessionId);
        const endMs = session.endedAt ? Date.parse(session.endedAt) : this.now().getTime();
        return endMs >= sinceMs;
      });
    const sessions: SystemAnalyticsCliSession[] = allSessions.map((session) => {
      const live = liveBySession.get(session.sessionId);
      const room = history.rooms.get(session.roomId);
      const pane = history.panes.get(session.paneId);
      const descriptor = findCliRuntimeDescriptor(session.runtimeId);
      const entity = current.entities.get(`CLI_SESSION\u0000${session.sessionId}`)?.sample;
      const aggregate = resources.get(session.sessionId);
      const endedAt = live ? null : session.endedAt;
      const durationEnd = endedAt ? Date.parse(endedAt) : this.now().getTime();
      const detachedAt = live?.live.detachedAt ?? null;
      const attachmentCount = live?.live.attachmentCount ?? 0;
      return {
        sessionId: session.sessionId,
        roomId: session.roomId,
        roomName: room?.name ?? `Room ${session.roomId.slice(0, 8)}`,
        paneId: session.paneId,
        paneTitle: pane?.title ?? `Pane ${session.paneId.slice(0, 8)}`,
        runtimeId: session.runtimeId,
        runtimeName: descriptor?.agentName ?? safeText(session.runtimeId, "CLI runtime", 160),
        providerId: session.providerId || descriptor?.providerId || "unknown",
        modelId: session.modelId ?? pane?.modelId ?? descriptor?.defaultModelId ?? null,
        reasoningEffort: session.reasoningEffort,
        status: live ? "RUNNING" : session.status,
        attachmentCount,
        cleanupEligible: Boolean(live && attachmentCount === 0 && detachedAt && this.now().getTime() - Date.parse(detachedAt) >= cleanupGraceMs),
        processCount: entity?.processCount ?? 0,
        pid: live?.live.pid ?? null,
        rssBytes: byteCount(entity?.rssBytes ?? 0),
        cpuOneCorePercent: Math.max(entity?.cpuOneCorePercent ?? 0, 0),
        startedAt: session.startedAt,
        detachedAt,
        endedAt,
        durationSeconds: Math.max(Math.trunc((durationEnd - Date.parse(session.startedAt)) / 1000), 0),
        avgRssBytes: byteCount(aggregate ? aggregate.rssSum / Math.max(aggregate.count, 1) : entity?.rssBytes ?? 0),
        maxRssBytes: byteCount(aggregate?.rssMax ?? entity?.rssBytes ?? 0),
        avgCpuOneCorePercent: Math.max(aggregate ? aggregate.cpuSum / Math.max(aggregate.count, 1) : entity?.cpuOneCorePercent ?? 0, 0),
        maxCpuOneCorePercent: Math.max(aggregate?.cpuMax ?? entity?.cpuOneCorePercent ?? 0, 0)
      };
    });
    for (const identity of current.sessions) {
      if (identity.session || seen.has(identity.live.cliSessionId)) continue;
      const live = identity.live;
      const entity = current.entities.get(`CLI_SESSION\u0000${live.cliSessionId}`)?.sample;
      const aggregate = resources.get(live.cliSessionId);
      const detachedAt = live.detachedAt;
      const reasoningEffort = live.reasoningEffort && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(live.reasoningEffort)
        ? live.reasoningEffort
        : "unknown";
      sessions.push({
        sessionId: live.cliSessionId,
        roomId: live.roomId,
        roomName: identity.room?.name ?? `Room ${live.roomId.slice(0, 8)}`,
        paneId: live.paneId,
        paneTitle: identity.pane?.title ?? `Pane ${live.paneId.slice(0, 8)}`,
        runtimeId: live.runtimeId,
        runtimeName: identity.runtimeName,
        providerId: identity.providerId,
        modelId: identity.modelId,
        reasoningEffort,
        status: "RUNNING",
        attachmentCount: live.attachmentCount,
        cleanupEligible: Boolean(
          live.attachmentCount === 0 && detachedAt && this.now().getTime() - Date.parse(detachedAt) >= cleanupGraceMs
        ),
        processCount: entity?.processCount ?? 0,
        pid: live.pid,
        rssBytes: byteCount(entity?.rssBytes ?? 0),
        cpuOneCorePercent: Math.max(entity?.cpuOneCorePercent ?? 0, 0),
        startedAt: live.startedAt,
        detachedAt,
        endedAt: null,
        durationSeconds: Math.max(Math.trunc((this.now().getTime() - Date.parse(live.startedAt)) / 1000), 0),
        avgRssBytes: byteCount(aggregate ? aggregate.rssSum / Math.max(aggregate.count, 1) : entity?.rssBytes ?? 0),
        maxRssBytes: byteCount(aggregate?.rssMax ?? entity?.rssBytes ?? 0),
        avgCpuOneCorePercent: Math.max(
          aggregate ? aggregate.cpuSum / Math.max(aggregate.count, 1) : entity?.cpuOneCorePercent ?? 0,
          0
        ),
        maxCpuOneCorePercent: Math.max(aggregate?.cpuMax ?? entity?.cpuOneCorePercent ?? 0, 0)
      });
    }
    sessions.sort((left, right) =>
      Number(right.status === "RUNNING") - Number(left.status === "RUNNING") ||
      right.startedAt.localeCompare(left.startedAt)
    );
    const backfill = await this.backfillStatus();
    return systemAnalyticsCliSessionsResponseSchema.parse({
      range,
      sampledAt: current.sampledAt,
      summary: {
        running: sessions.filter((session) => session.status === "RUNNING").length,
        attached: sessions.filter((session) => session.status === "RUNNING" && session.attachmentCount > 0).length,
        detached: sessions.filter((session) => session.status === "RUNNING" && session.attachmentCount === 0).length,
        cleanupEligible: sessions.filter((session) => session.cleanupEligible).length
      },
      sessions: sessions.slice(0, 1000),
      backfill
    });
  }

  async overview(range: SystemAnalyticsRange): Promise<SystemAnalyticsOverviewResponse> {
    const [models, resources, sessions] = await Promise.all([
      this.models(range),
      this.resources(range),
      this.cliSessions(range)
    ]);
    return systemAnalyticsOverviewResponseSchema.parse({
      range,
      sampledAt: resources.sampledAt,
      modelCount: models.models.length,
      providerCount: models.providers.length,
      runningCliSessions: sessions.summary.running,
      cpuUsagePercent: resources.current.cpuUsagePercent,
      memoryUsagePercent: resources.current.memoryUsagePercent,
      swapUsagePercent: resources.current.swapUsagePercent,
      topEntities: resources.entities.slice(0, 10),
      backfill: models.backfill
    });
  }

  async rollupAndSweep(): Promise<void> {
    if (this.disposed) return;
    await this.repository.rollupAndSweep(this.now().toISOString());
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.allSettled([
      this.sampleInFlight ?? Promise.resolve(),
      this.modelIngestInFlight ?? Promise.resolve(),
      this.backfillInFlight ?? Promise.resolve()
    ]);
    await this.repository.dispose();
  }
}
