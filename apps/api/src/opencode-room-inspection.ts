import {
  fetchOpenCodeSessionIsTurnActive,
  fetchOpenCodeSessionMessages,
  type OpenCodeServerControl
} from "@space/opencode-control";
import { nowIso, SpaceConflictError } from "@space/runtime";
import { openCodeTaskTimeline } from "./room-task-telemetry.js";

/**
 * What room inspection reads from an OpenCode pane's session: its task timeline and a transcript of the user and
 * assistant text; the history refused as unavailable when OpenCode cannot list the session's messages.
 */
export async function roomOpenCodeInspection(control: OpenCodeServerControl) {
  const [messages, busy] = await Promise.all([
    fetchOpenCodeSessionMessages(control, control.nativeSessionId, 512).catch(() => { throw new SpaceConflictError("OpenCode task history is unavailable."); }),
    fetchOpenCodeSessionIsTurnActive(control, control.nativeSessionId)
  ]);
  const tasks = openCodeTaskTimeline(messages, busy, nowIso());

  const transcriptLines: string[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const role = (msg as any).info?.role === "user" ? "User" : (msg as any).info?.role === "assistant" ? "Assistant" : null;
    if (!role) continue;
    const parts = Array.isArray((msg as any).parts) ? (msg as any).parts : [];
    const textParts = parts
      .filter((p: any) => p && typeof p === "object" && p.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text.trim())
      .filter(Boolean);
    if (textParts.length > 0) {
      transcriptLines.push(`[${role}]\n${textParts.join("\n")}`);
    }
  }
  const transcript = transcriptLines.join("\n\n");
  return { tasks, transcript };
}
export async function roomOpenCodeTasks(control: OpenCodeServerControl) {
  return (await roomOpenCodeInspection(control)).tasks;
}
