import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, appendFile, mkdir, open, readFile, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  codexGoalSharedTaskSchema,
  codexGoalStatusSchema,
  memoryEntrySchema,
  type CodexGoalSharedTask,
  type CreateMemoryEntryInput,
  type ListMemoryQuery,
  type MemoryEntry,
  type UpdateCodexGoalTaskInput
} from "@space/contracts";
import { nowIso, redactMemoryText } from "./store.js";

const execFileAsync = promisify(execFile);
const canonicalMemoryListLimit = 1000;

export interface CanonicalGeminiMemoryPaths {
  indexPath: string;
  monthlyPath: string;
  lockPath?: string;
}

export interface CanonicalMemoryBridge {
  list(query: ListMemoryQuery): Promise<MemoryEntry[]>;
  save(input: CreateMemoryEntryInput, traceId?: string): Promise<MemoryEntry>;
}

export interface CodexGoalsAdapter {
  list(): Promise<CodexGoalSharedTask[]>;
  update(threadId: string, input: UpdateCodexGoalTaskInput): Promise<CodexGoalSharedTask | null>;
}

function athensMonthFor(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Athens",
    year: "numeric",
    month: "2-digit"
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) throw new Error("Unable to resolve the Athens calendar month.");
  return `${year}-${month}`;
}

export function defaultCanonicalGeminiMemoryPaths(date = new Date()): CanonicalGeminiMemoryPaths {
  return resolveCanonicalGeminiMemoryPaths({}, date);
}

export function resolveCanonicalGeminiMemoryPaths(
  env: Record<string, string | undefined>,
  date = new Date()
): Required<CanonicalGeminiMemoryPaths> {
  const memoryRoot = env.SPACE_MEMORY_ROOT?.trim();
  const defaultIndexPath = memoryRoot ? join(memoryRoot, "gemini_history.md") : "/opt/spaceapp/docs/gemini_history.md";
  const defaultMonthlyPath = memoryRoot
    ? join(memoryRoot, `gemini_history_${athensMonthFor(date)}.md`)
    : `/opt/spaceapp/docs/gemini_history_${athensMonthFor(date)}.md`;
  const monthlyPath = env.SPACE_GEMINI_MEMORY_MONTHLY_PATH || defaultMonthlyPath;
  return {
    indexPath: env.SPACE_GEMINI_MEMORY_INDEX_PATH || defaultIndexPath,
    monthlyPath,
    lockPath: env.SPACE_GEMINI_MEMORY_LOCK_PATH || `${monthlyPath}.lock`
  };
}

function memoryReferenceMatchesQuery(text: string, query: string): boolean {
  const normalizedText = text.toLowerCase();
  const normalizedQuery = query.toLowerCase();
  if (normalizedText.includes(normalizedQuery)) return true;
  const terms = normalizedQuery.split(/\s+/).filter((term) => term.length >= 3);
  return terms.length > 0 && terms.every((term) => normalizedText.includes(term));
}

function canonicalMemoryId(path: string, line: string): string {
  return `gemini_memory:${createHash("sha256").update(`${path}\n${line}`).digest("hex").slice(0, 24)}`;
}

function canonicalMemoryEntry(path: string, line: string): MemoryEntry {
  const titleSource = line.replace(/^#+\s*/, "").replace(/^[-*]\s*/, "").trim() || basename(path, ".md");
  return memoryEntrySchema.parse({
    id: canonicalMemoryId(path, line),
    scope: "SYSTEM",
    roomId: null,
    title: redactMemoryText(titleSource).slice(0, 160),
    body: redactMemoryText(line).slice(0, 10000),
    provenance: path,
    createdAt: nowIso()
  });
}

async function readCanonicalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function listCanonicalGeminiMemory(paths: CanonicalGeminiMemoryPaths, query: ListMemoryQuery): Promise<MemoryEntry[]> {
  const uniquePaths = Array.from(new Set([paths.monthlyPath, paths.indexPath]));
  const entries: MemoryEntry[] = [];
  for (const path of uniquePaths) {
    const text = await readCanonicalFile(path);
    if (!text) continue;
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const matches = lines.filter((line) => {
      if (!query.q) return line.startsWith("## ") || line.startsWith("- ");
      return memoryReferenceMatchesQuery(line, query.q);
    });
    for (const line of matches) {
      entries.push(canonicalMemoryEntry(path, line));
      if (entries.length >= canonicalMemoryListLimit) return entries;
    }
  }
  return entries;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.close();
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" || Date.now() - startedAt > 5000) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockPath, { force: true });
  }
}

function canonicalAppendBlock(
  path: string,
  input: CreateMemoryEntryInput,
  traceId: string | undefined,
  createdAt: string
): { block: string; body: string; id: string; title: string } {
  const title = redactMemoryText(input.title).slice(0, 160);
  const body = redactMemoryText(input.body).slice(0, 10000);
  const id = `gemini_memory:${createHash("sha256").update(`${path}\n${createdAt}\n${title}\n${body}`).digest("hex").slice(0, 24)}`;
  const provenance = redactMemoryText(input.provenance).slice(0, 500);
  const roomSuffix = input.roomId ? `, room=${input.roomId}` : "";
  const date = createdAt.slice(0, 10);
  const tagLine = input.tags?.length
    ? [`- Tags: ${input.tags.map((tag) => redactMemoryText(tag)).join(", ")}`]
    : [];
  const lines = [
    `<!-- space-memory:id=${id} -->`,
    `## ${date} - Space canonical memory: ${title}`,
    "",
    `- Source: Space API memory.save; original_scope=${input.scope}${roomSuffix}; provenance=${provenance}; trace=${traceId ?? "none"}.`,
    ...tagLine,
    `- ${body}`,
    ""
  ];
  return { block: lines.join("\n"), body, id, title };
}

async function appendCanonicalGeminiMemory(
  paths: CanonicalGeminiMemoryPaths,
  input: CreateMemoryEntryInput,
  traceId?: string
): Promise<MemoryEntry> {
  await mkdir(dirname(paths.monthlyPath), { recursive: true });
  const lockPath = paths.lockPath ?? `${paths.monthlyPath}.lock`;
  const createdAt = nowIso();
  const { block, body, id, title } = canonicalAppendBlock(paths.monthlyPath, input, traceId, createdAt);
  await withFileLock(lockPath, async () => {
    const prefix = (await fileExists(paths.monthlyPath)) ? "" : `# Gemini History ${createdAt.slice(0, 7)}\n`;
    const existing = await readCanonicalFile(paths.monthlyPath);
    const separator = existing && !existing.endsWith("\n") ? "\n" : "";
    await appendFile(paths.monthlyPath, `${prefix}${separator}${block}`, "utf8");
  });
  return memoryEntrySchema.parse({
    id,
    scope: "SYSTEM",
    roomId: null,
    title,
    body,
    provenance: paths.monthlyPath,
    createdAt
  });
}

export function createCanonicalGeminiMemoryBridge(paths: CanonicalGeminiMemoryPaths): CanonicalMemoryBridge {
  return {
    list: (query) => listCanonicalGeminiMemory(paths, query),
    save: (input, traceId) => appendCanonicalGeminiMemory(paths, input, traceId)
  };
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function msToIso(value: unknown): string {
  const ms = typeof value === "number" ? value : Number(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : nowIso();
}

function mapCodexGoalRow(row: Record<string, unknown>): CodexGoalSharedTask {
  return codexGoalSharedTaskSchema.parse({
    id: `codex_goal:${String(row.threadId)}`,
    source: "codex_goal",
    threadId: String(row.threadId),
    goalId: String(row.goalId),
    title: String(row.objective),
    status: codexGoalStatusSchema.parse(row.status),
    tokenBudget: row.tokenBudget === null || row.tokenBudget === undefined ? null : Number(row.tokenBudget),
    tokensUsed: Number(row.tokensUsed ?? 0),
    timeUsedSeconds: Number(row.timeUsedSeconds ?? 0),
    createdAt: msToIso(row.createdAtMs),
    updatedAt: msToIso(row.updatedAtMs)
  });
}

function sqliteImmutableUri(dbPath: string): string {
  const uri = pathToFileURL(dbPath);
  uri.searchParams.set("mode", "ro");
  uri.searchParams.set("immutable", "1");
  return uri.href;
}

function isReadonlySidecarError(error: unknown): boolean {
  const stderr = (error as { stderr?: unknown }).stderr;
  const message = error instanceof Error ? error.message : "";
  return `${typeof stderr === "string" ? stderr : ""}\n${message}`.includes("attempt to write a readonly database");
}

async function execSqliteJson<T>(args: string[]): Promise<T[]> {
  const { stdout } = await execFileAsync("sqlite3", args, { timeout: 5000, maxBuffer: 1024 * 1024 });
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  return JSON.parse(trimmed) as T[];
}

async function sqliteJson<T>(dbPath: string, sql: string, options: { readonly?: boolean; immutableFallback?: boolean } = {}): Promise<T[]> {
  const args = options.readonly ? ["-readonly", "-json", dbPath, sql] : ["-json", dbPath, sql];
  try {
    return await execSqliteJson<T>(args);
  } catch (error) {
    if (!options.readonly || !options.immutableFallback || !isReadonlySidecarError(error)) throw error;
    return execSqliteJson<T>(["-json", sqliteImmutableUri(dbPath), sql]);
  }
}

const codexGoalSelect = `
  SELECT
    thread_id AS threadId,
    goal_id AS goalId,
    objective,
    status,
    token_budget AS tokenBudget,
    tokens_used AS tokensUsed,
    time_used_seconds AS timeUsedSeconds,
    created_at_ms AS createdAtMs,
    updated_at_ms AS updatedAtMs
  FROM thread_goals
`;

export function createCodexGoalsAdapter(dbPath: string): CodexGoalsAdapter {
  return {
    async list() {
      const rows = await sqliteJson<Record<string, unknown>>(dbPath, `${codexGoalSelect} ORDER BY updated_at_ms DESC`, {
        immutableFallback: true,
        readonly: true
      });
      return rows.map(mapCodexGoalRow);
    },
    async update(threadId, input) {
      const updates: string[] = [];
      if (input.status !== undefined) updates.push(`status = ${sqlString(input.status)}`);
      if (input.objective !== undefined) updates.push(`objective = ${sqlString(redactMemoryText(input.objective).slice(0, 4000))}`);
      updates.push(`updated_at_ms = ${Date.now()}`);
      const sql = [
        `UPDATE thread_goals SET ${updates.join(", ")} WHERE thread_id = ${sqlString(threadId)};`,
        `${codexGoalSelect} WHERE thread_id = ${sqlString(threadId)};`
      ].join("\n");
      const rows = await sqliteJson<Record<string, unknown>>(dbPath, sql);
      return rows[0] ? mapCodexGoalRow(rows[0]) : null;
    }
  };
}
