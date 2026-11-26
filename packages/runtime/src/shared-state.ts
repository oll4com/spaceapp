import { execFile } from "node:child_process";
import { childProcessEnv } from "./child-process-env.js";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, appendFile, chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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
  const body = redactMemoryText(input.body);
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

/**
 * Two users write the memory files: the API (`space`, in the agent user's group) and agents' `space-memory-save` (the agent user). The umask makes a
 * new month's file 0644, and the other writer then fails with EACCES (11/11 16:56 UTC, queue 2026-11-12 REVIEW). The writer that owns a
 * file that is not 0660 (no group write, or readable by others under a 0002 umask) gives it 0660 (rw for the group of the setgid folder, none for others, as on 11/11); best effort: a file another user owns is left as it is.
 */
async function keepGroupWritable(path: string): Promise<void> {
  try {
    const info = await stat(path);
    if ((info.mode & 0o777) === 0o660 || (typeof process.getuid === "function" && info.uid !== process.getuid())) return;
    await chmod(path, 0o660);
  } catch {
    // Only the next writer's access depends on it; the save itself is done.
  }
}

/** Appends to a month file read in full under its lock (existing: null when it did not exist). */
async function appendRead(path: string, existing: string | null, text: string): Promise<void> {
  await appendFile(path, text, "utf8").catch(async (error: NodeJS.ErrnoException) => {
    // 11/11 16:56 (Nous space_memory_save EACCES): the other writer's file without group write cannot be chmodded by this one. The month was
    // read in full under the shared lock, so it is written again as this writer's own file and renamed over in the group-writable folder.
    if (error.code !== "EACCES" || existing === null) throw error;
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, `${existing}${text}`, { encoding: "utf8", flag: "w", mode: 0o660 });
    await rename(temp, path).catch(async (renameError) => { await rm(temp, { force: true }); throw renameError; });
  });
  await keepGroupWritable(path);
}

const BLOCK_ID = /^<!-- space-memory:id=([A-Za-z0-9:_-]{3,200}) -->/;
/** The id-marked blocks of a memory file, first of each id; text before the first marker (a heading, older unmarked notes) is not a block. */
export function canonicalMemoryBlocks(content: string): Map<string, string> {
  const blocks = new Map<string, string>();
  for (const block of content.split(/(?=<!-- space-memory:id=)/)) {
    const id = BLOCK_ID.exec(block)?.[1];
    if (id && !blocks.has(id)) blocks.set(id, block.endsWith("\n") ? block : `${block}\n`);
  }
  return blocks;
}

/**
 * Space Memory from a linked SpaceApp (plan clipboard:TcX66vjNuZDv step 3): appends each whole block whose id this month's file lacks,
 * under the same lock as every save. Never rewrites or removes a block; a block that is not exactly one id-marked block is refused.
 */
export async function appendCanonicalMemoryBlocks(monthlyPath: string, blocks: readonly string[]): Promise<{ added: number }> {
  const parsed = blocks.map((block) => [...canonicalMemoryBlocks(block)]);
  if (parsed.some((found, index) => found.length !== 1 || found[0]![1].trimEnd() !== blocks[index]!.trimEnd())) throw new Error("Not one Space Memory block each.");
  await mkdir(dirname(monthlyPath), { recursive: true });
  return withFileLock(`${monthlyPath}.lock`, async () => {
    const existing = await readCanonicalFile(monthlyPath);
    const have = canonicalMemoryBlocks(existing ?? "");
    const missing = new Map(parsed.map((found) => found[0]!).filter(([id]) => !have.has(id)));
    if (!missing.size) return { added: 0 };
    const month = monthOfMemoryFile(monthlyPath);
    const prefix = existing === null ? `# Space Memory ${month ?? ""}\n` : existing.endsWith("\n") ? "" : "\n";
    await appendRead(monthlyPath, existing, prefix + [...missing.values()].join(""));
    return { added: missing.size };
  });
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
    await appendRead(paths.monthlyPath, existing, `${prefix}${existing && !existing.endsWith("\n") ? "\n" : ""}${block}`);
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
  const { stdout } = await execFileAsync("sqlite3", args, { env: childProcessEnv(), timeout: 5000, maxBuffer: 1024 * 1024 });
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
