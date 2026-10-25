import {
  buildCodexAppServerTurnWorkflowId,
  dotGatewayFunctionNames,
  dotNativeActionRisk,
  needsDotApproval,
  dotToolCallInputSchema,
  dotToolDescribeInputSchema,
  dotToolSearchInputSchema,
  type DotToolEntry,
  type DotToolInvocationStatus,
  type DummyTurnInput
} from "@space/contracts";
import type { CodexAppServerDynamicToolSpec, CodexAppServerJsonRpcMessage } from "@space/codex-app-server";
import type { DotsRepository } from "@space/db";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redactMemoryText, type SpaceStore } from "@space/runtime";
import type { CodexAppServerTurnActivityConfig } from "./activities.js";
import { executeChatActionBridge } from "./chat-action-bridge.js";
import { executeClipboardActionBridge } from "./clipboard-action-bridge.js";
import { executeMemoryActionBridge } from "./memory-action-bridge.js";
import type { CanonicalMemoryBridge } from "@space/runtime";
import { executeSkillActionBridge } from "./skill-action-bridge.js";
import { executeTaskActionBridge } from "./task-action-bridge.js";

/**
 * Native tool calls for gateway-enabled Dot threads (Space Dots Stage 3).
 *
 * Codex calls these client-side functions during the turn. Space-native tools
 * run here through the existing bridges; every other source runs in the API,
 * which re-authorizes the Dot, session, run and user on each call. Every call
 * is recorded once per Codex call id, so a retried call never runs twice.
 */
export const DOT_NATIVE_RUNTIME_ID = "native:dot";

const toolIdProperty = { type: "string", description: "Catalog tool id, for example space.inspect or resource.panes.open." };
export function dotGatewayDynamicTools(): CodexAppServerDynamicToolSpec[] {
  return [
    { type: "function", name: dotGatewayFunctionNames.search,
      description: "Search the Space tool catalog (Space control, room resources, memory, clipboard, tasks, shared chat, skills, browser and MCP tools). Returns ids, risk and availability without schemas.",
      inputSchema: { type: "object", properties: {
        query: { type: "string", maxLength: 200, description: "Keywords, for example 'open pane', 'memory', 'browser'." },
        source: { type: "string", enum: ["SPACE_CONTROL", "SPACE_RESOURCE", "SPACE_NATIVE", "SPACE_GOAL", "SPACE_SCHEDULE", "SPACE_COMPUTER", "SPACE_MEMORY", "CONNECTOR", "BROWSER", "MCP", "INSTALLED_MCP"] },
        includeUnavailable: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 50 }
      }, additionalProperties: false } },
    { type: "function", name: dotGatewayFunctionNames.describe,
      description: "Load one Space tool's full input schema and usage notes before calling it.",
      inputSchema: { type: "object", properties: { toolId: toolIdProperty }, required: ["toolId"], additionalProperties: false } },
    { type: "function", name: dotGatewayFunctionNames.call,
      description: "Call one Space tool with arguments matching its schema. Results are real data with a recorded receipt; BLOCKED or FAILED results explain why.",
      inputSchema: { type: "object", properties: { toolId: toolIdProperty,
        arguments: { type: "object", additionalProperties: true, description: "Arguments for the tool's input schema." } },
      required: ["toolId"], additionalProperties: false } }
  ];
}

/**
 * Codex thread overrides for every native Chat turn. The dispatcher, and shell
 * commands the agent starts (for example `space-capability`), see a native
 * runtime identity, so routing denies protected servers (tests, deploy,
 * unattributed Space Control) to Native agents. This is defense in depth: in
 * full-access permission mode the agent still has the owner's shell.
 */
export function nativeChatThreadConfig(dispatcherPath: string | null = existsSync(defaultDispatcherPath) ? defaultDispatcherPath : null,
  options: { writableRoots?: readonly string[]; proactive?: boolean; codexConfigToml?: string } = {}): Record<string, unknown> {
  const dispatcherOverrides = (key: string) => ({
    // A complete definition: valid whether or not the user's Codex config declares the dispatcher.
    [`mcp_servers.${key}.command`]: "/usr/bin/node",
    [`mcp_servers.${key}.args`]: [dispatcherPath],
    [`mcp_servers.${key}.env.SPACE_AGENT_RUNTIME_ID`]: DOT_NATIVE_RUNTIME_ID,
    // Proactive work may discover servers and skills, but not call installed MCP tools.
    ...(options.proactive ? { [`mcp_servers.${key}.enabled_tools`]: [...dispatcherReadTools] } : {})
  });
  return {
    ...(dispatcherPath ? Object.assign({}, ...codexDispatcherKeys(options.codexConfigToml).map(dispatcherOverrides)) : {}),
    // The Dot's private workspace stays writable even when the project is the working directory.
    ...(options.writableRoots?.length ? { "sandbox_workspace_write.writable_roots": [...options.writableRoots] } : {}),
    "shell_environment_policy.set.SPACE_AGENT_RUNTIME_ID": DOT_NATIVE_RUNTIME_ID
  };
}
// Space tools start with "space" (2026-10-13); a dispatcher from before the rename lists the old names.
/**
 * The dispatcher keys the user's Codex config declares (space_dispatcher, or mcp_dispatcher from
 * before the 2026-10-13 rename). The thread overrides must restrict every declared one: an
 * unrestricted second dispatcher would bypass the Native agent checks.
 */
function codexDispatcherKeys(configToml = readCodexConfig()): string[] {
  const declared = ["space_dispatcher", "mcp_dispatcher"].filter((key) =>
    new RegExp(`^\\[mcp_servers\\.${key}(?:\\.|\\])`, "m").test(configToml));
  return declared.length ? declared : ["space_dispatcher"];
}
function readCodexConfig(): string {
  try { return readFileSync(join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml"), "utf8"); }
  catch { return ""; }
}
const dispatcherReadTools = [
  "space_list_mcp_servers", "space_mcp_server_info", "space_list_skills", "space_get_skill",
  "list_mcp_servers", "mcp_server_info", "list_skills", "get_skill"
] as const;
export const DOT_PROACTIVE_BLOCK_REASON = "This is proactive work you proposed, so it is read-only. Report what you found and ask the user before changing anything.";
const defaultDispatcherPath = "/opt/spaceapp/bin/space-mcp-dispatcher.mjs";

interface GatewayOutcome { status: Exclude<DotToolInvocationStatus, "RUNNING">; statusReason: string | null; result?: unknown }
export interface DotToolCallContext {
  turnInput: DummyTurnInput;
  config: Pick<CodexAppServerTurnActivityConfig, "internalApiBaseUrl" | "internalApiToken">;
  store: SpaceStore;
  repository: Pick<DotsRepository, "startToolInvocation" | "finishToolInvocation"> & Partial<Pick<DotsRepository, "unresolvedToolCall" | "consumeApprovedNativeCall">>;
  canonicalMemory?: CanonicalMemoryBridge;
  fetchImpl?: typeof fetch;
}
type DynamicToolResponse = { contentItems: Array<{ type: "inputText"; text: string }>; success: boolean };

function response(value: unknown, success: boolean): DynamicToolResponse {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 1);
  return { contentItems: [{ type: "inputText", text: redactMemoryText(text).slice(0, 64_000) }], success };
}
function summary(outcome: GatewayOutcome): string {
  const text = outcome.statusReason ?? (outcome.result === undefined ? "" : JSON.stringify(outcome.result));
  return redactMemoryText(text).slice(0, 2000);
}

const nativeFences: Record<string, { fence: string; legacyToolId: string; type: string }> = {
  "memory.search": { fence: "space-memory-actions", legacyToolId: "memory:search", type: "search" },
  "memory.save": { fence: "space-memory-actions", legacyToolId: "memory:save", type: "save" },
  "clipboard.list": { fence: "space-clipboard-actions", legacyToolId: "clipboard:list", type: "list" },
  "clipboard.get": { fence: "space-clipboard-actions", legacyToolId: "clipboard:get", type: "get" },
  "clipboard.save": { fence: "space-clipboard-actions", legacyToolId: "clipboard:save", type: "save" },
  "clipboard.save_plan": { fence: "space-clipboard-actions", legacyToolId: "clipboard:save-plan", type: "save-plan" },
  "tasks.list": { fence: "space-task-actions", legacyToolId: "tasks:list", type: "list" },
  "tasks.get": { fence: "space-task-actions", legacyToolId: "tasks:get", type: "get" },
  "tasks.save": { fence: "space-task-actions", legacyToolId: "tasks:save", type: "save" },
  "tasks.update": { fence: "space-task-actions", legacyToolId: "tasks:update", type: "update" },
  "chat.send": { fence: "space-chat-actions", legacyToolId: "chat:send", type: "send" },
  "chat.read": { fence: "space-chat-actions", legacyToolId: "chat:read", type: "read" },
  "chat.react": { fence: "space-chat-actions", legacyToolId: "chat:react", type: "react" },
  "skills.list": { fence: "space-skill-actions", legacyToolId: "skills:list", type: "list" },
  "skills.read": { fence: "space-skill-actions", legacyToolId: "skills:read", type: "read" }
};

/** Runs one Space-native tool through its existing, validated bridge. */
export async function runNativeDotTool(context: DotToolCallContext, toolId: string, args: Record<string, unknown>): Promise<GatewayOutcome> {
  const native = nativeFences[toolId];
  if (!native) return { status: "BLOCKED", statusReason: "This native tool is not available." };
  const { type: _ignored, ...rest } = args;
  const block = `\`\`\`${native.fence}\n${JSON.stringify({ version: 1, actions: [{ toolId: native.legacyToolId, action: { ...rest, type: native.type } }] })}\n\`\`\``;
  // The gateway call itself is the authorization to use exactly this tool.
  const turnInput = { ...context.turnInput, selectedToolIds: [...new Set([...(context.turnInput.selectedToolIds ?? []), native.legacyToolId])].slice(-50) };
  const bridge = { turnInput, assistantContent: block, store: context.store };
  const execution = native.fence === "space-memory-actions" ? await executeMemoryActionBridge({ ...bridge, canonicalMemory: context.canonicalMemory })
    : native.fence === "space-clipboard-actions" ? await executeClipboardActionBridge(bridge)
    : native.fence === "space-task-actions" ? await executeTaskActionBridge(bridge)
    : native.fence === "space-chat-actions" ? await executeChatActionBridge(bridge)
    : await executeSkillActionBridge(bridge);
  const text = execution.toolMessageContent ?? "No result.";
  if (execution.executedActionCount > 0) return { status: "COMPLETED", statusReason: null, result: text };
  return { status: /\bBLOCKED\b/.test(text) ? "BLOCKED" : "FAILED", statusReason: text.slice(0, 1000) };
}

async function internalApi(context: DotToolCallContext, path: "catalog" | "call", body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!context.config.internalApiToken) return { status: 503, body: { error: { message: "Space tools require internal API authentication." } } };
  const response = await (context.fetchImpl ?? fetch)(`${context.config.internalApiBaseUrl.replace(/\/+$/, "")}/api/internal/dots/tools/${path}`, {
    method: "POST", headers: { "content-type": "application/json", "x-space-internal-token": context.config.internalApiToken },
    body: JSON.stringify(body), signal: AbortSignal.timeout(path === "call" ? 20 * 60_000 : 30_000)
  });
  const parsed = await response.json().catch(() => ({})) as Record<string, unknown>;
  return { status: response.status, body: parsed };
}
function apiError(body: Record<string, unknown>, fallback: string): string {
  const message = (body.error as { message?: unknown } | undefined)?.message;
  return typeof message === "string" ? message.slice(0, 500) : fallback;
}

export const DOT_UNKNOWN_OUTCOME_PREFIX = "Outcome unknown:";
export const DOT_RECONCILE_PREFIX = "Reconcile first:";

export function dotGatewayIdentity(turnInput: DummyTurnInput) {
  if (!turnInput.agentSessionId || !turnInput.operatorUserId || !turnInput.dotId) return null;
  return { roomId: turnInput.roomId, paneId: turnInput.paneId, agentSessionId: turnInput.agentSessionId,
    workflowId: buildCodexAppServerTurnWorkflowId(turnInput), operatorUserId: turnInput.operatorUserId, dotId: turnInput.dotId };
}

/** Handles one Codex `item/tool/call` request; never throws, so the turn survives tool failures. */
export async function handleDotToolCall(context: DotToolCallContext, request: CodexAppServerJsonRpcMessage): Promise<DynamicToolResponse> {
  const params = (request.params ?? {}) as { tool?: unknown; callId?: unknown; arguments?: unknown };
  const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments as Record<string, unknown> : {};
  const identity = dotGatewayIdentity(context.turnInput);
  if (!identity) return response({ status: "BLOCKED", statusReason: "Space tools need an authenticated Dot session." }, false);
  try {
    if (params.tool === dotGatewayFunctionNames.search) {
      const search = dotToolSearchInputSchema.safeParse(args);
      if (!search.success) return response({ status: "FAILED", statusReason: "Invalid search arguments." }, false);
      const result = await internalApi(context, "catalog", { identity, search: search.data });
      if (result.status !== 200) return response({ status: "BLOCKED", statusReason: apiError(result.body, "The Space tool catalog is unavailable.") }, false);
      return response({ ...result.body, next: "Call space_describe_tool for a schema, then space_call_tool." }, true);
    }
    if (params.tool === dotGatewayFunctionNames.describe) {
      const describe = dotToolDescribeInputSchema.safeParse(args);
      if (!describe.success) return response({ status: "FAILED", statusReason: "toolId must be a catalog tool id." }, false);
      const result = await internalApi(context, "catalog", { identity, describe: describe.data });
      if (result.status !== 200) return response({ status: "BLOCKED", statusReason: apiError(result.body, "Unknown tool. Use space_search_tools.") }, false);
      return response(result.body.tool, true);
    }
    if (params.tool !== dotGatewayFunctionNames.call) return response({ status: "FAILED", statusReason: "Unknown Space function." }, false);
    const call = dotToolCallInputSchema.safeParse(args);
    if (!call.success) return response({ status: "FAILED", statusReason: "space_call_tool needs a catalog toolId and an arguments object." }, false);
    const described = await internalApi(context, "catalog", { identity, describe: { toolId: call.data.toolId } });
    if (described.status !== 200) return response({ status: "BLOCKED", toolId: call.data.toolId, statusReason: apiError(described.body, "Unknown tool. Use space_search_tools.") }, false);
    const entry = described.body.tool as DotToolEntry;
    if (entry.availability !== "AVAILABLE") {
      return response({ status: "BLOCKED", toolId: entry.id, statusReason: entry.statusReason ?? `Tool is ${entry.availability.toLowerCase()}.` }, false);
    }
    if (context.turnInput.dotWorkMode === "PROACTIVE" && (entry.risk !== "READ" || entry.source === "MCP" || entry.source === "INSTALLED_MCP")) {
      return response({ status: "BLOCKED", toolId: entry.id, statusReason: DOT_PROACTIVE_BLOCK_REASON }, false);
    }
    const callId = typeof params.callId === "string" && params.callId ? params.callId.slice(0, 200) : null;
    // Reconcile before repeating an action whose earlier identical attempt has an unknown outcome.
    const unresolved = entry.risk !== "READ" && context.repository.unresolvedToolCall
      ? await context.repository.unresolvedToolCall(identity.agentSessionId, entry.id, call.data.arguments).catch(() => null) : null;
    const started = await context.repository.startToolInvocation({ dotId: identity.dotId, ownerUserId: identity.operatorUserId,
      roomId: identity.roomId, sessionId: identity.agentSessionId, runId: context.turnInput.agentRunId ?? null, callId,
      toolId: entry.id, source: entry.source, risk: entry.risk, arguments: call.data.arguments });
    if (!started.created) {
      // Reconcile instead of repeating: the same Codex call already ran (or its outcome is unknown).
      return response(started.running
        ? { status: "UNKNOWN", toolId: entry.id, statusReason: "This exact call was already started and its outcome is unknown. Inspect the current state before retrying." }
        : { status: started.invocation.status, toolId: entry.id, statusReason: started.invocation.statusReason, result: started.invocation.resultSummary,
          note: "This exact call was already executed; it was not repeated." }, started.invocation.status === "COMPLETED");
    }
    let outcome: GatewayOutcome;
    if (unresolved) {
      outcome = { status: "BLOCKED", statusReason: unresolved.state === "AWAITING_APPROVAL"
        ? `${DOT_RECONCILE_PREFIX} an identical ${entry.id} call is already waiting for the user's approval. Do not request it again.`
        : `${DOT_RECONCILE_PREFIX} an identical ${entry.id} call started at ${unresolved.startedAt} ${unresolved.state === "RUNNING" ? "may still be running" : "has an unknown outcome"}. `
          + "Check whether it already took effect before repeating it. If it did not, call it again and it will run." };
      await context.repository.finishToolInvocation(started.invocation.invocationId, { status: outcome.status,
        statusReason: outcome.statusReason, resultSummary: summary(outcome) }).catch(() => null);
      return response({ status: "UNKNOWN", toolId: entry.id, statusReason: outcome.statusReason, receipt: started.invocation.invocationId }, false);
    }
    try {
      // Native tools run here; one that needs the owner's approval runs only on an unused approval of this exact call.
      const nativeNeedsApproval = entry.source === "SPACE_NATIVE"
        && needsDotApproval(dotNativeActionRisk(entry.id, entry.risk), context.turnInput.permissionMode);
      const approvedGrant = nativeNeedsApproval && context.repository.consumeApprovedNativeCall
        ? await context.repository.consumeApprovedNativeCall(identity.agentSessionId, entry.id, call.data.arguments) : null;
      if (entry.source === "SPACE_NATIVE" && (!nativeNeedsApproval || approvedGrant)) outcome = await runNativeDotTool(context, entry.id, call.data.arguments);
      else {
        const result = await internalApi(context, "call", { identity, toolId: entry.id, arguments: call.data.arguments, callId,
          invocationId: started.invocation.invocationId });
        outcome = result.status === 200 ? result.body as unknown as GatewayOutcome
          : { status: "BLOCKED", statusReason: apiError(result.body, `Space tool call failed (HTTP ${result.status}).`) };
      }
    } catch (error) {
      // The request may have reached Space before the failure, so its effect is unknown.
      const message = redactMemoryText(error instanceof Error ? error.message : "Space tool call failed.").slice(0, 480);
      outcome = { status: "FAILED", statusReason: entry.source === "SPACE_NATIVE" ? message : `${DOT_UNKNOWN_OUTCOME_PREFIX} ${message}` };
    }
    await context.repository.finishToolInvocation(started.invocation.invocationId, { status: outcome.status,
      statusReason: outcome.statusReason, resultSummary: summary(outcome) }).catch(() => null);
    const next = outcome.status === "APPROVAL_REQUIRED" ? "Tell the user what you are waiting for and end your turn. Do not repeat the call; the decision arrives as the user's next message."
      : outcome.status === "PENDING" ? "The action is still running. Check it with space.operations before reporting completion." : undefined;
    return response({ status: outcome.status, toolId: entry.id, statusReason: outcome.statusReason, result: outcome.result,
      receipt: started.invocation.invocationId, ...(next ? { next } : {}) }, ["COMPLETED", "PENDING", "APPROVAL_REQUIRED"].includes(outcome.status));
  } catch (error) {
    return response({ status: "FAILED", statusReason: redactMemoryText(error instanceof Error ? error.message : "Space tool call failed.").slice(0, 500) }, false);
  }
}

/** Developer instructions for a gateway-enabled Dot thread. */
export function dotGatewayDeveloperInstructions(developerContext: string | undefined): string {
  return [
    developerContext?.trim(),
    "Space tools: use space_search_tools to find tools, space_describe_tool to load a schema, and space_call_tool to run one.",
    "Common ids: space.inspect (room state and content), space.execute (open/close/minimize/restore/rename/prompt panes, layouts, playback, configure models), space.pane_types, resource.panes.open, memory.search, memory.save, tasks.list, clipboard.list, computer.browser (your own browser), browser.navigate, goal.update, schedule.create, dot_memory.recall, dot_memory.remember, mail.search, calendar.list.",
    "Prefer your own shell and file abilities for local work. Use Space tools for Space state. Installed MCP servers are reachable through space_dispatcher.",
    "Never claim an action happened unless its result says COMPLETED. PENDING means still running. APPROVAL_REQUIRED means the user must approve it in Space: say what you are waiting for and stop.",
    "Destructive operations need the user's explicit request and confirm=true. Ask before acting when the request is ambiguous.",
    "For research, cite sources with links and dates. For code and data analysis, run the code or calculation and show the checks you ran.",
    "Before any purchase, booking, payment or form submission that commits the user, stop and ask the user to confirm in chat."
  ].filter(Boolean).join("\n\n");
}
