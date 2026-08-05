import {
  listClipboardItemsQuerySchema,
  saveAgentClipboardItemInputSchema,
  saveAgentClipboardPlanInputSchema,
  spaceAgentClipboardActionEnvelopeSchema,
  spaceClipboardToolIdSchema,
  type ClipboardItem,
  type DummyTurnInput,
  type SpaceAgentClipboardActionEnvelope,
  type SpaceClipboardToolId
} from "@space/contracts";
import { redactMemoryText, type SpaceStore } from "@space/runtime";

const clipboardActionBlockPattern = /```space-clipboard-actions\s*([\s\S]*?)```/gi;
const listPreviewCharacters = 800;
const getTextCharacters = 6_000;
const bridgeOutputCharacters = 12_000;

export interface ParsedClipboardActionBlock {
  found: boolean;
  cleanedContent: string;
  envelope: SpaceAgentClipboardActionEnvelope | null;
  error: string | null;
}

export interface ClipboardActionBridgeExecution {
  cleanedContent: string;
  toolMessageContent: string | null;
  executedActionCount: number;
}

function cleanAssistantContent(content: string): string {
  return content.replace(clipboardActionBlockPattern, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function parseClipboardActionBlock(content: string): ParsedClipboardActionBlock {
  const matches = Array.from(content.matchAll(clipboardActionBlockPattern));
  const cleanedContent = cleanAssistantContent(content);
  if (!matches.length) return { found: false, cleanedContent: content, envelope: null, error: null };
  const rawJson = matches[0]?.[1]?.trim();
  if (!rawJson) {
    return { found: true, cleanedContent, envelope: null, error: "Clipboard action block is empty." };
  }
  try {
    return {
      found: true,
      cleanedContent,
      envelope: spaceAgentClipboardActionEnvelopeSchema.parse(JSON.parse(rawJson)),
      error: null
    };
  } catch {
    return {
      found: true,
      cleanedContent,
      envelope: null,
      error: "Clipboard action block must be valid Space clipboard action JSON."
    };
  }
}

function blockedMessage(reason: string): string {
  return `Space clipboard action bridge result:\n- BLOCKED reason=${redactMemoryText(reason).slice(0, 500)}`;
}

function failedMessage(reason: string): string {
  return `Space clipboard action bridge result:\n- FAILED reason=${redactMemoryText(reason).slice(0, 500)}`;
}

function selectedClipboardToolIds(input: DummyTurnInput): Set<SpaceClipboardToolId> {
  return new Set(
    (input.selectedToolIds ?? []).flatMap((toolId) => {
      const parsed = spaceClipboardToolIdSchema.safeParse(toolId);
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

function formatClipboardItem(item: ClipboardItem, maximum: number): string {
  const preview = truncatedText(item.text, maximum);
  const fields = [
    `id=${item.id}`,
    `source=${item.source}`,
    `occurrences=${item.occurrenceCount}`,
    `characters=${item.characterCount}`,
    `lastUsedAt=${item.lastUsedAt}`
  ];
  if (item.roomId) fields.push(`room=${item.roomId}`);
  if (item.paneId) fields.push(`pane=${item.paneId}`);
  if (item.paneTitle) fields.push(`paneTitle=${redactMemoryText(item.paneTitle).slice(0, 160)}`);
  fields.push(`text=${JSON.stringify(preview.text)}`);
  if (preview.truncated) fields.push("textTruncated=true");
  return fields.join("; ");
}

async function paneTitleForTurn(store: SpaceStore, input: DummyTurnInput): Promise<string | null> {
  const panes = await store.listPanes(input.roomId, true);
  return panes.find((pane) => pane.id === input.paneId)?.title ?? null;
}

export async function executeClipboardActionBridge(input: {
  turnInput: DummyTurnInput;
  assistantContent: string;
  store: SpaceStore;
}): Promise<ClipboardActionBridgeExecution> {
  const parsed = parseClipboardActionBlock(input.assistantContent);
  if (!parsed.found) {
    return { cleanedContent: input.assistantContent, toolMessageContent: null, executedActionCount: 0 };
  }
  const cleanedContent = parsed.cleanedContent || "Requested Space clipboard actions.";
  if (parsed.error || !parsed.envelope) {
    return {
      cleanedContent,
      toolMessageContent: failedMessage(parsed.error ?? "Clipboard action request was invalid."),
      executedActionCount: 0
    };
  }
  if (!input.turnInput.agentSessionId) {
    return {
      cleanedContent,
      toolMessageContent: blockedMessage("Clipboard actions require a Space-native agent session."),
      executedActionCount: 0
    };
  }
  if (!input.turnInput.operatorUserId) {
    return {
      cleanedContent,
      toolMessageContent: blockedMessage("Clipboard actions require an authenticated operator identity."),
      executedActionCount: 0
    };
  }
  const selectedToolIds = selectedClipboardToolIds(input.turnInput);
  if (!selectedToolIds.size) {
    return {
      cleanedContent,
      toolMessageContent: blockedMessage("No clipboard tools are selected for this agent pane."),
      executedActionCount: 0
    };
  }

  const lines = ["Space clipboard action bridge result:"];
  let executedActionCount = 0;

  for (const request of parsed.envelope.actions) {
    if (!selectedToolIds.has(request.toolId)) {
      lines.push(`- BLOCKED ${request.toolId}; reason=Clipboard tool ${request.toolId} is not selected for this agent pane.`);
      continue;
    }
    try {
      if (request.action.type === "list") {
        const query = listClipboardItemsQuerySchema.parse({
          page: 1,
          pageSize: request.action.pageSize,
          q: request.action.q,
          source: request.action.source
        });
        const result = await input.store.listClipboardItems(input.turnInput.operatorUserId, query);
        lines.push(`- EXECUTED clipboard:list; matches=${result.total}; returned=${result.items.length}`);
        for (const item of result.items) lines.push(`  - ${formatClipboardItem(item, listPreviewCharacters)}`);
        executedActionCount += 1;
        continue;
      }

      if (request.action.type === "get") {
        const item = await input.store.getClipboardItem(
          input.turnInput.operatorUserId,
          request.action.clipboardItemId
        );
        if (!item) {
          lines.push("- FAILED clipboard:get; reason=Clipboard item was not found for this operator.");
          continue;
        }
        lines.push(`- EXECUTED clipboard:get; ${formatClipboardItem(item, getTextCharacters)}`);
        executedActionCount += 1;
        continue;
      }

      if (request.action.type === "save-plan") {
        const agentPlan = saveAgentClipboardPlanInputSchema.parse({
          text: request.action.text,
          title: request.action.title,
          roomId: input.turnInput.roomId,
          paneId: input.turnInput.paneId,
          paneTitle: await paneTitleForTurn(input.store, input.turnInput)
        });
        const item = await input.store.upsertClipboardItem({
          ...agentPlan,
          ownerUserId: input.turnInput.operatorUserId,
          source: "PLAN"
        });
        lines.push(
          `- EXECUTED clipboard:save-plan; id=${item.id}; title=${item.title ?? "(untitled)"}; characters=${item.characterCount}; occurrences=${item.occurrenceCount}`
        );
        executedActionCount += 1;
        continue;
      }

      const agentNote = saveAgentClipboardItemInputSchema.parse({
        text: request.action.text,
        roomId: input.turnInput.roomId,
        paneId: input.turnInput.paneId,
        paneTitle: await paneTitleForTurn(input.store, input.turnInput)
      });
      const item = await input.store.upsertClipboardItem({
        ...agentNote,
        ownerUserId: input.turnInput.operatorUserId,
        source: "AGENT_NOTE"
      });
      lines.push(`- EXECUTED clipboard:save; id=${item.id}; characters=${item.characterCount}; occurrences=${item.occurrenceCount}`);
      executedActionCount += 1;
    } catch {
      lines.push(`- FAILED ${request.toolId}; reason=Clipboard action failed validation or persistence.`);
    }
  }

  return {
    cleanedContent,
    toolMessageContent: redactMemoryText(lines.join("\n")).slice(0, bridgeOutputCharacters),
    executedActionCount
  };
}
