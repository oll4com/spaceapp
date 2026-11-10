import { reasoningEffortSchema, type PaneCliModelSettings, type PaneCliSession } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { validClaudeTurnReadIdentity } from "./claude-native-turns.js";
import { createNativeReadCache } from "./native-read-cache.js";
import { execFile } from "./safe-child-process.js";
import { SPACE_AGENT_HOME, SPACE_INSTALL_ROOT } from "@space/contracts";

// Oh My Pi 18 appends every model and thinking switch of a session to its session JSONL
// (`model_change` with "provider/id", `thinking_level_change`), including switches made inside
// the CLI (/model, the model selector), and names each terminal's session file in a breadcrumb
// `terminal-sessions/pts-<n>` (line 1 cwd, line 2 session file). The pane's launch model and the
// status rail (dropped in narrow panes) cannot show such a switch.
export const OMP_SPACE_AGENT_DIR = `${SPACE_AGENT_HOME}/.omp/agent`;
const OMP_SESSION_MAX_BYTES = 64 * 1024 * 1024;
const PROCESS_TREE_MAX = 64;
const ompModelIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,159}$/;
const ompEffortPattern = /^[a-z]{2,16}$/;

export interface OmpNativeModel {
  modelId: string;
  reasoningEffort: string | null;
}

/** omp session ids (UUIDv7, the session header's `id`): `omp --resume <id>` reopens exactly that session; the sudoers admits only this form. */
export const ompNativeSessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The id an omp session file's header records; the header leads the file (after an optional title line). */
export function ompSessionId(lines: readonly string[]): string | null {
  for (const line of lines.slice(0, 4)) {
    if (!line.includes('"session"')) continue;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (entry.type === "session") return typeof entry.id === "string" && ompNativeSessionIdPattern.test(entry.id) ? entry.id : null;
  }
  return null;
}

/** omp keys its breadcrumb by the process's terminal; Linux numbers every /dev/pts/<n> as major 136, minor n. */
export function ompTerminalName(ttyNr: number): string | null {
  const major = (ttyNr >> 8) & 0xfff;
  const minor = (ttyNr & 0xff) | ((ttyNr >> 12) & 0xfff00);
  return major === 136 ? `pts-${minor}` : null;
}

/** The newest model and thinking level recorded in an omp session file's lines. */
export function ompSessionModel(lines: readonly string[]): OmpNativeModel | null {
  let modelId: string | null = null;
  let reasoningEffort: string | null | undefined;
  for (let index = lines.length - 1; index >= 0 && (modelId === null || reasoningEffort === undefined); index--) {
    const line = lines[index]!;
    if (!line.includes('"model_change"') && !line.includes('"thinking_level_change"')) continue;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (modelId === null && entry.type === "model_change" && typeof entry.model === "string" && ompModelIdPattern.test(entry.model)) {
      modelId = entry.model;
    } else if (reasoningEffort === undefined && entry.type === "thinking_level_change") {
      reasoningEffort = typeof entry.thinkingLevel === "string" && ompEffortPattern.test(entry.thinkingLevel) ? entry.thinkingLevel : null;
    }
  }
  return modelId ? { modelId, reasoningEffort: reasoningEffort ?? null } : null;
}

/**
 * Whether the session's last turn goes on: a user message, a tool result or an assistant asking for a tool waits for more;
 * an assistant message with any other stop reason ("stop", "aborted", "error") ended it. null when the file holds no message.
 */
export function ompTurnOpen(lines: readonly string[]): boolean | null {
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;
    if (!line.includes('"message"')) continue;
    let entry: { type?: unknown; message?: { role?: unknown; stopReason?: unknown } };
    try { entry = JSON.parse(line) as typeof entry; } catch { continue; }
    if (entry.type !== "message" || !entry.message) continue;
    return entry.message.role !== "assistant" || entry.message.stopReason === "toolUse";
  }
  return null;
}

async function procTerminal(procRoot: string, pid: number): Promise<string | null> {
  const stat = await readFile(join(procRoot, String(pid), "stat"), "utf8").catch(() => "");
  const ttyNr = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[4]);
  return Number.isSafeInteger(ttyNr) ? ompTerminalName(ttyNr) : null;
}

async function procChildren(procRoot: string, pid: number): Promise<number[]> {
  const tasks = (await readdir(join(procRoot, String(pid), "task")).catch(() => [] as string[])).filter((task) => /^[1-9][0-9]{0,9}$/.test(task));
  const children = await Promise.all(tasks.slice(0, 256).map((task) =>
    readFile(join(procRoot, String(pid), "task", task, "children"), "utf8").catch(() => "")));
  return children.join(" ").split(/\s+/).filter((child) => /^[1-9][0-9]{0,9}$/.test(child)).map(Number);
}

/**
 * Bind a Space CLI session to its live omp process: the first descendant of the pane host's root process
 * whose environment (readable only for the omp user's own processes) carries this pane/session's Space
 * identity. Only its terminal's breadcrumb is followed, and only to a regular session file inside the agent's
 * sessions directory; a process with the identity but no terminal ends the read, so a child's own pty never counts.
 */
async function readPaneSessionLines(
  input: { paneId: string; sessionId: string; rootPid: number | null },
  options: { procRoot?: string; agentDir?: string }
): Promise<string[] | null> {
  if (!validClaudeTurnReadIdentity(input)) return null;
  const procRoot = options.procRoot ?? "/proc";
  const agentDir = options.agentDir ?? OMP_SPACE_AGENT_DIR;
  const queue = [input.rootPid!];
  for (let index = 0; index < queue.length && index < PROCESS_TREE_MAX; index++) {
    const pid = queue[index]!;
    const environ = (await readFile(join(procRoot, String(pid), "environ"), "utf8").catch(() => "")).split("\0");
    if (!environ.includes(`SPACE_CLI_SESSION_ID=${input.sessionId}`) || !environ.includes(`SPACE_PANE_ID=${input.paneId}`)) {
      for (const child of await procChildren(procRoot, pid)) if (!queue.includes(child)) queue.push(child);
      continue;
    }
    const terminal = await procTerminal(procRoot, pid);
    if (!terminal) return null;
    const [cwd, file] = (await readFile(join(agentDir, "terminal-sessions", terminal), "utf8").catch(() => "")).split("\n").map((line) => line.trim());
    if (!cwd || !file) return null;
    const [sessions, sessionFile] = await Promise.all([realpath(join(agentDir, "sessions")), realpath(resolve(cwd, file))]).catch(() => [null, null]);
    if (!sessions || !sessionFile?.startsWith(sessions + sep) || !sessionFile.endsWith(".jsonl")) return null;
    const info = await stat(sessionFile).catch(() => null);
    if (!info?.isFile() || info.size > OMP_SESSION_MAX_BYTES) return null;
    return (await readFile(sessionFile, "utf8").catch(() => "")).split("\n");
  }
  return null;
}

export async function readOmpNativeModel(
  input: { paneId: string; sessionId: string; rootPid: number | null },
  options: { procRoot?: string; agentDir?: string } = {}
): Promise<OmpNativeModel | null> {
  const lines = await readPaneSessionLines(input, options);
  return lines ? ompSessionModel(lines) : null;
}

/** What the launcher prints: the model fields (all an API before ADAPTER-006 reads) and the live session's id. */
export async function readOmpNativeSession(
  input: { paneId: string; sessionId: string; rootPid: number | null },
  options: { procRoot?: string; agentDir?: string } = {}
): Promise<(Partial<OmpNativeModel> & { sessionId: string | null; turnOpen: boolean | null }) | null> {
  const lines = await readPaneSessionLines(input, options);
  return lines ? { ...ompSessionModel(lines), sessionId: ompSessionId(lines), turnOpen: ompTurnOpen(lines) } : null;
}

// Model pickers and Space Control inspections of one pane share one launcher read for a few seconds. A switch
// made through Space records the session's model and effort, which are part of the key, so the read that
// confirms it is fresh; a switch made inside omp shows once the entry expires.
type OmpNativeRead = { model: OmpNativeModel | null; sessionId: string | null; turnOpen: boolean | null };
const ompNativeModelCache = createNativeReadCache<OmpNativeRead>({ busyTtlMs: 3_000, idleTtlMs: 6_000, isBusy: () => false });

/** Fixed launcher read adapter; omp's private agent directory keeps its permissions. */
async function loadOmpNativeRead(
  session: Pick<PaneCliSession, "paneId" | "sessionId" | "modelId" | "reasoningEffort">,
  rootPid: number | null,
  fresh = false
): Promise<OmpNativeRead | null> {
  const input = { paneId: session.paneId, sessionId: session.sessionId, rootPid };
  if (!validClaudeTurnReadIdentity(input)) return null;
  return ompNativeModelCache.read(`${input.paneId}|${input.sessionId}|${rootPid}|${session.modelId}|${session.reasoningEffort}`, async () => {
    try {
      const { stdout } = await promisify(execFile)(`${SPACE_INSTALL_ROOT}/bin/omp-vscode-parity`,
        ["native-model", input.paneId, input.sessionId, String(input.rootPid)],
        { timeout: 3000, maxBuffer: 65_536, env: { PATH: "/usr/bin:/bin" } });
      const result = JSON.parse(stdout) as (Partial<OmpNativeModel> & { sessionId?: unknown; turnOpen?: unknown }) | null;
      return {
        model: typeof result?.modelId === "string" && ompModelIdPattern.test(result.modelId)
          ? { modelId: result.modelId, reasoningEffort: typeof result.reasoningEffort === "string" && ompEffortPattern.test(result.reasoningEffort) ? result.reasoningEffort : null }
          : null,
        sessionId: typeof result?.sessionId === "string" && ompNativeSessionIdPattern.test(result.sessionId) ? result.sessionId : null,
        turnOpen: typeof result?.turnOpen === "boolean" ? result.turnOpen : null
      };
    } catch { return null; }
  }, { fresh });
}

export async function loadOmpNativeModel(
  session: Pick<PaneCliSession, "paneId" | "sessionId" | "modelId" | "reasoningEffort">,
  rootPid: number | null
): Promise<OmpNativeModel | null> {
  return (await loadOmpNativeRead(session, rootPid))?.model ?? null;
}

/** The id of the omp session this pane's live process runs (its terminal's breadcrumb), for an exact resume (ADAPTER-006). */
export async function loadOmpNativeSessionId(
  session: Pick<PaneCliSession, "paneId" | "sessionId" | "modelId" | "reasoningEffort">,
  rootPid: number | null
): Promise<string | null> {
  return (await loadOmpNativeRead(session, rootPid))?.sessionId ?? null;
}

/** Whether omp's own session says its turn goes on (null when the launcher cannot read it, as in dev's API, which has no sudo). */
export async function loadOmpTurnOpen(
  session: Pick<PaneCliSession, "paneId" | "sessionId" | "modelId" | "reasoningEffort">,
  rootPid: number | null,
  fresh: boolean
): Promise<boolean | null> {
  return (await loadOmpNativeRead(session, rootPid, fresh))?.turnOpen ?? null;
}

/** What recording a pane's live model needs from the store. */
export type OmpModelStore = Pick<SpaceStore, "getPaneCliSession" | "updatePaneCliSession" | "updatePane">;

/**
 * A switch made inside omp (/model, the model selector) becomes the session's and the pane's model, as a switch
 * through Space does: Space Control, Nous and the pane's next launch then name what omp runs, not the launch model.
 * The read compares against the session it started from, so a switch Space recorded meanwhile is never undone.
 */
export async function recordOmpNativeModel(store: OmpModelStore, session: PaneCliSession,
  current: NonNullable<PaneCliModelSettings["current"]>): Promise<void> {
  if (session.runtimeId !== "cli:omp") return;
  const effort = current.reasoningEffort === "unknown" ? null : current.reasoningEffort;
  if (session.modelId === current.modelId && (!effort || session.reasoningEffort === effort)) return;
  const stored = await store.getPaneCliSession(session.sessionId);
  if (!stored?.isActive || stored.modelId !== session.modelId || stored.reasoningEffort !== session.reasoningEffort) return;
  const traceId = `trace:omp-native-model:${session.sessionId.slice("cli_session:".length)}`;
  await store.updatePaneCliSession(session.sessionId, { modelId: current.modelId, ...(effort ? { reasoningEffort: effort } : {}) }, traceId);
  const paneEffort = reasoningEffortSchema.safeParse(effort);
  await store.updatePane(session.paneId, { modelId: current.modelId, ...(paneEffort.success ? { reasoningEffort: paneEffort.data } : {}) }, traceId);
}
