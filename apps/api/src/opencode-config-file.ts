import { randomUUID } from "node:crypto";
import { chmod, chown, copyFile, open, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { SpaceConflictError } from "@space/runtime";

// The shared OpenCode config (~/.config/opencode/opencode.json) holds every provider, the Space dispatcher MCP and the
// agents. On 28/10 22:00:49 UTC a write hit ENOSPC and left it empty (Alex/Finn's Claude model read "unavailable" until
// 01:57 UTC), and a provider toggle then read the empty file as {} and wrote a 31-byte stub over it. Its writers read it
// strictly and replace it whole; scripts/lib/opencode-config-file.mjs is the scripts' copy of the same rules.

/** A real config is kilobytes; anything shorter is a truncated or stub file, never a config to build on. */
export const MIN_OPENCODE_CONFIG_BYTES = 100;

/** The newest `<file>.bak*` beside the file (by modification time), or null. */
export async function newestConfigBackup(file: string): Promise<string | null> {
  const names = (await readdir(dirname(file)).catch(() => [] as string[])).filter((name) => name.startsWith(`${basename(file)}.bak`));
  let newest: { path: string; mtimeMs: number } | null = null;
  for (const name of names) {
    const path = join(dirname(file), name);
    const mtimeMs = (await stat(path).catch(() => null))?.mtimeMs;
    if (mtimeMs !== undefined && (!newest || mtimeMs > newest.mtimeMs)) newest = { path, mtimeMs };
  }
  return newest?.path ?? null;
}

/** Why `text` (null: unreadable, with its error code) cannot be a config to change, or null when it is one. */
export function openCodeConfigProblem(text: string | null, readError?: string): string | null {
  if (text === null) return `cannot be read (${readError ?? "error"})`;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes < MIN_OPENCODE_CONFIG_BYTES) return `holds only ${bytes} bytes`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "is not valid JSON";
  }
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? null : "is not a JSON object";
}

/** The refusal that names the file, what is wrong with it and the backup to restore it from. */
export async function openCodeConfigRefusal(file: string, problem: string): Promise<SpaceConflictError> {
  const backup = await newestConfigBackup(file);
  return new SpaceConflictError(`${file} ${problem}; refusing to write it. Restore it from ${backup ?? "a backup (none found beside it)"} first.`);
}

/** Reads the config to change it; an unreadable, unparsable, empty or stub file is refused, never treated as {}. */
export async function readOpenCodeConfigForUpdate<T extends object>(file: string): Promise<T> {
  let text: string | null = null;
  let readError: string | undefined;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    readError = (error as NodeJS.ErrnoException)?.code;
  }
  const problem = openCodeConfigProblem(text, readError);
  if (problem) throw await openCodeConfigRefusal(file, problem);
  return JSON.parse(text as string) as T;
}

/**
 * Replaces `file` with `text`: a dated copy `<file>.bak-<label>-<ISO>` first (a failed copy stops the write), then a
 * temp file in the same folder, written, fsynced and renamed over the file with the old file's mode and group. On any
 * error the temp file is removed and the old file stays intact.
 */
export async function writeOpenCodeConfigAtomic(file: string, text: string, label: string, now = new Date()): Promise<{ backup: string | null }> {
  const previous = await stat(file).catch(() => null);
  let backup: string | null = null;
  if (previous) {
    backup = `${file}.bak-${label}-${now.toISOString().replace(/[:.]/g, "-")}`;
    await copyFile(file, backup);
  }
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(tmp, "wx", previous ? previous.mode & 0o777 : 0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    if (previous) {
      await chmod(tmp, previous.mode & 0o7777);
      // Keep the old file's group (the API is not its owner), so every writer can still write it.
      await chown(tmp, -1, previous.gid).catch(() => undefined);
    }
    await rename(tmp, file);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
  const folder = await open(dirname(file), "r").catch(() => null);
  await folder?.sync().catch(() => undefined);
  await folder?.close().catch(() => undefined);
  return { backup };
}
