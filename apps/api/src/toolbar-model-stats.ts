import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { copyFile, open, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { toolbarModelStatsSchema } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import type { PaneCliSession, ToolbarModelStats, ToolbarModelStatsModel } from "@space/contracts";
import { opencodeDirectParityRoot } from "./cli-parity.js";
import { opencodeNativeSessionIdPattern, readOpenCodeNativeSessionId } from "./opencode-native-session.js";

const execFileAsync = promisify(execFile);
const sqliteTimeoutMs = 5_000;
const sqliteMaxBuffer = 2 * 1024 * 1024;
const codexRolloutTailMaxBytes = 8 * 1024 * 1024;
const codexStateDbCandidatesMax = 64;
const modelStatsErrorsMax = 20;
const modelStatsModelsMax = 50;

export interface ToolbarModelStatsCollector {
  (input: { roomId: string; windowMinutes: number }): Promise<ToolbarModelStats>;
}

export interface OpenCodeDbRow {
  sessionId?: unknown;
  messageId?: unknown;
  modelID?: unknown;
  providerID?: unknown;
  msgCreated?: unknown;
  msgTokensIn?: unknown;
  msgTokensOut?: unknown;
  msgTokensReasoning?: unknown;
  partType?: unknown;
  partTime?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function intValue(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(Math.trunc(parsed), 0) : 0;
}

function numberOrNull(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function openCodeDbPath(stateRoot: string): string {
  return join(opencodeDirectParityRoot, "data", "opencode", "opencode.db");
}

export async function resolveOpenCodeDbPath(stateRoot: string): Promise<string | null> {
  const primary = openCodeDbPath(stateRoot);
  try {
    const metadata = await stat(primary);
    if (metadata.isFile() && metadata.size > 0) return primary;
  } catch {
    // Fall through to alternate candidates.
  }
  try {
    const fallback = join(stateRoot, "opencode", "opencode.db");
    const metadata = await stat(fallback);
    if (metadata.isFile() && metadata.size > 0) return fallback;
  } catch {
    // No state DB is available.
  }
  return null;
}

async function runSqliteJson<T>(dbPath: string, sql: string): Promise<T[]> {
  try {
    const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", dbPath, sql], {
      timeout: sqliteTimeoutMs,
      maxBuffer: sqliteMaxBuffer
    });
    const parsed = JSON.parse(stdout) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch (error) {
    const cause = error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "UNKNOWN";
    if (cause === "ETIMEDOUT" || cause === "ENOENT") throw error;
    return runSqliteSnapshotFallback(dbPath, sql);
  }
}

export async function runSqliteSnapshotFallback<T>(dbPath: string, sql: string): Promise<T[]> {
  const dir = mkdtempSync(join(tmpdir(), "space-model-stats-"));
  const snapshotPath = join(dir, basename(dbPath));
  try {
    for (const candidate of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      const suffix = candidate.endsWith("-wal") ? "-wal" : candidate.endsWith("-shm") ? "-shm" : "";
      await copyFile(candidate, `${snapshotPath}${suffix}`).catch(() => undefined);
    }
    const { stdout } = await execFileAsync("sqlite3", ["-json", snapshotPath, sql], {
      timeout: sqliteTimeoutMs,
      maxBuffer: sqliteMaxBuffer
    });
    const parsed = JSON.parse(stdout) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function sqliteQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function collectOpenCodeStatsFromRows(rows: OpenCodeDbRow[]): Map<string, ToolbarModelStatsModel> {
  const turns = new Map<string, {
    model: string;
    providerId: string;
    turns: number;
    tokensIn: number;
    tokensOut: number;
    tokensReasoning: number;
    durationMs: number;
  }>();
  const pendingStepStart = new Map<string, number>();
  const countedMessages = new Set<string>();
  for (const row of rows) {
    const messageId = stringValue(row.messageId);
    const modelID = stringValue(row.modelID);
    if (!messageId || !modelID) continue;
    const modelKey = `${modelID}\u0000${stringValue(row.providerID)}`;
    if (!countedMessages.has(messageId)) {
      countedMessages.add(messageId);
      const created = numberOrNull(row.msgCreated);
      if (created !== null) {
        const existing = turns.get(modelKey);
        if (existing) {
          existing.turns += 1;
          existing.tokensIn += intValue(row.msgTokensIn);
          existing.tokensOut += intValue(row.msgTokensOut);
          existing.tokensReasoning += intValue(row.msgTokensReasoning);
        } else {
          turns.set(modelKey, {
            model: modelID,
            providerId: stringValue(row.providerID) || "unknown",
            turns: 1,
            tokensIn: intValue(row.msgTokensIn),
            tokensOut: intValue(row.msgTokensOut),
            tokensReasoning: intValue(row.msgTokensReasoning),
            durationMs: 0
          });
        }
      }
    }
    const partType = stringValue(row.partType);
    const partTime = numberOrNull(row.partTime);
    if (partType === "step-start" && partTime !== null) {
      pendingStepStart.set(messageId, partTime);
      continue;
    }
    if (partType === "step-finish" && partTime !== null) {
      const start = pendingStepStart.get(messageId);
      const durationMs = start !== undefined && start > 0 ? Math.max(partTime - start, 0) : 0;
      pendingStepStart.delete(messageId);
      const existing = turns.get(modelKey);
      if (existing) existing.durationMs += durationMs;
      continue;
    }
  }
  const result = new Map<string, ToolbarModelStatsModel>();
  for (const [key, sample] of turns) {
    if (sample.tokensIn === 0 && sample.tokensOut === 0 && sample.durationMs === 0) continue;
    result.set(key, {
      modelId: sample.model,
      providerId: sample.providerId,
      source: "opencode",
      turns: sample.turns,
      avgTtftMs: null,
      avgDurationMs: sample.durationMs > 0 ? Math.round(sample.durationMs / sample.turns) : null,
      avgTokPerSec: sample.durationMs > 0
        ? Math.round((sample.tokensOut / (sample.durationMs / 1000)) * 10) / 10
        : null,
      tokensIn: sample.tokensIn,
      tokensOut: sample.tokensOut,
      tokensReasoning: sample.tokensReasoning
    });
  }
  return result;
}

export async function collectOpenCodeModelStats(input: {
  nativeSessionIds: string[];
  windowMinutes: number;
  now: () => Date;
  stateRoot: string;
}): Promise<ToolbarModelStatsModel[]> {
  const rows = await readOpenCodeModelRows(input);
  return [...collectOpenCodeStatsFromRows(rows).values()];
}

export async function readOpenCodeModelRows(input: {
  nativeSessionIds: string[];
  windowMinutes: number;
  now: () => Date;
  stateRoot: string;
}): Promise<OpenCodeDbRow[]> {
  const validIds = input.nativeSessionIds.filter((id) => opencodeNativeSessionIdPattern.test(id));
  if (validIds.length === 0) return [];
  const dbPath = await resolveOpenCodeDbPath(input.stateRoot);
  if (!dbPath) return [];
  const windowMs = Math.max(1, input.windowMinutes) * 60_000;
  const sinceMs = input.now().getTime() - windowMs;
  const sessionClause = validIds.map(sqliteQuote).join(", ");
  const sql = [
    "select",
    "s.id as sessionId,",
    "m.id as messageId,",
    "json_extract(m.data, '$.modelID') as modelID,",
    "json_extract(m.data, '$.providerID') as providerID,",
    "m.time_created as msgCreated,",
    "json_extract(m.data, '$.tokens.input') as msgTokensIn,",
    "json_extract(m.data, '$.tokens.output') as msgTokensOut,",
    "json_extract(m.data, '$.tokens.reasoning') as msgTokensReasoning,",
    "json_extract(p.data, '$.type') as partType,",
    "p.time_created as partTime",
    "from message m",
    "join part p on p.message_id = m.id",
    "join session s on s.id = m.session_id",
    `where m.time_created >= ${sinceMs}`,
    `and s.id in (${sessionClause})`,
    "order by p.time_created asc"
  ].join(" ");
  return runSqliteJson<OpenCodeDbRow>(dbPath, `${sql};`);
}

export function parseCodexRolloutStats(
  content: string,
  windowMinutes: number,
  now: () => Date
): Map<string, ToolbarModelStatsModel> {
  const windowMs = Math.max(1, windowMinutes) * 60_000;
  const sinceMs = now().getTime() - windowMs;
  const modelByTurn = new Map<string, { modelId: string; providerId: string }>();
  const byTurn = new Map<string, {
    status: "RUNNING" | "COMPLETED" | "ABORTED";
    startedAtMs: number | null;
    endedAtMs: number | null;
    ttftMs: number | null;
    durationMs: number | null;
  }>();
  const tokensByTurn = new Map<string, { tokensIn: number; tokensOut: number; tokensReasoning: number }>();
  let currentTurn: string | null = null;
  let currentProviderId = "codex";

  function eventTimestampMs(record: Record<string, unknown>, payload: Record<string, unknown>): number | null {
    for (const value of [payload.completed_at, payload.started_at]) {
      const numeric = numberOrNull(value);
      if (numeric !== null) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    }
    for (const value of [record.timestamp, payload.timestamp]) {
      if (typeof value !== "string") continue;
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  }

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
    if (!record) continue;
    const type = typeof record.type === "string" ? record.type : "";
    const payload = isRecord(record.payload) ? record.payload : null;
    if (!payload) continue;
    if (type === "session_meta") {
      const providerId = stringValue(payload.model_provider);
      if (providerId) currentProviderId = providerId;
      continue;
    }
    if (type === "turn_context") {
      const turnId = typeof payload.turn_id === "string" ? payload.turn_id : "";
      const model = typeof payload.model === "string" ? payload.model : "";
      const providerId = stringValue(payload.model_provider) || currentProviderId;
      if (turnId) {
        currentTurn = turnId;
        if (model) modelByTurn.set(turnId, { modelId: model, providerId });
      }
      continue;
    }
    if (type === "event_msg" && payload.type === "task_started") {
      const turnId = typeof payload.turn_id === "string" ? payload.turn_id : currentTurn;
      if (!turnId) continue;
      currentTurn = turnId;
      const startedAtMs = eventTimestampMs(record, payload) ?? now().getTime();
      byTurn.set(turnId, {
        status: "RUNNING",
        startedAtMs,
        endedAtMs: null,
        ttftMs: null,
        durationMs: null
      });
      continue;
    }
    if (type === "event_msg" && (payload.type === "task_complete" || payload.type === "turn_aborted")) {
      const turnId = typeof payload.turn_id === "string" ? payload.turn_id : currentTurn;
      if (!turnId) continue;
      currentTurn = turnId;
      const completedAt = eventTimestampMs(record, payload);
      if (completedAt === null || completedAt < sinceMs) {
        byTurn.delete(turnId);
        continue;
      }
      const prior = byTurn.get(turnId);
      if (prior?.endedAtMs !== null && prior?.endedAtMs !== undefined && prior.endedAtMs >= completedAt) continue;
      const reportedDuration = numberOrNull(payload.duration_ms);
      byTurn.set(turnId, {
        status: payload.type === "turn_aborted" ? "ABORTED" : "COMPLETED",
        startedAtMs: prior?.startedAtMs ?? (reportedDuration === null ? null : completedAt - reportedDuration),
        endedAtMs: completedAt,
        ttftMs: numberOrNull(payload.time_to_first_token_ms),
        durationMs: reportedDuration ?? (
          prior?.startedAtMs !== null && prior?.startedAtMs !== undefined
            ? Math.max(completedAt - prior.startedAtMs, 0)
            : null
        )
      });
      continue;
    }
    if (type === "event_msg" && payload.type === "token_count" && isRecord(payload.info)) {
      const usage = isRecord(payload.info.last_token_usage) ? payload.info.last_token_usage : null;
      if (!usage) continue;
      const tokensIn = intValue(usage.input_tokens);
      const tokensOut = intValue(usage.output_tokens);
      const tokensReasoning = intValue(usage.reasoning_output_tokens);
      if (tokensIn === 0 && tokensOut === 0) continue;
      const turnId = typeof payload.turn_id === "string" ? payload.turn_id : currentTurn;
      if (!turnId) continue;
      const prior = tokensByTurn.get(turnId);
      if (!prior || prior.tokensIn + prior.tokensOut < tokensIn + tokensOut) {
        tokensByTurn.set(turnId, { tokensIn, tokensOut, tokensReasoning });
      }
    }
  }

  const aggregate = new Map<string, {
    modelId: string;
    providerId: string;
    turns: number;
    tokensIn: number;
    tokensOut: number;
    tokensReasoning: number;
    ttftSum: number;
    ttftCount: number;
    durationSum: number;
    durationCount: number;
  }>();
  for (const [turnId, sample] of byTurn) {
    if (sample.status !== "RUNNING" && (sample.endedAtMs === null || sample.endedAtMs < sinceMs)) continue;
    const identity = modelByTurn.get(turnId);
    if (!identity) continue;
    const tokens = tokensByTurn.get(turnId) ?? { tokensIn: 0, tokensOut: 0, tokensReasoning: 0 };
    const key = `${identity.providerId}\u0000${identity.modelId}`;
    const existing = aggregate.get(key);
    const durationMs = sample.durationMs ?? 0;
    if (existing) {
      existing.turns += 1;
      existing.tokensIn += tokens.tokensIn;
      existing.tokensOut += tokens.tokensOut;
      existing.tokensReasoning += tokens.tokensReasoning;
      if (sample.ttftMs !== null) {
        existing.ttftSum += sample.ttftMs;
        existing.ttftCount += 1;
      }
      if (durationMs > 0) {
        existing.durationSum += durationMs;
        existing.durationCount += 1;
      }
    } else {
      aggregate.set(key, {
        modelId: identity.modelId,
        providerId: identity.providerId,
        turns: 1,
        tokensIn: tokens.tokensIn,
        tokensOut: tokens.tokensOut,
        tokensReasoning: tokens.tokensReasoning,
        ttftSum: sample.ttftMs ?? 0,
        ttftCount: sample.ttftMs === null ? 0 : 1,
        durationSum: durationMs,
        durationCount: durationMs > 0 ? 1 : 0
      });
    }
  }
  const result = new Map<string, ToolbarModelStatsModel>();
  for (const [key, entry] of aggregate) {
    result.set(key, {
      modelId: entry.modelId,
      providerId: entry.providerId,
      source: "codex",
      turns: entry.turns,
      avgTtftMs: entry.ttftCount > 0 ? Math.round(entry.ttftSum / entry.ttftCount) : null,
      avgDurationMs: entry.durationCount > 0 ? Math.round(entry.durationSum / entry.durationCount) : null,
      avgTokPerSec: entry.durationSum > 0 && entry.tokensOut > 0
        ? Math.round((entry.tokensOut / (entry.durationSum / 1000)) * 10) / 10
        : null,
      tokensIn: entry.tokensIn,
      tokensOut: entry.tokensOut,
      tokensReasoning: entry.tokensReasoning
    });
  }
  return result;
}

export async function resolveCodexRolloutPaths(threadIds: string[], codexHome: string): Promise<Map<string, string>> {
  const candidates = [join(codexHome, "state_5.sqlite")];
  try {
    const homes = await readdir(join(codexHome, "space-codex-homes")).catch(() => []);
    for (const home of homes.slice(0, codexStateDbCandidatesMax)) {
      const dbPath = join(codexHome, "space-codex-homes", home, "state_5.sqlite");
      try {
        const metadata = await stat(dbPath);
        if (metadata.isFile() && metadata.size > 0) candidates.push(dbPath);
      } catch {
        // Unreadable per-home state DBs are skipped.
      }
    }
  } catch {
    // No per-home state DBs.
  }
  const byThread = new Map<string, string>();
  if (threadIds.length === 0) return byThread;
  const placeholders = threadIds.map((_, index) => `$${index + 1}`).join(", ");
  const sql = `select id, rollout_path from threads where id in (${placeholders});`;
  for (const dbPath of candidates) {
    try {
      const rows = await runSqliteJson<{ id?: unknown; rollout_path?: unknown }>(dbPath, sql);
      for (const row of rows) {
        const id = stringValue(row.id);
        const path = stringValue(row.rollout_path);
        if (id && path && !byThread.has(id)) byThread.set(id, path);
      }
    } catch {
      // A broken state DB must not fail the whole room sample.
    }
  }
  return byThread;
}

export async function readCodexRolloutTail(path: string): Promise<string> {
  const metadata = await stat(path);
  if (metadata.size <= codexRolloutTailMaxBytes) {
    return readFile(path, "utf8");
  }
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(codexRolloutTailMaxBytes);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, metadata.size - codexRolloutTailMaxBytes);
    const firstNewline = buffer.indexOf("\n", 0);
    const start = firstNewline === -1 ? 0 : firstNewline + 1;
    return buffer.toString("utf8", start, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function resolveSessionRolloutPath(session: PaneCliSession, codexHome: string): Promise<string | null> {
  const threadId = session.codexThreadId;
  if (!threadId) return null;
  const resolved = await resolveCodexRolloutPaths([threadId], codexHome);
  const path = resolved.get(threadId);
  if (!path) return null;
  try {
    await stat(path);
    return path;
  } catch {
    return null;
  }
}

export async function collectCodexModelStats(input: {
  sessions: PaneCliSession[];
  windowMinutes: number;
  now: () => Date;
  codexHome: string;
}): Promise<ToolbarModelStatsModel[]> {
  const merged = new Map<string, {
    modelId: string;
    providerId: string;
    turns: number;
    tokensIn: number;
    tokensOut: number;
    tokensReasoning: number;
    ttftSum: number;
    ttftCount: number;
    durationSum: number;
  }>();
  for (const session of input.sessions) {
    try {
      const rolloutPath = await resolveSessionRolloutPath(session, input.codexHome);
      if (!rolloutPath) continue;
      const parsed = parseCodexRolloutStats(
        await readCodexRolloutTail(rolloutPath),
        input.windowMinutes,
        input.now
      );
      for (const [key, stats] of parsed) {
        const existing = merged.get(key);
        if (existing) {
          existing.turns += stats.turns;
          existing.tokensIn += stats.tokensIn;
          existing.tokensOut += stats.tokensOut;
          existing.tokensReasoning += stats.tokensReasoning;
          if (stats.avgTtftMs !== null) {
            existing.ttftSum += stats.avgTtftMs * stats.turns;
            existing.ttftCount += stats.turns;
          }
          if (stats.avgDurationMs !== null) {
            existing.durationSum += stats.avgDurationMs * stats.turns;
          }
        } else {
          merged.set(key, {
            modelId: stats.modelId,
            providerId: stats.providerId,
            turns: stats.turns,
            tokensIn: stats.tokensIn,
            tokensOut: stats.tokensOut,
            tokensReasoning: stats.tokensReasoning,
            ttftSum: stats.avgTtftMs !== null ? stats.avgTtftMs * stats.turns : 0,
            ttftCount: stats.avgTtftMs !== null ? stats.turns : 0,
            durationSum: stats.avgDurationMs !== null ? stats.avgDurationMs * stats.turns : 0
          });
        }
      }
    } catch {
      // A single unreadable rollout must not fail the room sample.
    }
  }
  const result = new Map<string, ToolbarModelStatsModel>();
  for (const [key, value] of merged) {
    result.set(key, {
      modelId: value.modelId,
      providerId: value.providerId,
      source: "codex",
      turns: value.turns,
      avgTtftMs: value.ttftCount > 0 ? Math.round(value.ttftSum / value.ttftCount) : null,
      avgDurationMs: value.turns > 0 && value.durationSum > 0 ? Math.round(value.durationSum / value.turns) : null,
      avgTokPerSec: value.durationSum > 0 && value.tokensOut > 0
        ? Math.round((value.tokensOut / (value.durationSum / 1000)) * 10) / 10
        : null,
      tokensIn: value.tokensIn,
      tokensOut: value.tokensOut,
      tokensReasoning: value.tokensReasoning
    });
  }
  return [...result.values()];
}

export function createToolbarModelStatsCollector(input: {
  store: SpaceStore;
  stateRoot?: string;
  codexHome?: string;
  now?: () => Date;
}): ToolbarModelStatsCollector {
  const stateRoot = input.stateRoot ?? join(opencodeDirectParityRoot, "state");
  const codexHome = input.codexHome ?? "/var/lib/spaceapp-user/.codex";
  const now = input.now ?? (() => new Date());
  return async ({ windowMinutes }) => {
    const errors: string[] = [];
    const sources: string[] = [];
    const models: ToolbarModelStatsModel[] = [];
    const sessions = (await Promise.all([
      Promise.resolve(input.store.listActivePaneCliSessions("cli:opencode")).catch(() => []),
      Promise.resolve(input.store.listActivePaneCliSessions("cli:codex")).catch(() => [])
    ])).flat();
    const openCodeSessions = sessions.filter(
      (session) => session.runtimeId === "cli:opencode" && session.purpose === "NORMAL"
    );
    const codexSessions = sessions.filter(
      (session) => session.runtimeId === "cli:codex" && session.purpose === "NORMAL"
    );
    if (openCodeSessions.length > 0) {
      const nativeIds: string[] = [];
      for (const session of openCodeSessions) {
        const nativeId = await readOpenCodeNativeSessionId(session.sessionId, stateRoot);
        if (nativeId) nativeIds.push(nativeId);
      }
      if (nativeIds.length > 0) {
        try {
          models.push(...await collectOpenCodeModelStats({ nativeSessionIds: nativeIds, windowMinutes, now, stateRoot }));
          sources.push("opencode");
        } catch (error) {
          errors.push(`opencode: ${error instanceof Error ? error.message : "collection failed"}`);
        }
      }
    }
    if (codexSessions.length > 0) {
      try {
        models.push(...await collectCodexModelStats({ sessions: codexSessions, windowMinutes, now, codexHome }));
        sources.push("codex");
      } catch (error) {
        errors.push(`codex: ${error instanceof Error ? error.message : "collection failed"}`);
      }
    }
    models.sort((left, right) => right.turns - left.turns || right.tokensOut - left.tokensOut);
    return toolbarModelStatsSchema.parse({
      windowMinutes,
      sampledAt: now().toISOString(),
      models: models.slice(0, modelStatsModelsMax),
      sources,
      errors: errors.slice(0, modelStatsErrorsMax)
    });
  };
}
