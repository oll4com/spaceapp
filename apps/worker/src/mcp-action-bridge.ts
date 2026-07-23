import {
  spaceAgentMcpActionBridgeRequestSchema,
  spaceAgentMcpActionBridgeResponseSchema,
  spaceAgentMcpActionEnvelopeSchema,
  type DummyTurnInput,
  type SpaceAgentMcpActionBridgeResponse,
  type SpaceAgentMcpActionEnvelope
} from "@space/contracts";
import { redactMemoryText } from "@space/runtime";
import type { CodexAppServerTurnActivityConfig } from "./activities.js";

const mcpActionBlockPattern = /```space-mcp-actions\s*([\s\S]*?)```/gi;

export interface ParsedMcpActionBlock {
  found: boolean;
  cleanedContent: string;
  envelope: SpaceAgentMcpActionEnvelope | null;
  error: string | null;
}

export interface McpActionBridgeExecution {
  cleanedContent: string;
  toolMessageContent: string | null;
  executedActionCount: number;
}

function cleanAssistantContent(content: string): string {
  return content.replace(mcpActionBlockPattern, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function parseMcpActionBlock(content: string): ParsedMcpActionBlock {
  const matches = Array.from(content.matchAll(mcpActionBlockPattern));
  const cleanedContent = cleanAssistantContent(content);
  if (!matches.length) {
    return { found: false, cleanedContent: content, envelope: null, error: null };
  }
  const rawJson = matches[0]?.[1]?.trim();
  if (!rawJson) {
    return { found: true, cleanedContent, envelope: null, error: "MCP action block is empty." };
  }
  try {
    const parsed = spaceAgentMcpActionEnvelopeSchema.parse(JSON.parse(rawJson));
    return { found: true, cleanedContent, envelope: parsed, error: null };
  } catch {
    return { found: true, cleanedContent, envelope: null, error: "MCP action block must be valid Space MCP action JSON." };
  }
}

function internalApiUrl(config: CodexAppServerTurnActivityConfig): string {
  return `${config.internalApiBaseUrl.replace(/\/+$/, "")}/api/internal/agent/mcp-actions`;
}

function blockedMessage(reason: string): string {
  return `Space MCP action bridge result:\n- BLOCKED reason=${redactMemoryText(reason).slice(0, 500)}`;
}

function failedMessage(reason: string): string {
  return `Space MCP action bridge result:\n- FAILED reason=${redactMemoryText(reason).slice(0, 500)}`;
}

function formatBridgeResponse(response: SpaceAgentMcpActionBridgeResponse): string {
  const lines = ["Space MCP action bridge result:"];
  for (const result of response.results) {
    const observation = result.observation;
    const details = [
      `${result.status} ${result.request.toolId}`,
      `action=${result.request.action.type}`,
      `reason=${result.statusReason}`
    ];
    if (observation?.code) details.push(`code=${observation.code}`);
    if (observation?.serverId) details.push(`server=${observation.serverId}`);
    if (observation?.toolName) details.push(`tool=${observation.toolName}`);
    if (observation?.policyDecision) details.push(`policy=${observation.policyDecision}`);
    if (observation?.policyReasonCode) details.push(`policyReason=${observation.policyReasonCode}`);
    if (observation?.artifactId) details.push(`artifact=${observation.artifactId}`);
    if (observation?.artifactStorageUri) details.push(`artifactUri=${observation.artifactStorageUri}`);
    lines.push(`- ${details.join("; ")}`);
  }
  return redactMemoryText(lines.join("\n")).slice(0, 12000);
}

export async function executeMcpActionBridge(input: {
  turnInput: DummyTurnInput;
  assistantContent: string;
  config: CodexAppServerTurnActivityConfig;
  fetchImpl?: typeof fetch;
}): Promise<McpActionBridgeExecution> {
  const parsed = parseMcpActionBlock(input.assistantContent);
  if (!parsed.found) {
    return { cleanedContent: input.assistantContent, toolMessageContent: null, executedActionCount: 0 };
  }
  const cleanedContent = parsed.cleanedContent || "Requested Space MCP actions.";
  if (parsed.error || !parsed.envelope) {
    return {
      cleanedContent,
      toolMessageContent: failedMessage(parsed.error ?? "MCP action request was invalid."),
      executedActionCount: 0
    };
  }
  if (!input.turnInput.agentSessionId) {
    return {
      cleanedContent,
      toolMessageContent: blockedMessage("MCP actions require a Space-native agent session."),
      executedActionCount: 0
    };
  }
  if (!input.config.mcpToolBridgeEnabled || !input.config.internalApiToken) {
    return {
      cleanedContent,
      toolMessageContent: blockedMessage(
        "MCP tool bridge is disabled until SPACE_MCP_TOOL_BRIDGE_ENABLED and SPACE_INTERNAL_API_TOKEN are configured."
      ),
      executedActionCount: 0
    };
  }

  const requestBody = spaceAgentMcpActionBridgeRequestSchema.parse({
    roomId: input.turnInput.roomId,
    agentPaneId: input.turnInput.paneId,
    agentSessionId: input.turnInput.agentSessionId,
    selectedToolIds: input.turnInput.selectedToolIds ?? [],
    actions: parsed.envelope.actions
  });

  try {
    const fetchImpl = input.fetchImpl ?? fetch;
    const response = await fetchImpl(internalApiUrl(input.config), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-space-internal-token": input.config.internalApiToken
      },
      body: JSON.stringify(requestBody)
    });
    if (!response.ok) {
      return {
        cleanedContent,
        toolMessageContent: failedMessage(`Internal MCP action API returned HTTP ${response.status}.`),
        executedActionCount: 0
      };
    }
    const body = spaceAgentMcpActionBridgeResponseSchema.parse(await response.json());
    return {
      cleanedContent,
      toolMessageContent: formatBridgeResponse(body),
      executedActionCount: body.results.filter((result) => result.status === "EXECUTED").length
    };
  } catch {
    return {
      cleanedContent,
      toolMessageContent: failedMessage("Internal MCP action API was unavailable or returned invalid data."),
      executedActionCount: 0
    };
  }
}
