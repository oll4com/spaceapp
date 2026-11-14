import { isLightCodexPane, LIGHT_CODEX_RUNTIME_ID, type Pane } from "@space/contracts";
import { buildCliEnvironment } from "./cli-terminal.js";
import type { SpaceApiConfig } from "./config.js";
import { harnessAgentPrincipal, isHarnessAgentSessionId } from "./harness-agent-tokens.js";

// A Codex light pane (CHAT + cli:codex, plan YqhRIXfLAnfK Δ S2) runs `codex app-server` per turn through the CLI broker,
// so it has no pane CLI session. Its Space Control token names this principal, verified against the open pane like a
// Harness pane's (harness-agent-tokens.ts).
export const LIGHT_CODEX_SESSION_PREFIX = "light:";
export const lightCodexSessionId = (paneId: string) => LIGHT_CODEX_SESSION_PREFIX + paneId;
export const isLightCodexSessionId = (sessionId: string) => sessionId.startsWith(LIGHT_CODEX_SESSION_PREFIX);

/** True only for an open Codex light pane in the token's room, under its own principal. */
export async function lightCodexPrincipal(store: { getPane(paneId: string): Pane | Promise<Pane> },
  claims: { roomId: string; paneId: string; cliSessionId: string }): Promise<boolean> {
  if (claims.cliSessionId !== lightCodexSessionId(claims.paneId)) return false;
  const pane = await Promise.resolve().then(() => store.getPane(claims.paneId)).catch(() => null);
  return Boolean(pane && pane.id === claims.paneId && isLightCodexPane(pane) && !pane.isClosed && pane.roomId === claims.roomId);
}

/** For a Harness or light pane's token: whether its pane may still act; null for a CLI session's token. */
export async function agentPanePrincipal(store: { getPane(paneId: string): Pane | Promise<Pane> },
  claims: { roomId: string; paneId: string; cliSessionId: string }): Promise<boolean | null> {
  if (isHarnessAgentSessionId(claims.cliSessionId)) return harnessAgentPrincipal(store, claims);
  return isLightCodexSessionId(claims.cliSessionId) ? lightCodexPrincipal(store, claims) : null;
}

/**
 * The launch environment of one light turn: a TUI cli:codex pane's (same netns route, uid, control token scope and
 * lifetime) built only from the pane record. The browser bridge and Agent Files tokens stay out until their routes
 * accept this principal, and the wrapper must start a stdio app-server, not the per-session TUI.
 */
export function buildLightCodexEnvironment(config: SpaceApiConfig, pane: Pane): Record<string, string> {
  const env = buildCliEnvironment(config, {
    roomId: pane.roomId, paneId: pane.id, cliSessionId: lightCodexSessionId(pane.id), runtimeId: LIGHT_CODEX_RUNTIME_ID,
    purpose: "NORMAL", cwd: pane.cwd ?? config.cliWorkspaceRoot
  });
  for (const name of ["SPACE_CODEX_PER_SESSION_APP_SERVER", config.codexAppServerKeyEnv]) delete env[name];
  for (const name of Object.keys(env)) {
    if (/^SPACE_(BROWSER_(?!BRIDGE_ENABLED)|AGENT_FILES_(?!ENABLED)|(JOB_APPLY|MAIL_COPILOT|MARKETING_COPILOT|FREELANCE_COPILOT)_ENDPOINT)/.test(name)) delete env[name];
  }
  if (env.SPACE_BROWSER_BRIDGE_ENABLED === "true") env.SPACE_BROWSER_BRIDGE_ENABLED = "unavailable";
  if (env.SPACE_AGENT_FILES_ENABLED === "true") env.SPACE_AGENT_FILES_ENABLED = "unavailable";
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}
