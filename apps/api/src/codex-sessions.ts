import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

// A public install shows the API only Codex's sessions/ (read-only mount, 1.1.7): no state_5.sqlite, no auth.json.
// Threads are then found from the rollout files themselves: sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl.
const threadIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maxDayFolders = 31;
const maxRollouts = 2_000;
const sessionMetaBytes = 1024 * 1024;

/** True when the Codex home has no state database, as in a public install's sessions-only mount. */
export async function codexStateDbMissing(codexHome: string): Promise<boolean> {
  return stat(join(codexHome, "state_5.sqlite")).then(() => false, () => true);
}

/** Rollout files, newest day folder and newest file first, bounded. */
async function* recentRollouts(codexHome: string): AsyncGenerator<string> {
  const root = join(codexHome, "sessions");
  const numbered = async (dir: string) => (await readdir(dir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name)).map((entry) => entry.name).sort().reverse();
  let days = 0, files = 0;
  for (const year of await numbered(root)) for (const month of await numbered(join(root, year))) for (const day of await numbered(join(root, year, month))) {
    if (++days > maxDayFolders) return;
    const folder = join(root, year, month, day);
    const names = (await readdir(folder).catch(() => [] as string[])).filter((name) => /^rollout-.+\.jsonl$/.test(name)).sort().reverse();
    for (const name of names) {
      if (++files > maxRollouts) return;
      yield join(folder, name);
    }
  }
}

/** The thread's rollout, found by its file name. */
export async function findCodexRolloutByThreadId(codexHome: string, threadId: string): Promise<string | null> {
  if (!threadIdPattern.test(threadId)) return null;
  for await (const path of recentRollouts(codexHome)) if (path.endsWith(`-${threadId}.jsonl`)) return path;
  return null;
}

async function readSessionMeta(path: string): Promise<{ id: string; cwd: string; startedMs: number } | null> {
  let handle;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.allocUnsafe(sessionMetaBytes);
    const { bytesRead } = await handle.read(buffer, 0, sessionMetaBytes, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const line = JSON.parse(text.slice(0, text.includes("\n") ? text.indexOf("\n") : text.length)) as { type?: unknown; payload?: Record<string, unknown> };
    const payload = line.type === "session_meta" ? line.payload : undefined;
    const startedMs = Date.parse(String(payload?.timestamp ?? ""));
    return typeof payload?.id === "string" && threadIdPattern.test(payload.id) && typeof payload.cwd === "string" && Number.isFinite(startedMs)
      ? { id: payload.id, cwd: payload.cwd, startedMs } : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * The pane's thread: the one rollout in its cwd that started after its session did. Null when there is none or more
 * than one, so an older thread of the same folder, or another pane's, is never bound.
 */
export async function findCodexThreadInSessions(input: { codexHome: string; cwd: string; sinceMs: number }): Promise<string | null> {
  const found: string[] = [];
  for await (const path of recentRollouts(input.codexHome)) {
    const meta = await readSessionMeta(path);
    if (!meta) continue;
    if (meta.startedMs < input.sinceMs) break;
    if (meta.cwd !== input.cwd) continue;
    found.push(meta.id);
    if (found.length > 1) return null;
  }
  return found[0] ?? null;
}
