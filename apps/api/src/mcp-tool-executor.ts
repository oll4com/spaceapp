import type {} from "./request-context.js";
import type { FastifyRequest } from "fastify";
import type { z } from "zod";
import { createMcpToolExecutionInputSchema, mcpToolExecutionResultSchema, type McpToolExecutionResult } from "@space/contracts";
import { decideMcpToolPolicy, makeSpaceId, nowIso, type SpaceEventBus, type SpaceStore } from "@space/runtime";
import type { SpaceApiConfig } from "./config.js";
import type { AuditRecorder } from "./request-audit.js";
import { executeMcpTool } from "./mcp.js";

function buildMcpToolExecutionResult(input: {
  executionId?: string;
  status: "BLOCKED" | "APPROVAL_REQUIRED" | "EXECUTED" | "FAILED";
  code: z.infer<typeof mcpToolExecutionResultSchema>["code"];
  message: string;
  toolId: string;
  serverId: string | null;
  toolName: string | null;
  startedAt: string;
  finishedAt?: string;
  policy: z.infer<typeof mcpToolExecutionResultSchema>["policy"];
  approved: boolean;
  artifact: z.infer<typeof mcpToolExecutionResultSchema>["artifact"];
}) {
  const finishedAt = input.finishedAt ?? nowIso();
  return mcpToolExecutionResultSchema.parse({
    id: "mcp-gateway",
    executionId: input.executionId ?? makeSpaceId("mcp_exec"),
    status: input.status,
    code: input.code,
    message: input.message,
    toolId: input.toolId,
    serverId: input.serverId,
    toolName: input.toolName,
    startedAt: input.startedAt,
    finishedAt,
    durationMs: Math.max(0, new Date(finishedAt).getTime() - new Date(input.startedAt).getTime()),
    policy: input.policy,
    approved: input.approved,
    artifact: input.artifact
  });
}

/** Policy, execution and result publication, independent of the HTTP composition root. */
export function createMcpToolExecutor(options: {
  store: Pick<SpaceStore, "getMcpGatewayStatus" | "listMcpServers" | "listMcpTools" | "createArtifact">;
  config: Pick<SpaceApiConfig, "version" | "mcpToolExecutionEnabled" | "mcpServerConfigs" |
    "mcpAllowlistedSchemaHashes" | "browserEvidenceArtifactRoot" | "mcpToolExecutionTimeoutMs">;
  eventBus: Pick<SpaceEventBus, "publish">;
  recordAudit: AuditRecorder;
}) {
  const { store, config, eventBus, recordAudit } = options;
  return async function executeMcpToolWithPolicy(input: z.infer<typeof createMcpToolExecutionInputSchema>, request: FastifyRequest): Promise<McpToolExecutionResult> {
    const startedAt = nowIso();
    const auditResult = async (result: McpToolExecutionResult) => {
      await recordAudit(request, {
        action: "mcp.tool.execute",
        targetType: "mcp_tool",
        targetId: input.toolId,
        metadata: {
          status: result.status,
          code: result.code,
          serverId: result.serverId,
          toolName: result.toolName,
          approved: result.approved,
          policyDecision: result.policy?.decision ?? null,
          policyReasonCode: result.policy?.reasonCode ?? null,
          artifactId: result.artifact?.id ?? null
        }
      });
      return result;
    };

    if (!config.mcpToolExecutionEnabled) {
      return auditResult(
        buildMcpToolExecutionResult({
          status: "BLOCKED",
          code: "GATEWAY_DISABLED",
          message: "SPACE_MCP_TOOL_EXECUTION_ENABLED=true is required before MCP tool execution can run.",
          toolId: input.toolId,
          serverId: null,
          toolName: null,
          startedAt,
          policy: null,
          approved: false,
          artifact: null
        })
      );
    }

    const [gateway, servers, tools] = await Promise.all([store.getMcpGatewayStatus(), store.listMcpServers(), store.listMcpTools()]);
    const tool = tools.find((candidate) => candidate.id === input.toolId);
    if (!tool) {
      return auditResult(
        buildMcpToolExecutionResult({
          status: "BLOCKED",
          code: "TOOL_NOT_FOUND",
          message: "MCP tool was not found in the verified Space registry.",
          toolId: input.toolId,
          serverId: null,
          toolName: null,
          startedAt,
          policy: null,
          approved: false,
          artifact: null
        })
      );
    }

    const server = servers.find((candidate) => candidate.id === tool.serverId);
    if (!server) {
      return auditResult(
        buildMcpToolExecutionResult({
          status: "BLOCKED",
          code: "SERVER_NOT_FOUND",
          message: "MCP server for the selected tool was not found.",
          toolId: input.toolId,
          serverId: tool.serverId,
          toolName: tool.name,
          startedAt,
          policy: null,
          approved: false,
          artifact: null
        })
      );
    }

    const policy = decideMcpToolPolicy({
      gatewayApprovalMode: "ALLOWLISTED",
      serverStatus: server.status,
      toolStatus: tool.status,
      riskLevel: tool.riskLevel,
      schemaHash: tool.schemaHash,
      toolApprovalRequired: tool.approvalRequired,
      allowlistedSchemaHashes: config.mcpAllowlistedSchemaHashes
    });
    if (policy.decision === "BLOCKED") {
      return auditResult(
        buildMcpToolExecutionResult({
          status: "BLOCKED",
          code: policy.reasonCode,
          message: "MCP tool execution was blocked by Space policy.",
          toolId: input.toolId,
          serverId: server.id,
          toolName: tool.name,
          startedAt,
          policy,
          approved: false,
          artifact: null
        })
      );
    }
    if (policy.decision === "REQUIRES_APPROVAL" && !input.approvalReason) {
      return auditResult(
        buildMcpToolExecutionResult({
          status: "APPROVAL_REQUIRED",
          code: policy.reasonCode,
          message: "MCP tool execution requires an operator approval reason.",
          toolId: input.toolId,
          serverId: server.id,
          toolName: tool.name,
          startedAt,
          policy,
          approved: false,
          artifact: null
        })
      );
    }

    const serverConfig = (config.mcpServerConfigs ?? []).find((candidate) => candidate.id === server.id && candidate.enabled);
    if (!serverConfig) {
      return auditResult(
        buildMcpToolExecutionResult({
          status: "BLOCKED",
          code: "SERVER_CONFIG_MISSING",
          message: "Enabled MCP server config is missing; execution remains blocked.",
          toolId: input.toolId,
          serverId: server.id,
          toolName: tool.name,
          startedAt,
          policy,
          approved: input.approvalReason !== undefined,
          artifact: null
        })
      );
    }
    if (server.transport !== "stdio" || serverConfig.transport !== "stdio") {
      return auditResult(
        buildMcpToolExecutionResult({
          status: "BLOCKED",
          code: "TRANSPORT_NOT_SUPPORTED",
          message: "Only stdio MCP tool execution is supported in this slice.",
          toolId: input.toolId,
          serverId: server.id,
          toolName: tool.name,
          startedAt,
          policy,
          approved: input.approvalReason !== undefined,
          artifact: null
        })
      );
    }

    try {
      const capture = await executeMcpTool(
        config,
        { gatewayStatus: gateway, server, tool },
        input,
        {
          artifactRoot: config.browserEvidenceArtifactRoot,
          timeoutMs: config.mcpToolExecutionTimeoutMs
        }
      );
      const artifactRecord = await store.createArtifact(
        {
          roomId: input.roomId ?? null,
          paneId: input.paneId ?? null,
          turnId: null,
          workflowId: null,
          ...capture.artifact
        },
        request.requestIdForSpace
      );
      eventBus.publish(artifactRecord.event);
      return auditResult(
        buildMcpToolExecutionResult({
          executionId: capture.executionId,
          status: capture.isError ? "FAILED" : "EXECUTED",
          code: capture.isError ? "TOOL_RETURNED_ERROR" : "TOOL_EXECUTION_OK",
          message: capture.isError ? "MCP tool returned an error result." : "MCP tool execution completed.",
          toolId: input.toolId,
          serverId: server.id,
          toolName: tool.name,
          startedAt: capture.startedAt,
          finishedAt: capture.finishedAt,
          policy,
          approved: input.approvalReason !== undefined,
          artifact: artifactRecord.artifact
        })
      );
    } catch {
      return auditResult(
        buildMcpToolExecutionResult({
          status: "FAILED",
          code: "EXECUTION_FAILED",
          message: "MCP tool execution failed without exposing process details.",
          toolId: input.toolId,
          serverId: server.id,
          toolName: tool.name,
          startedAt,
          policy,
          approved: input.approvalReason !== undefined,
          artifact: null
        })
      );
    }
  }

}
