import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { DotEvalsRepository, PostgresDotHomeRepository, PostgresDotsRepository } from "@space/db";
import { SpaceFeatureDisabledError, SpaceNotFoundError, makeSpaceId, redactMemoryText, type SpaceStore } from "@space/runtime";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import { verifySession } from "./auth.js";
import type { BrowserSessionManagerWithHostHealth } from "./browser-host-proxy.js";
import { safeBrowserObservationText, safeBrowserObservationUrl } from "./browser-observation.js";
import type { SpaceApiConfig } from "./config.js";
import { dotDesignRequest } from "./design/wiring.js";
import type { createDotChannelService } from "./dot-channels.js";
import type { createDotComputerService } from "./dot-computer.js";
import type { createConnectorService } from "./dot-connectors.js";
import type { createDotDelegationService } from "./dot-delegations.js";
import type { createDotDeliverablesService } from "./dot-deliverables.js";
import type { createDotGoalService } from "./dot-goals.js";
import type { createDotMemoryService } from "./dot-memory.js";
import type { createDotScheduleService } from "./dot-schedules.js";
import { registerDotToolGatewayRoutes, type DotToolGatewayDeps } from "./dot-tools-gateway.js";
import type { createMcpToolExecutor } from "./mcp-tool-executor.js";
import { assertBrowserPaneCompatible, getPaneById } from "./pane-guards.js";
import { recordAudit } from "./request-audit.js";
import { GitControlError } from "./source-control/errors.js";
import type { SpaceAgentAdapter } from "./space-agent.js";
import type { registerSpaceControlRoutes } from "./space-control-routes.js";
import { assertVaultBrowserActionAllowed, type VaultProtection } from "./vault/protection.js";
import { dotVideoRequest } from "./video/wiring.js";
import { SPACE_INSTALL_ROOT } from "@space/contracts";

type DotToolGatewayWiringDeps = {
  store: SpaceStore;
  config: SpaceApiConfig;
  auth: { sessionSecret: string };
  cookieName: string;
  defaultRouteRateLimitOptions: RouteShorthandOptions;
  dotsRepository: PostgresDotsRepository | null;
  dotHomeRepository: Pick<PostgresDotHomeRepository, "settings"> | null;
  dotEvalsRepository: Pick<DotEvalsRepository, "isRunningSession"> | null;
  controlUser: (userId: string) => ReturnType<DotToolGatewayDeps["resolveActor"]>;
  spaceControlRoutes: Pick<ReturnType<typeof registerSpaceControlRoutes>, "call">;
  executeMcpToolWithPolicy: ReturnType<typeof createMcpToolExecutor>;
  browserSessionManager: Pick<BrowserSessionManagerWithHostHealth, "action">;
  vault: { protection: Pick<VaultProtection, "ownerOf" | "release"> };
  spaceAgentAdapter: Pick<SpaceAgentAdapter, "sendMessage">;
  connectorService: ReturnType<typeof createConnectorService> | null;
  dotChannelService: ReturnType<typeof createDotChannelService> | null;
  dotGoalService: ReturnType<typeof createDotGoalService> | null;
  dotComputerService: ReturnType<typeof createDotComputerService> | null;
  dotDelegationService: ReturnType<typeof createDotDelegationService> | null;
  dotMemoryService: ReturnType<typeof createDotMemoryService> | null;
  dotDeliverablesService: ReturnType<typeof createDotDeliverablesService> | null;
  dotScheduleService: ReturnType<typeof createDotScheduleService> | null;
  designService: Parameters<typeof dotDesignRequest>[0] | undefined;
  videoService: Parameters<typeof dotVideoRequest>[0] | undefined;
};

/**
 * The Dot tool gateway's wiring: the catalog context (MCP tools and installed servers, connectors, channels, browser panes), MCP and
 * browser execution behind the bridges' switches and the Vault fence, the Dot services' tools (goals, computer, delegation, design and
 * video requests, memory, deliverables, connectors, schedules, channels), the evaluation sessions, the continuation after an approval
 * and the audit; with no Dots storage the routes answer unavailable.
 */
export function registerDotToolGatewayWiring(app: FastifyInstance, deps: DotToolGatewayWiringDeps) {
  const { store, config, auth, cookieName, defaultRouteRateLimitOptions, dotsRepository, dotHomeRepository, dotEvalsRepository, controlUser,
    spaceControlRoutes, executeMcpToolWithPolicy, browserSessionManager, vault, spaceAgentAdapter, connectorService, dotChannelService,
    dotGoalService, dotComputerService, dotDelegationService, dotMemoryService, dotDeliverablesService, dotScheduleService, designService,
    videoService } = deps;
  const installedMcpRegistryPath = `${SPACE_INSTALL_ROOT}/bin/tool-routing-current/mcp-registry.json`;
  const mcpResultRoot = resolve(config.browserEvidenceArtifactRoot, "mcp-executions");
  registerDotToolGatewayRoutes(app, dotsRepository ? {
    store, repository: dotsRepository,
    resolveActor: (userId) => controlUser(userId),
    callControl: (actor, tool, args) => spaceControlRoutes.call(actor, tool, args),
    catalogContext: async ({ roomId, role, ownerUserId }) => {
      const [servers, tools, sessions, registry, connectors, channels] = await Promise.all([
        store.listMcpServers(), store.listMcpTools(), roomId ? store.listActivePaneBrowserSessions(roomId) : Promise.resolve([]),
        readFile(installedMcpRegistryPath, "utf8").then((text) => JSON.parse(text) as { servers?: Array<{ id?: unknown; description?: unknown }> })
          .catch(() => ({ servers: [] })),
        connectorService && ownerUserId ? connectorService.catalog(ownerUserId).catch(() => null) : Promise.resolve(null),
        dotChannelService && ownerUserId ? dotChannelService.status(ownerUserId).catch(() => null) : Promise.resolve(null)
      ]);
      const serverById = new Map(servers.map((server) => [server.id, server]));
      return {
        role,
        ...(channels ? { channels: channels.providers.map((provider) => ({ provider: provider.provider, configured: provider.configured,
          linked: channels.identities.some((identity) => identity.provider === provider.provider) })) } : {}),
        ...(connectors ?? (connectorService ? { connectorAccounts: [], connectorProviders: { google: Boolean(connectorService.client("GOOGLE")),
          microsoft: Boolean(connectorService.client("MICROSOFT")) } } : {})),
        browserSessionsEnabled: config.browserSessionsEnabled && config.browserToolBridgeEnabled,
        browserPaneIds: sessions.map((session) => session.paneId),
        mcpTools: tools.map((tool) => {
          const server = serverById.get(tool.serverId);
          return { toolId: tool.id, serverName: server?.displayName ?? tool.serverId, name: tool.name,
            available: config.mcpToolBridgeEnabled && tool.status === "VERIFIED" && server?.status === "VERIFIED",
            approvalRequired: tool.approvalRequired,
            statusReason: config.mcpToolBridgeEnabled ? tool.statusReason : "The Space MCP tool bridge is disabled." };
        }),
        installedMcpServers: (registry.servers ?? []).flatMap((server) =>
          typeof server.id === "string" && typeof server.description === "string" ? [{ serverId: server.id, description: server.description }] : [])
      };
    },
    executeMcp: async (input, request) => {
      if (!config.mcpToolBridgeEnabled) return { status: "BLOCKED", message: "The Space MCP tool bridge is disabled.", artifactLocalPath: null };
      const result = await executeMcpToolWithPolicy(input, request);
      const localPath = result.artifact?.metadata && typeof (result.artifact.metadata as Record<string, unknown>).localPath === "string"
        ? (result.artifact.metadata as Record<string, string>).localPath : null;
      return { status: result.status, message: result.message, artifactLocalPath: localPath ?? null };
    },
    readMcpResult: async (localPath) => {
      const path = resolve(localPath);
      if (!path.startsWith(`${mcpResultRoot}/`)) return { message: "The MCP result is stored as a Space artifact." };
      const text = await readFile(path, "utf8");
      return (JSON.parse(text) as { result?: unknown }).result ?? null;
    },
    executeBrowser: async (input, request) => {
      if (!config.browserSessionsEnabled || !config.browserToolBridgeEnabled) throw new SpaceFeatureDisabledError("BROWSER_TOOL_BRIDGE_DISABLED", "Managed browser tools are disabled.");
      const browserPane = await getPaneById(store, input.targetPaneId);
      assertBrowserPaneCompatible(browserPane);
      if (browserPane.roomId !== input.roomId) throw new SpaceNotFoundError(`Browser pane ${browserPane.id} was not found in room ${input.roomId}.`);
      await assertVaultBrowserActionAllowed(vault.protection, browserPane.id, input.action.type);
      const actionResult = await browserSessionManager.action(browserPane, input.action, request.requestIdForSpace,
        { holderType: "AGENT", holderId: input.agentSessionId });
      await recordAudit(store, request, { action: "pane.browser.agent_action.executed", targetType: "pane", targetId: browserPane.id,
        metadata: { roomId: input.roomId, agentSessionId: input.agentSessionId, sessionId: actionResult.session.sessionId, actionType: input.action.type, via: "dot-gateway" } });
      return { sessionId: actionResult.session.sessionId, paneId: actionResult.session.paneId, actionType: input.action.type,
        viewport: actionResult.session.viewport, currentUrl: safeBrowserObservationUrl(actionResult.session.currentUrl),
        title: actionResult.session.title ? redactMemoryText(actionResult.session.title).slice(0, 500) : null,
        text: safeBrowserObservationText(actionResult.text), capturedAt: actionResult.frame?.capturedAt ?? actionResult.session.lastFrameAt };
    },
    goalTool: dotGoalService ? (sessionId, toolId, args) => dotGoalService.tool(sessionId, toolId, args) : undefined,
    computerBrowser: dotComputerService ? (session, owner, args) => dotComputerService.browser(session, owner, args) : undefined,
    delegate: dotDelegationService ? (session, owner, args) => dotDelegationService.delegate(session, owner, args) : undefined, designRequest: designService && dotDesignRequest(designService), videoRequest: videoService && dotVideoRequest(videoService),
    memoryTool: dotMemoryService ? (session, owner, toolId, args) => dotMemoryService.tool(session, owner, toolId, args) : undefined,
    memoryScope: dotMemoryService ? (owner, dotId, memoryId) => dotMemoryService.scope(owner, dotId, memoryId) : undefined,
    publishDeliverable: dotDeliverablesService ? (owner, dotId, input) => dotDeliverablesService.publish(owner, dotId,
      { path: input.path, roomId: input.roomId }, "DOT", null, input.expectedSha256) : undefined,
    deliverableFingerprint: dotDeliverablesService ? (owner, dotId, path) => dotDeliverablesService.fingerprint(owner, dotId, path) : undefined,
    connectorTool: connectorService ? (owner, toolId, args) => connectorService.tool(owner, toolId, args) : undefined,
    confirmExternalActions: async (owner) => dotHomeRepository ? (await dotHomeRepository.settings(owner)).confirmExternalActions : true,
    scheduleTool: dotScheduleService ? (session, owner, args) => dotScheduleService.tool(session, owner, args) : undefined,
    decideSchedule: dotScheduleService ? async (owner, dotId, scheduleId, decision) => {
      const schedule = await dotScheduleService.control(owner, dotId, scheduleId, { action: decision === "APPROVE" ? "CONFIRM" : "CANCEL" });
      return { status: schedule.status, nextRunAt: schedule.nextRunAt };
    } : undefined,
    evaluationSession: dotEvalsRepository ? (sessionId) => dotEvalsRepository.isRunningSession(sessionId) : undefined,
    channelTool: dotChannelService ? async (session, owner, toolId, args) => {
      try { return await dotChannelService.toolSend(session, owner, toolId, args); }
      catch (error) { return { status: "BLOCKED" as const, statusReason: `Sending failed: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}` }; }
    } : undefined,
    continueAfterApproval: async ({ sessionId, paneId, ownerUserId, content, requestKey }) => {
      const pane = await getPaneById(store, paneId);
      const active = await store.getActiveSpaceAgentSession(pane.id);
      if (active?.sessionId !== sessionId) return false;
      await spaceAgentAdapter.sendMessage({ pane, sessionId, content, operatorUserId: ownerUserId, clientRequestId: requestKey,
        traceId: makeSpaceId("trace") });
      return true;
    },
    audit: (request, action, roomId, metadata) => recordAudit(store, request, { action, targetType: "room", targetId: roomId, metadata })
  } : null, {
    routeOptions: defaultRouteRateLimitOptions,
    authenticatedOwner: async request => {
      if (!request.user || !verifySession(request.cookies[cookieName], auth.sessionSecret)) {
        throw new GitControlError("UNAUTHENTICATED", "Sign in to use Dots.", 401);
      }
      return (await store.upsertUser(request.user)).id;
    }
  });
}
