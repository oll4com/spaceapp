import {
  agentSessionHistoryResponseSchema,
  type AgentSessionHistoryItem,
  type CodexHistoryItem
} from "@space/contracts";
import type { CodexParityService } from "./codex-parity.js";
import type { UnifiedCliTask } from "./unified-cli-task-registry.js";
import type { UnifiedCliTaskRegistry } from "./unified-cli-task-registry.js";

export interface AgentSessionHistoryListInput {
  page?: number;
  pageSize?: number;
  includeArchived?: boolean;
  q?: string;
  runtimeIds?: string[];
}

export interface AgentSessionHistoryServiceOptions {
  codexParity: CodexParityService;
  unifiedCliTaskRegistry: UnifiedCliTaskRegistry;
}

function recencyTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mapCodexItem(item: CodexHistoryItem): AgentSessionHistoryItem {
  return {
    id: `codex:${item.id}`,
    kind: "codex",
    threadId: item.id,
    taskId: null,
    title: item.title,
    preview: item.preview,
    providerLabel: "Codex",
    model: item.model,
    modelProvider: item.modelProvider,
    cwd: item.cwd,
    source: item.source,
    threadSource: item.threadSource,
    firstUserMessage: item.firstUserMessage,
    archived: item.archived,
    updatedAt: item.updatedAt,
    recencyAt: item.recencyAt
  };
}

function mapCliItem(task: UnifiedCliTask): AgentSessionHistoryItem {
  return {
    id: `cli:${task.taskId}`,
    kind: "cli",
    threadId: null,
    taskId: task.taskId,
    title: task.title,
    preview: task.preview,
    providerLabel: task.providerLabel,
    model: task.model,
    modelProvider: task.modelProvider,
    cwd: task.cwd,
    source: task.source,
    threadSource: task.threadSource,
    firstUserMessage: task.firstUserMessage,
    archived: task.archived,
    updatedAt: task.updatedAt,
    recencyAt: task.recencyAt
  };
}

export class AgentSessionHistoryService {
  constructor(private readonly options: AgentSessionHistoryServiceOptions) {}

  async list(input: AgentSessionHistoryListInput = {}) {
    const page = input.page ?? 1;
    const pageSize = input.pageSize ?? 50;
    const includeArchived = input.includeArchived ?? false;
    const q = input.q?.trim() || undefined;
    const fetchSize = Math.min(Math.max(Math.trunc(pageSize * 3), 1), 100);
    const start = (page - 1) * pageSize;
    const maxRounds = 6;

    const resumableItems: AgentSessionHistoryItem[] = [];
    for (let round = 1; round <= maxRounds; round += 1) {
      const [codexResponse, cliResponse] = await Promise.all([
        this.options.codexParity.listHistory({
          page: round,
          pageSize: fetchSize,
          limit: fetchSize,
          includeArchived,
          dedupeTitles: true,
          q
        }),
        this.options.unifiedCliTaskRegistry.listAllTasks({
          page: round,
          pageSize: fetchSize,
          includeArchived,
          q,
          runtimeIds: input.runtimeIds
        })
      ]);

      const codexItems = codexResponse.data.map(mapCodexItem);
      const claimedThreadIds = await this.options.unifiedCliTaskRegistry.listResumableCodexThreadIds(
        codexItems.map((item) => item.threadId).filter((threadId): threadId is string => Boolean(threadId))
      );
      resumableItems.push(
        ...codexItems.filter((item) => item.threadId && claimedThreadIds.has(item.threadId)),
        ...cliResponse.tasks.map(mapCliItem)
      );

      if (codexResponse.data.length < fetchSize && cliResponse.tasks.length < fetchSize) break;
      if (resumableItems.length >= start + pageSize) break;
    }

    const merged = resumableItems.sort(
      (left, right) => recencyTimestamp(right.recencyAt) - recencyTimestamp(left.recencyAt)
    );

    return agentSessionHistoryResponseSchema.parse({
      data: merged.slice(start, start + pageSize),
      totalItems: merged.length,
      visibleItems: merged.length,
      checkedAt: new Date().toISOString()
    });
  }
}
