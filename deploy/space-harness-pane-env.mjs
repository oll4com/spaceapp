import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A DeepSeek Harness agent has no Space CLI session, and one harness process serves every Harness pane. The API
// publishes each loaded Harness pane's tool tokens under every harness session that acts for it: the pane's own
// (space-pane-<id>) and the session the operator picked in the pane (session-<uuid>, apps/api/src/harness-agent-tokens.ts);
// the harness gives every shell command its session id as DSH_SESSION_ID and its Space plugin adds it to each
// dispatcher call. Returns the pane's CLI-style environment, or null.
export const HARNESS_AGENT_TOKEN_DIR = "/opt/spaceapp/var/harness-agent-tokens";
export function harnessPaneEnvironment(sessionId, { dir = process.env.SPACE_HARNESS_AGENT_TOKEN_DIR || HARNESS_AGENT_TOKEN_DIR, now = Date.now(), prefix = "harness" } = {}) {
  // A plain file name in the token directory: no path separators, dots or empty names.
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId)) return null;
  let value;
  try { value = JSON.parse(readFileSync(join(dir, `${sessionId}.json`), "utf8")); } catch { return null; }
  if (value?.version !== 1 || value.sessionId !== sessionId || typeof value.expiresAt !== "number" || value.expiresAt <= now ||
      !value.env || typeof value.env !== "object") return null;
  // Space variables only: the file never sets PATH, NODE_OPTIONS or the like.
  const env = Object.fromEntries(Object.entries(value.env).filter(([key, item]) => /^SPACE_[A-Z0-9_]+$/.test(key) && typeof item === "string"));
  if (env.SPACE_PANE_ID !== value.paneId || env.SPACE_ROOM_ID !== value.roomId) return null;
  // Each pane and token gets its own capability worker and backend processes.
  const key = createHash("sha256").update(JSON.stringify([env.SPACE_BROWSER_ACTION_TOKEN ?? null, env.SPACE_AGENT_FILES_TOKEN ?? null,
    env.SPACE_CONTROL_TOKEN ?? null])).digest("hex").slice(0, 12);
  return { ...env, CODEX_MCP_SESSION_ID: `${prefix}:${env.SPACE_PANE_ID}:${key}` };
}

// An OpenCode pane's agent runs its shell commands inside the one shared OpenCode server (deploy/space-opencode-shared.service),
// whose environment names no pane: OpenCode gives each command its session as OPENCODE_SESSION_ID, and the pane's wrapper
// (deploy/opencode-space-full-tui.mjs) publishes the pane's Space variables under that session, in the same file format.
export const OPENCODE_PANE_ENV_DIR = "/var/lib/spaceapp-user/.codex/space-opencode/state/opencode/space-cli-pane-env";

/** The pane environment of an agent whose process serves many panes (Harness, shared OpenCode server), or null. */
export function sharedServerPaneEnvironment(env) {
  return harnessPaneEnvironment(env.DSH_SESSION_ID) ?? harnessPaneEnvironment(env.OPENCODE_SESSION_ID,
    { dir: process.env.SPACE_OPENCODE_PANE_ENV_DIR || OPENCODE_PANE_ENV_DIR, prefix: "opencode" });
}
