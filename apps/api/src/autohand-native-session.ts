import type { PaneCliSession } from "@space/contracts";
import { constants } from "node:fs";
import { open, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { validClaudeTurnReadIdentity } from "./claude-native-turns.js";
import { procChildren } from "./muse-native-session.js";
import { execFile } from "./safe-child-process.js";
import { SPACE_AGENT_HOME, SPACE_INSTALL_ROOT } from "@space/contracts";

export const AUTOHAND_SPACE_HOME = `${SPACE_AGENT_HOME}/.codex/space-autohand`;
// Autohand 0.9.9's SessionManager.generateSessionId(): randomUUID() + '-' + Date.now().
export const autohandNativeSessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9]{13}$/;
// Native ActiveAgentRegistry freshness and presence-file safety limits. No conversation is scanned.
const ACTIVE_AGENT_STALE_MS = 15_000;
const NATIVE_RECORD_MAX_BYTES = 131_072;
// Space JSON preflight memory budget; native metadata has no matching size bound. Oversized state fails closed.
const METADATA_MAX_BYTES = 64 * 1024 * 1024;

async function privateJson(path: string, maxBytes = NATIVE_RECORD_MAX_BYTES): Promise<Record<string, unknown> | null> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!file) return null;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.geteuid?.() || (stat.mode & 0o077) !== 0 || stat.size > maxBytes) return null;
    const value: unknown = JSON.parse(await file.readFile("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; } finally { await file.close(); }
}

function startTicks(stat: string): number | null {
  const ticks = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19];
  return ticks && /^[0-9]+$/.test(ticks) ? Number(ticks) : null;
}

/** Read only the native presence record owned by this pane's live process. Never choose the newest session. */
export async function readAutohandNativeSessionId(
  input: { paneId: string; sessionId: string; rootPid: number | null },
  options: { procRoot?: string; home?: string; now?: number; clockTicks?: number } = {}
): Promise<string | null> {
  if (!validClaudeTurnReadIdentity(input)) return null;
  const procRoot = options.procRoot ?? "/proc", home = options.home ?? AUTOHAND_SPACE_HOME;
  const directory = join(home, "active-agents");
  if (await realpath(directory).catch(() => null) !== directory) return null;
  const records = await Promise.all((await readdir(directory).catch(() => [] as string[]))
    .filter(name => name.endsWith(".json")).map(name => privateJson(join(directory, name))));
  const uptime = Number((await readFile(join(procRoot, "uptime"), "utf8").catch(() => "")).split(" ")[0]);
  const clockTicks = options.clockTicks ?? Number((await promisify(execFile)("/usr/bin/getconf", ["CLK_TCK"],
    { timeout: 1000, maxBuffer: 128, env: { PATH: "/usr/bin:/bin" } }).catch(() => ({ stdout: "" }))).stdout.trim());
  if (!(uptime > 0) || !(clockTicks > 0)) return null;
  const now = options.now ?? Date.now();
  const ids = new Set<string>();
  const queue = [input.rootPid!], visited = new Set<number>();
  for (let index = 0; index < queue.length; index++) {
    const pid = queue[index]!;
    if (visited.has(pid)) continue;
    visited.add(pid);
    const base = join(procRoot, String(pid));
    const started = startTicks(await readFile(join(base, "stat"), "utf8").catch(() => ""));
    const environ = await readFile(join(base, "environ"), "utf8").catch(() => "");
    if (started !== null && environ.split("\0").includes(`SPACE_CLI_SESSION_ID=${input.sessionId}`) &&
        environ.split("\0").includes(`SPACE_PANE_ID=${input.paneId}`)) {
      const cwd = await readlink(join(base, "cwd")).catch(() => null);
      for (const record of records) {
        if (!record || record.version !== 1 || record.pid !== pid || typeof record.sessionId !== "string" ||
            !autohandNativeSessionIdPattern.test(record.sessionId) || record.workspaceRoot !== cwd ||
            typeof record.updatedAt !== "string") continue;
        const updatedAt = Date.parse(record.updatedAt);
        if (!Number.isFinite(updatedAt) || updatedAt > now || now - updatedAt > ACTIVE_AGENT_STALE_MS) continue;
        // Native startedAt is session creation, so it can predate a resumed process. The heartbeat must instead
        // postdate this process's start. One kernel tick allows /proc/uptime's sampling precision, not PID reuse.
        if (updatedAt < now - (uptime - started / clockTicks) * 1000 - 1000 / clockTicks) continue;
        const sessionDir = join(home, "sessions", record.sessionId);
        if (await realpath(sessionDir).catch(() => null) !== sessionDir) continue;
        const metadata = await privateJson(join(sessionDir, "metadata.json"), METADATA_MAX_BYTES);
        if (metadata?.sessionId !== record.sessionId || metadata.projectPath !== cwd) continue;
        if (startTicks(await readFile(join(base, "stat"), "utf8").catch(() => "")) !== started ||
            await readFile(join(base, "environ"), "utf8").catch(() => "") !== environ) return null;
        ids.add(record.sessionId);
      }
    }
    for (const child of await procChildren(procRoot, pid)) if (!visited.has(child)) queue.push(child);
  }
  return ids.size === 1 ? [...ids][0]! : null;
}

/** Fixed privileged read; emits only an id, without exposing config, conversation or native private state. */
export async function loadAutohandNativeSessionId(
  session: Pick<PaneCliSession, "paneId" | "sessionId">,
  rootPid: number | null
): Promise<string | null> {
  const input = { paneId: session.paneId, sessionId: session.sessionId, rootPid };
  if (!validClaudeTurnReadIdentity(input)) return null;
  try {
    const { stdout } = await promisify(execFile)(`${SPACE_INSTALL_ROOT}/bin/autohand-vscode-parity`,
      ["native-session", input.paneId, input.sessionId, String(rootPid)],
      { timeout: 3000, maxBuffer: 4096, env: { PATH: "/usr/bin:/bin" } });
    const id = (JSON.parse(stdout) as { sessionId?: unknown } | null)?.sessionId;
    return typeof id === "string" && autohandNativeSessionIdPattern.test(id) ? id : null;
  } catch { return null; }
}
