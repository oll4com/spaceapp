import {
  listTaskItemsQuerySchema,
  saveAgentTaskItemInputSchema,
  spaceAgentTaskActionEnvelopeSchema,
  spaceTaskToolIdSchema,
  type DummyTurnInput,
  type SpaceAgentTaskActionEnvelope,
  type SpaceTaskToolId,
  type TaskItem
} from "@space/contracts";
import { redactMemoryText, type SpaceStore } from "@space/runtime";

const taskActionBlockPattern = /```space-task-actions\s*([\s\S]*?)```/gi;
const listPreviewCharacters = 800;
const getObjectiveCharacters = 6_000;
const bridgeOutputCharacters = 12_000;

export interface ParsedTaskActionBlock {
  found: boolean;
  cleanedContent: string;
  envelope: SpaceAgentTaskActionEnvelope | null;
  error: string | null;
}

export interface TaskActionBridgeExecution {
  cleanedContent: string;
  toolMessageContent: string | null;
  executedActionCount: number;
}

function cleanAssistantContent(content: string): string {
  return content.replace(taskActionBlockPattern, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function parseTaskActionBlock(content: string): ParsedTaskActionBlock {
  const matches = Array.from(content.matchAll(taskActionBlockPattern));
  const cleanedContent = cleanAssistantContent(content);
  if (!matches.length) return { found: false, cleanedContent: content, envelope: null, error: null };
  const rawJson = matches[0]?.[1]?.trim();
  if (!rawJson) {
    return { found: true, cleanedContent, envelope: null, error: "Task action block is empty." };
  }
  try {
    return {
      found: true,
      cleanedContent,
      envelope: spaceAgentTaskActionEnvelopeSchema.parse(JSON.parse(rawJson)),
      error: null
    };
  } catch {
    return {
      found: true,
      cleanedContent,
      envelope: null,
      error: "Task action block must be valid Space task action JSON."
    };
  }
}

function blockedMessage(reason: string): string {
  return `Space task action bridge result:\n- BLOCKED reason=${redactMemoryText(reason).slice(0, 500)}`;
}

function failedMessage(reason: string): string {
  return `Space task action bridge result:\n- FAILED reason=${redactMemoryText(reason).slice(0, 500)}`;
}

function selectedTaskToolIds(input: DummyTurnInput): Set<SpaceTaskToolId> {
  return new Set(
    (input.selectedToolIds ?? []).flatMap((toolId) => {
      const parsed = spaceTaskToolIdSchema.safeParse(toolId);
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

function formatTaskItem(item: TaskItem, maximum: number): string {
  const preview = truncatedText(item.objective, maximum);
  const fields = [
    `id=${item.id}`,
    `status=${item.status}`,
    `source=${item.source}`,
    `occurrences=${item.occurrenceCount}`,
    `characters=${item.characterCount}`,
    `lastUsedAt=${item.lastUsedAt}`
  ];
  if (item.roomId) fields.push(`room=${item.roomId}`);
  if (item.paneId) fields.push(`pane=${item.paneId}`);
  if (item.paneTitle) fields.push(`paneTitle=${redactMemoryText(item.paneTitle).slice(0, 160)}`);
  fields.push(`title=${JSON.stringify(redactMemoryText(item.title).slice(0, 160))}`);
  fields.push(`objective=${JSON.stringify(preview.text)}`);
  if (preview.truncated) fields.push("objectiveTruncated=true");
  return fields.join("; ");
}

async function paneTitleForTurn(store: SpaceStore, input: DummyTurnInput): Promise<string | null> {
  const panes = await store.listPanes(input.roomId, true);
  return panes.find((pane) => pane.id === input.paneId)?.title ?? null;
}

export async function executeTaskActionBridge(input: {
  turnInput: DummyTurnInput;
  assistantContent: string;
  store: SpaceStore;
}): Promise<TaskActionBridgeExecution> {
  const parsed = parseTaskActionBlock(input.assistantContent);
  if (!parsed.found) {
    return { cleanedContent: input.assistantContent, toolMessageContent: null, executedActionCount: 0 };
  }
  const cleanedContent = parsed.cleanedContent || "Requested Space task actions.";
  if (parsed.error || !parsed.envelope) {
    return {
      cleanedContent,
      toolMessageContent: failedMessage(parsed.error ?? "Task action request was invalid."),
      executedActionCount: 0
    };
  }
  if (!input.turnInput.agentSessionId) {
    return {
      cleanedContent,
      toolMessageContent: blockedMessage("Task actions require a Space-native agent session."),
      executedActionCount: 0
    };
  }
  if (!input.turnInput.operatorUserId) {
    return {
      cleanedContent,
      toolMessageContent: blockedMessage("Task actions require an authenticated operator identity."),
      executedActionCount: 0
    };
  }
  const selectedToolIds = selectedTaskToolIds(input.turnInput);
  if (!selectedToolIds.size) {
    return {
      cleanedContent,
      toolMessageContent: blockedMessage("No task tools are selected for this agent pane."),
      executedActionCount: 0
    };
  }

  const lines = ["Space task action bridge result:"];
  let executedActionCount = 0;

  for (const request of parsed.envelope.actions) {
    if (!selectedToolIds.has(request.toolId)) {
      lines.push(`- BLOCKED ${request.toolId}; reason=Task tool ${request.toolId} is not selected for this agent pane.`);
      continue;
    }
    try {
      if (request.action.type === "list") {
        const query = listTaskItemsQuerySchema.parse({
          page: 1,
          pageSize: request.action.pageSize,
          q: request.action.q,
          status: request.action.status
        });
        const result = await input.store.listTaskItems(input.turnInput.operatorUserId, query);
        lines.push(`- EXECUTED tasks:list; matches=${result.total}; returned=${result.items.length}`);
        for (const item of result.items) lines.push(`  - ${formatTaskItem(item, listPreviewCharacters)}`);
        executedActionCount += 1;
        continue;
      }

      if (request.action.type === "get") {
        const item = await input.store.getTaskItem(
          input.turnInput.operatorUserId,
          request.action.taskItemId
        );
        if (!item) {
          lines.push("- FAILED tasks:get; reason=Task item was not found for this operator.");
          continue;
        }
        lines.push(`- EXECUTED tasks:get; ${formatTaskItem(item, getObjectiveCharacters)}`);
        executedActionCount += 1;
        continue;
      }

      if (request.action.type === "save") {
        const agentTask = saveAgentTaskItemInputSchema.parse({
          title: request.action.title,
          objective: request.action.objective
        });
        const item = await input.store.upsertTaskItem({
          ...agentTask,
          ownerUserId: input.turnInput.operatorUserId,
          status: "OPEN",
          source: "AGENT",
          roomId: input.turnInput.roomId,
          paneId: input.turnInput.paneId,
          paneTitle: await paneTitleForTurn(input.store, input.turnInput)
        });
        lines.push(
          `- EXECUTED tasks:save; id=${item.id}; title=${item.title}; characters=${item.characterCount}; occurrences=${item.occurrenceCount}`
        );
        executedActionCount += 1;
        continue;
      }

      if (request.action.type === "update") {
        const item = await input.store.updateTaskItem(
          input.turnInput.operatorUserId,
          request.action.taskItemId,
          {
            status: request.action.status,
            objective: request.action.objective
          }
        );
        lines.push(
          `- EXECUTED tasks:update; id=${item.id}; status=${item.status}; characters=${item.characterCount}`
        );
        executedActionCount += 1;
        continue;
      }

      lines.push(`- BLOCKED ${request.toolId}; reason=Unsupported task action type.`);
    } catch {
      lines.push(`- FAILED ${request.toolId}; reason=Task action failed validation or persistence.`);
    }
  }

  return {
    cleanedContent,
    toolMessageContent: redactMemoryText(lines.join("\n")).slice(0, bridgeOutputCharacters),
    executedActionCount
  };
}
