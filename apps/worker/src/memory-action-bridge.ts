import {
  createMemoryEntryInputSchema,
  listMemoryQuerySchema,
  spaceAgentMemoryActionEnvelopeSchema,
  spaceMemoryToolIdSchema,
  type DummyTurnInput,
  type MemoryEntry,
  type SpaceAgentMemoryActionEnvelope,
  type SpaceMemoryToolId
} from "@space/contracts";
import { redactMemoryText, type SpaceStore } from "@space/runtime";
import type { CanonicalMemoryBridge } from "@space/runtime";

const memoryActionBlockPattern = /```space-memory-actions\s*([\s\S]*?)```/gi;

export interface ParsedMemoryActionBlock {
  found: boolean;
  cleanedContent: string;
  envelope: SpaceAgentMemoryActionEnvelope | null;
  error: string | null;
}

export interface MemoryActionBridgeExecution {
  cleanedContent: string;
  toolMessageContent: string | null;
  executedActionCount: number;
}

function cleanAssistantContent(content: string): string {
  return content.replace(memoryActionBlockPattern, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function parseMemoryActionBlock(content: string): ParsedMemoryActionBlock {
  const matches = Array.from(content.matchAll(memoryActionBlockPattern));
  const cleanedContent = cleanAssistantContent(content);
  if (!matches.length) {
    return { found: false, cleanedContent: content, envelope: null, error: null };
  }
  const rawJson = matches[0]?.[1]?.trim();
  if (!rawJson) {
    return { found: true, cleanedContent, envelope: null, error: "Memory action block is empty." };
  }
  try {
    const parsed = spaceAgentMemoryActionEnvelopeSchema.parse(JSON.parse(rawJson));
    return { found: true, cleanedContent, envelope: parsed, error: null };
  } catch {
    return { found: true, cleanedContent, envelope: null, error: "Memory action block must be valid Space memory action JSON." };
  }
}

function blockedMessage(reason: string): string {
  return `Space memory action bridge result:\n- BLOCKED reason=${redactMemoryText(reason).slice(0, 500)}`;
}

function failedMessage(reason: string): string {
  return `Space memory action bridge result:\n- FAILED reason=${redactMemoryText(reason).slice(0, 500)}`;
}

function selectedMemoryToolIds(input: DummyTurnInput): Set<SpaceMemoryToolId> {
  return new Set(
    (input.selectedToolIds ?? []).flatMap((toolId) => {
      const parsed = spaceMemoryToolIdSchema.safeParse(toolId);
      return parsed.success ? [parsed.data] : [];
    })
  );
}

function memoryScopeRoomId(input: DummyTurnInput, scope: "ROOM" | "PROJECT" | "SYSTEM"): string | undefined {
  return scope === "ROOM" ? input.roomId : undefined;
}

function formatMemoryEntry(entry: MemoryEntry): string {
  const parts = [`id=${entry.id}`, `scope=${entry.scope}`, `title=${entry.title}`];
  if (entry.roomId) parts.push(`room=${entry.roomId}`);
  parts.push(`body=${entry.body.slice(0, 700)}`);
  return parts.join("; ");
}

function formatSearchResult(query: string, entries: MemoryEntry[]): string {
  if (!entries.length) {
    return `EXECUTED memory:search; query=${query}; matches=0`;
  }
  return [`EXECUTED memory:search; query=${query}; matches=${entries.length}`, ...entries.map((entry) => `  - ${formatMemoryEntry(entry)}`)].join(
    "\n"
  );
}

export async function executeMemoryActionBridge(input: {
  turnInput: DummyTurnInput;
  assistantContent: string;
  store: SpaceStore;
  canonicalMemory?: CanonicalMemoryBridge;
}): Promise<MemoryActionBridgeExecution> {
  const parsed = parseMemoryActionBlock(input.assistantContent);
  if (!parsed.found) {
    return { cleanedContent: input.assistantContent, toolMessageContent: null, executedActionCount: 0 };
  }
  const cleanedContent = parsed.cleanedContent || "Requested Space memory actions.";
  if (parsed.error || !parsed.envelope) {
    return {
      cleanedContent,
      toolMessageContent: failedMessage(parsed.error ?? "Memory action request was invalid."),
      executedActionCount: 0
    };
  }
  if (!input.turnInput.agentSessionId) {
    return {
      cleanedContent,
      toolMessageContent: blockedMessage("Memory actions require a Space-native agent session."),
      executedActionCount: 0
    };
  }
  const selectedToolIds = selectedMemoryToolIds(input.turnInput);
  if (!selectedToolIds.size) {
    return {
      cleanedContent,
      toolMessageContent: blockedMessage("No memory tools are selected for this agent pane."),
      executedActionCount: 0
    };
  }

  const lines = ["Space memory action bridge result:"];
  let executedActionCount = 0;

  for (const request of parsed.envelope.actions) {
    if (!selectedToolIds.has(request.toolId)) {
      lines.push(`BLOCKED ${request.toolId}; reason=Memory tool ${request.toolId} is not selected for this agent pane.`);
      continue;
    }
    try {
      if (request.action.type === "search") {
        const query = listMemoryQuerySchema.parse({
          page: 1,
          pageSize: request.action.pageSize,
          sortOrder: "desc",
          scope: request.action.scope,
          roomId: memoryScopeRoomId(input.turnInput, request.action.scope),
          q: request.action.q,
          searchMode: "keyword"
        });
        const entries = input.canonicalMemory
          ? await input.canonicalMemory.list(query)
          : await input.store.listMemoryEntries(query);
        lines.push(formatSearchResult(request.action.q, entries.slice(0, request.action.pageSize)));
        executedActionCount += 1;
        continue;
      }

      const memoryInput = createMemoryEntryInputSchema.parse({
        scope: request.action.scope,
        roomId: memoryScopeRoomId(input.turnInput, request.action.scope),
        title: request.action.title,
        body: request.action.body,
        provenance: request.action.provenance,
        tags: request.action.tags
      });
      const entry = input.canonicalMemory
        ? await input.canonicalMemory.save(memoryInput, input.turnInput.traceId)
        : (await input.store.createMemoryEntry(memoryInput, input.turnInput.traceId)).entry;
      lines.push(`EXECUTED memory:save; ${formatMemoryEntry(entry)}`);
      executedActionCount += 1;
    } catch {
      lines.push(`FAILED ${request.toolId}; reason=Memory action failed validation or persistence.`);
    }
  }

  return {
    cleanedContent,
    toolMessageContent: redactMemoryText(lines.join("\n")).slice(0, 12000),
    executedActionCount
  };
}
