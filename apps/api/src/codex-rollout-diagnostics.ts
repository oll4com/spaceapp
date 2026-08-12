import { execFile } from "node:child_process";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const currentTurnTailBytes = 2 * 1024 * 1024;
const currentTurnRolloutPathCache = new Map<string, string>();
const currentTurnRolloutPathCacheMax = 256;
const codexRolloutGoalStatuses = new Set([
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete"
]);

export interface NullAgentMessageDiagnostic {
  rolloutPath: string;
  sessionId: string | null;
  turnId: string | null;
  cwd: string | null;
  completedAt: number | null;
  durationMs: number | null;
  message: string;
}

export interface FindRecentNullAgentMessageDiagnosticOptions {
  codexHome: string;
  threadId: string;
  cwd?: string | null;
  inputText?: string | null;
  sinceMs: number;
  maxFiles?: number;
}

export interface DetectNullAgentMessageRolloutOptions {
  sinceMs?: number;
}

export interface CodexCliTurnActivity {
  status: "PENDING" | "RUNNING" | "COMPLETED" | "ABORTED";
  turnId: string | null;
  lastActivityAtMs?: number;
}

export interface CodexCliPlanState {
  status: "READY" | "PAUSED_BY_ROOM_AGENT" | "RUNNING" | "COMPLETED";
  title: string;
  text: string;
  threadTurnId: string | null;
  updatedAt: string | null;
}

export interface InspectCodexCliTurnActivityOptions {
  markerAtMs: number;
  turnId?: string | null;
  inputMarker?: string;
}

export interface FindRecentCodexCliTurnActivityOptions extends InspectCodexCliTurnActivityOptions {
  codexHome: string;
  threadId: string;
  maxFiles?: number;
}

export interface FindCurrentCodexCliTurnActivityOptions {
  codexHome: string;
  threadId: string;
}

export type FindCodexCliPlanStateOptions = FindCurrentCodexCliTurnActivityOptions;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberField(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function timestampToMs(timestamp: number | null): number | null {
  if (timestamp === null) return null;
  return timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000;
}

function sqliteQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function rolloutEventAtMs(record: Record<string, unknown> | null, payload: Record<string, unknown> | null): number | null {
  const timestamp = record?.timestamp;
  if (typeof timestamp === "string") {
    const parsed = Date.parse(timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) return timestampToMs(timestamp);
  return timestampToMs(numberField(payload, "completed_at"));
}

function recordTimestamp(record: Record<string, unknown> | null): string | null {
  const timestamp = record?.timestamp;
  if (typeof timestamp === "string" && Number.isFinite(Date.parse(timestamp))) return timestamp;
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    return new Date(timestampToMs(timestamp) ?? timestamp).toISOString();
  }
  return null;
}

function userMessageText(record: Record<string, unknown> | null, payload: Record<string, unknown> | null): string | null {
  const type = stringField(record, "type");
  if (type === "event_msg" && stringField(payload, "type") === "user_message") {
    return stringField(payload, "message") ?? stringField(payload, "text");
  }
  if (type !== "response_item" || stringField(payload, "type") !== "message" || stringField(payload, "role") !== "user") {
    return null;
  }
  const content = payload?.content;
  if (!Array.isArray(content)) return null;
  const text = content
    .map((item) => {
      const contentItem = asRecord(item);
      return stringField(contentItem, "text") ?? "";
    })
    .filter(Boolean)
    .join("\n");
  return text || null;
}

function planTitle(text: string): string {
  const heading = text.split(/\r?\n/).find((line) => /^#{1,6}\s+\S/.test(line.trim()));
  return heading?.trim().replace(/^#{1,6}\s+/, "") ?? text.trim().split(/\r?\n/, 1)[0]?.slice(0, 120) ?? "Untitled plan";
}

function isRoomAgentMessage(text: string): boolean {
  return /<space-room-action\b[^>]*\bmarker=/i.test(text) || /space-room-action:[0-9a-f-]{16,}/i.test(text);
}

function isImplementationRequest(text: string): boolean {
  return /\bimplement\s+the\s+plan\b/i.test(text);
}

export function inspectCodexCliPlanState(content: string, activity: CodexCliTurnActivity): CodexCliPlanState | null {
  let plan: CodexCliPlanState | null = null;
  let sawRoomAgentMessage = false;
  let sawImplementationRequest = false;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = asRecord(parsed);
    const payload = asRecord(record?.payload);
    const item = asRecord(payload?.item);
    if (
      stringField(record, "type") === "event_msg" &&
      stringField(payload, "type") === "item_completed" &&
      stringField(item, "type") === "Plan"
    ) {
      const text = stringField(item, "text");
      if (!text?.trim()) continue;
      plan = {
        status: "READY",
        title: planTitle(text),
        text,
        threadTurnId: stringField(item, "id"),
        updatedAt: recordTimestamp(record)
      };
      sawRoomAgentMessage = false;
      sawImplementationRequest = false;
      continue;
    }
    if (!plan) continue;
    const message = userMessageText(record, payload);
    if (!message) continue;
    plan.updatedAt = recordTimestamp(record) ?? plan.updatedAt;
    if (isRoomAgentMessage(message)) {
      sawRoomAgentMessage = true;
    } else if (isImplementationRequest(message)) {
      sawImplementationRequest = true;
    }
  }

  if (!plan) return null;
  if (sawImplementationRequest) {
    plan.status = activity.status === "RUNNING"
      ? "RUNNING"
      : activity.status === "COMPLETED"
        ? "COMPLETED"
        : activity.status === "ABORTED"
          ? "PAUSED_BY_ROOM_AGENT"
          : "READY";
  } else if (sawRoomAgentMessage) {
    plan.status = "PAUSED_BY_ROOM_AGENT";
  }
  return plan;
}

function diagnosticMessage(input: {
  rolloutPath: string;
  sessionId: string | null;
  turnId: string | null;
  completedAt: number | null;
  durationMs: number | null;
}): string {
  const parts = [
    "Codex completed a CLI turn with last_agent_message:null; Space surfaced this diagnostic instead of silent success.",
    input.sessionId ? `thread=${input.sessionId}` : null,
    input.turnId ? `turn=${input.turnId}` : null,
    input.completedAt ? `completed_at=${input.completedAt}` : null,
    input.durationMs ? `duration_ms=${input.durationMs}` : null,
    `rollout=${input.rolloutPath}`
  ].filter(Boolean);
  return parts.join(" ").slice(0, 500);
}

export function detectNullAgentMessageRollout(
  rolloutPath: string,
  content: string,
  options: DetectNullAgentMessageRolloutOptions = {}
): NullAgentMessageDiagnostic | null {
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let turnId: string | null = null;
  let latestDiagnostic: NullAgentMessageDiagnostic | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = asRecord(parsed);
    const type = stringField(record, "type");
    const payload = asRecord(record?.payload);
    if (type === "session_meta") {
      sessionId = stringField(payload, "session_id") ?? stringField(payload, "id") ?? sessionId;
      cwd = stringField(payload, "cwd") ?? cwd;
      continue;
    }
    if (type === "turn_context") {
      turnId = stringField(payload, "turn_id") ?? turnId;
      cwd = stringField(payload, "cwd") ?? cwd;
      continue;
    }
    if (type !== "event_msg") continue;
    if (stringField(payload, "type") !== "task_complete") continue;
    if (payload?.last_agent_message !== null) continue;
    const completedAt = numberField(payload, "completed_at");
    const completedAtMs = timestampToMs(completedAt);
    if (options.sinceMs && completedAtMs !== null && completedAtMs < options.sinceMs) continue;
    const durationMs = numberField(payload, "duration_ms");
    const completedTurnId = stringField(payload, "turn_id") ?? turnId;
    latestDiagnostic = {
      rolloutPath,
      sessionId,
      turnId: completedTurnId,
      cwd,
      completedAt,
      durationMs,
      message: diagnosticMessage({
        rolloutPath,
        sessionId,
        turnId: completedTurnId,
        completedAt,
        durationMs
      })
    };
  }

  return latestDiagnostic;
}

export function inspectCodexCliTurnActivity(content: string, options: InspectCodexCliTurnActivityOptions): CodexCliTurnActivity {
  let turnId = options.turnId ?? null;
  let contextualTurnId = turnId;
  let markerMatched = !options.inputMarker || Boolean(turnId);
  let goalStatus: string | null = null;
  let goalTurnId: string | null = null;
  let terminalStatus: "COMPLETED" | "ABORTED" | null = null;
  let terminalTurnId: string | null = turnId;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = asRecord(parsed);
    const payload = asRecord(record?.payload);
    const eventAtMs = rolloutEventAtMs(record, payload);
    if (eventAtMs === null || eventAtMs < options.markerAtMs) continue;

    const type = stringField(record, "type");
    if (type === "turn_context") {
      const candidate = stringField(payload, "turn_id");
      if (candidate) contextualTurnId = candidate;
      if (!options.inputMarker && candidate && (!turnId || candidate === turnId)) turnId = candidate;
      if (markerMatched && goalStatus && candidate && candidate !== turnId) {
        goalTurnId = candidate;
        terminalStatus = null;
        terminalTurnId = candidate;
      }
      continue;
    }
    if (type !== "event_msg") continue;

    const eventType = stringField(payload, "type");
    const eventTurnId = stringField(payload, "turn_id");
    if (eventType === "user_message" && (!turnId || !eventTurnId || eventTurnId === turnId)) {
      if (options.inputMarker && !JSON.stringify(payload).includes(options.inputMarker)) continue;
      turnId = eventTurnId ?? contextualTurnId ?? turnId;
      markerMatched = true;
      continue;
    }
    if (!markerMatched) continue;
    if (eventType === "thread_goal_updated") {
      const status = stringField(asRecord(payload?.goal), "status");
      if (status && codexRolloutGoalStatuses.has(status)) {
        if (!goalStatus && !goalTurnId) {
          terminalStatus = null;
          terminalTurnId = null;
        }
        goalStatus = status;
      }
      continue;
    }
    if (eventType === "task_started" && goalStatus) {
      const candidate = eventTurnId ?? contextualTurnId;
      if (candidate && candidate !== turnId) {
        goalTurnId = candidate;
        terminalStatus = null;
        terminalTurnId = candidate;
      }
      continue;
    }
    if (eventType !== "task_complete" && eventType !== "turn_aborted") continue;
    const candidate = eventTurnId ?? contextualTurnId ?? turnId;
    if (goalStatus) {
      if (candidate && candidate !== turnId) goalTurnId = candidate;
      if (!goalTurnId || !candidate || candidate === goalTurnId) {
        terminalStatus = eventType === "turn_aborted" ? "ABORTED" : "COMPLETED";
        terminalTurnId = goalTurnId ?? candidate ?? turnId;
      }
      continue;
    }
    if (turnId && (!candidate || candidate === turnId)) {
      terminalStatus = eventType === "turn_aborted" ? "ABORTED" : "COMPLETED";
      terminalTurnId = turnId;
    }
  }

  const effectiveTurnId = goalTurnId ?? terminalTurnId ?? turnId;
  if (goalStatus === "active") {
    return effectiveTurnId ? { status: "RUNNING", turnId: effectiveTurnId } : { status: "PENDING", turnId: null };
  }
  if (terminalStatus) return { status: terminalStatus, turnId: effectiveTurnId };
  return markerMatched && effectiveTurnId
    ? { status: "RUNNING", turnId: effectiveTurnId }
    : { status: "PENDING", turnId: null };
}

export function inspectCurrentCodexCliTurnActivity(content: string): CodexCliTurnActivity {
  let turnId: string | null = null;
  let status: CodexCliTurnActivity["status"] = "PENDING";
  let goalStatus: string | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = asRecord(parsed);
    const payload = asRecord(record?.payload);
    const type = stringField(record, "type");
    if (type === "turn_context") {
      const candidate = stringField(payload, "turn_id");
      if (candidate) {
        turnId = candidate;
        status = "RUNNING";
      }
      continue;
    }
    if (type !== "event_msg") continue;
    const eventType = stringField(payload, "type");
    const eventTurnId = stringField(payload, "turn_id");
    if (eventType === "thread_goal_updated") {
      const candidate = stringField(asRecord(payload?.goal), "status");
      if (candidate && codexRolloutGoalStatuses.has(candidate)) goalStatus = candidate;
      continue;
    }
    if (eventType === "task_started" || eventType === "user_message") {
      if (eventTurnId) turnId = eventTurnId;
      if (turnId) status = "RUNNING";
      continue;
    }
    if ((eventType === "task_complete" || eventType === "turn_aborted") && turnId && (!eventTurnId || eventTurnId === turnId)) {
      status = eventType === "turn_aborted" ? "ABORTED" : "COMPLETED";
    } else if ((eventType === "task_complete" || eventType === "turn_aborted") && eventTurnId) {
      turnId = eventTurnId;
      status = eventType === "turn_aborted" ? "ABORTED" : "COMPLETED";
    }
  }

  if (goalStatus === "active" && turnId) status = "RUNNING";
  return { status, turnId };
}

async function collectRecentRolloutFiles(root: string, sinceMs: number, depth = 0): Promise<Array<{ path: string; mtimeMs: number }>> {
  if (depth > 5) return [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: Array<{ path: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectRecentRolloutFiles(path, sinceMs, depth + 1)));
      continue;
    }
    if (!entry.isFile() || !entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) continue;
    try {
      const fileStat = await stat(path);
      if (fileStat.mtimeMs >= sinceMs) {
        files.push({ path, mtimeMs: fileStat.mtimeMs });
      }
    } catch {
      continue;
    }
  }
  return files;
}

function rolloutThreadId(content: string): string | null {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const record = asRecord(JSON.parse(line));
      if (stringField(record, "type") !== "session_meta") continue;
      const payload = asRecord(record?.payload);
      return stringField(payload, "session_id") ?? stringField(payload, "id");
    } catch {
      continue;
    }
  }
  return null;
}

export async function findRecentCodexCliTurnActivity(
  options: FindRecentCodexCliTurnActivityOptions
): Promise<CodexCliTurnActivity> {
  const files = (await collectRecentRolloutFiles(join(options.codexHome, "sessions"), options.markerAtMs))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, options.maxFiles ?? 12);
  let running: CodexCliTurnActivity | null = null;

  for (const file of files) {
    let content: string;
    try {
      content = await readFile(file.path, "utf8");
    } catch {
      continue;
    }
    if (rolloutThreadId(content) !== options.threadId) continue;
    const activity = inspectCodexCliTurnActivity(content, options);
    if (activity.status === "COMPLETED") return activity;
    if (activity.status === "RUNNING" && running === null) running = { ...activity, lastActivityAtMs: file.mtimeMs };
  }

  return running ?? { status: "PENDING", turnId: options.turnId ?? null };
}

export async function findCurrentCodexCliTurnActivity(
  options: FindCurrentCodexCliTurnActivityOptions
): Promise<CodexCliTurnActivity> {
  const stateDbPath = join(options.codexHome, "state_5.sqlite");
  const cacheKey = `${stateDbPath}\0${options.threadId}`;
  let rolloutPath = currentTurnRolloutPathCache.get(cacheKey);
  if (!rolloutPath) {
    const sql = `SELECT rollout_path FROM threads WHERE id = ${sqliteQuote(options.threadId)} LIMIT 2`;
    try {
      const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", stateDbPath, sql], {
        timeout: 1_500,
        maxBuffer: 64 * 1024
      });
      const rows = JSON.parse(String(stdout || "[]")) as Array<{ rollout_path?: unknown }>;
      if (rows.length !== 1 || typeof rows[0]?.rollout_path !== "string") return { status: "PENDING", turnId: null };
      rolloutPath = resolve(rows[0].rollout_path);
      currentTurnRolloutPathCache.set(cacheKey, rolloutPath);
      if (currentTurnRolloutPathCache.size > currentTurnRolloutPathCacheMax) {
        const oldestKey = currentTurnRolloutPathCache.keys().next().value;
        if (typeof oldestKey === "string") currentTurnRolloutPathCache.delete(oldestKey);
      }
    } catch {
      return { status: "PENDING", turnId: null };
    }
  }
  const codexHome = resolve(options.codexHome);
  if (rolloutPath !== codexHome && !rolloutPath.startsWith(`${codexHome}${sep}`)) {
    return { status: "PENDING", turnId: null };
  }
  let handle;
  try {
    handle = await open(rolloutPath, "r");
    const fileStat = await handle.stat();
    const byteLength = Math.min(fileStat.size, currentTurnTailBytes);
    if (byteLength < 1) return { status: "PENDING", turnId: null };
    const buffer = Buffer.allocUnsafe(byteLength);
    const { bytesRead } = await handle.read(buffer, 0, byteLength, fileStat.size - byteLength);
    const content = buffer.subarray(0, bytesRead).toString("utf8");
    const activity = inspectCurrentCodexCliTurnActivity(content);
    return activity.status === "PENDING" ? { status: "RUNNING", turnId: null } : activity;
  } catch {
    currentTurnRolloutPathCache.delete(cacheKey);
    return { status: "PENDING", turnId: null };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function findCodexCliPlanState(
  options: FindCodexCliPlanStateOptions
): Promise<CodexCliPlanState | null> {
  const stateDbPath = join(options.codexHome, "state_5.sqlite");
  const sql = `SELECT rollout_path FROM threads WHERE id = ${sqliteQuote(options.threadId)} LIMIT 2`;
  let rolloutPath: string;
  try {
    const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", stateDbPath, sql], {
      timeout: 1_500,
      maxBuffer: 64 * 1024
    });
    const rows = JSON.parse(String(stdout || "[]")) as Array<{ rollout_path?: unknown }>;
    if (rows.length !== 1 || typeof rows[0]?.rollout_path !== "string") return null;
    rolloutPath = resolve(rows[0].rollout_path);
  } catch {
    return null;
  }
  const codexHome = resolve(options.codexHome);
  if (rolloutPath !== codexHome && !rolloutPath.startsWith(`${codexHome}${sep}`)) return null;
  try {
    const content = await readFile(rolloutPath, "utf8");
    return inspectCodexCliPlanState(content, inspectCurrentCodexCliTurnActivity(content));
  } catch {
    return null;
  }
}

export async function findRecentNullAgentMessageDiagnostic(
  options: FindRecentNullAgentMessageDiagnosticOptions
): Promise<NullAgentMessageDiagnostic | null> {
  const files = (await collectRecentRolloutFiles(join(options.codexHome, "sessions"), options.sinceMs))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, options.maxFiles ?? 12);
  for (const file of files) {
    let content: string;
    try {
      content = await readFile(file.path, "utf8");
    } catch {
      continue;
    }
    if (rolloutThreadId(content) !== options.threadId) continue;
    const inputText = options.inputText?.trim();
    if (inputText && !content.includes(inputText)) continue;
    const diagnostic = detectNullAgentMessageRollout(file.path, content, { sinceMs: options.sinceMs });
    if (!diagnostic) continue;
    if (options.cwd && diagnostic.cwd && diagnostic.cwd !== options.cwd) continue;
    return diagnostic;
  }
  return null;
}
