import type { PaneCliSession } from "@space/contracts";
import { readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { validClaudeTurnReadIdentity } from "./claude-native-turns.js";
import { createNativeReadCache } from "./native-read-cache.js";
import { execFile } from "./safe-child-process.js";
import { SPACE_AGENT_HOME, SPACE_INSTALL_ROOT } from "@space/contracts";

// Muse Code 1.4.14 keeps each session in <data>/sessions/YYYY/MM/DD/<uuid>/ and its live process holds that folder's
// `.session.lock` open (checked live 2026-11-02; a resumed session reopens the same folder). `muse resume <uuid>` reopens
// exactly that session; an id it does not hold exits "retained session not found".
export const MUSE_SPACE_DATA_DIR = `${SPACE_AGENT_HOME}/.local/share/muse`;
const PROCESS_TREE_MAX = 64;
const FD_MAX = 1024;

/** Muse session ids (UUIDv7, the session folder's name); the sudoers admits only this form after `resume`. */
export const museNativeSessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function procChildren(procRoot: string, pid: number): Promise<number[]> {
  const tasks = (await readdir(join(procRoot, String(pid), "task")).catch(() => [] as string[])).filter((task) => /^[1-9][0-9]{0,9}$/.test(task));
  const children = await Promise.all(tasks.slice(0, 256).map((task) =>
    readFile(join(procRoot, String(pid), "task", task, "children"), "utf8").catch(() => "")));
  return children.join(" ").split(/\s+/).filter((child) => /^[1-9][0-9]{0,9}$/.test(child)).map(Number);
}

async function lockedSession(procRoot: string, pid: number, sessions: string): Promise<string | null> {
  const fds = (await readdir(join(procRoot, String(pid), "fd")).catch(() => [] as string[])).filter((fd) => /^[0-9]{1,6}$/.test(fd));
  for (const fd of fds.slice(0, FD_MAX)) {
    const target = await readlink(join(procRoot, String(pid), "fd", fd)).catch(() => "");
    if (!target.startsWith(sessions)) continue;
    const match = /^[0-9]{4}\/[0-9]{2}\/[0-9]{2}\/([^/]+)\/\.session\.lock$/.exec(target.slice(sessions.length));
    if (match && museNativeSessionIdPattern.test(match[1]!)) return match[1]!;
  }
  return null;
}

/**
 * The id of the Muse session this pane's live process runs: a process under the pane host's root process whose
 * environment (readable only for the Muse user's own processes) carries this pane/session's Space identity, and
 * that holds a session's lock open inside Muse's sessions folder. The muse launcher carries the identity too,
 * so the walk goes on into its children until one holds a lock. No file is read.
 */
export async function readMuseNativeSessionId(
  input: { paneId: string; sessionId: string; rootPid: number | null },
  options: { procRoot?: string; dataDir?: string } = {}
): Promise<string | null> {
  if (!validClaudeTurnReadIdentity(input)) return null;
  const procRoot = options.procRoot ?? "/proc";
  const sessions = join(options.dataDir ?? MUSE_SPACE_DATA_DIR, "sessions") + "/";
  const queue = [input.rootPid!];
  for (let index = 0; index < queue.length && index < PROCESS_TREE_MAX; index++) {
    const pid = queue[index]!;
    const environ = (await readFile(join(procRoot, String(pid), "environ"), "utf8").catch(() => "")).split("\0");
    if (environ.includes(`SPACE_CLI_SESSION_ID=${input.sessionId}`) && environ.includes(`SPACE_PANE_ID=${input.paneId}`)) {
      const id = await lockedSession(procRoot, pid, sessions);
      if (id) return id;
    }
    for (const child of await procChildren(procRoot, pid)) if (!queue.includes(child)) queue.push(child);
  }
  return null;
}

// Context reads of one pane share one launcher read; a session switched inside Muse (/new, /resume) shows once it expires.
const museSessionCache = createNativeReadCache<string>({ busyTtlMs: 10_000, idleTtlMs: 10_000, isBusy: () => false });

/** Fixed launcher read adapter; Muse's data folder keeps its permissions (ADAPTER-006). */
export async function loadMuseNativeSessionId(
  session: Pick<PaneCliSession, "paneId" | "sessionId">,
  rootPid: number | null
): Promise<string | null> {
  const input = { paneId: session.paneId, sessionId: session.sessionId, rootPid };
  if (!validClaudeTurnReadIdentity(input)) return null;
  return museSessionCache.read(`${input.paneId}|${input.sessionId}|${rootPid}`, async () => {
    try {
      const { stdout } = await promisify(execFile)(`${SPACE_INSTALL_ROOT}/bin/muse-vscode-parity`,
        ["native-session", input.paneId, input.sessionId, String(input.rootPid)],
        { timeout: 3000, maxBuffer: 4096, env: { PATH: "/usr/bin:/bin" } });
      const id = (JSON.parse(stdout) as { sessionId?: unknown } | null)?.sessionId;
      return typeof id === "string" && museNativeSessionIdPattern.test(id) ? id : null;
    } catch { return null; }
  });
}
