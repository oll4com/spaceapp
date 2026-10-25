import type {} from "./request-context.js";
import { readFile } from "node:fs/promises";
import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from "fastify";
import type { z } from "zod";
import {
  createMcpToolExecutionInputSchema, type McpToolExecutionResult, spaceAgentMcpActionBridgeRequestSchema,
  spaceAgentMcpActionBridgeResponseSchema
} from "@space/contracts";
import { SpaceFeatureDisabledError, SpaceNotFoundError, type SpaceStore } from "@space/runtime";
import type { CliRuntimeVisibilityPolicy } from "./cli-runtime-visibility.js";
import type { SpaceApiConfig } from "./config.js";
import { assertAgentPaneCompatible, getPaneById } from "./pane-guards.js";
import { recordAudit } from "./request-audit.js";
import { parseBody } from "./route-parsing.js";

function buildAgentMcpObservation(result: McpToolExecutionResult) {
  return {
    executionId: result.executionId,
    status: result.status,
    code: result.code,
    message: result.message,
    toolId: result.toolId,
    serverId: result.serverId,
    toolName: result.toolName,
    approved: result.approved,
    policyDecision: result.policy?.decision ?? null,
    policyReasonCode: result.policy?.reasonCode ?? null,
    artifactId: result.artifact?.id ?? null,
    artifactKind: result.artifact?.kind ?? null,
    artifactMimeType: result.artifact?.mimeType ?? null,
    artifactStorageUri: result.artifact?.storageUri ?? null,
    durationMs: result.durationMs
  };
}

/**
 * MCP catalog, policy-checked tool execution and the internal agent MCP action bridge; the parent retains
 * authentication, CSRF, errors and rate limits.
 */
export function registerMcpRoutes(app: FastifyInstance, options: {
  config: SpaceApiConfig;
  store: SpaceStore;
  cliRuntimeVisibility: CliRuntimeVisibilityPolicy;
  routeOptions: Pick<RouteShorthandOptions, "config">;
  executeMcpToolWithPolicy: (input: z.infer<typeof createMcpToolExecutionInputSchema>, request: FastifyRequest) => Promise<McpToolExecutionResult>;
  /** Written by the inventory job (scripts/space-capability-usage.mjs); its `backends` describe the CLI dispatcher. */
  capabilityUsagePath?: string;
}) {
  const { config, store, cliRuntimeVisibility, routeOptions: defaultRouteRateLimitOptions, executeMcpToolWithPolicy } = options;
  const capabilityUsagePath = options.capabilityUsagePath ?? "/opt/spaceapp/var/inventory/capability-usage.json";
  // The gateway above serves Native chats; CLI agents reach their backends through the MCP dispatcher.
  const dispatcherBackends = async () => {
    const usage = await readFile(capabilityUsagePath, "utf8").then((raw) => JSON.parse(raw) as { generatedAt?: unknown; backends?: unknown }).catch(() => null);
    if (!Array.isArray(usage?.backends)) return null;
    const backends = usage.backends as Array<{ id?: unknown; stale?: unknown }>;
    return {
      backendCount: backends.length,
      staleIds: backends.filter((backend) => backend?.stale === true).map((backend) => String(backend.id)).slice(0, 50),
      checkedAt: typeof usage.generatedAt === "string" ? usage.generatedAt : null
    };
  };
  app.get("/api/mcp", defaultRouteRateLimitOptions, async () => {
    const capabilities = (await store.listCapabilities()).filter((item) => item.kind === "MCP_SERVER" || item.kind === "MCP_TOOL");
    const gateway = await store.getMcpGatewayStatus();
    const servers = await store.listMcpServers();
    const tools = await store.listMcpTools();
    return {
      data: capabilities,
      gateway,
      servers,
      tools,
      dispatcher: await dispatcherBackends(),
      pagination: { page: 1, pageSize: 100, totalItems: capabilities.length, totalPages: capabilities.length ? 1 : 0 }
    };
  });
  app.post("/api/mcp/tools/execute", defaultRouteRateLimitOptions, async (request) => {
    const input = parseBody(createMcpToolExecutionInputSchema, request.body);
    return executeMcpToolWithPolicy(input, request);
  });
  app.post("/api/internal/agent/mcp-actions", defaultRouteRateLimitOptions, async (request) => {
    await cliRuntimeVisibility.assertEnabled("cli:codex");
    if (!config.mcpToolBridgeEnabled) {
      throw new SpaceFeatureDisabledError(
        "MCP_TOOL_BRIDGE_DISABLED",
        "Space agent MCP tool bridge is disabled. Set SPACE_MCP_TOOL_BRIDGE_ENABLED=true after configuring internal API auth and MCP execution policy."
      );
    }
    const input = parseBody(spaceAgentMcpActionBridgeRequestSchema, request.body ?? {});
    const agentPane = await getPaneById(store, input.agentPaneId);
    assertAgentPaneCompatible(agentPane);
    if (agentPane.roomId !== input.roomId) {
      throw new SpaceNotFoundError(`Agent pane ${agentPane.id} was not found in room ${input.roomId}.`);
    }
    const agentSession = await store.getSpaceAgentSession(input.agentSessionId);
    if (!agentSession || agentSession.roomId !== input.roomId || agentSession.paneId !== input.agentPaneId || !agentSession.isActive) {
      throw new SpaceNotFoundError(`Space agent session ${input.agentSessionId} was not found in room ${input.roomId}.`);
    }

    const storedSelectedToolIds = new Set(agentSession.selectedToolIds ?? []);
    const selectedToolIds = new Set(input.selectedToolIds.filter((toolId) => storedSelectedToolIds.has(toolId)));
    const tools = await store.listMcpTools();
    const results = [];
    for (const actionRequest of input.actions) {
      const tool = tools.find((candidate) => candidate.id === actionRequest.toolId);
      const isSelected = selectedToolIds.has(actionRequest.toolId) || (tool ? selectedToolIds.has(tool.serverId) : false);
      if (!isSelected) {
        const blocked = {
          request: actionRequest,
          status: "BLOCKED" as const,
          statusReason: `MCP tool ${actionRequest.toolId} is not selected for this agent pane.`,
          observation: null
        };
        results.push(blocked);
        await recordAudit(store, request, {
          action: "mcp.agent_action.blocked",
          targetType: "mcp_tool",
          targetId: actionRequest.toolId,
          metadata: {
            roomId: input.roomId,
            agentPaneId: input.agentPaneId,
            agentSessionId: input.agentSessionId,
            reason: "tool_not_selected"
          }
        });
        continue;
      }

      const result = await executeMcpToolWithPolicy(
        {
          roomId: input.roomId,
          paneId: input.agentPaneId,
          toolId: actionRequest.toolId,
          arguments: actionRequest.action.arguments
        },
        request
      );
      results.push({
        request: actionRequest,
        status: result.status,
        statusReason: result.message,
        observation: buildAgentMcpObservation(result)
      });
    }

    return spaceAgentMcpActionBridgeResponseSchema.parse({
      id: "space-agent-mcp-action-bridge",
      results
    });
  });
}
