import { createHash } from "node:crypto";

/** Qoder session ids are UUIDs; Space starts every Qoder pane on one it can name again later. */
export const qoderNativeSessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The Qoder session a Space CLI session runs in: `--session-id` on a fresh start and `-r` on
 * restore or task-history resume, so Qoder resumes that exact conversation instead of the
 * folder's latest one. Derived from the Space session id, so no extra state is stored.
 */
export function qoderNativeSessionId(spaceSessionId: string): string {
  return spaceNamedSessionId("qoder", spaceSessionId);
}

/**
 * The Copilot session a Space CLI session runs in (`copilot --session-id <uuid>` starts a new session on that
 * UUID or resumes it). Space passes it in SPACE_COPILOT_SESSION_ID; the wrapper adds the flag (ADAPTER-006).
 */
export function copilotNativeSessionId(spaceSessionId: string): string {
  return spaceNamedSessionId("copilot", spaceSessionId);
}

/**
 * The Grok session a Space CLI session runs in: `grok --session-id <uuid>` starts it, `grok --resume <uuid>` reopens it.
 * Space passes it in SPACE_GROK_SESSION_ID; the wrapper picks the flag (ADAPTER-006).
 */
export function grokNativeSessionId(spaceSessionId: string): string {
  return spaceNamedSessionId("grok", spaceSessionId);
}

/**
 * The Cursor chat a Space CLI session runs in: `cursor-agent --resume <uuid>` starts a new chat on that UUID or reopens it.
 * Space passes it in SPACE_CURSOR_SESSION_ID; the wrapper adds the flag (ADAPTER-006).
 */
export function cursorNativeSessionId(spaceSessionId: string): string {
  return spaceNamedSessionId("cursor", spaceSessionId);
}

function spaceNamedSessionId(runtime: string, spaceSessionId: string): string {
  const hex = createHash("sha256").update(`space-${runtime}-session:${spaceSessionId}`).digest("hex");
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
