import type { PaneCliSession } from "@space/contracts";
import { readdir, readFile, readlink, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { validClaudeTurnReadIdentity } from "./claude-native-turns.js";
import { procChildren } from "./muse-native-session.js";
import { execFile } from "./safe-child-process.js";
import { SPACE_AGENT_HOME, SPACE_INSTALL_ROOT } from "@space/contracts";

export const DROID_SESSIONS = `${SPACE_AGENT_HOME}/.factory/sessions`;
export const droidNativeSessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const droidExecutables = ["/usr/local/bin/droid", `${SPACE_AGENT_HOME}/.local/bin/droid`, `${SPACE_AGENT_HOME}/bin/droid`, "/usr/bin/droid"];

function startTicks(value: string): string | null {
  const ticks = value.slice(value.lastIndexOf(")") + 1).trim().split(/\s+/)[19];
  return ticks && /^[0-9]+$/.test(ticks) ? ticks : null;
}

/**
 * Opportunistic, path-only binding. Only a writable native session file held by this pane's actual Droid
 * executable can identify it; folder recency, settings files and another process's descriptors cannot.
 * Whether Droid keeps such a descriptor open long enough to observe is still unproven on the installed CLI.
 * No descriptor means no reference. No conversation/config file contents are read.
 */
export async function readDroidNativeSessionId(
  input: { paneId: string; sessionId: string; rootPid: number | null },
  options: { procRoot?: string; sessions?: string; executables?: readonly string[] } = {}
): Promise<string | null> {
  if (!validClaudeTurnReadIdentity(input)) return null;
  const procRoot = options.procRoot ?? "/proc", sessions = options.sessions ?? DROID_SESSIONS;
  if (await realpath(sessions).catch(() => null) !== sessions) return null;
  const rootStat = join(procRoot, String(input.rootPid), "stat");
  const rootStart = startTicks(await readFile(rootStat, "utf8").catch(() => ""));
  if (!rootStart) return null;
  const executables = new Set((await Promise.all((options.executables ?? droidExecutables)
    .map(path => realpath(path).catch(() => null)))).filter((path): path is string => path !== null));
  const ids = new Set<string>(), visited = new Set<number>(), queue = [input.rootPid!];
  for (let index = 0; index < queue.length; index++) {
    const pid = queue[index]!;
    if (visited.has(pid)) continue;
    visited.add(pid);
    const base = join(procRoot, String(pid));
    const before = startTicks(await readFile(join(base, "stat"), "utf8").catch(() => ""));
    const environ = (await readFile(join(base, "environ"), "utf8").catch(() => "")).split("\0");
    const exe = await readlink(join(base, "exe")).catch(() => "");
    if (before && executables.has(exe) && environ.includes(`SPACE_PANE_ID=${input.paneId}`) &&
        environ.includes(`SPACE_CLI_SESSION_ID=${input.sessionId}`)) {
      const localIds = new Set<string>();
      for (const fd of await readdir(join(base, "fd")).catch(() => [] as string[])) {
        if (!/^[0-9]+$/.test(fd)) continue;
        const fdPath = join(base, "fd", fd);
        const target = await readlink(fdPath).catch(() => "");
        if (!target.startsWith(sessions + "/")) continue;
        const match = /^[^/]+\/([^/]+)\.jsonl$/.exec(target.slice(sessions.length + 1));
        if (!match || !droidNativeSessionIdPattern.test(match[1]!)) continue;
        const flags = /^flags:\s+([0-7]+)$/m.exec(await readFile(join(base, "fdinfo", fd), "utf8").catch(() => ""));
        const access = flags ? parseInt(flags[1]!, 8) & 3 : 0;
        if (access !== 1 && access !== 2) continue;
        if (await realpath(target).catch(() => null) !== target) continue;
        const [file, opened] = await Promise.all([stat(target).catch(() => null), stat(fdPath).catch(() => null)]);
        if (!file?.isFile() || file.nlink !== 1 || file.uid !== process.geteuid?.() ||
            !opened || file.dev !== opened.dev || file.ino !== opened.ino ||
            await readlink(fdPath).catch(() => "") !== target) continue;
        localIds.add(match[1]!);
      }
      // PID recycling or a process/session replacement during inspection invalidates the whole read.
      if (startTicks(await readFile(join(base, "stat"), "utf8").catch(() => "")) !== before ||
          await readlink(join(base, "exe")).catch(() => "") !== exe ||
          await readFile(join(base, "environ"), "utf8").catch(() => "") !== environ.join("\0")) return null;
      for (const id of localIds) ids.add(id);
    }
    for (const child of await procChildren(procRoot, pid)) if (!visited.has(child)) queue.push(child);
  }
  if (startTicks(await readFile(rootStat, "utf8").catch(() => "")) !== rootStart) return null;
  return ids.size === 1 ? [...ids][0]! : null;
}

/** Fixed privileged read: only the validated id leaves the native owner's process namespace. */
export async function loadDroidNativeSessionId(
  session: Pick<PaneCliSession, "paneId" | "sessionId">, rootPid: number | null
): Promise<string | null> {
  const input = { paneId: session.paneId, sessionId: session.sessionId, rootPid };
  if (!validClaudeTurnReadIdentity(input)) return null;
  try {
    const { stdout } = await promisify(execFile)(`${SPACE_INSTALL_ROOT}/bin/droid-vscode-parity`,
      ["native-session", input.paneId, input.sessionId, String(rootPid)],
      { timeout: 3000, maxBuffer: 4096, env: { PATH: "/usr/bin:/bin" } });
    const id = (JSON.parse(stdout) as { sessionId?: unknown } | null)?.sessionId;
    return typeof id === "string" && droidNativeSessionIdPattern.test(id) ? id : null;
  } catch { return null; }
}
