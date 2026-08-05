import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { opencodeDirectParityRoot } from "./cli-parity.js";

export const opencodeNativeSessionIdPattern = /^ses_[A-Za-z0-9]+$/;

const opencodeNativeSessionMappingMaxBytes = 4_096;
const opencodeProcessTreeMaxProcesses = 2_048;
const opencodeProcessTreeMaxTasks = 512;
const opencodeProcessCommandMaxBytes = 65_536;

function safeSpaceSessionFileName(spaceSessionId: string): string {
  return spaceSessionId.replace(/[^A-Za-z0-9_.-]/g, "_");
}

export function opencodeNativeSessionMappingPath(
  spaceSessionId: string,
  stateRoot = join(opencodeDirectParityRoot, "state")
): string {
  return join(stateRoot, "opencode", "space-cli-sessions", `${safeSpaceSessionFileName(spaceSessionId)}.json`);
}

export async function readOpenCodeNativeSessionId(
  spaceSessionId: string,
  stateRoot?: string
): Promise<string | null> {
  const path = opencodeNativeSessionMappingPath(spaceSessionId, stateRoot);
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > opencodeNativeSessionMappingMaxBytes) return null;
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const mapping = parsed as Record<string, unknown>;
    if (mapping.version !== 1 || mapping.spaceSessionId !== spaceSessionId) return null;
    return typeof mapping.nativeSessionId === "string" && opencodeNativeSessionIdPattern.test(mapping.nativeSessionId)
      ? mapping.nativeSessionId
      : null;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    return null;
  }
}

export async function readOpenCodeNativeSessionIdFromProcessTree(
  rootPid: number,
  procRoot = "/proc"
): Promise<string | null> {
  if (!Number.isSafeInteger(rootPid) || rootPid < 1) return null;
  const pending = [rootPid];
  const visited = new Set<number>();
  const nativeSessionIds = new Set<string>();

  while (pending.length > 0 && visited.size < opencodeProcessTreeMaxProcesses) {
    const pid = pending.shift();
    if (!pid || visited.has(pid)) continue;
    visited.add(pid);

    try {
      const command = await readFile(join(procRoot, String(pid), "cmdline"));
      if (command.byteLength <= opencodeProcessCommandMaxBytes) {
        const args = command.toString("utf8").split("\0").filter(Boolean);
        const sessionArgumentIndex = args.indexOf("--session");
        if (
          basename(args[0] ?? "") === "opencode" &&
          args[1] === "attach" &&
          sessionArgumentIndex >= 2
        ) {
          const nativeSessionId = args[sessionArgumentIndex + 1] ?? "";
          if (opencodeNativeSessionIdPattern.test(nativeSessionId)) nativeSessionIds.add(nativeSessionId);
        }
      }
    } catch {
      // Processes can exit while a live CLI tree is inspected.
    }

    try {
      const taskIds = (await readdir(join(procRoot, String(pid), "task"))).slice(0, opencodeProcessTreeMaxTasks);
      for (const taskId of taskIds) {
        const children = (await readFile(join(procRoot, String(pid), "task", taskId, "children"), "utf8").catch(() => ""))
          .trim()
          .split(/\s+/)
          .map((value) => Number.parseInt(value, 10))
          .filter((value) => Number.isSafeInteger(value) && value > 0);
        pending.push(...children);
      }
    } catch {
      // A disappearing process is equivalent to an unresolved native task.
    }
  }

  return nativeSessionIds.size === 1 ? [...nativeSessionIds][0]! : null;
}
