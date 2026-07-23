import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { SpaceStore } from "@space/runtime";

const execFileAsync = promisify(execFile);

type JsonRecord = Record<string, unknown>;

export type CodexCliCompletionInspection =
  | { status: "PENDING"; turnId: string | null; safeErrorCode?: "CODEX_CLI_FINAL_RESPONSE_PENDING" }
  | { status: "ABORTED"; turnId: string }
  | { status: "COMPLETED"; turnId: string; finalResponse: string; completedAt: string };

export type CodexCliRolloutResolution =
  | { status: "READY"; rolloutPath: string }
  | {
      status: "PENDING";
      safeErrorCode: "CODEX_CLI_ROLLOUT_LOOKUP_PENDING" | "CODEX_CLI_ROLLOUT_NOT_READY";
    }
  | { status: "EXCLUDED"; safeErrorCode: "CODEX_CLI_THREAD_EXCLUDED" }
  | { status: "UNSAFE"; safeErrorCode: "CODEX_CLI_ROLLOUT_OUTSIDE_SESSION" };

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function timestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value > 10_000_000_000 ? value : value * 1_000;
  }
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function eventTimestampMs(item: JsonRecord, payload: JsonRecord | null): number | null {
  return timestampMs(payload?.completed_at) ?? timestampMs(item.timestamp) ?? timestampMs(payload?.timestamp);
}

function textParts(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.flatMap((part) => {
      if (typeof part === "string") return [part];
      const item = record(part);
      if (!item) return [];
      return [item.text, item.output_text, item.content]
        .filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
    });
  }
  const item = record(value);
  if (!item) return [];
  return [item.text, item.output_text, item.content]
    .filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
}

function assistantResponse(payload: JsonRecord): string | null {
  const parts = [
    ...textParts(payload.content),
    ...textParts(payload.message),
    ...textParts(payload.text)
  ];
  const response = parts.join("\n\n").trim();
  return response || null;
}

function isEligible(timestamp: number | null, submittedAtMs: number): boolean {
  return timestamp === null || timestamp >= submittedAtMs;
}

export function inspectCodexCliCompletion(
  content: string,
  options: { submittedAtMs: number; turnId?: string | null }
): CodexCliCompletionInspection {
  let targetTurnId = options.turnId ?? null;
  let contextualTurnId: string | null = null;
  let finalResponse: string | null = null;
  let completedAtMs: number | null = null;
  let completionSeen = false;
  let aborted = false;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let item: JsonRecord | null;
    try {
      item = record(JSON.parse(line));
    } catch {
      continue;
    }
    if (!item) continue;
    const payload = record(item.payload);
    const type = stringValue(item.type);
    const atMs = eventTimestampMs(item, payload);

    if (type === "turn_context") {
      const turnId = stringValue(payload?.turn_id);
      if (turnId && isEligible(atMs, options.submittedAtMs)) {
        contextualTurnId = turnId;
        targetTurnId ??= turnId;
      }
      continue;
    }

    if (type === "response_item" && payload) {
      if (
        targetTurnId &&
        contextualTurnId === targetTurnId &&
        isEligible(atMs, options.submittedAtMs) &&
        payload.type === "message" &&
        payload.role === "assistant"
      ) {
        finalResponse = assistantResponse(payload) ?? finalResponse;
      }
      continue;
    }

    if (type !== "event_msg" || !payload) continue;
    const eventType = stringValue(payload.type);
    const eventTurnId = stringValue(payload.turn_id) ?? contextualTurnId;
    if (eventType === "user_message" && isEligible(atMs, options.submittedAtMs)) {
      if (eventTurnId) {
        targetTurnId ??= eventTurnId;
        contextualTurnId = eventTurnId;
      }
      continue;
    }
    if (!isEligible(atMs, options.submittedAtMs)) continue;
    if (!targetTurnId && eventTurnId && (eventType === "task_complete" || eventType === "turn_aborted")) {
      targetTurnId = eventTurnId;
    }
    if (!targetTurnId || (eventTurnId && eventTurnId !== targetTurnId)) continue;

    if (eventType === "agent_message" && (payload.phase === "final" || payload.phase === undefined)) {
      finalResponse = assistantResponse(payload) ?? finalResponse;
      continue;
    }
    if (eventType === "turn_aborted") {
      aborted = true;
      continue;
    }
    if (eventType !== "task_complete") continue;

    completionSeen = true;
    completedAtMs ??= atMs;
    const lastAgentMessage = stringValue(payload.last_agent_message)?.trim();
    if (lastAgentMessage) finalResponse ??= lastAgentMessage;
  }

  if (!targetTurnId) return { status: "PENDING", turnId: null };
  if (aborted) return { status: "ABORTED", turnId: targetTurnId };
  if (!completionSeen) return { status: "PENDING", turnId: targetTurnId };
  if (!finalResponse) {
    return { status: "PENDING", turnId: targetTurnId, safeErrorCode: "CODEX_CLI_FINAL_RESPONSE_PENDING" };
  }
  return {
    status: "COMPLETED",
    turnId: targetTurnId,
    finalResponse,
    completedAt: new Date(completedAtMs ?? options.submittedAtMs).toISOString()
  };
}

function sqliteQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function safeRuntimeKey(paneId: string, sessionId: string): string {
  return `${paneId}--${sessionId}`.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function isContained(root: string, candidate: string): boolean {
  const nested = relative(root, candidate);
  return Boolean(nested) && !nested.startsWith(`..${sep}`) && nested !== ".." && !isAbsolute(nested);
}

export async function resolveCodexCliRolloutPath(input: {
  codexHome: string;
  paneId: string;
  sessionId: string;
  threadId: string;
}): Promise<CodexCliRolloutResolution> {
  const codexHome = resolve(input.codexHome);
  const stateDbPath = join(codexHome, "state_5.sqlite");
  const sql = `SELECT rollout_path, thread_source, agent_path FROM threads WHERE id = ${sqliteQuote(input.threadId)} LIMIT 2`;
  let rawRolloutPath: string;
  try {
    const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", stateDbPath, sql], {
      timeout: 1_500,
      maxBuffer: 64 * 1024
    });
    const rows = JSON.parse(String(stdout || "[]")) as Array<{
      rollout_path?: unknown;
      thread_source?: unknown;
      agent_path?: unknown;
    }>;
    if (rows.length !== 1 || typeof rows[0]?.rollout_path !== "string" || !rows[0].rollout_path) {
      return { status: "PENDING", safeErrorCode: "CODEX_CLI_ROLLOUT_LOOKUP_PENDING" };
    }
    if (rows[0].thread_source !== "user" || rows[0].agent_path !== null) {
      return { status: "EXCLUDED", safeErrorCode: "CODEX_CLI_THREAD_EXCLUDED" };
    }
    rawRolloutPath = rows[0].rollout_path;
  } catch {
    return { status: "PENDING", safeErrorCode: "CODEX_CLI_ROLLOUT_LOOKUP_PENDING" };
  }

  const ownedSessionsRoot = join(
    codexHome,
    "space-codex-homes",
    safeRuntimeKey(input.paneId, input.sessionId),
    "sessions"
  );
  const candidate = resolve(isAbsolute(rawRolloutPath) ? rawRolloutPath : join(codexHome, rawRolloutPath));
  let realOwnedRoot: string;
  let realCandidate: string;
  try {
    [realOwnedRoot, realCandidate] = await Promise.all([realpath(ownedSessionsRoot), realpath(candidate)]);
  } catch {
    return { status: "PENDING", safeErrorCode: "CODEX_CLI_ROLLOUT_NOT_READY" };
  }
  const name = basename(realCandidate);
  if (!isContained(realOwnedRoot, realCandidate) || !name.startsWith("rollout-") || !name.endsWith(".jsonl")) {
    return { status: "UNSAFE", safeErrorCode: "CODEX_CLI_ROLLOUT_OUTSIDE_SESSION" };
  }
  return { status: "READY", rolloutPath: realCandidate };
}

export interface CodexCliCompletionSweepLog {
  markerId: string;
  status: "COMPLETED" | "DEFERRED" | "IGNORED" | "FAILED";
  attempt: number;
  safeErrorCode: string | null;
}

export interface CodexCliCompletionSweepOptions {
  store: SpaceStore;
  workerId: string;
  codexHome: string;
  now?: () => Date;
  maxCheckAttempts?: number;
  resolveRolloutPath?: typeof resolveCodexCliRolloutPath;
  readRollout?: (rolloutPath: string) => Promise<string>;
  log?: (record: CodexCliCompletionSweepLog) => void;
}

export interface CodexCliCompletionSweepSummary {
  claimed: number;
  completed: number;
  deferred: number;
  ignored: number;
  failed: number;
}

async function readBoundedRollout(rolloutPath: string): Promise<string> {
  const fileStats = await stat(rolloutPath);
  if (!fileStats.isFile() || fileStats.size > 64 * 1024 * 1024) {
    throw new Error("CODEX_CLI_ROLLOUT_UNREADABLE");
  }
  return readFile(rolloutPath, "utf8");
}

export async function sweepCodexCliCompletions(
  options: CodexCliCompletionSweepOptions,
  limit = 10
): Promise<CodexCliCompletionSweepSummary> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const maxCheckAttempts = Math.max(1, Math.min(options.maxCheckAttempts ?? 240, 720));
  const resolveRolloutPath = options.resolveRolloutPath ?? resolveCodexCliRolloutPath;
  const readRollout = options.readRollout ?? readBoundedRollout;
  const markers = await options.store.claimCodexCliTurnMarkers({
    workerId: options.workerId,
    limit: Math.max(1, Math.min(Math.trunc(limit), 50)),
    now: startedAt.toISOString(),
    staleBefore: new Date(startedAt.getTime() - 5 * 60_000).toISOString()
  });
  const summary: CodexCliCompletionSweepSummary = {
    claimed: markers.length,
    completed: 0,
    deferred: 0,
    ignored: 0,
    failed: 0
  };

  for (const marker of markers) {
    const log = (status: CodexCliCompletionSweepLog["status"], safeErrorCode: string | null) => {
      options.log?.({ markerId: marker.markerId, status, attempt: marker.checkAttemptCount, safeErrorCode });
    };
    const finish = async (status: "IGNORED" | "FAILED", safeErrorCode: string) => {
      await options.store.finishCodexCliTurnMarker({
        markerId: marker.markerId,
        workerId: options.workerId,
        status,
        safeErrorCode,
        now: now().toISOString()
      });
      summary[status === "IGNORED" ? "ignored" : "failed"] += 1;
      log(status, safeErrorCode);
    };
    const defer = async (input: {
      safeErrorCode: string;
      codexThreadId?: string | null;
      rolloutPath?: string | null;
      terminalStatus?: "IGNORED" | "FAILED";
      terminalCode?: string;
    }) => {
      if (marker.checkAttemptCount >= maxCheckAttempts) {
        await finish(input.terminalStatus ?? "FAILED", input.terminalCode ?? input.safeErrorCode);
        return;
      }
      const delayMs = Math.min(30_000, 2_000 * 2 ** Math.min(marker.checkAttemptCount - 1, 4));
      const deferredAt = now();
      await options.store.deferCodexCliTurnMarker({
        markerId: marker.markerId,
        workerId: options.workerId,
        ...(input.codexThreadId === undefined ? {} : { codexThreadId: input.codexThreadId }),
        ...(input.rolloutPath === undefined ? {} : { rolloutPath: input.rolloutPath }),
        nextCheckAt: new Date(deferredAt.getTime() + delayMs).toISOString(),
        safeErrorCode: input.safeErrorCode,
        now: deferredAt.toISOString()
      });
      summary.deferred += 1;
      log("DEFERRED", input.safeErrorCode);
    };

    const session = await options.store.getPaneCliSession(marker.sessionId);
    if (!session || session.roomId !== marker.roomId || session.paneId !== marker.paneId) {
      await finish("IGNORED", "CODEX_CLI_SESSION_GONE");
      continue;
    }
    if (session.runtimeId !== "cli:codex") {
      await finish("IGNORED", "CODEX_CLI_RUNTIME_EXCLUDED");
      continue;
    }
    const codexThreadId = marker.codexThreadId ?? session.codexThreadId;
    if (!codexThreadId) {
      await defer({
        safeErrorCode: "CODEX_CLI_THREAD_PENDING",
        terminalCode: "CODEX_CLI_THREAD_UNAVAILABLE"
      });
      continue;
    }

    const resolution = await resolveRolloutPath({
      codexHome: options.codexHome,
      paneId: marker.paneId,
      sessionId: marker.sessionId,
      threadId: codexThreadId
    });
    if (resolution.status === "EXCLUDED") {
      await finish("IGNORED", resolution.safeErrorCode);
      continue;
    }
    if (resolution.status === "UNSAFE") {
      await finish("FAILED", resolution.safeErrorCode);
      continue;
    }
    if (resolution.status === "PENDING") {
      await defer({ safeErrorCode: resolution.safeErrorCode, codexThreadId });
      continue;
    }

    let content: string;
    try {
      content = await readRollout(resolution.rolloutPath);
    } catch {
      await defer({
        safeErrorCode: "CODEX_CLI_ROLLOUT_READ_PENDING",
        codexThreadId,
        rolloutPath: resolution.rolloutPath,
        terminalCode: "CODEX_CLI_ROLLOUT_UNREADABLE"
      });
      continue;
    }
    const completion = inspectCodexCliCompletion(content, {
      submittedAtMs: Date.parse(marker.submittedAt)
    });
    if (completion.status === "ABORTED") {
      await finish("IGNORED", "CODEX_CLI_TURN_ABORTED");
      continue;
    }
    if (completion.status === "PENDING") {
      const missingFinal = completion.safeErrorCode === "CODEX_CLI_FINAL_RESPONSE_PENDING";
      await defer({
        safeErrorCode: completion.safeErrorCode ?? "CODEX_CLI_COMPLETION_PENDING",
        codexThreadId,
        rolloutPath: resolution.rolloutPath,
        terminalStatus: missingFinal ? "IGNORED" : "FAILED",
        terminalCode: missingFinal ? "CODEX_CLI_FINAL_RESPONSE_MISSING" : "CODEX_CLI_COMPLETION_TIMEOUT"
      });
      continue;
    }

    await options.store.completeCodexCliTurnMarker({
      markerId: marker.markerId,
      workerId: options.workerId,
      codexThreadId,
      codexTurnId: completion.turnId,
      rolloutPath: resolution.rolloutPath,
      finalResponse: completion.finalResponse,
      completedAt: completion.completedAt,
      traceId: `telegram-terminal:${marker.markerId}`
    });
    summary.completed += 1;
    log("COMPLETED", null);
  }

  return summary;
}
