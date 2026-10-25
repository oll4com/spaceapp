import {
  spaceAgentBrowserActionBridgeRequestSchema,
  spaceAgentBrowserActionBridgeResponseSchema,
  spaceAgentBrowserActionEnvelopeSchema,
  spaceBrowserToolIdSchema,
  type DummyTurnInput,
  type SpaceAgentBrowserActionBridgeResponse,
  type SpaceAgentBrowserActionEnvelope,
  type SpaceBrowserToolId
} from "@space/contracts";
import { redactMemoryText } from "@space/runtime";
import type { CodexAppServerTurnActivityConfig } from "./activities.js";

const browserActionBlockPattern = /```space-browser-actions\s*([\s\S]*?)```/gi;

export interface ParsedBrowserActionBlock {
  found: boolean;
  cleanedContent: string;
  envelope: SpaceAgentBrowserActionEnvelope | null;
  error: string | null;
}

export interface BrowserActionBridgeExecution {
  cleanedContent: string;
  toolMessageContent: string | null;
  executedActionCount: number;
}

function cleanAssistantContent(content: string): string {
  return content.replace(browserActionBlockPattern, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function parseBrowserActionBlock(content: string): ParsedBrowserActionBlock {
  const matches = Array.from(content.matchAll(browserActionBlockPattern));
  const cleanedContent = cleanAssistantContent(content);
  if (!matches.length) {
    return { found: false, cleanedContent: content, envelope: null, error: null };
  }
  const rawJson = matches[0]?.[1]?.trim();
  if (!rawJson) {
    return { found: true, cleanedContent, envelope: null, error: "Browser action block is empty." };
  }
  try {
    const parsed = spaceAgentBrowserActionEnvelopeSchema.parse(JSON.parse(rawJson));
    return { found: true, cleanedContent, envelope: parsed, error: null };
  } catch {
    return { found: true, cleanedContent, envelope: null, error: "Browser action block must be valid Space browser action JSON." };
  }
}

function selectedBrowserToolIds(input: DummyTurnInput): SpaceBrowserToolId[] {
  return Array.from(
    new Set(
      (input.selectedToolIds ?? []).flatMap((toolId) => {
        const parsed = spaceBrowserToolIdSchema.safeParse(toolId);
        return parsed.success ? [parsed.data] : [];
      })
    )
  );
}

function internalApiUrl(config: CodexAppServerTurnActivityConfig): string {
  return `${config.internalApiBaseUrl.replace(/\/+$/, "")}/api/internal/agent/browser-actions`;
}

function formatBridgeResponse(response: SpaceAgentBrowserActionBridgeResponse): string {
  const lines = ["Space browser action bridge result:"];
  for (const result of response.results) {
    const observation = result.observation;
    const details = [
      `${result.status} ${result.request.toolId}`,
      `target=${result.request.targetPaneId}`,
      `action=${result.request.action.type}`,
      `reason=${result.statusReason}`
    ];
    if (observation?.currentUrl) details.push(`url=${observation.currentUrl}`);
    if (observation?.title) details.push(`title=${observation.title}`);
    if (observation?.text) details.push(`text=${observation.text.slice(0, 1200)}`);
    lines.push(`- ${details.join("; ")}`);
  }
  return redactMemoryText(lines.join("\n")).slice(0, 12000);
}

function blockedMessage(reason: string): string {
  return `Space browser action bridge result:\n- BLOCKED reason=${redactMemoryText(reason).slice(0, 500)}`;
}

export function formatBrowserActionBridgeBlockedMessage(reason: string): string {
  return blockedMessage(reason);
}

function failedMessage(reason: string): string {
  return `Space browser action bridge result:\n- FAILED reason=${redactMemoryText(reason).slice(0, 500)}`;
}

export async function executeBrowserActionBridge(input: {
  turnInput: DummyTurnInput;
  assistantContent: string;
  config: CodexAppServerTurnActivityConfig;
  fetchImpl?: typeof fetch;
}): Promise<BrowserActionBridgeExecution> {
  const parsed = parseBrowserActionBlock(input.assistantContent);
  if (!parsed.found) {
    return { cleanedContent: input.assistantContent, toolMessageContent: null, executedActionCount: 0 };
  }
  const cleanedContent = parsed.cleanedContent || "Requested Space browser actions.";
  if (parsed.error || !parsed.envelope) {
    return {
      cleanedContent,
      toolMessageContent: failedMessage(parsed.error ?? "Browser action request was invalid."),
      executedActionCount: 0
    };
  }
  if (!input.turnInput.agentSessionId) {
    return {
      cleanedContent,
      toolMessageContent: blockedMessage("Browser actions require a Space-native agent session."),
      executedActionCount: 0
    };
  }
  const selectedToolIds = selectedBrowserToolIds(input.turnInput);
  if (!selectedToolIds.length) {
    return {
      cleanedContent,
      toolMessageContent: blockedMessage("No browser tools are selected for this agent pane."),
      executedActionCount: 0
    };
  }
  if (!input.config.browserToolBridgeEnabled || !input.config.internalApiToken) {
    return {
      cleanedContent,
      toolMessageContent: blockedMessage(
        "Browser tool bridge is disabled until SPACE_BROWSER_TOOL_BRIDGE_ENABLED and SPACE_INTERNAL_API_TOKEN are configured."
      ),
      executedActionCount: 0
    };
  }

  const requestBody = spaceAgentBrowserActionBridgeRequestSchema.parse({
    roomId: input.turnInput.roomId,
    agentPaneId: input.turnInput.paneId,
    agentSessionId: input.turnInput.agentSessionId,
    roomAgentMissionId: input.turnInput.roomAgentMissionId,
    selectedToolIds,
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
        toolMessageContent: failedMessage(`Internal browser action API returned HTTP ${response.status}.`),
        executedActionCount: 0
      };
    }
    const body = spaceAgentBrowserActionBridgeResponseSchema.parse(await response.json());
    return {
      cleanedContent,
      toolMessageContent: formatBridgeResponse(body),
      executedActionCount: body.results.filter((result) => result.status === "EXECUTED").length
    };
  } catch {
    return {
      cleanedContent,
      toolMessageContent: failedMessage("Internal browser action API was unavailable or returned invalid data."),
      executedActionCount: 0
    };
  }
}
