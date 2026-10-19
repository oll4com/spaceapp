import { randomUUID } from "node:crypto";
import { chmod, chown, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pane } from "@space/contracts";
import type { SpaceApiConfig } from "./config.js";
import { cliAgentFilesApiBaseUrl, issueCliAgentFilesToken } from "./cli-agent-files.js";
import { cliBrowserBridgeApiBaseUrl, issueCliBrowserBridgeToken } from "./cli-browser-bridge.js";
import { issueControlToken } from "./space-control-token.js";
import { tokenExpiryMs } from "./t3code/agent-tokens.js";

// A DeepSeek Harness agent has no Space CLI session, and one harness process serves every Harness pane.
// Its pane-bound tools (space_browser, space_playwright_pane, space-task, Agent Files, Space Control) act
// for its Harness pane under this principal, verified against the open pane like a T3 Code agent's.
export const HARNESS_AGENT_SESSION_PREFIX = "harness:";
export const HARNESS_AGENT_RUNTIME_ID = "cli:harness";
// One file per harness session that acts for a pane, named by that session: the pane's own session
// (space-pane-<id>) and, when the operator picked another session in the pane, that one too. The harness gives every
// shell command its session id as DSH_SESSION_ID and its Space plugin adds it to each dispatcher call
// (deploy/space-harness-pane-env.mjs reads the file). Readable by the harness user's group only.
export const HARNESS_AGENT_TOKEN_DIR = "/opt/spaceapp/var/harness-agent-tokens";
const HARNESS_STATE_DIR = "/opt/spaceapp/var/deepseek-harness";
const REFRESH_BEFORE_MS = 6 * 60 * 60 * 1000;
// A harness session id that names a token file (deploy/space-harness-pane-env.mjs accepts the same pattern).
const HARNESS_SESSION_FILE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const TOKEN_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.json$/;

export const harnessAgentSessionId = (paneId: string) => HARNESS_AGENT_SESSION_PREFIX + paneId;
export const isHarnessAgentSessionId = (sessionId: string) => sessionId.startsWith(HARNESS_AGENT_SESSION_PREFIX);
export const harnessPaneSessionName = (paneId: string) => `space-pane-${paneId.slice("pane:".length)}`;

/**
 * The harness sessions whose shells act for a pane: its own session, plus the session its picker shows when the
 * operator chose another one (taskMetadata.harnessSessionId, bound by task-title-service). Another pane's own
 * session (space-pane-*) never takes this pane's tokens.
 */
export function harnessPaneTokenSessions(paneId: string, boundSessionId?: string | null): string[] {
  const own = harnessPaneSessionName(paneId);
  return boundSessionId && boundSessionId !== own && HARNESS_SESSION_FILE_ID.test(boundSessionId) &&
    !boundSessionId.startsWith("space-pane-") ? [own, boundSessionId] : [own];
}

export interface HarnessAgentTokenOptions {
  config: Pick<SpaceApiConfig, "internalApiToken" | "browserToolBridgeEnabled" | "host" | "port" | "browserEvidenceTargetOrigin">;
  dir?: string;
  // The token files take this directory's group: the harness user's.
  groupFrom?: string;
  now?: () => number;
}

const readTokenFile = (path: string) =>
  readFile(path, "utf8").then(raw => JSON.parse(raw) as Record<string, unknown>, () => null);

/**
 * Writes (or keeps, while fresh) the pane-bound tool tokens of one Harness pane for every harness session that acts
 * for it (harnessPaneTokenSessions), and removes this pane's files for sessions it no longer shows.
 */
export async function publishHarnessAgentTokens(options: HarnessAgentTokenOptions,
  input: { roomId: string; paneId: string; boundSessionId?: string | null }): Promise<"written" | "fresh" | "unavailable"> {
  const dir = options.dir ?? HARNESS_AGENT_TOKEN_DIR, nowMs = (options.now ?? Date.now)();
  if (!/^space-pane-[A-Za-z0-9_-]{1,64}$/.test(harnessPaneSessionName(input.paneId))) return "unavailable";
  const sessionIds = harnessPaneTokenSessions(input.paneId, input.boundSessionId);
  const stale: string[] = [];
  for (const id of sessionIds) {
    const current = await readTokenFile(join(dir, `${id}.json`));
    if (!(current?.sessionId === id && current.paneId === input.paneId && current.roomId === input.roomId &&
        typeof current.expiresAt === "number" && current.expiresAt - nowMs > REFRESH_BEFORE_MS)) stale.push(id);
  }
  if (!stale.length) {
    await removeOutdatedTokenFiles(dir, input.paneId, sessionIds, nowMs);
    return "fresh";
  }
  const context = { roomId: input.roomId, paneId: input.paneId, cliSessionId: harnessAgentSessionId(input.paneId) };
  const browserToken = issueCliBrowserBridgeToken(options.config, context, nowMs);
  const agentFilesToken = issueCliAgentFilesToken(options.config, context, nowMs);
  const controlToken = issueControlToken(options.config.internalApiToken, context);
  if (!browserToken && !agentFilesToken && !controlToken) return "unavailable";
  const apiBase = cliBrowserBridgeApiBaseUrl(options.config), filesBase = cliAgentFilesApiBaseUrl(options.config);
  // The same variables a CLI pane's session gets (cli-terminal.ts).
  const env: Record<string, string> = { SPACE_ROOM_ID: input.roomId, SPACE_PANE_ID: input.paneId,
    ...(browserToken ? { SPACE_BROWSER_BRIDGE_ENABLED: "true", SPACE_BROWSER_CONTEXT_ENDPOINT: `${apiBase}/api/cli/browser/context`,
      SPACE_BROWSER_SESSION_ENDPOINT: `${apiBase}/api/cli/browser/session`, SPACE_BROWSER_ACTION_ENDPOINT: `${apiBase}/api/cli/browser/actions`,
      SPACE_BROWSER_COMMAND_ENDPOINT: `${apiBase}/api/cli/browser/commands`, SPACE_BROWSER_ACTION_TOKEN: browserToken } : {}),
    ...(agentFilesToken ? { SPACE_AGENT_FILES_ENABLED: "true", SPACE_AGENT_FILES_ENDPOINT: `${filesBase}/api/cli/agent-files`,
      SPACE_AGENT_FILES_TOKEN: agentFilesToken } : {}),
    ...(controlToken ? { SPACE_CONTROL_TOKEN: controlToken, SPACE_CONTROL_ENDPOINT: `${filesBase}/api/cli/control/mcp` } : {}) };
  const expiresAt = Math.min(...[browserToken, agentFilesToken, controlToken].filter((token): token is string => Boolean(token)).map(tokenExpiryMs));
  const { gid } = await stat(options.groupFrom ?? HARNESS_STATE_DIR);
  await mkdir(dir, { recursive: true, mode: 0o750 });
  await chown(dir, -1, gid);
  await chmod(dir, 0o2750);
  for (const sessionId of stale) {
    const path = join(dir, `${sessionId}.json`), temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, sessionId, roomId: input.roomId, paneId: input.paneId, expiresAt, env }) + "\n",
        { mode: 0o640, flag: "wx" });
      await chown(temporary, -1, gid);
      await chmod(temporary, 0o640);
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }
  await removeOutdatedTokenFiles(dir, input.paneId, sessionIds, nowMs);
  return "written";
}

/**
 * Removes expired or unreadable files (closed panes' are useless; the API refuses them anyway) and this pane's files
 * for sessions it no longer shows. A session another pane now shows keeps that pane's file.
 */
async function removeOutdatedTokenFiles(dir: string, paneId: string, keep: string[], nowMs: number): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    if (!TOKEN_FILE_NAME.test(name) || keep.includes(name.slice(0, -".json".length))) continue;
    const other = await readTokenFile(join(dir, name));
    if (!other || typeof other.expiresAt !== "number" || other.expiresAt <= nowMs || other.paneId === paneId)
      await rm(join(dir, name), { force: true });
  }
}

/** True only for an open Harness pane in the token's room, under its own principal. */
export async function harnessAgentPrincipal(store: { getPane(paneId: string): Pane | Promise<Pane> },
  claims: { roomId: string; paneId: string; cliSessionId: string }): Promise<boolean> {
  if (claims.cliSessionId !== harnessAgentSessionId(claims.paneId)) return false;
  const pane = await Promise.resolve().then(() => store.getPane(claims.paneId)).catch(() => null);
  return Boolean(pane && pane.id === claims.paneId && pane.mode === "HARNESS" && !pane.isClosed && pane.roomId === claims.roomId);
}
