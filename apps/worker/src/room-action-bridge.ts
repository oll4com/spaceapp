import {
  spaceAgentRoomActionBridgeRequestSchema,
  spaceAgentRoomActionBridgeResponseSchema,
  spaceAgentRoomActionEnvelopeSchema,
  roomAgentRoomInventorySchema,
  spaceRoomToolIdSchema,
  type DummyTurnInput,
  type RoomAgentRoomInventory,
  type SpaceAgentRoomActionBridgeResponse,
  type SpaceAgentRoomActionEnvelope,
  type SpaceRoomToolId
} from "@space/contracts";
import { redactMemoryText } from "@space/runtime";
import { cancellationSignal } from "@temporalio/activity";
import { Agent, fetch as undiciFetch } from "undici";
import type { CodexAppServerTurnActivityConfig } from "./activities.js";

const roomActionBlockPattern = /```space-room-actions\s*([\s\S]*?)```/gi;
const roomActionBridgeTransportTimeoutMs = 24 * 60 * 60_000;
const roomActionBridgeDispatcher = new Agent({
  headersTimeout: roomActionBridgeTransportTimeoutMs,
  bodyTimeout: roomActionBridgeTransportTimeoutMs,
  pipelining: 0
});

function activeActivityCancellationSignal(): AbortSignal | undefined {
  try {
    return cancellationSignal();
  } catch {
    return undefined;
  }
}

export interface ParsedRoomActionBlock {
  found: boolean;
  cleanedContent: string;
  envelope: SpaceAgentRoomActionEnvelope | null;
  error: string | null;
}

export interface RoomActionBridgeExecution {
  cleanedContent: string;
  toolMessageContent: string | null;
  executedActionCount: number;
  authoritativeCompletion?: boolean;
  actionSignature?: string;
  inspectHasActiveWork?: boolean;
  roomInventory?: RoomAgentRoomInventory;
}

export class RetryableRoomActionBridgeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RetryableRoomActionBridgeError";
  }
}

export function isRetryableRoomActionBridgeError(error: unknown): error is RetryableRoomActionBridgeError {
  return error instanceof RetryableRoomActionBridgeError;
}

function cleanAssistantContent(content: string): string {
  return content.replace(roomActionBlockPattern, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function parseRoomActionBlock(content: string): ParsedRoomActionBlock {
  const matches = Array.from(content.matchAll(roomActionBlockPattern));
  const cleanedContent = cleanAssistantContent(content);
  if (!matches.length) return { found: false, cleanedContent: content, envelope: null, error: null };
  const rawJson = matches[0]?.[1]?.trim();
  if (!rawJson) return { found: true, cleanedContent, envelope: null, error: "Room action block is empty." };
  try {
    return {
      found: true,
      cleanedContent,
      envelope: spaceAgentRoomActionEnvelopeSchema.parse(JSON.parse(rawJson)),
      error: null
    };
  } catch {
    return {
      found: true,
      cleanedContent,
      envelope: null,
      error: "Room action block must be valid allowlisted Space room action JSON."
    };
  }
}

function selectedRoomToolIds(input: DummyTurnInput): SpaceRoomToolId[] {
  return Array.from(
    new Set(
      (input.selectedToolIds ?? []).flatMap((toolId) => {
        const parsed = spaceRoomToolIdSchema.safeParse(toolId);
        return parsed.success ? [parsed.data] : [];
      })
    )
  );
}

const ROOM_ACTION_TOOL_MESSAGE_MAX_CHARS = 12_000;

function unknownRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isActiveWorkStatus(value: unknown): boolean {
  return value === "RUNNING" || value === "QUEUED";
}

function inspectPaneHasActiveWork(value: unknown): boolean {
  const pane = unknownRecord(value);
  if (!pane || pane.isClosed === true) return false;
  if (isActiveWorkStatus(pane.status)) return true;
  if (pane.mode === "TERMINAL") return false;
  const chat = unknownRecord(pane.chat);
  const chatSession = unknownRecord(chat?.session);
  return isActiveWorkStatus(chat?.runStatus) || isActiveWorkStatus(chatSession?.status);
}

function evidenceHasActiveWork(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(evidenceHasActiveWork);
  const record = unknownRecord(value);
  if (!record) return false;
  if (Array.isArray(record.panes)) return record.panes.some(inspectPaneHasActiveWork);
  return Object.entries(record).some(([key, entry]) => {
    if (/status$/i.test(key) && isActiveWorkStatus(entry)) return true;
    return evidenceHasActiveWork(entry);
  });
}

function compactValue(value: unknown, fallback: string, maxChars = 200): string {
  const text = typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : fallback;
  return redactMemoryText(text.replace(/\s+/g, " ").trim()).slice(0, maxChars) || fallback;
}

function latestContentTail(items: unknown, maxChars: number): string {
  if (!Array.isArray(items) || maxChars < 1) return "none";
  let tail = "";
  for (let index = items.length - 1; index >= 0 && tail.length < maxChars; index -= 1) {
    const item = unknownRecord(items[index]);
    const content = item && typeof item.content === "string" ? item.content : "";
    if (!content) continue;
    tail = tail ? `${content}\n${tail}` : content;
  }
  return redactMemoryText(tail.replace(/\s+/g, " ").trim()).slice(-maxChars) || "none";
}

function inspectPaneSummary(pane: Record<string, unknown>, index: number, total: number): string {
  return [
    `pane ${index + 1}/${total}`,
    `id=${compactValue(pane.id, "unknown")}`,
    `title=${compactValue(pane.title, "untitled")}`,
    `mode=${compactValue(pane.mode, "unknown", 40)}`,
    `status=${compactValue(pane.status, "unknown", 40)}`,
    `closed=${compactValue(pane.isClosed, "unknown", 10)}`
  ].join("; ");
}

function inspectPaneDetail(pane: Record<string, unknown>, maxChars: number): string {
  if (maxChars < 1) return "";
  const mode = compactValue(pane.mode, "unknown", 40);
  if (mode === "TERMINAL") {
    const cli = unknownRecord(pane.cli);
    const session = unknownRecord(cli?.session);
    const prefix = redactMemoryText(
      `  cli status=${compactValue(session?.status, "unknown", 40)}; reason=${compactValue(session?.statusReason, "none", 180)}; transcript_tail=`
    );
    if (prefix.length >= maxChars) return prefix.slice(0, maxChars);
    return `${prefix}${latestContentTail(cli?.transcript, maxChars - prefix.length)}`;
  }
  if (mode === "CHAT") {
    const chat = unknownRecord(pane.chat);
    const session = unknownRecord(chat?.session);
    const messages = Array.isArray(chat?.messages) ? chat.messages : [];
    const latestMessage = messages.length ? unknownRecord(messages[messages.length - 1]) : null;
    const prefix = redactMemoryText(
      `  chat status=${compactValue(chat?.runStatus ?? session?.status, "unknown", 40)}; reason=${compactValue(chat?.statusReason, "none", 180)}; latest_role=${compactValue(latestMessage?.role, "none", 30)}; latest_status=${compactValue(latestMessage?.status, "unknown", 40)}; message_tail=`
    );
    if (prefix.length >= maxChars) return prefix.slice(0, maxChars);
    return `${prefix}${latestContentTail(messages.length ? [latestMessage] : [], maxChars - prefix.length)}`;
  }
  return "";
}

function inspectRoomInventory(response: SpaceAgentRoomActionBridgeResponse): RoomAgentRoomInventory | undefined {
  for (const result of response.results) {
    if (result.request.toolId !== "room:inspect") continue;
    const parsed = roomAgentRoomInventorySchema.safeParse(result.evidence.roomInventory);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

function formatRoomInventoryLines(inventory: RoomAgentRoomInventory | undefined): string[] {
  if (!inventory) return [];
  return [
    `Structured active plan inventory: pending=${inventory.pendingPlans}; ready=${inventory.readyPlans}; paused=${inventory.pausedPlans}; running=${inventory.runningPlans}`,
    ...inventory.plans.map((plan, index) => redactMemoryText(
      `plan ${index + 1}/${inventory.plans.length}; paneId=${plan.paneId}; paneTitle=${plan.paneTitle}; status=${plan.status}; title=${plan.title}; sessionId=${plan.sessionId}; threadId=${plan.threadId}`
    ))
  ];
}

function formatInspectResponse(response: SpaceAgentRoomActionBridgeResponse): string {
  const roomInventory = inspectRoomInventory(response);
  const resultLines = response.results.map((result) =>
    redactMemoryText(
      `- ${result.status} ${result.request.toolId}; pane=${result.paneId ?? "none"}; mission=${result.missionId ?? "none"}; reason=${result.statusReason}`
    )
  );
  const repeatedPanes = response.results.flatMap((result) => {
    if (result.request.toolId !== "room:inspect") return [];
    const evidencePanes = result.evidence.panes;
    return Array.isArray(evidencePanes)
      ? evidencePanes.flatMap((pane) => {
          const record = unknownRecord(pane);
          return record ? [record] : [];
        })
      : [];
  });
  const inspectMetadataLines = response.results.flatMap((result, index) => {
    if (result.request.toolId !== "room:inspect") return [];
    const metadata = Object.fromEntries(
      Object.entries(result.evidence).filter(([key]) => key !== "panes" && key !== "roomInventory")
    );
    return Object.keys(metadata).length
      ? [`inspect ${index + 1} evidence=${redactMemoryText(JSON.stringify(metadata)).slice(0, 1_000)}`]
      : [];
  });
  const panes: Array<Record<string, unknown>> = [];
  const paneIndexes = new Map<string, number>();
  for (const pane of repeatedPanes) {
    const paneId = typeof pane.id === "string" ? pane.id : `__unknown_${panes.length}`;
    const existingIndex = paneIndexes.get(paneId);
    if (existingIndex === undefined) {
      paneIndexes.set(paneId, panes.length);
      panes.push(pane);
    } else {
      panes[existingIndex] = pane;
    }
  }
  const openPanes = panes.filter((pane) => pane.isClosed !== true);
  const closedPaneCount = panes.length - openPanes.length;
  const summaryLines = openPanes.map((pane, index) => inspectPaneSummary(pane, index, openPanes.length));
  const base = [
    "Space room action bridge result:",
    ...resultLines,
    ...formatRoomInventoryLines(roomInventory),
    ...inspectMetadataLines,
    `inspect panes=${panes.length}; open=${openPanes.length}; closed=${closedPaneCount}`,
    ...summaryLines
  ].join("\n");
  if (!openPanes.length || base.length >= ROOM_ACTION_TOOL_MESSAGE_MAX_CHARS) {
    return redactMemoryText(base).slice(0, ROOM_ACTION_TOOL_MESSAGE_MAX_CHARS);
  }
  const remaining = ROOM_ACTION_TOOL_MESSAGE_MAX_CHARS - base.length;
  const perPaneBudget = Math.max(0, Math.floor((remaining - openPanes.length) / openPanes.length));
  const detailLines = openPanes.map((pane) => inspectPaneDetail(pane, perPaneBudget));
  return redactMemoryText([base, ...detailLines].join("\n")).slice(0, ROOM_ACTION_TOOL_MESSAGE_MAX_CHARS);
}

function formatResponse(response: SpaceAgentRoomActionBridgeResponse): string {
  if (response.results.some((result) => result.request.toolId === "room:inspect")) {
    return formatInspectResponse(response);
  }
  const lines = ["Space room action bridge result:"];
  for (const result of response.results) {
    lines.push(
      `- ${result.status} ${result.request.toolId}; pane=${result.paneId ?? "none"}; mission=${result.missionId ?? "none"}; reason=${result.statusReason}; evidence=${JSON.stringify(result.evidence).slice(0, 4000)}`
    );
  }
  return redactMemoryText(lines.join("\n")).slice(0, ROOM_ACTION_TOOL_MESSAGE_MAX_CHARS);
}

function bridgeMessage(status: "BLOCKED" | "FAILED", reason: string): string {
  return `Space room action bridge result:\n- ${status} reason=${redactMemoryText(reason).slice(0, 700)}`;
}

export async function executeRoomActionBridge(input: {
  turnInput: DummyTurnInput;
  assistantContent: string;
  config: CodexAppServerTurnActivityConfig;
  fetchImpl?: typeof fetch;
}): Promise<RoomActionBridgeExecution> {
  const parsed = parseRoomActionBlock(input.assistantContent);
  if (!parsed.found) return { cleanedContent: input.assistantContent, toolMessageContent: null, executedActionCount: 0 };
  const cleanedContent = parsed.cleanedContent || "Requested Space room actions.";
  if (parsed.error || !parsed.envelope) {
    return { cleanedContent, toolMessageContent: bridgeMessage("FAILED", parsed.error ?? "Invalid request."), executedActionCount: 0 };
  }
  if (!input.turnInput.agentSessionId || !input.turnInput.roomAgentMissionId) {
    return {
      cleanedContent,
      toolMessageContent: bridgeMessage("BLOCKED", "Room actions require a durable Room Agent mission."),
      executedActionCount: 0
    };
  }
  const selectedToolIds = selectedRoomToolIds(input.turnInput);
  if (!selectedToolIds.length) {
    return {
      cleanedContent,
      toolMessageContent: bridgeMessage("BLOCKED", "No room tools are selected for this agent."),
      executedActionCount: 0
    };
  }
  if (!input.config.internalApiToken) {
    return {
      cleanedContent,
      toolMessageContent: bridgeMessage("BLOCKED", "Room action bridge requires configured internal API authentication."),
      executedActionCount: 0
    };
  }
  const requestBody = spaceAgentRoomActionBridgeRequestSchema.parse({
    roomId: input.turnInput.roomId,
    missionId: input.turnInput.roomAgentMissionId,
    agentPaneId: input.turnInput.paneId,
    agentSessionId: input.turnInput.agentSessionId,
    selectedToolIds,
    actions: parsed.envelope.actions
  });
  let response: Pick<Response, "ok" | "status" | "json">;
  try {
    const url = `${input.config.internalApiBaseUrl.replace(/\/+$/, "")}/api/internal/agent/room-actions`;
    const headers = {
      "content-type": "application/json",
      "x-space-internal-token": input.config.internalApiToken
    };
    const body = JSON.stringify(requestBody);
    response = input.fetchImpl
      ? await input.fetchImpl(url, { method: "POST", headers, body })
      : await undiciFetch(url, {
          method: "POST",
          headers,
          body,
          dispatcher: roomActionBridgeDispatcher,
          signal: activeActivityCancellationSignal()
        });
  } catch (error) {
    throw new RetryableRoomActionBridgeError(
      "Internal room action API is temporarily unavailable; the durable activity must retry.",
      { cause: error }
    );
  }
  if (!response.ok) {
    if (response.status >= 500) {
      throw new RetryableRoomActionBridgeError(
        `Internal room action API is temporarily unavailable with HTTP ${response.status}; the durable activity must retry.`
      );
    }
    return {
      cleanedContent,
      toolMessageContent: bridgeMessage("FAILED", `Internal room action API returned HTTP ${response.status}.`),
      executedActionCount: 0
    };
  }
  let body: SpaceAgentRoomActionBridgeResponse;
  try {
    body = spaceAgentRoomActionBridgeResponseSchema.parse(await response.json());
  } catch (error) {
    throw new RetryableRoomActionBridgeError(
      "Internal room action API returned an invalid transient response; the durable activity must retry.",
      { cause: error }
    );
  }
  return {
    cleanedContent,
    toolMessageContent: formatResponse(body),
    executedActionCount: body.results.filter((result) => result.status === "EXECUTED").length,
    actionSignature: JSON.stringify(parsed.envelope.actions),
    inspectHasActiveWork: body.results
      .filter((result) => result.request.toolId === "room:inspect")
      .some((result) => evidenceHasActiveWork(result.evidence)),
    roomInventory: inspectRoomInventory(body),
    authoritativeCompletion:
      parsed.envelope.actions.length > 0 &&
      parsed.envelope.actions.every((request) => request.toolId === "room:orchestrate") &&
      body.results.length === parsed.envelope.actions.length &&
      body.results.every((result, index) => {
        if (JSON.stringify(result.request) !== JSON.stringify(parsed.envelope!.actions[index])) return false;
        if (result.request.toolId !== "room:orchestrate" || result.status !== "EXECUTED") return false;
        const steps = result.evidence.steps;
        return Array.isArray(steps) && steps.length > 0 && steps.every((step) => {
          const record = unknownRecord(step);
          return record?.status === "EXECUTED";
        });
      })
  };
}
