import { createHash, randomUUID } from "node:crypto";
import { chmod, chown, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pane } from "@space/contracts";
import type { SpaceApiConfig } from "../config.js";
import { cliAgentFilesApiBaseUrl, issueCliAgentFilesToken } from "../cli-agent-files.js";
import { cliBrowserBridgeApiBaseUrl, issueCliBrowserBridgeToken } from "../cli-browser-bridge.js";

// A T3 agent has no Space CLI session. Its pane-bound tools (space_browser,
// Agent Files) act for the T3 pane under this principal, verified against the
// open T3 pane instead of a CLI session.
export const T3_AGENT_SESSION_PREFIX = "t3code:";
export const T3_AGENT_RUNTIME_ID = "cli:t3code";
// One file per T3 workspace (the agents' working directory), readable by the
// T3 service group only; the Space tools find it from their working directory.
export const T3_AGENT_TOKEN_DIR = "/opt/spaceapp/var/t3code-agent-tokens";
const T3_DATA_DIR = "/opt/spaceapp/var/t3code";
const REFRESH_BEFORE_MS = 6 * 60 * 60 * 1000;

export const t3AgentSessionId = (paneId: string) => T3_AGENT_SESSION_PREFIX + paneId;
export const isT3AgentSessionId = (sessionId: string) => sessionId.startsWith(T3_AGENT_SESSION_PREFIX);
export const t3AgentTokenFile = (dir: string, workspaceRoot: string) =>
  join(dir, createHash("sha256").update(workspaceRoot).digest("hex") + ".json");

export interface T3AgentTokenOptions {
  config: Pick<SpaceApiConfig, "internalApiToken" | "browserToolBridgeEnabled" | "host" | "port" | "browserEvidenceTargetOrigin">;
  dir?: string;
  // The token files take this directory's group: the T3 service user's.
  groupFrom?: string;
  now?: () => number;
}

// <prefix>.<payload>.<signature>; the prefix itself contains a dot.
export const tokenExpiryMs = (token: string) => {
  const parts = token.split(".");
  const payload = JSON.parse(Buffer.from(parts[parts.length - 2] ?? "", "base64url").toString("utf8")) as { exp?: unknown };
  return typeof payload.exp === "number" ? payload.exp * 1000 : 0;
};

/** Writes (or keeps, while fresh) the pane-bound tool tokens for the T3 agents of one workspace. */
export async function publishT3AgentTokens(options: T3AgentTokenOptions,
  input: { roomId: string; paneId: string; workspaceRoot: string }): Promise<"written" | "fresh" | "unavailable"> {
  const dir = options.dir ?? T3_AGENT_TOKEN_DIR, nowMs = (options.now ?? Date.now)();
  const context = { roomId: input.roomId, paneId: input.paneId, cliSessionId: t3AgentSessionId(input.paneId) };
  const browserToken = issueCliBrowserBridgeToken(options.config, context, nowMs);
  const agentFilesToken = issueCliAgentFilesToken(options.config, context, nowMs);
  if (!browserToken && !agentFilesToken) return "unavailable";
  const path = t3AgentTokenFile(dir, input.workspaceRoot);
  const current = await readFile(path, "utf8").then(raw => JSON.parse(raw) as Record<string, unknown>, () => null);
  if (current?.paneId === input.paneId && current.roomId === input.roomId && typeof current.expiresAt === "number" &&
      current.expiresAt - nowMs > REFRESH_BEFORE_MS) return "fresh";
  const { gid } = await stat(options.groupFrom ?? T3_DATA_DIR);
  await mkdir(dir, { recursive: true, mode: 0o750 });
  await chown(dir, -1, gid);
  await chmod(dir, 0o2750);
  const apiBase = cliBrowserBridgeApiBaseUrl(options.config), filesBase = cliAgentFilesApiBaseUrl(options.config);
  const content = {
    version: 1, workspaceRoot: input.workspaceRoot, roomId: input.roomId, paneId: input.paneId,
    expiresAt: Math.min(...[browserToken, agentFilesToken].filter((token): token is string => Boolean(token)).map(tokenExpiryMs)),
    browser: browserToken ? { token: browserToken, contextEndpoint: `${apiBase}/api/cli/browser/context`,
      sessionEndpoint: `${apiBase}/api/cli/browser/session`, actionEndpoint: `${apiBase}/api/cli/browser/actions`,
      commandEndpoint: `${apiBase}/api/cli/browser/commands` } : null,
    agentFiles: agentFilesToken ? { token: agentFilesToken, endpoint: `${filesBase}/api/cli/agent-files` } : null
  };
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(content) + "\n", { mode: 0o640, flag: "wx" });
    await chown(temporary, -1, gid);
    await chmod(temporary, 0o640);
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
  // Expired files of closed or moved panes are useless; the API refuses them anyway.
  for (const name of await readdir(dir)) {
    if (!/^[0-9a-f]{64}\.json$/.test(name) || join(dir, name) === path) continue;
    const other = await readFile(join(dir, name), "utf8").then(raw => JSON.parse(raw) as { expiresAt?: unknown }, () => null);
    if (!other || typeof other.expiresAt !== "number" || other.expiresAt <= nowMs) await rm(join(dir, name), { force: true });
  }
  return "written";
}

/** True only for an open T3 pane in the token's room, under its own principal. */
export async function t3AgentPrincipal(store: { getPane(paneId: string): Pane | Promise<Pane> },
  claims: { roomId: string; paneId: string; cliSessionId: string }): Promise<boolean> {
  if (claims.cliSessionId !== t3AgentSessionId(claims.paneId)) return false;
  const pane = await Promise.resolve().then(() => store.getPane(claims.paneId)).catch(() => null);
  return Boolean(pane && pane.id === claims.paneId && pane.mode === "T3CODE" && !pane.isClosed && pane.roomId === claims.roomId);
}
