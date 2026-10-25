import type {} from "./request-context.js";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import {
  agentPaneGoalInputSchema, agentPaneInterruptInputSchema, agentPaneSendMessageInputSchema,
  agentPaneSettingsInputSchema, createAgentPaneSessionInputSchema
} from "@space/contracts";
import { SpaceFeatureDisabledError, type SpaceStore } from "@space/runtime";
import type { CliRuntimeVisibilityPolicy } from "./cli-runtime-visibility.js";
import type { CodexHistoryAccessCoordinator } from "./codex-history-purge.js";
import { assertAgentPaneCompatible, getPaneById } from "./pane-guards.js";
import { recordAudit } from "./request-audit.js";
import { idParamSchema, parseBody, parseQuery } from "./route-parsing.js";
import type { SpaceAgentAdapter } from "./space-agent.js";

/**
 * Native agent (CHAT) pane session, messages, retry, interrupt, settings and goal; the parent retains
 * authentication, CSRF, errors and rate limits.
 */
export function registerAgentPaneRoutes(app: FastifyInstance, options: {
  store: SpaceStore;
  spaceAgentAdapter: SpaceAgentAdapter;
  cliRuntimeVisibility: CliRuntimeVisibilityPolicy;
  codexHistoryAccessCoordinator: CodexHistoryAccessCoordinator;
  routeOptions: Pick<RouteShorthandOptions, "config">;
}) {
  const { store, spaceAgentAdapter, cliRuntimeVisibility, codexHistoryAccessCoordinator,
    routeOptions: defaultRouteRateLimitOptions } = options;
  app.post("/api/panes/:id/agent-session", defaultRouteRateLimitOptions, async (request) => codexHistoryAccessCoordinator.withHistoryAttachment(async () => {
    await cliRuntimeVisibility.assertEnabled("cli:codex");
    const params = parseQuery(idParamSchema, request.params);
    const input = parseBody(createAgentPaneSessionInputSchema, request.body ?? {});
    if (input.dotId && (request.user?.automationScope || request.user?.proofScope === "READ_ONLY")) {
      throw new SpaceFeatureDisabledError("DOTS_SCOPE_FORBIDDEN", "An interactive user session is required.");
    }
    const pane = await getPaneById(store, params.id);
    assertAgentPaneCompatible(pane);
    return spaceAgentAdapter.createOrRestoreSession({
      pane,
      title: input.title,
      dotId: input.dotId,
      ownerUserId: request.user!.id,
      sessionId: input.sessionId,
      threadId: input.threadId,
      selectedModelConfigId: input.selectedModelConfigId,
      selectedToolIds: input.selectedToolIds
    });
  }));
  app.post("/api/panes/:id/agent/messages", defaultRouteRateLimitOptions, async (request) => {
    await cliRuntimeVisibility.assertEnabled("cli:codex");
    const params = parseQuery(idParamSchema, request.params);
    const input = parseBody(agentPaneSendMessageInputSchema, request.body);
    const pane = await getPaneById(store, params.id);
    assertAgentPaneCompatible(pane);
    const result = await spaceAgentAdapter.sendMessage({
      acceptance: input.acceptance,
      dotId: input.dotId,
      sessionId: input.sessionId,
      clientRequestId: input.clientRequestId,
      pane,
      content: input.content,
      operatorUserId: request.user!.id,
      selectedModelConfigId: input.selectedModelConfigId,
      selectedToolIds: input.selectedToolIds,
      artifactIds: input.artifactIds,
      traceId: request.requestIdForSpace
    });
    await recordAudit(store, request, {
      action: "pane.agent.message",
      targetType: "pane",
      targetId: pane.id,
      metadata: { roomId: pane.roomId, source: result.binding.source, sessionId: result.binding.sessionId }
    });
    return result.session;
  });
  app.post("/api/panes/:id/agent/prepare-retry", defaultRouteRateLimitOptions, async (request) => {
    const params = parseQuery(idParamSchema, request.params);
    const pane = await getPaneById(store, params.id);
    assertAgentPaneCompatible(pane);
    return spaceAgentAdapter.prepareRetry({ pane });
  });
  app.post("/api/panes/:id/agent/interrupt", defaultRouteRateLimitOptions, async (request) => {
    const params = parseQuery(idParamSchema, request.params);
    const input = parseBody(agentPaneInterruptInputSchema, request.body ?? {});
    const pane = await getPaneById(store, params.id);
    assertAgentPaneCompatible(pane);
    const result = await spaceAgentAdapter.interrupt({ pane, reason: input.reason });
    await recordAudit(store, request, {
      action: "pane.agent.interrupt",
      targetType: "pane",
      targetId: pane.id,
      metadata: { roomId: pane.roomId, source: result.binding.source, sessionId: result.binding.sessionId }
    });
    return result.session;
  });
  app.patch("/api/panes/:id/agent/settings", defaultRouteRateLimitOptions, async (request) => {
    await cliRuntimeVisibility.assertEnabled("cli:codex");
    const params = parseQuery(idParamSchema, request.params);
    const input = parseBody(agentPaneSettingsInputSchema, request.body);
    const pane = await getPaneById(store, params.id);
    assertAgentPaneCompatible(pane);
    const result = await spaceAgentAdapter.updateSettings({
      pane,
      title: input.title,
      selectedModelConfigId: input.selectedModelConfigId,
      selectedToolIds: input.selectedToolIds,
      permissionMode: input.permissionMode,
      collaborationMode: input.collaborationMode
    });
    await recordAudit(store, request, {
      action: "pane.agent.settings",
      targetType: "pane",
      targetId: pane.id,
      metadata: {
        roomId: pane.roomId,
        source: result.binding.source,
        ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode, inherited: input.permissionMode === null } : {}),
        ...(input.collaborationMode !== undefined ? { collaborationMode: input.collaborationMode } : {})
      }
    });
    return result.session;
  });
  app.put("/api/panes/:id/agent/goal", defaultRouteRateLimitOptions, async (request) => {
    await cliRuntimeVisibility.assertEnabled("cli:codex");
    const params = parseQuery(idParamSchema, request.params);
    const input = parseBody(agentPaneGoalInputSchema, request.body);
    const pane = await getPaneById(store, params.id);
    assertAgentPaneCompatible(pane);
    const result = await spaceAgentAdapter.setGoal({ pane, objective: input.objective });
    await recordAudit(store, request, {
      action: "pane.agent.goal.set",
      targetType: "pane",
      targetId: pane.id,
      metadata: {
        roomId: pane.roomId,
        source: result.binding.source,
        sessionId: result.binding.sessionId,
        threadId: result.session.threadId,
        goalStatus: result.session.goal?.status ?? null
      }
    });
    return result.session;
  });
  app.delete("/api/panes/:id/agent/goal", defaultRouteRateLimitOptions, async (request) => {
    await cliRuntimeVisibility.assertEnabled("cli:codex");
    const params = parseQuery(idParamSchema, request.params);
    const pane = await getPaneById(store, params.id);
    assertAgentPaneCompatible(pane);
    const result = await spaceAgentAdapter.clearGoal({ pane });
    await recordAudit(store, request, {
      action: "pane.agent.goal.clear",
      targetType: "pane",
      targetId: pane.id,
      metadata: {
        roomId: pane.roomId,
        source: result.binding.source,
        sessionId: result.binding.sessionId,
        threadId: result.session.threadId
      }
    });
    return result.session;
  });
}
