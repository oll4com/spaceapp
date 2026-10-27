import type {} from "./request-context.js";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import {
  spaceAgentBrowserActionBridgeRequestSchema, spaceAgentBrowserActionBridgeResponseSchema,
  spaceAgentRoomActionBridgeRequestSchema, spaceAgentRoomActionBridgeResponseSchema
} from "@space/contracts";
import { redactMemoryText, SpaceFeatureDisabledError, SpaceNotFoundError, type SpaceStore } from "@space/runtime";
import { BrowserControlHeldError } from "./browser-errors.js";
import type { BrowserSessionManagerWithHostHealth } from "./browser-host-proxy.js";
import {
  safeBrowserActionRequestForResponse, safeBrowserObservationText, safeBrowserObservationUrl
} from "./browser-observation.js";
import type { CliRuntimeVisibilityPolicy } from "./cli-runtime-visibility.js";
import type { SpaceApiConfig } from "./config.js";
import { assertAgentPaneCompatible, assertBrowserPaneCompatible, getPaneById } from "./pane-guards.js";
import { recordAudit } from "./request-audit.js";
import { assertVaultBrowserActionAllowed, type VaultProtection } from "./vault/protection.js";
import type { RoomActionExecutor } from "./room-actions.js";
import { parseBody } from "./route-parsing.js";

/**
 * Internal Space Agent bridges for browser actions and room actions; the parent retains internal-token
 * authentication, errors and rate limits.
 */
export function registerInternalAgentActionRoutes(app: FastifyInstance, options: {
  config: SpaceApiConfig;
  store: SpaceStore;
  browserSessionManager: BrowserSessionManagerWithHostHealth;
  cliRuntimeVisibility: CliRuntimeVisibilityPolicy;
  roomActionExecutor: RoomActionExecutor;
  vaultProtection?: Pick<VaultProtection, "ownerOf" | "release">;
  routeOptions: Pick<RouteShorthandOptions, "config">;
}) {
  const { config, store, browserSessionManager, cliRuntimeVisibility, roomActionExecutor, vaultProtection,
    routeOptions: defaultRouteRateLimitOptions } = options;
  app.post("/api/internal/agent/browser-actions", defaultRouteRateLimitOptions, async (request) => {
    await cliRuntimeVisibility.assertEnabled("cli:codex");
    if (!config.browserToolBridgeEnabled) {
      throw new SpaceFeatureDisabledError(
        "BROWSER_TOOL_BRIDGE_DISABLED",
        "Space agent browser tool bridge is disabled. Set SPACE_BROWSER_TOOL_BRIDGE_ENABLED=true after configuring internal API auth."
      );
    }
    const input = parseBody(spaceAgentBrowserActionBridgeRequestSchema, request.body ?? {});
    const agentPane = await getPaneById(store, input.agentPaneId);
    assertAgentPaneCompatible(agentPane);
    if (agentPane.roomId !== input.roomId) {
      throw new SpaceNotFoundError(`Agent pane ${agentPane.id} was not found in room ${input.roomId}.`);
    }
    const agentSession = await store.getSpaceAgentSession(input.agentSessionId);
    if (!agentSession || agentSession.roomId !== input.roomId || agentSession.paneId !== input.agentPaneId || !agentSession.isActive) {
      throw new SpaceNotFoundError(`Space agent session ${input.agentSessionId} was not found in room ${input.roomId}.`);
    }
    if (input.roomAgentMissionId) {
      const mission = await store.getRoomAgentMission(input.roomId, input.roomAgentMissionId);
      if (!mission || mission.sessionId !== input.agentSessionId || mission.status !== "RUNNING") {
        const statusReason = redactMemoryText(
          mission?.statusReason ?? "Room Agent mission is no longer available."
        ).slice(0, 500);
        await recordAudit(store, request, {
          action: "room.agent.browser_actions.blocked",
          targetType: "room",
          targetId: input.roomId,
          metadata: {
            missionId: input.roomAgentMissionId,
            agentSessionId: input.agentSessionId,
            reason: mission ? `mission_${mission.status.toLowerCase()}` : "mission_not_found"
          }
        });
        return spaceAgentBrowserActionBridgeResponseSchema.parse({
          results: input.actions.map((actionRequest) => ({
            request: safeBrowserActionRequestForResponse(actionRequest),
            status: "BLOCKED",
            statusReason,
            observation: null
          }))
        });
      }
    }

    const storedSelectedToolIds = new Set(agentSession.selectedToolIds ?? []);
    const selectedToolIds = new Set(input.selectedToolIds.filter((toolId) => storedSelectedToolIds.has(toolId)));
    const results = [];
    for (const actionRequest of input.actions) {
      if (!selectedToolIds.has(actionRequest.toolId)) {
        const blocked = {
          request: safeBrowserActionRequestForResponse(actionRequest),
          status: "BLOCKED" as const,
          statusReason: `Browser tool ${actionRequest.toolId} is not selected for this agent pane.`,
          observation: null
        };
        results.push(blocked);
        await recordAudit(store, request, {
          action: "pane.browser.agent_action.blocked",
          targetType: "pane",
          targetId: input.agentPaneId,
          metadata: {
            roomId: input.roomId,
            agentSessionId: input.agentSessionId,
            targetPaneId: actionRequest.targetPaneId,
            actionType: actionRequest.action.type,
            reason: "tool_not_selected"
          }
        });
        continue;
      }

      try {
        const browserPane = await getPaneById(store, actionRequest.targetPaneId);
        assertBrowserPaneCompatible(browserPane);
        if (browserPane.roomId !== input.roomId) {
          throw new SpaceNotFoundError(`Browser pane ${browserPane.id} was not found in room ${input.roomId}.`);
        }
        if (vaultProtection) await assertVaultBrowserActionAllowed(vaultProtection, browserPane.id, actionRequest.action.type);
        const actionResult = await browserSessionManager.action(
          browserPane,
          actionRequest.action,
          request.requestIdForSpace,
          { holderType: "AGENT", holderId: input.agentSessionId }
        );
        const observation = {
          sessionId: actionResult.session.sessionId,
          paneId: actionResult.session.paneId,
          roomId: actionResult.session.roomId,
          actionType: actionRequest.action.type,
          viewport: actionResult.session.viewport,
          currentUrl: safeBrowserObservationUrl(actionResult.session.currentUrl),
          title: actionResult.session.title ? redactMemoryText(actionResult.session.title).slice(0, 500) : null,
          text: safeBrowserObservationText(actionResult.text),
          capturedAt: actionResult.frame?.capturedAt ?? actionResult.session.lastFrameAt
        };
        results.push({
          request: safeBrowserActionRequestForResponse(actionRequest),
          status: "EXECUTED" as const,
          statusReason: "Browser action executed through Space mediation.",
          observation
        });
        await recordAudit(store, request, {
          action: "pane.browser.agent_action.executed",
          targetType: "pane",
          targetId: browserPane.id,
          metadata: {
            roomId: input.roomId,
            agentPaneId: input.agentPaneId,
            agentSessionId: input.agentSessionId,
            sessionId: actionResult.session.sessionId,
            actionType: actionRequest.action.type
          }
        });
      } catch (error) {
        if (error instanceof BrowserControlHeldError) throw error;
        const message = error instanceof Error ? error.message : "Browser action failed.";
        results.push({
          request: safeBrowserActionRequestForResponse(actionRequest),
          status: "FAILED" as const,
          statusReason: redactMemoryText(message).slice(0, 500),
          observation: null
        });
        await recordAudit(store, request, {
          action: "pane.browser.agent_action.failed",
          targetType: "pane",
          targetId: input.agentPaneId,
          metadata: {
            roomId: input.roomId,
            agentSessionId: input.agentSessionId,
            targetPaneId: actionRequest.targetPaneId,
            actionType: actionRequest.action.type
          }
        });
      }
    }

    return spaceAgentBrowserActionBridgeResponseSchema.parse({ results });
  });
  app.post("/api/internal/agent/room-actions", defaultRouteRateLimitOptions, async (request) => {
    const input = parseBody(spaceAgentRoomActionBridgeRequestSchema, request.body ?? {});
    const roomAgentPane = await store.getOrCreateRoomAgentPane(input.roomId, request.requestIdForSpace);
    if (roomAgentPane.id !== input.agentPaneId) {
      throw new SpaceNotFoundError(`Room Agent pane ${input.agentPaneId} was not found in room ${input.roomId}.`);
    }
    const agentSession = await store.getSpaceAgentSession(input.agentSessionId);
    if (!agentSession || agentSession.roomId !== input.roomId || agentSession.paneId !== roomAgentPane.id || !agentSession.isActive) {
      throw new SpaceNotFoundError(`Room Agent session ${input.agentSessionId} was not found in room ${input.roomId}.`);
    }
    const storedSelectedToolIds = new Set(agentSession.selectedToolIds ?? []);
    const requestedSelectedToolIds = new Set(input.selectedToolIds.filter((toolId) => storedSelectedToolIds.has(toolId)));
    if (input.actions.some((action) => !requestedSelectedToolIds.has(action.toolId))) {
      return spaceAgentRoomActionBridgeResponseSchema.parse({
        id: "space-agent-room-action-bridge",
        results: input.actions.map((action) => ({
          request: action,
          status: "BLOCKED",
          statusReason: `Room tool ${action.toolId} is not selected for this Room Agent.`,
          paneId: null,
          missionId: input.missionId,
          evidence: {}
        }))
      });
    }
    // The worker calls this route with its own HTTP request; link it to the
    // originating Space request id (input.requestId) for trace lookups.
    request.log.info(
      { event: "room_action.bridge", parentTraceId: input.requestId ?? null, missionId: input.missionId, actionCount: input.actions.length },
      "internal room action request"
    );
    const result = await roomActionExecutor.execute(input, request.requestIdForSpace);
    await recordAudit(store, request, {
      action: "room.agent.actions",
      targetType: "room",
      targetId: input.roomId,
      metadata: {
        parentTraceId: input.requestId ?? null,
        missionId: input.missionId,
        agentSessionId: input.agentSessionId,
        actionTypes: input.actions.map((action) => action.action.type),
        statuses: result.results.map((entry) => entry.status)
      }
    });
    return result;
  });
}
