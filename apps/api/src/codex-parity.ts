import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  codexEnvironmentSchema,
  codexHistoryItemSchema,
  codexHistoryResponseSchema,
  codexThreadItemSchema,
  codexThreadResponseSchema,
  reasoningEffortSchema,
  type CodexEnvironment,
  type CodexHistoryItem,
  type CodexHistoryResponse,
  type CodexThreadItem,
  type CodexThreadPresentation,
  type CodexThreadResponse
} from "@space/contracts";
import { redactMemoryText } from "@space/runtime";

const execFileAsync = promisify(execFile);
const defaultCodexHome = "/var/lib/spaceapp-user/.codex";
const defaultEnvironmentInspectorCommand = "/opt/spaceapp/bin/codex-vscode-parity";
const sqliteTimeoutMs = 5000;
const sqliteMaxBuffer = 2 * 1024 * 1024;
const historyBatchSize = 100;
const maxRolloutBytes = 20 * 1024 * 1024;
const maxRolloutItems = 1000;
const environmentInspectorTimeoutMs = 5000;
const environmentInspectorMaxBuffer = 1024 * 1024;
const lbUsageFetchTimeoutMs = 5000;
const defaultEnvironmentCacheTtlMs = 30_000;
const maxEnvironmentCacheTtlMs = 60_000;
const trustedChatBootstrapContextPattern = /# AGENTS\.md instructions for\s|<environment_context(?:>|\s)/iu;
const canonicalBootstrapDocPattern = /\/(?:etc\/docs\/gemini(?:_core)?\.md|etc\/AGENTS\.md|srv\/space\/AGENTS\.md)\b/iu;
const bootstrapDocReferencePattern = /\b(?:gemini(?:_core)?\.md|AGENTS\.md)\b/iu;

export interface CodexParityService {
  listHistory(input?: {
    page?: number;
    pageSize?: number;
    limit?: number;
    includeArchived?: boolean;
    dedupeTitles?: boolean;
    q?: string;
    mapRows?: (rows: CodexHistoryItem[]) => Promise<CodexHistoryItem[]> | CodexHistoryItem[];
  }): Promise<CodexHistoryResponse>;
  getHistoryThread(threadId: string): Promise<CodexHistoryItem>;
  getThread(threadId: string, options?: { presentation?: CodexThreadPresentation }): Promise<CodexThreadResponse>;
  renameThread(threadId: string, title: string): Promise<CodexHistoryItem>;
  getEnvironment(): Promise<CodexEnvironment>;
}

export interface CreateCodexParityServiceOptions {
  codexHome?: string;
  stateDbPath?: string;
  environmentInspectorCommand?: string | null;
  threadRenameCommand?: string | null;
  codexLbBaseUrl?: string | null;
  codexLbKeyFile?: string | null;
  codexRouteCommand?: string | null;
  environmentCacheTtlMs?: number;
}

export class CodexParityNotFoundError extends Error {
  readonly statusCode = 404;

  constructor(message: string) {
    super(message);
    this.name = "CodexParityNotFoundError";
  }
}

function sqliteQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function boundedLimit(value: number | undefined): number {
  if (!Number.isFinite(value ?? Number.NaN)) return 50;
  return Math.min(Math.max(Math.trunc(value ?? 50), 1), 100);
}

function boundedEnvironmentCacheTtl(value: number | undefined): number {
  if (!Number.isFinite(value ?? Number.NaN)) return defaultEnvironmentCacheTtlMs;
  return Math.min(Math.max(Math.trunc(value ?? defaultEnvironmentCacheTtlMs), 0), maxEnvironmentCacheTtlMs);
}

function boundedPage(value: number | undefined): number {
  if (!Number.isFinite(value ?? Number.NaN)) return 1;
  return Math.max(Math.trunc(value ?? 1), 1);
}

function normalizeHistoryText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function filterHistoryRows(rows: CodexHistoryItem[], input: { dedupeTitles: boolean; q?: string }): CodexHistoryItem[] {
  const queryTerms = normalizeHistoryText(input.q ?? "").split(" ").filter(Boolean);
  if (!input.dedupeTitles) {
    if (!queryTerms.length) return rows;
    return rows.filter((item) => {
      const searchable = normalizeHistoryText(`${item.title} ${item.firstUserMessage}`);
      return queryTerms.every((term) => searchable.includes(term));
    });
  }

  const groups = new Map<string, { item: CodexHistoryItem; searchable: string }>();
  for (const item of rows) {
    const key = normalizeHistoryText(item.title);
    const searchable = normalizeHistoryText(`${item.title} ${item.firstUserMessage}`);
    const existing = groups.get(key);
    if (existing) {
      existing.searchable += ` ${searchable}`;
    } else {
      groups.set(key, { item, searchable });
    }
  }

  return [...groups.values()]
    .filter((group) => queryTerms.every((term) => group.searchable.includes(term)))
    .map((group) => group.item);
}

async function runSqliteJson<T>(dbPath: string, sql: string): Promise<T[]> {
  const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", dbPath, sql], {
    timeout: sqliteTimeoutMs,
    maxBuffer: sqliteMaxBuffer
  });
  const text = stdout.trim();
  if (!text) return [];
  const parsed = JSON.parse(text) as unknown;
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

async function runSqliteWrite(dbPath: string, sql: string): Promise<void> {
  await execFileAsync("sqlite3", [dbPath, sql], {
    timeout: sqliteTimeoutMs,
    maxBuffer: 64 * 1024
  });
}

function readonlySqliteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /readonly database/i.test(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function booleanFromSqlite(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function normalizedBaseUrl(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
  return text || null;
}

interface CodexLbTarget {
  name: string;
  url: string;
}

interface CodexLbRouteStatus {
  routeMode: NonNullable<CodexEnvironment["lbUsage"]>["routeMode"];
  routeTargetMode: NonNullable<CodexEnvironment["lbUsage"]>["routeTargetMode"];
  activeTargets: CodexLbTarget[];
}

function codexLbAllAccountsRemainingPercent(payload: Record<string, unknown>): number | null {
  const pooled = numberValue(payload.remaining_percent);
  if (pooled !== null) return pooled;
  return numberValue(payload.all_accounts_remaining_percent);
}

function codexLbActiveAccountsRemainingPercent(payload: Record<string, unknown>): number | null {
  const pooled = numberValue(payload.active_pooled_remaining_percent);
  if (pooled !== null) return pooled;
  const legacy = numberValue(payload.active_remaining_percent);
  if (legacy !== null) return legacy;
  return numberValue(payload.active_accounts_remaining_percent);
}

function codexLbRouteMode(value: unknown): NonNullable<CodexEnvironment["lbUsage"]>["routeMode"] {
  return value === "direct" || value === "headroom" ? value : null;
}

function codexLbRouteTargetMode(value: unknown): NonNullable<CodexEnvironment["lbUsage"]>["routeTargetMode"] {
  return value === "primary" || value === "fallback" || value === "auto" ? value : null;
}

function codexLbErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "Codex LB request failed.";
  return safeText(message, 500) || "Codex LB request failed.";
}

function pushCodexLbTarget(targets: CodexLbTarget[], name: string, baseUrl: unknown): void {
  const normalized = normalizedBaseUrl(baseUrl);
  if (!normalized) return;
  const url = `${normalized}/api/codex/weekly-remaining`;
  if (targets.some((target) => target.url === url)) return;
  targets.push({ name, url });
}

function codexLbTargetsFromRouteStatus(routeStatus: CodexLbRouteStatus | null, codexLbBaseUrl: string | null): CodexLbTarget[] {
  const targets: CodexLbTarget[] = [];
  pushCodexLbTarget(targets, "proxy", codexLbBaseUrl);
  for (const target of routeStatus?.activeTargets ?? []) {
    if (targets.some((candidate) => candidate.url === target.url)) continue;
    targets.push(target);
  }
  return targets;
}

function isoFromEpoch(value: unknown): string | null {
  const numeric = numberValue(value);
  if (!numeric || numeric <= 0) return null;
  const ms = numeric > 10_000_000_000 ? numeric : numeric * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeReasoning(value: unknown): CodexHistoryItem["reasoningEffort"] {
  const parsed = reasoningEffortSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function safeText(value: unknown, maxLength: number): string {
  const text = typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
  return redactMemoryText(text).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function normalizeCodexThreadTitle(title: string): string {
  return safeText(title, 300) || "Untitled";
}

async function runThreadRenameCommand(command: string, threadId: string, title: string, stateDbPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, ["rename-thread", threadId], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CODEX_STATE_DB_PATH: stateDbPath
      }
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      stderr = stderr.slice(-8192);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `${command} rename-thread exited with code ${code ?? "unknown"}`));
    });
    child.stdin.end(`${title}\n`);
  });
}

function threadFromRow(row: Record<string, unknown>): CodexHistoryItem {
  return codexHistoryItemSchema.parse({
    id: safeText(row.id, 200),
    rolloutPath: stringValue(row.rolloutPath),
    title: safeText(row.title, 300) || "Untitled",
    preview: safeText(row.preview, 2000),
    model: stringValue(row.model),
    reasoningEffort: normalizeReasoning(row.reasoningEffort),
    cwd: stringValue(row.cwd),
    archived: booleanFromSqlite(row.archived),
    source: safeText(row.source, 120) || null,
    modelProvider: stringValue(row.modelProvider),
    threadSource: stringValue(row.threadSource),
    firstUserMessage: safeText(row.firstUserMessage, 2000),
    updatedAt: isoFromEpoch(row.updatedAtMs) ?? isoFromEpoch(row.updatedAt),
    recencyAt: isoFromEpoch(row.recencyAtMs) ?? isoFromEpoch(row.recencyAt)
  });
}

function isAllowedRolloutRelativePath(relativePath: string): boolean {
  if (!relativePath || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return false;
  const segments = relativePath.split(sep);
  if (segments[0] === "sessions" || segments[0] === "archived_sessions") return segments.length >= 2;
  return (
    segments[0] === "space-codex-homes" &&
    Boolean(segments[1]) &&
    (segments[2] === "sessions" || segments[2] === "archived_sessions") &&
    segments.length >= 4
  );
}

async function resolveRolloutPath(codexHome: string, rawPath: string | null): Promise<string> {
  if (!rawPath) {
    throw new CodexParityNotFoundError("Codex thread has no rollout file.");
  }
  const candidate = isAbsolute(rawPath) ? rawPath : join(codexHome, rawPath);
  let realCodexHome: string;
  let realCandidate: string;
  try {
    [realCodexHome, realCandidate] = await Promise.all([realpath(codexHome), realpath(resolve(candidate))]);
  } catch {
    throw new CodexParityNotFoundError("Codex rollout file was not found.");
  }
  if (!isAllowedRolloutRelativePath(relative(realCodexHome, realCandidate))) {
    throw new CodexParityNotFoundError("Codex rollout file is outside the shared Codex sessions directory.");
  }
  return realCandidate;
}

function textParts(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === "string") return [item];
      if (!isRecord(item)) return [];
      return [
        item.text,
        item.input_text,
        item.output_text,
        item.content
      ].filter((candidate): candidate is string => typeof candidate === "string");
    });
  }
  if (isRecord(value)) {
    return [
      value.text,
      value.input_text,
      value.output_text,
      value.content
    ].filter((candidate): candidate is string => typeof candidate === "string");
  }
  return [];
}

function messageContent(payload: Record<string, unknown>): string {
  const parts = [
    ...textParts(payload.content),
    ...textParts(payload.message),
    ...textParts(payload.text),
    ...textParts(payload.summary)
  ];
  return safeText(parts.join("\n\n"), 50_000);
}

function rawMessageContent(payload: Record<string, unknown>): string {
  return [
    ...textParts(payload.content),
    ...textParts(payload.message),
    ...textParts(payload.text),
    ...textParts(payload.summary)
  ].join("\n\n");
}

function safeChatText(value: unknown, maxLength: number): string {
  const text = typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
  return redactMemoryText(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxLength);
}

const artifactContextOpening = "Attached Space artifacts for this user message:";
const artifactContextClosing =
  "Use image artifacts directly when available. For other file kinds, use the artifact id/uri as the safe Space reference; do not guess raw file contents unless a mediated file-reading tool exposes them.";
const clipboardContextOpening = "Space private clipboard tools selected:";
const clipboardContextTail = [
  "Use these tools only when the operator explicitly asks to list, read, or save Space clipboard history or a designed plan. Never add clipboard history to an ordinary prompt.",
  "To request a clipboard action, include one fenced block named space-clipboard-actions with JSON only:",
  '```space-clipboard-actions\n{"version":1,"actions":[{"toolId":"clipboard:list","action":{"type":"list","pageSize":10}}]}\n```',
  "Action bodies: clipboard:list uses type=list with optional q/source/pageSize; clipboard:get uses type=get with clipboardItemId; clipboard:save uses type=save with text; clipboard:save-plan uses type=save-plan with text and an optional title.",
  "V1 allows at most 3 actions per turn. clipboard:save creates an AGENT_NOTE and accepts at most 10,000 characters. clipboard:save-plan stores a PLAN (the full designed plan) and accepts up to 100,000 characters. CLI agents do not have clipboard API access."
];
const taskContextOpening = "Space private task tools selected:";
const taskContextTail = [
  "Use these tools only when the operator explicitly asks to list, read, save, or update Space task declarations. Never add task declarations to an ordinary prompt.",
  "To request a task action, include one fenced block named space-task-actions with JSON only:",
  '```space-task-actions\n{"version":1,"actions":[{"toolId":"tasks:list","action":{"type":"list","pageSize":10}}]}\n```',
  "Action bodies: tasks:list uses type=list with optional q/status/pageSize; tasks:get uses type=get with taskItemId; tasks:save uses type=save with title and objective; tasks:update uses type=update with taskItemId and optional status/objective.",
  "V1 allows at most 3 actions per turn. tasks:save creates an OPEN task with source AGENT and accepts objectives up to 10,000 characters. CLI agents do not have task API access."
];
const restartRecoveryPrompt =
  "Continue only unfinished work after the Space worker restarted. Inspect durable room and thread progress before acting, and do not repeat completed actions.";
const trailingRoomActionMarker = /(?:\n\n)?<space-room-action marker="[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}">Internal recovery marker; ignore and do not mention\.<\/space-room-action>\s*$/i;
const trailingDurableTurnMarker = /(?:\n\n)?<space-durable-turn marker="[A-Za-z0-9:._-]{1,500}">Internal recovery marker; do not mention it in your response\.<\/space-durable-turn>\s*$/;

function isTrustedArtifactContext(value: string): boolean {
  const lines = value.split("\n");
  const artifactLines = lines.slice(1, -1);
  return (
    lines[0] === artifactContextOpening &&
    lines.at(-1) === artifactContextClosing &&
    artifactLines.length >= 1 &&
    artifactLines.length <= 8 &&
    artifactLines.every((line) =>
      line.startsWith("- ") &&
      line.includes("; kind=") &&
      line.includes("; mime=") &&
      line.includes("; bytes=") &&
      line.includes("; uri=")
    )
  );
}

function isTrustedClipboardContext(value: string): boolean {
  const lines = value.split("\n");
  if (lines[0] !== clipboardContextOpening || !/^tools=clipboard:(?:list|get|save|save-plan)(?:, clipboard:(?:list|get|save|save-plan))*$/.test(lines[1] ?? "")) {
    return false;
  }
  return lines.slice(2).join("\n") === clipboardContextTail.join("\n");
}

function isTrustedTaskContext(value: string): boolean {
  const lines = value.split("\n");
  if (lines[0] !== taskContextOpening || !/^tools=tasks:(?:list|get|save|update)(?:, tasks:(?:list|get|save|update))*$/.test(lines[1] ?? "")) {
    return false;
  }
  return lines.slice(2).join("\n") === taskContextTail.join("\n");
}

function stripTrustedSpacePromptWrapper(value: string): string {
  const separator = "\n\nUser prompt:\n";
  const separatorIndex = value.indexOf(separator);
  const contexts = value.slice(0, separatorIndex < 0 ? undefined : separatorIndex).split("\n\n");
  if (!contexts.length || !contexts.every((context) => isTrustedArtifactContext(context) || isTrustedClipboardContext(context) || isTrustedTaskContext(context))) {
    return value;
  }
  if (separatorIndex < 0) return "";
  return value.slice(separatorIndex + separator.length);
}

function stripTrailingSpaceMarkers(value: string): { value: string; strippedTrustedMarker: boolean } {
  let next = value;
  let strippedTrustedMarker = false;
  for (;;) {
    const stripped = next.replace(trailingRoomActionMarker, "").replace(trailingDurableTurnMarker, "");
    if (stripped === next) return { value: next, strippedTrustedMarker };
    strippedTrustedMarker = true;
    next = stripped;
  }
}

function isTrustedBootstrapEnvelope(value: string): boolean {
  return (
    value.startsWith("# AGENTS.md instructions for ") &&
    value.includes("<environment_context>") &&
    value.endsWith("</environment_context>")
  );
}

function chatUserPrompt(payload: Record<string, unknown>): string | null {
  const raw = rawMessageContent({ content: payload.message ?? payload.content ?? payload.text });
  const stripped = stripTrailingSpaceMarkers(raw);
  const prompt = safeChatText(stripTrustedSpacePromptWrapper(stripped.value), 50_000);
  if (!prompt || isTrustedBootstrapEnvelope(prompt)) return null;
  if (stripped.strippedTrustedMarker && prompt === restartRecoveryPrompt) return null;
  return prompt;
}

function roleFromValue(value: unknown): CodexThreadItem["role"] {
  return value === "user" || value === "assistant" || value === "system" || value === "tool" ? value : null;
}

function buildThreadItem(
  index: number,
  timestamp: string | null,
  input: Partial<CodexThreadItem> & Pick<CodexThreadItem, "kind" | "content">
): CodexThreadItem | null {
  const content = safeText(input.content, 50_000);
  if (!content && input.kind !== "tool_call") return null;
  return codexThreadItemSchema.parse({
    id: `${timestamp ?? "rollout"}:${index}`,
    kind: input.kind,
    role: input.role ?? null,
    content,
    toolName: input.toolName ?? null,
    rawType: input.rawType ?? null,
    createdAt: timestamp
  });
}

function buildChatThreadItem(
  index: number,
  timestamp: string | null,
  input: Partial<CodexThreadItem> & Pick<CodexThreadItem, "kind" | "content">
): CodexThreadItem | null {
  const content = safeChatText(input.content, 50_000);
  if (!content && input.kind !== "tool_call") return null;
  return codexThreadItemSchema.parse({
    id: `${timestamp ?? "rollout"}:${index}`,
    kind: input.kind,
    role: input.role ?? null,
    content,
    toolName: input.toolName ?? null,
    rawType: input.rawType ?? null,
    createdAt: timestamp
  });
}

function chatToolCallContent(payload: Record<string, unknown>, itemType: string): string {
  const detail = itemType === "custom_tool_call"
    ? payload.input ?? payload.arguments
    : itemType === "local_shell_call" || itemType === "web_search_call"
      ? payload.action ?? payload.command ?? payload.query
      : payload.arguments ?? payload.query ?? payload.command;
  return safeChatText(detail, 50_000) || "Tool call";
}

interface ChatRolloutProjectionState {
  trustedBootstrapContextSeen: boolean;
  latestUserPrompt: string | null;
  suppressedToolCallIds: Set<string>;
}

function shouldSuppressChatBootstrapTool(
  state: ChatRolloutProjectionState,
  content: string
): boolean {
  return state.trustedBootstrapContextSeen &&
    canonicalBootstrapDocPattern.test(content) &&
    !bootstrapDocReferencePattern.test(state.latestUserPrompt ?? "");
}

function itemFromRolloutLine(index: number, line: string): CodexThreadItem | null {
  const parsed = JSON.parse(line) as unknown;
  if (!isRecord(parsed)) return null;
  const timestamp = stringValue(parsed.timestamp);
  const payload = isRecord(parsed.payload) ? parsed.payload : {};
  const type = stringValue(parsed.type);

  if (type === "session_meta") {
    const cwd = stringValue(payload.cwd);
    const source = stringValue(payload.source);
    const modelProvider = stringValue(payload.model_provider);
    const content = ["Session started", cwd ? `cwd ${cwd}` : null, source ? `source ${source}` : null, modelProvider ? `provider ${modelProvider}` : null]
      .filter(Boolean)
      .join(" · ");
    return buildThreadItem(index, timestamp, { kind: "metadata", role: "system", content, rawType: type });
  }

  if (type === "turn_context") {
    const cwd = stringValue(payload.cwd);
    const model = stringValue(payload.model);
    const content = ["Turn context", cwd ? `cwd ${cwd}` : null, model ? `model ${model}` : null].filter(Boolean).join(" · ");
    return buildThreadItem(index, timestamp, { kind: "metadata", role: "system", content, rawType: type });
  }

  if (type === "event_msg") {
    const eventType = stringValue(payload.type);
    if (eventType === "agent_message" || eventType === "user_message") return null;
    return buildThreadItem(index, timestamp, {
      kind: "event",
      role: "assistant",
      content: messageContent(payload),
      rawType: eventType ?? type
    });
  }

  if (type !== "response_item") return null;

  const itemType = stringValue(payload.type);
  if (itemType === "message") {
    const role = roleFromValue(payload.role);
    if (role !== "user" && role !== "assistant") return null;
    return buildThreadItem(index, timestamp, {
      kind: "message",
      role,
      content: messageContent(payload),
      rawType: itemType
    });
  }
  if (itemType === "reasoning") {
    return buildThreadItem(index, timestamp, {
      kind: "reasoning",
      role: "assistant",
      content: messageContent(payload) || "Reasoning",
      rawType: itemType
    });
  }
  if (itemType === "function_call") {
    return buildThreadItem(index, timestamp, {
      kind: "tool_call",
      role: "tool",
      content: messageContent({ content: payload.arguments }) || "Tool call",
      toolName: stringValue(payload.name),
      rawType: itemType
    });
  }
  if (itemType === "function_call_output") {
    return buildThreadItem(index, timestamp, {
      kind: "tool_result",
      role: "tool",
      content: messageContent({ content: payload.output ?? payload.content }),
      toolName: stringValue(payload.name),
      rawType: itemType
    });
  }
  return null;
}

function itemFromChatRolloutLine(
  index: number,
  line: string,
  state: ChatRolloutProjectionState
): CodexThreadItem | null {
  const parsed = JSON.parse(line) as unknown;
  if (!isRecord(parsed)) return null;
  const timestamp = stringValue(parsed.timestamp);
  const payload = isRecord(parsed.payload) ? parsed.payload : {};
  const type = stringValue(parsed.type);

  if (type === "event_msg") {
    if (stringValue(payload.type) !== "user_message") return null;
    const content = chatUserPrompt(payload);
    if (content) state.latestUserPrompt = content;
    return content
      ? buildChatThreadItem(index, timestamp, { kind: "message", role: "user", content, rawType: "user_message" })
      : null;
  }

  if (type !== "response_item") return null;
  const itemType = stringValue(payload.type);
  if (itemType === "message") {
    const role = roleFromValue(payload.role);
    if (role === "user") {
      const rawContent = rawMessageContent(payload);
      if (trustedChatBootstrapContextPattern.test(rawContent)) {
        state.trustedBootstrapContextSeen = true;
        return null;
      }
      const content = chatUserPrompt(payload);
      if (content) state.latestUserPrompt = content;
      return content
        ? buildChatThreadItem(index, timestamp, { kind: "message", role, content, rawType: itemType })
        : null;
    }
    if (role !== "assistant") return null;
    return buildChatThreadItem(index, timestamp, {
      kind: "message",
      role: "assistant",
      content: rawMessageContent(payload),
      rawType: itemType
    });
  }
  if (itemType === "reasoning") {
    return buildChatThreadItem(index, timestamp, {
      kind: "reasoning",
      role: "assistant",
      content: rawMessageContent(payload) || "Reasoning",
      rawType: itemType
    });
  }
  if (itemType === "function_call" || itemType === "custom_tool_call" || itemType === "local_shell_call" || itemType === "web_search_call") {
    const content = chatToolCallContent(payload, itemType);
    const callId = stringValue(payload.call_id);
    if (callId && shouldSuppressChatBootstrapTool(state, content)) {
      state.suppressedToolCallIds.add(callId);
      return null;
    }
    return buildChatThreadItem(index, timestamp, {
      kind: "tool_call",
      role: "tool",
      content,
      toolName: stringValue(payload.name) ?? stringValue(payload.tool) ?? itemType.replace(/_call$/, ""),
      rawType: itemType
    });
  }
  if (itemType === "function_call_output" || itemType === "custom_tool_call_output" || itemType === "local_shell_call_output") {
    const callId = stringValue(payload.call_id);
    if (callId && state.suppressedToolCallIds.delete(callId)) return null;
    return buildChatThreadItem(index, timestamp, {
      kind: "tool_result",
      role: "tool",
      content: rawMessageContent({ content: payload.output ?? payload.content }),
      toolName: stringValue(payload.name) ?? stringValue(payload.tool),
      rawType: itemType
    });
  }
  return null;
}

async function readRolloutItems(path: string, presentation: CodexThreadPresentation = "raw"): Promise<CodexThreadItem[]> {
  const fileStats = await stat(path);
  if (fileStats.size > maxRolloutBytes) {
    throw new Error("Codex rollout file is too large for bounded API rendering.");
  }
  const stream = createReadStream(path, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  const items: CodexThreadItem[] = [];
  const chatState: ChatRolloutProjectionState = {
    trustedBootstrapContextSeen: false,
    latestUserPrompt: null,
    suppressedToolCallIds: new Set()
  };
  let index = 0;
  for await (const rawLine of reader) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const item = presentation === "chat"
        ? itemFromChatRolloutLine(index, line, chatState)
        : itemFromRolloutLine(index, line);
      if (item) {
        const previous = items.at(-1);
        const isDuplicateChatUserRecord =
          presentation === "chat" &&
          item.role === "user" &&
          previous?.role === "user" &&
          previous.content === item.content &&
          previous.rawType !== item.rawType;
        if (!isDuplicateChatUserRecord) items.push(item);
      }
    } catch {
      if (presentation === "chat") {
        index += 1;
        continue;
      }
      items.push(
        codexThreadItemSchema.parse({
          id: `rollout:${index}`,
          kind: "metadata",
          role: "system",
          content: "Skipped an unreadable rollout line.",
          toolName: null,
          rawType: "parse_error",
          createdAt: null
        })
      );
    }
    index += 1;
    if (items.length >= maxRolloutItems) break;
  }
  return items;
}

function stringSetting(content: string, name: string): string | null {
  const match = content.match(new RegExp(`^\\s*${name}\\s*=\\s*["']([^"']+)["']\\s*$`, "m"));
  return match?.[1] ?? null;
}

function booleanSettingInSection(content: string, sectionName: string, name: string): boolean | null {
  const lines = content.split(/\r?\n/);
  let inSection = false;
  for (const line of lines) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (section) {
      inSection = section[1] === sectionName;
      continue;
    }
    if (!inSection) continue;
    const match = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(true|false)\\s*$`, "i"));
    const value = match?.[1];
    if (value) return value.toLowerCase() === "true";
  }
  return null;
}

function mcpServerNames(content: string): string[] {
  const names = new Set<string>();
  for (const match of content.matchAll(/^\s*\[mcp_servers\.([^\]]+)\]\s*$/gm)) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    names.add(raw.replace(/^["']|["']$/g, ""));
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

async function countNamedFiles(root: string, filename: string, maxDepth = 7): Promise<number> {
  async function visit(path: string, depth: number): Promise<number> {
    if (depth > maxDepth) return 0;
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return 0;
    }
    let count = 0;
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const child = join(path, entry.name);
      if (entry.isFile() && entry.name === filename) {
        count += 1;
      } else if (entry.isDirectory()) {
        count += await visit(child, depth + 1);
      }
    }
    return count;
  }
  return visit(root, 0);
}

function isConfigReadFallbackError(error: unknown): boolean {
  const code = isRecord(error) ? error.code : null;
  return code === "EACCES" || code === "EPERM" || code === "EISDIR";
}

export async function readCodexEnvironmentMetadata(codexHome: string, stateDbPath: string): Promise<CodexEnvironment> {
  const configText = await readFile(join(codexHome, "config.toml"), "utf8").catch((error: unknown) => {
    const code = isRecord(error) ? error.code : null;
    if (code === "ENOENT") return "";
    throw error;
  });
  const reasoning = stringSetting(configText, "model_reasoning_effort");
  return codexEnvironmentSchema.parse({
    codexHome,
    stateDbPath,
    config: {
      modelProvider: stringSetting(configText, "model_provider"),
      model: stringSetting(configText, "model"),
      reasoningEffort: normalizeReasoning(reasoning)
    },
    mcpServers: mcpServerNames(configText),
    skillCount: await countNamedFiles(join(codexHome, "skills"), "SKILL.md"),
    pluginCount: await countNamedFiles(join(codexHome, "plugins"), "plugin.json"),
    memories: {
      generateMemories: booleanSettingInSection(configText, "memories", "generate_memories"),
      useMemories: booleanSettingInSection(configText, "memories", "use_memories")
    },
    features: {
      plugins: booleanSettingInSection(configText, "features", "plugins"),
      memories: booleanSettingInSection(configText, "features", "memories")
    },
    checkedAt: new Date().toISOString()
  });
}

async function fetchJsonRecord(url: string, headers: Record<string, string>): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), lbUsageFetchTimeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        ...headers
      },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`Codex LB HTTP ${response.status} from ${url}`);
    }
    const payload = (await response.json()) as unknown;
    if (!isRecord(payload)) {
      throw new Error(`Codex LB returned a non-object payload from ${url}`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function inspectCodexLbRouteStatus(command: string): Promise<CodexLbRouteStatus> {
  const { stdout } = await execFileAsync(command, ["route-status"], {
    timeout: environmentInspectorTimeoutMs,
    maxBuffer: environmentInspectorMaxBuffer
  });
  const parsed = JSON.parse(stdout) as unknown;
  const root = isRecord(parsed) ? parsed : {};
  const route = isRecord(root.route) ? root.route : {};
  const activeUpstreams = Array.isArray(root.active_upstreams) ? root.active_upstreams : [];
  const routeMode = codexLbRouteMode(route.route_mode);
  const routeTargetMode = codexLbRouteTargetMode(route.mode);
  const activeTargets: CodexLbTarget[] = [];
  for (const item of activeUpstreams) {
    if (!isRecord(item)) continue;
    const name = stringValue(item.name);
    const baseUrl = normalizedBaseUrl(item.base_url);
    if (!name || !baseUrl) continue;
    pushCodexLbTarget(activeTargets, name, baseUrl);
  }
  if (activeTargets.length === 0) {
    if (routeMode === "headroom") {
      pushCodexLbTarget(activeTargets, "headroom", route.headroom_base_url);
    }
    if (routeTargetMode === "fallback") {
      pushCodexLbTarget(activeTargets, "fallback", route.fallback_base_url);
    } else if (routeTargetMode === "auto") {
      pushCodexLbTarget(activeTargets, "primary", route.primary_base_url);
      pushCodexLbTarget(activeTargets, "fallback", route.fallback_base_url);
    } else {
      pushCodexLbTarget(activeTargets, "primary", route.primary_base_url);
    }
  }
  return {
    routeMode,
    routeTargetMode,
    activeTargets
  };
}

async function readCodexLbUsage(input: {
  codexLbBaseUrl: string | null;
  codexLbKeyFile: string | null;
  codexRouteCommand: string | null;
}): Promise<NonNullable<CodexEnvironment["lbUsage"]> | null> {
  if (!input.codexLbKeyFile && !input.codexLbBaseUrl && !input.codexRouteCommand) {
    return null;
  }

  const checkedAt = new Date().toISOString();
  let routeStatus: CodexLbRouteStatus | null = null;
  if (input.codexRouteCommand) {
    try {
      routeStatus = await inspectCodexLbRouteStatus(input.codexRouteCommand);
    } catch {
      routeStatus = null;
    }
  }

  if (!input.codexLbKeyFile) {
    return {
      allAccountsRemainingPercent: null,
      activeAccountsRemainingPercent: null,
      routeMode: routeStatus?.routeMode ?? null,
      routeTargetMode: routeStatus?.routeTargetMode ?? null,
      upstream: null,
      source: null,
      error: "Codex LB key file is not configured.",
      checkedAt
    };
  }

  let credential = "";
  try {
    credential = (await readFile(input.codexLbKeyFile, "utf8")).trim();
  } catch (error) {
    return {
      allAccountsRemainingPercent: null,
      activeAccountsRemainingPercent: null,
      routeMode: routeStatus?.routeMode ?? null,
      routeTargetMode: routeStatus?.routeTargetMode ?? null,
      upstream: null,
      source: null,
      error: codexLbErrorMessage(error),
      checkedAt
    };
  }
  if (!credential) {
    return {
      allAccountsRemainingPercent: null,
      activeAccountsRemainingPercent: null,
      routeMode: routeStatus?.routeMode ?? null,
      routeTargetMode: routeStatus?.routeTargetMode ?? null,
      upstream: null,
      source: null,
      error: "Codex LB key file is empty.",
      checkedAt
    };
  }

  const targets = codexLbTargetsFromRouteStatus(routeStatus, input.codexLbBaseUrl);
  if (!targets.length) {
    return {
      allAccountsRemainingPercent: null,
      activeAccountsRemainingPercent: null,
      routeMode: routeStatus?.routeMode ?? null,
      routeTargetMode: routeStatus?.routeTargetMode ?? null,
      upstream: null,
      source: null,
      error: "Codex LB weekly remaining targets are not configured.",
      checkedAt
    };
  }

  let lastError = "Codex LB weekly remaining request failed.";
  const headers = { Authorization: `Bearer ${credential}` };
  for (const target of targets) {
    try {
      const payload = await fetchJsonRecord(target.url, headers);
      return {
        allAccountsRemainingPercent: codexLbAllAccountsRemainingPercent(payload),
        activeAccountsRemainingPercent: codexLbActiveAccountsRemainingPercent(payload),
        routeMode: routeStatus?.routeMode ?? null,
        routeTargetMode: routeStatus?.routeTargetMode ?? null,
        upstream: stringValue(payload.upstream) ?? target.name,
        source: stringValue(payload.source),
        error: null,
        checkedAt
      };
    } catch (error) {
      lastError = codexLbErrorMessage(error);
    }
  }

  return {
    allAccountsRemainingPercent: null,
    activeAccountsRemainingPercent: null,
    routeMode: routeStatus?.routeMode ?? null,
    routeTargetMode: routeStatus?.routeTargetMode ?? null,
    upstream: null,
    source: null,
    error: lastError,
    checkedAt
  };
}

async function inspectEnvironmentWithWrapper(command: string): Promise<CodexEnvironment> {
  const { stdout } = await execFileAsync(command, ["inspect-env"], {
    timeout: environmentInspectorTimeoutMs,
    maxBuffer: environmentInspectorMaxBuffer
  });
  return codexEnvironmentSchema.parse(JSON.parse(stdout) as unknown);
}

export function createCodexParityService(options: CreateCodexParityServiceOptions = {}): CodexParityService {
  const codexHome = resolve(options.codexHome ?? defaultCodexHome);
  const stateDbPath = resolve(options.stateDbPath ?? join(codexHome, "state_5.sqlite"));
  const environmentInspectorCommand =
    options.environmentInspectorCommand === undefined ? defaultEnvironmentInspectorCommand : options.environmentInspectorCommand;
  const threadRenameCommand =
    options.threadRenameCommand === undefined ? environmentInspectorCommand : options.threadRenameCommand;
  const codexLbBaseUrl = normalizedBaseUrl(options.codexLbBaseUrl);
  const codexLbKeyFile = options.codexLbKeyFile ? resolve(options.codexLbKeyFile) : null;
  const codexRouteCommand =
    options.codexRouteCommand === undefined ? defaultEnvironmentInspectorCommand : options.codexRouteCommand;
  const environmentCacheTtlMs = boundedEnvironmentCacheTtl(options.environmentCacheTtlMs);
  let environmentCache: { value: CodexEnvironment; expiresAt: number } | null = null;
  let environmentInFlight: Promise<CodexEnvironment> | null = null;

  async function withLbUsage(environment: CodexEnvironment): Promise<CodexEnvironment> {
    const lbUsage = await readCodexLbUsage({
      codexLbBaseUrl,
      codexLbKeyFile,
      codexRouteCommand
    });
    return codexEnvironmentSchema.parse({
      ...environment,
      ...(lbUsage ? { lbUsage } : {})
    });
  }

  async function readEnvironment(): Promise<CodexEnvironment> {
    let environment: CodexEnvironment;
    try {
      environment = await readCodexEnvironmentMetadata(codexHome, stateDbPath);
    } catch (error) {
      if (environmentInspectorCommand && isConfigReadFallbackError(error)) {
        environment = await inspectEnvironmentWithWrapper(environmentInspectorCommand);
      } else {
        throw error;
      }
    }
    return withLbUsage(environment);
  }

  function refreshEnvironment(): Promise<CodexEnvironment> {
    if (environmentInFlight) return environmentInFlight;
    const request = readEnvironment().then((value) => {
      environmentCache = {
        value,
        expiresAt: Date.now() + environmentCacheTtlMs
      };
      return value;
    });
    environmentInFlight = request;
    const clearIfCurrent = () => {
      if (environmentInFlight === request) environmentInFlight = null;
    };
    void request.then(clearIfCurrent, clearIfCurrent);
    return request;
  }

  function getEnvironment(): Promise<CodexEnvironment> {
    const now = Date.now();
    if (environmentCache && environmentCache.expiresAt > now) {
      return Promise.resolve(environmentCache.value);
    }
    if (environmentCache) {
      void refreshEnvironment().catch(() => undefined);
      return Promise.resolve(environmentCache.value);
    }
    return refreshEnvironment();
  }

  async function historyRows(input: { whereClause: string; limit?: number; offset?: number }): Promise<CodexHistoryItem[]> {
    const rows = await runSqliteJson<Record<string, unknown>>(
      stateDbPath,
      [
        "select",
        "id, rollout_path as rolloutPath, title, preview, model, reasoning_effort as reasoningEffort, cwd, archived, source,",
        "model_provider as modelProvider, thread_source as threadSource, first_user_message as firstUserMessage,",
        "updated_at as updatedAt, updated_at_ms as updatedAtMs, recency_at as recencyAt, recency_at_ms as recencyAtMs",
        "from threads",
        input.whereClause,
        "order by coalesce(recency_at_ms, updated_at_ms, updated_at * 1000, recency_at * 1000, 0) desc, id desc",
        input.limit === undefined ? "" : `limit ${input.limit}`,
        input.offset ? `offset ${input.offset}` : ""
      ].join(" ")
    );
    return rows.map(threadFromRow);
  }

  async function allHistoryRows(whereClause: string): Promise<CodexHistoryItem[]> {
    const rows: CodexHistoryItem[] = [];
    for (let offset = 0; ; offset += historyBatchSize) {
      const batch = await historyRows({ whereClause, limit: historyBatchSize, offset });
      rows.push(...batch);
      if (batch.length < historyBatchSize) return rows;
    }
  }

  async function historyCounts(): Promise<{ totalItems: number; visibleItems: number }> {
    const rows = await runSqliteJson<{ totalItems?: unknown; visibleItems?: unknown }>(
      stateDbPath,
      "select count(*) as totalItems, coalesce(sum(case when archived = 0 then 1 else 0 end), 0) as visibleItems from threads"
    );
    return {
      totalItems: Math.max(0, Math.trunc(numberValue(rows[0]?.totalItems) ?? 0)),
      visibleItems: Math.max(0, Math.trunc(numberValue(rows[0]?.visibleItems) ?? 0))
    };
  }

  async function historyThread(threadId: string): Promise<CodexHistoryItem> {
    const rows = await historyRows({ whereClause: `where id = ${sqliteQuote(threadId)}`, limit: 1 });
    const thread = rows[0];
    if (!thread) {
      throw new CodexParityNotFoundError(`Codex thread ${threadId} was not found.`);
    }
    return thread;
  }

  return {
    async listHistory(input = {}) {
      const pageSize = boundedLimit(input.pageSize ?? input.limit);
      const page = boundedPage(input.page);
      const query = input.q?.trim();
      if (input.dedupeTitles || query) {
        const sourceRows = await allHistoryRows("");
        const rows = input.mapRows ? await input.mapRows(sourceRows) : sourceRows;
        const allItems = filterHistoryRows(rows, { dedupeTitles: Boolean(input.dedupeTitles), q: query });
        const visibleItems = filterHistoryRows(
          rows.filter((item) => !item.archived),
          { dedupeTitles: Boolean(input.dedupeTitles), q: query }
        );
        const selectedItems = input.includeArchived ? allItems : visibleItems;
        const start = (page - 1) * pageSize;
        const paginationTotalItems = selectedItems.length;
        return codexHistoryResponseSchema.parse({
          data: selectedItems.slice(start, start + pageSize),
          totalItems: allItems.length,
          visibleItems: visibleItems.length,
          pagination: {
            page,
            pageSize,
            totalItems: paginationTotalItems,
            totalPages: paginationTotalItems === 0 ? 0 : Math.ceil(paginationTotalItems / pageSize)
          },
          checkedAt: new Date().toISOString()
        });
      }
      const [counts, sourceData] = await Promise.all([
        historyCounts(),
        historyRows({
          whereClause: input.includeArchived ? "" : "where archived = 0",
          limit: pageSize,
          offset: (page - 1) * pageSize
        })
      ]);
      const data = input.mapRows ? await input.mapRows(sourceData) : sourceData;
      const paginationTotalItems = input.includeArchived ? counts.totalItems : counts.visibleItems;
      return codexHistoryResponseSchema.parse({
        data,
        ...counts,
        pagination: {
          page,
          pageSize,
          totalItems: paginationTotalItems,
          totalPages: paginationTotalItems === 0 ? 0 : Math.ceil(paginationTotalItems / pageSize)
        },
        checkedAt: new Date().toISOString()
      });
    },

    async getHistoryThread(threadId: string) {
      return historyThread(threadId);
    },

    async getThread(threadId: string, input: { presentation?: CodexThreadPresentation } = {}) {
      const thread = await historyThread(threadId);
      const rolloutPath = await resolveRolloutPath(codexHome, thread.rolloutPath);
      const items = await readRolloutItems(rolloutPath, input.presentation ?? "raw");
      return codexThreadResponseSchema.parse({
        thread,
        items,
        checkedAt: new Date().toISOString()
      });
    },

    async renameThread(threadId: string, title: string) {
      await historyThread(threadId);
      const nextTitle = normalizeCodexThreadTitle(title);
      try {
        await runSqliteWrite(
          stateDbPath,
          `update threads set title = ${sqliteQuote(nextTitle)} where id = ${sqliteQuote(threadId)}`
        );
      } catch (error) {
        if (!threadRenameCommand || !readonlySqliteError(error)) {
          throw error;
        }
        await runThreadRenameCommand(threadRenameCommand, threadId, nextTitle, stateDbPath);
      }
      return historyThread(threadId);
    },

    getEnvironment
  };
}
