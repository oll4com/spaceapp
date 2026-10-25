import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";

/** Codex 0.162 reports method-not-supported before its first turn. Only a
 * complete, unchanged, metadata-only native rollout proves that history is empty.
 * The root is trusted server configuration; the native path is not trusted.
 */
export async function confirmFreshNativeHistory(root: string | undefined, path: unknown, threadId: string, cwd: string): Promise<boolean> {
  if (!root || !isAbsolute(root) || typeof path !== "string" || !isAbsolute(path)) return false;
  try {
    const sessions = await realpath(join(root, "sessions"));
    const resolved = await realpath(path);
    if (!resolved.startsWith(sessions + sep)) return false;
    const file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat({bigint:true});
      if (!before.isFile() || before.size <= 0n || before.size > 1048576n) return false;
      const bytes = Buffer.alloc(Number(before.size) + 1);
      const {bytesRead} = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== Number(before.size)) return false;
      const content = bytes.subarray(0, bytesRead).toString("utf8");
      if (!content.endsWith("\n")) return false;
      const lines = content.trimEnd().split("\n");
      if (lines.length !== 1) return false;
      const record = JSON.parse(lines[0]!);
      if (record.type !== "session_meta" || record.payload?.id !== threadId || record.payload?.cwd !== cwd ||
          record.payload?.history_mode !== "paginated") return false;
      const after = await file.stat({bigint:true});
      const current = await stat(resolved, {bigint:true});
      return [after, current].every(value => value.dev === before.dev && value.ino === before.ino &&
        value.size === before.size && value.mtimeNs === before.mtimeNs && value.ctimeNs === before.ctimeNs);
    } finally { await file.close(); }
  } catch { return false; }
}
