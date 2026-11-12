import { stat } from "node:fs/promises";
import { findFileMentions, SPACE_AGENT_HOME } from "@space/contracts";

const NOTIFICATION_ID = /(?<![\w:-])notification:[A-Za-z0-9_-]{6,80}(?![A-Za-z0-9_-])/g;

/**
 * 2026-11-12 REVIEW (4 of 11 corrections were claims from stale reports, among them a card id that never existed): the notification ids
 * and workspace report paths a Nous answer names that do not exist. A path the server cannot read (EACCES) is not called missing.
 * shortcut: Vault keys and bare card numbers are not checked; add them when an answer names one that does not exist.
 */
export async function unknownRefs(text: string, notificationExists: (id: string) => Promise<boolean>): Promise<string[]> {
  const ids = [...new Set(text.match(NOTIFICATION_ID) ?? [])];
  const paths = [...new Set(findFileMentions(text).filter((mention) => mention.kind === "path" && !mention.text.startsWith("nous/")).map((mention) => mention.text))];
  const missing = await Promise.all([
    ...ids.map(async (id) => await notificationExists(id).catch(() => true) ? null : id),
    ...paths.map(async (path) => await stat(path.replace(/^~/, SPACE_AGENT_HOME)).then(() => null, (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? path : null))
  ]);
  return missing.filter((ref): ref is string => ref !== null);
}

/** The line the answer ends with when it names something that does not exist. */
export const unknownRefsLine = (refs: string[]) => `⚠ Not found in Space: ${refs.join(", ")}. Check these before acting on this answer.`;
