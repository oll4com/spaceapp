import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, appendFile, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
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
import { createCanonicalMemoryReader, type CanonicalMemoryReaderOptions } from "./canonical-memory-reader.js";
import { monthOfMemoryFile, spaceMemoryIndexPath, spaceMemoryMonthlyPath } from "./space-memory-files.js";
import { nowIso, redactMemoryText } from "./store.js";

const execFileAsync = promisify(execFile);
const canonicalMemoryListLimit = 1000;

export interface CanonicalSpaceMemoryPaths {
  indexPath: string;
  monthlyPath: string;
  lockPath?: string;
}
/** @deprecated Use CanonicalSpaceMemoryPaths. */
export type CanonicalGeminiMemoryPaths = CanonicalSpaceMemoryPaths;

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

export function defaultCanonicalSpaceMemoryPaths(date = new Date()): CanonicalSpaceMemoryPaths {
  return resolveCanonicalSpaceMemoryPaths({}, date);
}

/**
 * Space Memory files: space_memory.md and space_memory_YYYY-MM.md once the index has that
 * name, the legacy gemini_history files until then. Old and new code therefore write the
 * same monthly file under the same lock. SPACE_MEMORY_* overrides; SPACE_GEMINI_MEMORY_*
 * is the legacy spelling.
 */
export function resolveCanonicalSpaceMemoryPaths(
  env: Record<string, string | undefined>,
  date = new Date()
): Required<CanonicalSpaceMemoryPaths> {
  const monthlyPath = env.SPACE_MEMORY_MONTHLY_PATH || env.SPACE_GEMINI_MEMORY_MONTHLY_PATH ||
    spaceMemoryMonthlyPath(athensMonthFor(date));
  return {
    indexPath: env.SPACE_MEMORY_INDEX_PATH || env.SPACE_GEMINI_MEMORY_INDEX_PATH || spaceMemoryIndexPath(),
    monthlyPath,
    lockPath: env.SPACE_MEMORY_LOCK_PATH || env.SPACE_GEMINI_MEMORY_LOCK_PATH || `${monthlyPath}.lock`
  };
}

/** @deprecated Use defaultCanonicalSpaceMemoryPaths. */
export const defaultCanonicalGeminiMemoryPaths = defaultCanonicalSpaceMemoryPaths;
/** @deprecated Use resolveCanonicalSpaceMemoryPaths. */
export const resolveCanonicalGeminiMemoryPaths = resolveCanonicalSpaceMemoryPaths;

async function readCanonicalFile(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

const staleLockMs = 30_000;

/** A lock left by a crashed writer (dead pid, or no pid) blocks every later save until removed. */
async function removeStaleLock(lockPath: string): Promise<boolean> {
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs < staleLockMs) return false;
    const pid = Number((await readFile(lockPath, "utf8")).split(/\s+/)[0]);
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false; }
    }
    await rm(lockPath, { force: true });
    return true;
  } catch { return false; }
}

async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  let staleChecked = false;
  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      try { await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`); }
      finally { await handle.close(); }
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" && !staleChecked) {
        staleChecked = true;
        if (await removeStaleLock(lockPath)) continue;
      }
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
  const title = redactMemoryText(input.title).replace(/[\r\n]+/g, " ").slice(0, 160);
  const body = redactMemoryText(input.body).slice(0, 10000);
  const id = `space_memory:${createHash("sha256").update(`${path}\n${createdAt}\n${title}\n${body}`).digest("hex").slice(0, 24)}`;
  const provenance = redactMemoryText(input.provenance).replace(/[\r\n]+/g, " ").slice(0, 500);
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
    `- created_at=${createdAt}`,
    ...tagLine,
    `- ${body.replace(/\r?\n/g, "\n  ")}`,
    ""
  ];
  return { block: lines.join("\n"), body, id, title };
}

/** An identical title and body already saved this month is returned instead of appended again. */
function findSavedBlock(existing: string, title: string, body: string): { id: string; createdAt: string } | null {
  const heading = ` - Space canonical memory: ${title}\n`;
  const bodyLine = `\n- ${body.replace(/\r?\n/g, "\n  ")}\n`;
  for (const block of existing.split(/(?=<!-- space-memory:id=)/)) {
    const firstLines = block.split("\n", 2).join("\n") + "\n";
    if (!firstLines.includes(heading) || !`${block}\n`.includes(bodyLine)) continue;
    const id = /^<!-- space-memory:id=([A-Za-z0-9:_-]{3,200}) -->/.exec(block)?.[1];
    const createdAt = /\n- created_at=(\S+)/.exec(block)?.[1];
    if (id && createdAt) return { id, createdAt };
  }
  return null;
}

async function appendCanonicalSpaceMemory(
  paths: CanonicalSpaceMemoryPaths,
  input: CreateMemoryEntryInput,
  traceId?: string
): Promise<MemoryEntry> {
  await mkdir(dirname(paths.monthlyPath), { recursive: true });
  const lockPath = paths.lockPath ?? `${paths.monthlyPath}.lock`;
  const createdAt = nowIso();
  const { block, body, id, title } = canonicalAppendBlock(paths.monthlyPath, input, traceId, createdAt);
  const saved = await withFileLock(lockPath, async () => {
    const month = monthOfMemoryFile(paths.monthlyPath) ?? athensMonthFor(new Date(createdAt));
    const prefix = (await fileExists(paths.monthlyPath)) ? "" : `# Space Memory ${month}\n`;
    const existing = await readCanonicalFile(paths.monthlyPath);
    const duplicate = existing ? findSavedBlock(existing, title, body) : null;
    if (duplicate) return duplicate;
    const separator = existing && !existing.endsWith("\n") ? "\n" : "";
    await appendFile(paths.monthlyPath, `${prefix}${separator}${block}`, "utf8");
    return { id, createdAt };
  });
  return memoryEntrySchema.parse({
    id: saved.id,
    scope: input.scope,
    roomId: input.scope === "ROOM" ? input.roomId ?? null : null,
    title,
    body,
    provenance: paths.monthlyPath,
    createdAt: saved.createdAt
  });
}

export function createCanonicalSpaceMemoryBridge(
  paths: CanonicalSpaceMemoryPaths,
  options: CanonicalMemoryReaderOptions = {}
): CanonicalMemoryBridge {
  return {
    list: createCanonicalMemoryReader(paths, options),
    save: (input, traceId) => appendCanonicalSpaceMemory(paths, input, traceId)
  };
}

/** @deprecated Use createCanonicalSpaceMemoryBridge. */
export const createCanonicalGeminiMemoryBridge = createCanonicalSpaceMemoryBridge;

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
