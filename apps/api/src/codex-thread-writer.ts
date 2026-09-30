import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Read kernel ownership, never lock-file existence or private process environments.
// A resumed thread keeps its original rollout path, outside the new pane's home.
export async function findCodexWriterThreads(input: {
  codexHome: string; paneId: string; sessionId: string;
}): Promise<string[]> {
  try {
    const key = `${input.paneId}--${input.sessionId}`.replace(/[^A-Za-z0-9_.-]/g, "_");
    const ownerText = (await readFile(join(input.codexHome, "space-app-servers", key, "app-server.pid"), "utf8")).trim();
    if (!/^[1-9][0-9]*$/.test(ownerText)) return [];
    const owner = Number(ownerText);
    const ownerIdentity = await readFile(`/proc/${owner}/stat`, "utf8");
    const startTime = (value: string) => value.slice(value.lastIndexOf(")") + 2).split(" ")[19];
    const locks = await readFile("/proc/locks", "utf8");
    const ownedLocks = new Set<string>();
    for (const line of locks.split("\n")) {
      const match = /^\d+: FLOCK\s+ADVISORY\s+WRITE\s+(\d+)\s+([0-9a-f]+):([0-9a-f]+):(\d+)\s+0 EOF$/.exec(line);
      if (!match) continue;
      let pid = Number(match[1]);
      for (let depth = 0; pid > 1 && depth < 16; depth += 1) {
        if (pid === owner) {
          ownedLocks.add(`${parseInt(match[2]!, 16)}:${parseInt(match[3]!, 16)}:${match[4]}`);
          break;
        }
        const processStat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
        if (!processStat) break;
        pid = Number(processStat.slice(processStat.lastIndexOf(")") + 2).split(" ")[1]);
      }
    }
    if (!ownedLocks.size) return [];
    const root = join(input.codexHome, "thread-writer-locks");
    const ids: string[] = [];
    for (const name of await readdir(root)) {
      const id = name.endsWith(".lock") ? name.slice(0, -5) : "";
      if (!uuid.test(id)) continue;
      const file = await stat(join(root, name), { bigint: true }).catch(() => null);
      if (!file?.isFile()) continue;
      const major = ((file.dev >> 8n) & 0xfffn) | ((file.dev >> 32n) & ~0xfffn);
      const minor = (file.dev & 0xffn) | ((file.dev >> 12n) & ~0xffn);
      if (ownedLocks.has(`${major}:${minor}:${file.ino}`)) ids.push(id);
    }
    // Fail closed if the supervisor exited or its PID was reused during inspection.
    const currentIdentity = await readFile(`/proc/${owner}/stat`, "utf8");
    return startTime(ownerIdentity) === startTime(currentIdentity) ? ids : [];
  } catch {
    return [];
  }
}
