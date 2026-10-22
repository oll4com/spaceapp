import { open, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "./safe-child-process.js";
import { promisify } from "node:util";
import type { PaneCliSession } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import type { NativeTaskExecution } from "./room-task-telemetry.js";
import { createNativeReadCache } from "./native-read-cache.js";

// Claude Code 2.1 transcript JSONL: a turn starts at a non-meta user prompt
// (typed or a background task notification) and ends at system/turn_duration.
// Local slash commands write user records that never reach the model.
export const CLAUDE_SPACE_CONFIG_DIR = "/var/lib/spaceapp-user/.codex/space-claude";
const CLAUDE_TRANSCRIPT_TAIL_BYTES = 16 * 1024 * 1024;
/** The newest characters of Claude's last answer this read returns (Nous's space_read_pane reply "last"). */
export const CLAUDE_LAST_ANSWER_MAX_CHARS = 6_000;
export const claudeNativeSessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Claude Code's live per-process session status; `shell` is idle with background shells still running (2.1.303: `idle && shells ? "shell"`). */
export type ClaudeSessionStatus = "busy" | "shell" | "waiting" | "idle";

export interface ClaudeNativeTurns {
  nativeSessionId: string;
  /** A turn is running. A finished turn whose background shells run on ("shell") takes prompts, so it is not busy. */
  busy: boolean;
  status: ClaudeSessionStatus | null;
  /** What a waiting session needs from the user, e.g. "permission prompt". */
  waitingFor: string | null;
  statusUpdatedAt: string | null;
  modelId: string | null;
  reasoningEffort: string | null;
  /** Claude's saved session title: a /rename title, else its own AI title. */
  title: string | null;
  /** The title came from /rename rather than Claude's automatic AI title. */
  titleManual: boolean;
  /** The latest answer broke on a transient server or connection error ("API Error: Connection lost"). */
  apiError: boolean;
  /** The latest answer is the account's usage limit (429 rate_limit) and when it resets; absent from readers older than 2026-10-20. */
  rateLimit?: { at: string | null; resetsAt: string | null } | null;
  /** Claude's last answer text from the transcript (its newest characters), null before the first one. */
  lastAnswer: string | null;
  tasks: NativeTaskExecution[];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string | null { return typeof value === "string" && value ? value : null; }
function time(value: unknown): string | null {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function promptText(entry: Record<string, unknown>): string | null {
  const content = record(entry.message).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = content.map(record);
  if (parts.some((part) => part.type === "tool_result")) return null;
  const textParts = parts.filter((part) => part.type === "text").map((part) => text(part.text) ?? "");
  return textParts.length ? textParts.join("\n") : null;
}

type ClaudeLiveStatus = "nativeSessionId" | "busy" | "status" | "waitingFor" | "statusUpdatedAt";

export function claudeTaskTimeline(lines: Iterable<string>, busy: boolean, observedAt: string): Omit<ClaudeNativeTurns, ClaudeLiveStatus> {
  const tasks: NativeTaskExecution[] = [];
  let open: NativeTaskExecution | null = null;
  let lastActivityAt: string | null = null;
  let modelId: string | null = null;
  let reasoningEffort: string | null = null;
  let aiTitle: string | null = null;
  let customTitle: string | null = null;
  let apiError = false;
  let rateLimit: ClaudeNativeTurns["rateLimit"] = null;
  let lastAnswer: string | null = null;
  let lastAnswerId: string | null = null;
  const close = (status: "COMPLETED" | "INTERRUPTED", completedAt: string | null, durationMs?: number) => {
    if (!open) return;
    open.status = status;
    open.timing.completedAt = completedAt;
    open.timing.durationMs = typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0
      ? Math.round(durationMs)
      : open.timing.startedAt && completedAt ? Math.max(0, Date.parse(completedAt) - Date.parse(open.timing.startedAt)) : null;
    const lastModel = open.modelsUsed.at(-1);
    if (lastModel && !lastModel.completedAt) lastModel.completedAt = completedAt;
    open = null;
  };
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try { entry = record(JSON.parse(line)); } catch { continue; }
    if (entry.isSidechain === true) continue;
    if (entry.type === "ai-title") { aiTitle = text(entry.aiTitle)?.slice(0, 160) ?? aiTitle; continue; }
    if (entry.type === "custom-title") { customTitle = text(entry.customTitle)?.slice(0, 160) ?? customTitle; continue; }
    const at = time(entry.timestamp);
    if (entry.type === "system" && entry.subtype === "turn_duration") {
      close("COMPLETED", at, typeof entry.durationMs === "number" ? entry.durationMs : undefined);
      if (at) lastActivityAt = at;
      continue;
    }
    if (entry.type === "assistant") {
      if (at) lastActivityAt = at;
      // Only server errors are worth a retry; rate, session, sign-in and billing limits are not.
      apiError = entry.isApiErrorMessage === true && entry.error === "server_error";
      const resetsAt = record(entry.quotaLimits).resetsAt;
      rateLimit = entry.isApiErrorMessage === true && entry.error === "rate_limit"
        ? { at, resetsAt: typeof resetsAt === "number" && Number.isFinite(resetsAt) ? new Date(resetsAt * 1000).toISOString() : null } : null;
      // One answer may span several records of the same message id (text, tool use, more text).
      const message = record(entry.message);
      const content = message.content;
      const said = typeof content === "string" ? content : Array.isArray(content)
        ? content.map((block) => record(block)).filter((block) => block.type === "text").map((block) => text(block.text) ?? "").join("\n") : "";
      if (said.trim() && entry.isApiErrorMessage !== true) {
        const id = text(message.id);
        lastAnswer = (id && id === lastAnswerId && lastAnswer ? `${lastAnswer}\n${said}` : said).slice(-CLAUDE_LAST_ANSWER_MAX_CHARS);
        lastAnswerId = id;
      }
      const model = text(message.model);
      if (!model || model === "<synthetic>") continue;
      const effort = text(entry.effort);
      modelId = model;
      reasoningEffort = effort;
      if (!open) continue;
      const lastModel = open.modelsUsed.at(-1);
      if (lastModel?.modelId === model && lastModel.reasoningEffort === effort) continue;
      if (lastModel && !lastModel.completedAt) lastModel.completedAt = at;
      open.modelsUsed.push({ providerId: "anthropic", modelId: model, reasoningEffort: effort, turnId: open.taskId,
        startedAt: at, completedAt: null, source: "NATIVE" });
      continue;
    }
    if (entry.type !== "user" || entry.isMeta === true) continue;
    const prompt = promptText(entry);
    if (prompt === null) {
      if (at && open) lastActivityAt = at;
      continue;
    }
    const trimmed = prompt.trimStart();
    if (trimmed.startsWith("[Request interrupted by user")) {
      close("INTERRUPTED", at ?? lastActivityAt);
      continue;
    }
    if (/^<(?:command-|local-command-|bash-)/.test(trimmed)) continue;
    // A prompt arriving while a turn is still open means that turn ended without
    // a turn_duration record (killed or crashed CLI).
    close("INTERRUPTED", lastActivityAt ?? at);
    apiError = false;
    rateLimit = null;
    open = {
      taskId: text(entry.promptId) ?? text(entry.uuid) ?? `claude-turn-${tasks.length + 1}`,
      title: (trimmed.startsWith("<task-notification>") ? "Background task notification" : prompt).slice(0, 2000),
      status: "RUNNING",
      timing: { startedAt: at, completedAt: null, durationMs: null, source: "NATIVE", observedAt },
      modelsUsed: []
    };
    tasks.push(open);
    if (at) lastActivityAt = at;
  }
  if (open && !busy) close("INTERRUPTED", lastActivityAt);
  for (const task of tasks) task.timing.observedAt = observedAt;
  return { tasks: tasks.slice(-256), modelId, reasoningEffort, title: customTitle ?? aiTitle, titleManual: customTitle !== null, apiError, rateLimit, lastAnswer };
}

async function readTail(path: string, maxBytes = CLAUDE_TRANSCRIPT_TAIL_BYTES): Promise<string[]> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    return start > 0 ? lines.slice(1) : lines;
  } finally {
    await handle.close();
  }
}

async function procStat(procRoot: string, pid: number): Promise<{ ppid: number; startTime: string } | null> {
  const stat = await readFile(join(procRoot, String(pid), "stat"), "utf8").catch(() => "");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const ppid = Number(fields[1]);
  return Number.isSafeInteger(ppid) && fields[19] ? { ppid, startTime: fields[19] } : null;
}

function claudeSessionStatus(value: unknown): ClaudeSessionStatus | null {
  return value === "busy" || value === "shell" || value === "waiting" || value === "idle" ? value : null;
}

export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Bind a Space CLI session to its live Claude Code process: the per-process
 * session record names a PID; the PID must descend from the pane host's root
 * process, still have the recorded start time, and carry this pane/session's
 * Space identity in its environment. Only then is its transcript read.
 */
export async function readClaudeNativeTurns(
  input: { paneId: string; sessionId: string; rootPid: number | null },
  options: { procRoot?: string; configDir?: string; now?: () => Date } = {}
): Promise<ClaudeNativeTurns | null> {
  if (!input.rootPid) return null;
  const procRoot = options.procRoot ?? "/proc";
  const configDir = options.configDir ?? CLAUDE_SPACE_CONFIG_DIR;
  const names = (await readdir(join(configDir, "sessions")).catch(() => [] as string[]))
    .filter((name) => /^[1-9][0-9]{0,9}\.json$/.test(name)).slice(0, 512);
  for (const name of names) {
    const pid = Number(name.slice(0, -5));
    const session = record(JSON.parse(await readFile(join(configDir, "sessions", name), "utf8").catch(() => "null")));
    const nativeSessionId = text(session.sessionId);
    const cwd = text(session.cwd);
    if (session.pid !== pid || !nativeSessionId || !claudeNativeSessionIdPattern.test(nativeSessionId) || !cwd) continue;
    const stat = await procStat(procRoot, pid);
    if (!stat || String(session.procStart ?? "") !== stat.startTime) continue;
    let ancestor = stat.ppid;
    for (let depth = 0; ancestor !== input.rootPid && ancestor > 1 && depth < 8; depth++) {
      ancestor = (await procStat(procRoot, ancestor))?.ppid ?? 0;
    }
    if (pid !== input.rootPid && ancestor !== input.rootPid) continue;
    const environ = (await readFile(join(procRoot, String(pid), "environ"), "utf8").catch(() => "")).split("\0");
    if (!environ.includes(`SPACE_CLI_SESSION_ID=${input.sessionId}`) || !environ.includes(`SPACE_PANE_ID=${input.paneId}`)) continue;
    const projects = join(configDir, "projects");
    let transcript = join(projects, claudeProjectDirName(cwd), `${nativeSessionId}.jsonl`);
    let lines = await readTail(transcript).catch(() => null);
    if (!lines) {
      for (const dir of (await readdir(projects).catch(() => [] as string[])).slice(0, 2048)) {
        transcript = join(projects, dir, `${nativeSessionId}.jsonl`);
        lines = await readTail(transcript).catch(() => null);
        if (lines) break;
      }
    }
    const status = claudeSessionStatus(session.status);
    const busy = status === "busy";
    const timeline = claudeTaskTimeline(lines ?? [], busy, (options.now?.() ?? new Date()).toISOString());
    const waitingFor = status === "waiting" ? text(session.waitingFor)?.replace(/\s+/g, " ").trim().slice(0, 80) || null : null;
    const statusUpdatedAt = typeof session.statusUpdatedAt === "number" && Number.isFinite(session.statusUpdatedAt) && session.statusUpdatedAt > 0
      ? new Date(session.statusUpdatedAt).toISOString() : null;
    return { nativeSessionId, busy, status, waitingFor, statusUpdatedAt, ...timeline };
  }
  return null;
}

export function validClaudeTurnReadIdentity(input: { paneId: string; sessionId: string; rootPid: number | null }): boolean {
  return /^pane:[A-Za-z0-9_-]{6,80}$/.test(input.paneId) && /^cli_session:[A-Za-z0-9_-]{6,80}$/.test(input.sessionId) &&
    Number.isSafeInteger(input.rootPid) && input.rootPid! > 1 && input.rootPid! < 2 ** 31;
}

// Every read spawns the launcher through sudo; badge, dashboard and task-registry
// polls of the same pane share one read for a few seconds (see native-read-cache.ts).
const claudeNativeTurnsCache = createNativeReadCache<ClaudeNativeTurns>({
  busyTtlMs: 3_000,
  idleTtlMs: 6_000,
  isBusy: (turns) => turns.busy || turns.status === "waiting"
});

/** Fixed launcher read adapter; Claude's private session and transcript files keep their permissions.
 * Pass `fresh` where a just-finished state matters (resume, delivery checks, Room Agent inspections). */
export async function loadClaudeNativeTurns(
  input: { paneId: string; sessionId: string; rootPid: number | null },
  { fresh = false }: { fresh?: boolean } = {}
): Promise<ClaudeNativeTurns | null> {
  if (!validClaudeTurnReadIdentity(input)) return null;
  return claudeNativeTurnsCache.read(`${input.paneId}|${input.sessionId}|${input.rootPid}`, async () => {
    try {
      const { stdout } = await promisify(execFile)("/opt/spaceapp/bin/claude-vscode-parity",
        ["native-turns", input.paneId, input.sessionId, String(input.rootPid)],
        { timeout: 3000, maxBuffer: 8_388_608, env: { PATH: "/usr/bin:/bin" } });
      return JSON.parse(stdout) as ClaudeNativeTurns | null;
    } catch { return null; }
  }, { fresh });
}

/**
 * Claude names its conversation only inside the live process. Record it on the task revision
 * so host-loss restore, reopen and task history resume it exactly after the process is gone.
 * Only a session with a written turn has a transcript that `claude --resume` can open.
 */
export function createClaudeNativeRefRecorder(store: Pick<SpaceStore, "getCliTaskRevision" | "updateCliTaskRevision">) {
  const recorded = new Set<string>();
  return async (session: Pick<PaneCliSession, "cliTaskRevisionId">, native: Pick<ClaudeNativeTurns, "nativeSessionId" | "tasks">): Promise<void> => {
    if (!native.tasks.length || !session.cliTaskRevisionId) return;
    const key = `${session.cliTaskRevisionId}|${native.nativeSessionId}`;
    if (recorded.has(key)) return;
    const revision = await store.getCliTaskRevision(session.cliTaskRevisionId);
    if (revision && revision.nativeTaskRef !== native.nativeSessionId) {
      await store.updateCliTaskRevision(revision.revisionId, { nativeTaskRef: native.nativeSessionId }, "trace:claude-native-ref");
    }
    if (recorded.size >= 4_096) recorded.clear();
    recorded.add(key);
  };
}
