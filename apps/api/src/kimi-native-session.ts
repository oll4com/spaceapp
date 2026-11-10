import type { PaneCliSession } from "@space/contracts";
import { readdir, readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { validClaudeTurnReadIdentity } from "./claude-native-turns.js";
import { procChildren } from "./muse-native-session.js";
import { createNativeReadCache } from "./native-read-cache.js";
import { execFile } from "./safe-child-process.js";
import { SPACE_AGENT_HOME, SPACE_INSTALL_ROOT } from "@space/contracts";

// Kimi Code 2.4.1 leases a session while a turn runs: <home>/locks/sessions/<session id>.lock holds {pid, hostname, …} of
// the process that runs it (checked live 2026-11-03; a session reopened with `--session <id>` leases the same id). Account
// profiles have their own home under profiles/<name>/ and share the sessions folder with the main one.
export const KIMI_SPACE_HOME = `${SPACE_AGENT_HOME}/.codex/space-kimi`;
const PROCESS_TREE_MAX = 64;
const LOCK_MAX = 256;

/** Kimi session ids (`kimi --session <id>`); the sudoers admits only this form. */
export const kimiNativeSessionIdPattern = /^session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function leases(home: string): Promise<Array<{ id: string; path: string }>> {
  const homes = [home, ...(await readdir(join(home, "profiles")).catch(() => [] as string[]))
    .filter((name) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(name)).map((name) => join(home, "profiles", name))];
  const found = await Promise.all(homes.map(async (dir) => (await readdir(join(dir, "locks", "sessions")).catch(() => [] as string[]))
    .map((file) => ({ id: file.slice(0, -".lock".length), path: join(dir, "locks", "sessions", file) }))
    .filter((lease) => lease.path.endsWith(".lock") && kimiNativeSessionIdPattern.test(lease.id))));
  return found.flat().slice(0, LOCK_MAX);
}

/**
 * The id of the Kimi session this pane's live process is running a turn in: a lease whose holder is a process under the
 * pane host's root process whose environment (readable only for the Kimi user's own processes) carries this pane/session's
 * Space identity. Between turns no lease exists and the answer is null; the task titles keep the id they recorded.
 */
export async function readKimiNativeSessionId(
  input: { paneId: string; sessionId: string; rootPid: number | null },
  options: { procRoot?: string; homeDir?: string; host?: string } = {}
): Promise<string | null> {
  if (!validClaudeTurnReadIdentity(input)) return null;
  const procRoot = options.procRoot ?? "/proc";
  const owned = new Set<number>();
  const queue = [input.rootPid!];
  for (let index = 0; index < queue.length && index < PROCESS_TREE_MAX; index++) {
    const pid = queue[index]!;
    const environ = (await readFile(join(procRoot, String(pid), "environ"), "utf8").catch(() => "")).split("\0");
    if (environ.includes(`SPACE_CLI_SESSION_ID=${input.sessionId}`) && environ.includes(`SPACE_PANE_ID=${input.paneId}`)) owned.add(pid);
    for (const child of await procChildren(procRoot, pid)) if (!queue.includes(child)) queue.push(child);
  }
  if (!owned.size) return null;
  const host = options.host ?? hostname();
  const ids = new Set<string>();
  for (const lease of await leases(options.homeDir ?? KIMI_SPACE_HOME)) {
    try {
      const holder = JSON.parse(await readFile(lease.path, "utf8")) as { pid?: unknown; hostname?: unknown };
      if (typeof holder.pid === "number" && owned.has(holder.pid) && holder.hostname === host) ids.add(lease.id);
    } catch {
      // A lease released or rewritten while it was read names nobody.
    }
  }
  return ids.size === 1 ? [...ids][0]! : null;
}

// Context reads of one pane share one launcher read.
const kimiSessionCache = createNativeReadCache<string>({ busyTtlMs: 10_000, idleTtlMs: 10_000, isBusy: () => false });

/** Fixed launcher read adapter; Kimi's home keeps its permissions (ADAPTER-006). */
export async function loadKimiNativeSessionId(
  session: Pick<PaneCliSession, "paneId" | "sessionId">,
  rootPid: number | null
): Promise<string | null> {
  const input = { paneId: session.paneId, sessionId: session.sessionId, rootPid };
  if (!validClaudeTurnReadIdentity(input)) return null;
  return kimiSessionCache.read(`${input.paneId}|${input.sessionId}|${rootPid}`, async () => {
    try {
      const { stdout } = await promisify(execFile)(`${SPACE_INSTALL_ROOT}/bin/kimi-vscode-parity`,
        ["native-session", input.paneId, input.sessionId, String(input.rootPid)],
        { timeout: 3000, maxBuffer: 4096, env: { PATH: "/usr/bin:/bin" } });
      const id = (JSON.parse(stdout) as { sessionId?: unknown } | null)?.sessionId;
      return typeof id === "string" && kimiNativeSessionIdPattern.test(id) ? id : null;
    } catch { return null; }
  });
}
