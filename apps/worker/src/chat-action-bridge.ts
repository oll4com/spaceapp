import {
  listSharedChatMessagesQuerySchema,
  spaceAgentChatActionEnvelopeSchema,
  spaceSharedChatToolIdSchema,
  type DummyTurnInput,
  type SpaceAgentChatActionEnvelope,
  type SpaceSharedChatToolId
} from "@space/contracts";
import { makeSpaceId, redactMemoryText, type SpaceStore } from "@space/runtime";

const chatActionBlockPattern = /```space-chat-actions\s*([\s\S]*?)```/gi;
const readMessageCharacters = 2_000;
const bridgeOutputCharacters = 12_000;

export interface ParsedChatActionBlock {
  found: boolean;
  cleanedContent: string;
  envelope: SpaceAgentChatActionEnvelope | null;
  error: string | null;
}

export interface ChatActionBridgeExecution {
  cleanedContent: string;
  toolMessageContent: string | null;
  executedActionCount: number;
}

function cleanAssistantContent(content: string): string {
  return content.replace(chatActionBlockPattern, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function parseChatActionBlock(content: string): ParsedChatActionBlock {
  const matches = Array.from(content.matchAll(chatActionBlockPattern));
  const cleanedContent = cleanAssistantContent(content);
  if (!matches.length) return { found: false, cleanedContent: content, envelope: null, error: null };
  const rawJson = matches[0]?.[1]?.trim();
  if (!rawJson) {
    return { found: true, cleanedContent, envelope: null, error: "Shared chat action block is empty." };
  }
  try {
    return {
      found: true,
      cleanedContent,
      envelope: spaceAgentChatActionEnvelopeSchema.parse(JSON.parse(rawJson)),
      error: null
    };
  } catch {
    return {
      found: true,
      cleanedContent,
      envelope: null,
      error: "Shared chat action block must be valid Space shared chat action JSON."
    };
  }
}

function blockedMessage(reason: string): string {
  return `Space shared chat action bridge result:\n- BLOCKED reason=${redactMemoryText(reason).slice(0, 500)}`;
}

function failedMessage(reason: string): string {
  return `Space shared chat action bridge result:\n- FAILED reason=${redactMemoryText(reason).slice(0, 500)}`;
}

function selectedChatToolIds(input: DummyTurnInput): Set<SpaceSharedChatToolId> {
  return new Set(
    (input.selectedToolIds ?? []).flatMap((toolId) => {
      const parsed = spaceSharedChatToolIdSchema.safeParse(toolId);
      return parsed.success ? [parsed.data] : [];
    })
  );
}

function truncatedText(value: string, maximum: number): { text: string; truncated: boolean } {
  const characters = Array.from(redactMemoryText(value));
  return characters.length <= maximum
    ? { text: characters.join(""), truncated: false }
    : { text: characters.slice(0, maximum).join(""), truncated: true };
}

async function paneForTurn(store: SpaceStore, input: DummyTurnInput): Promise<{ title: string; runtimeId: string } | null> {
  const panes = await store.listPanes(input.roomId, true);
  const pane = panes.find((candidate) => candidate.id === input.paneId);
  if (!pane) return null;
  return { title: pane.title ?? `agent:${input.paneId}`, runtimeId: pane.terminalRuntimeId ?? "" };
}

export async function executeChatActionBridge(input: {
  turnInput: DummyTurnInput;
  assistantContent: string;
  store: SpaceStore;
}): Promise<ChatActionBridgeExecution> {
  const parsed = parseChatActionBlock(input.assistantContent);
  if (!parsed.found) {
    return { cleanedContent: input.assistantContent, toolMessageContent: null, executedActionCount: 0 };
  }
  const cleanedContent = parsed.cleanedContent || "Requested Space shared chat actions.";
  if (parsed.error || !parsed.envelope) {
    return {
      cleanedContent,
      toolMessageContent: failedMessage(parsed.error ?? "Shared chat action request was invalid."),
      executedActionCount: 0
    };
  }
  if (!input.turnInput.agentSessionId) {
    return {
      cleanedContent,
      toolMessageContent: blockedMessage("Shared chat actions require a Space-native agent session."),
      executedActionCount: 0
    };
  }
  if (!input.turnInput.operatorUserId) {
    return {
      cleanedContent,
      toolMessageContent: blockedMessage("Shared chat actions require an authenticated operator identity."),
      executedActionCount: 0
    };
  }
  const selectedToolIds = selectedChatToolIds(input.turnInput);
  if (!selectedToolIds.size) {
    return {
      cleanedContent,
      toolMessageContent: blockedMessage("No shared chat tools are selected for this agent pane."),
      executedActionCount: 0
    };
  }

  const lines = ["Space shared chat action bridge result:"];
  let executedActionCount = 0;
  const paneInfo = await paneForTurn(input.store, input.turnInput);
  const senderLabel = paneInfo?.title ?? `agent:${input.turnInput.paneId}`;
  const senderRuntimeId = paneInfo?.runtimeId ?? null;

  for (const request of parsed.envelope.actions) {
    if (!selectedToolIds.has(request.toolId)) {
      lines.push(`- BLOCKED ${request.toolId}; reason=Shared chat tool ${request.toolId} is not selected for this agent pane.`);
      continue;
    }
    try {
      if (request.action.type === "send") {
        const message = await input.store.appendSharedChatMessage({
          id: makeSpaceId("shared_chat_msg"),
          senderType: "agent",
          senderId: input.turnInput.paneId,
          senderLabel,
          roomId: input.turnInput.roomId,
          kind: "message",
          content: request.action.content,
          replyToId: request.action.replyToId ?? null,
          metadata: { runtimeId: senderRuntimeId }
        });
        await input.store.appendAuditChainEntry({
          action: "shared_chat.message_created",
          actor: `agent:${input.turnInput.paneId}`,
          targetType: "shared_chat_message",
          targetId: message.id,
          metadata: { senderLabel, roomId: message.roomId, kind: message.kind }
        });
        lines.push(`- EXECUTED chat:send; id=${message.id}; room=${message.roomId ?? "(shared)"}`);
        executedActionCount += 1;
        continue;
      }

      if (request.action.type === "read") {
        const query = listSharedChatMessagesQuerySchema.parse({
          limit: request.action.limit,
          before: request.action.before,
          senderType: request.action.senderType
        });
        const result = await input.store.listSharedChatMessages(query);
        lines.push(`- EXECUTED chat:read; returned=${result.items.length}; nextCursor=${result.nextCursor ?? "(none)"}`);
        for (const message of result.items) {
          const preview = truncatedText(message.content, readMessageCharacters);
          lines.push(
            `  - [${message.createdAt}] ${message.senderLabel} (${message.senderType}): ${JSON.stringify(preview.text)}${preview.truncated ? " [truncated]" : ""}`
          );
        }
        executedActionCount += 1;
        continue;
      }

      if (request.action.type === "react") {
        const reaction = await input.store.appendSharedChatMessage({
          id: makeSpaceId("shared_chat_msg"),
          senderType: "agent",
          senderId: input.turnInput.paneId,
          senderLabel,
          roomId: input.turnInput.roomId,
          kind: "reaction",
          content: request.action.emoji,
          replyToId: request.action.messageId,
          metadata: { runtimeId: senderRuntimeId }
        });
        await input.store.appendAuditChainEntry({
          action: "shared_chat.reaction_created",
          actor: `agent:${input.turnInput.paneId}`,
          targetType: "shared_chat_message",
          targetId: reaction.id,
          metadata: { reactionTo: request.action.messageId, emoji: request.action.emoji }
        });
        lines.push(`- EXECUTED chat:react; id=${reaction.id}; emoji=${request.action.emoji}; reactionTo=${request.action.messageId}`);
        executedActionCount += 1;
        continue;
      }
    } catch {
      lines.push(`- FAILED ${request.toolId}; reason=Shared chat action failed validation or persistence.`);
    }
  }

  return {
    cleanedContent,
    toolMessageContent: redactMemoryText(lines.join("\n")).slice(0, bridgeOutputCharacters),
    executedActionCount
  };
}
