import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  agentSessionHistoryResponseSchema,
  type AgentSessionHistoryItem,
  type AgentSessionInterval,
  type AgentSessionStatusFilter,
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
  interval?: AgentSessionInterval;
  status?: AgentSessionStatusFilter;
  maxAgeDays?: number | null;
  now?: () => number;
}

export interface AgentSessionHistoryServiceOptions {
  codexParity: CodexParityService;
  unifiedCliTaskRegistry: UnifiedCliTaskRegistry;
  codexHome?: string;
  maxAgeDays?: number | null;
  verifyRolloutExistence?: boolean;
  now?: () => number;
}

function recencyTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rolloutExists(rawPath: string | null | undefined, codexHome: string): boolean {
  if (!rawPath) return false;
  const candidate = isAbsolute(rawPath) ? rawPath : join(codexHome, rawPath);
  try {
    return existsSync(candidate);
  } catch {
    return false;
  }
}

function computeIntervalCutoff(
  interval: AgentSessionInterval | undefined,
  maxAgeDays: number | null | undefined,
  nowMs: number
): number | null {
  const maxRetentionCutoff =
    maxAgeDays !== null && maxAgeDays !== undefined ? nowMs - maxAgeDays * 86_400_000 : null;
  if (!interval || interval === "all" || interval === "7d") {
    return maxRetentionCutoff;
  }
  if (interval === "today") {
    const startOfToday = new Date(nowMs);
    startOfToday.setHours(0, 0, 0, 0);
    const todayMs = startOfToday.getTime();
    return maxRetentionCutoff !== null ? Math.max(todayMs, maxRetentionCutoff) : todayMs;
  }
  if (interval === "24h") {
    const dayMs = nowMs - 86_400_000;
    return maxRetentionCutoff !== null ? Math.max(dayMs, maxRetentionCutoff) : dayMs;
  }
  if (interval === "3d") {
    const threeDaysMs = nowMs - 3 * 86_400_000;
    return maxRetentionCutoff !== null ? Math.max(threeDaysMs, maxRetentionCutoff) : threeDaysMs;
  }
  return maxRetentionCutoff;
}

function mapCodexItem(item: CodexHistoryItem, activeThreadIds: Set<string>): AgentSessionHistoryItem {
  const isActive = Boolean(item.id && activeThreadIds.has(item.id));
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
    recencyAt: item.recencyAt,
    status: isActive ? "active" : "completed",
    isCompleted: !isActive
  };
}

function mapCliItem(task: UnifiedCliTask): AgentSessionHistoryItem {
  const isCompleted = task.isCompleted ?? (task.status !== "active");
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
    recencyAt: task.recencyAt,
    status: isCompleted ? "completed" : "active",
    isCompleted
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

    const codexHome = this.options.codexHome ?? "/var/lib/spaceapp-user/.codex";
    const nowFn = input.now ?? this.options.now ?? (() => Date.now());
    const nowMs = nowFn();
    const maxAgeDays = input.maxAgeDays !== undefined ? input.maxAgeDays : this.options.maxAgeDays;
    const cutoffMs = computeIntervalCutoff(input.interval, maxAgeDays, nowMs);

    const activeCodexThreadIds =
      typeof this.options.unifiedCliTaskRegistry.listActiveCodexThreadIds === "function"
        ? await this.options.unifiedCliTaskRegistry.listActiveCodexThreadIds()
        : new Set<string>();

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

      const codexCandidateItems = codexResponse.data
        .filter((item) => {
          if (!item.id) return false;
          if (this.options.verifyRolloutExistence && item.rolloutPath) {
            return rolloutExists(item.rolloutPath, codexHome);
          }
          return true;
        })
        .map((item) => mapCodexItem(item, activeCodexThreadIds));

      const claimedThreadIds = await this.options.unifiedCliTaskRegistry.listResumableCodexThreadIds(
        codexCandidateItems
          .map((item) => item.threadId)
          .filter((threadId): threadId is string => Boolean(threadId))
      );

      const validCodexItems = codexCandidateItems.filter(
        (item) => item.threadId && claimedThreadIds.has(item.threadId)
      );

      const validCliItems = cliResponse.tasks
        .filter((task) => Boolean(task.firstUserMessage?.trim() || task.nativeTaskRef))
        .map(mapCliItem);

      resumableItems.push(...validCodexItems, ...validCliItems);

      if (codexResponse.data.length < fetchSize && cliResponse.tasks.length < fetchSize) break;
      if (resumableItems.length >= start + pageSize * 2) break;
    }

    let filtered = resumableItems;

    // Filter by time cutoff (e.g. max 7 days and interval filter)
    if (cutoffMs !== null) {
      filtered = filtered.filter((item) => {
        const timestamp = recencyTimestamp(item.recencyAt ?? item.updatedAt);
        return timestamp >= cutoffMs;
      });
    }

    // Filter by completion status
    if (input.status && input.status !== "all") {
      filtered = filtered.filter((item) => {
        if (input.status === "completed") return item.isCompleted;
        if (input.status === "active") return !item.isCompleted;
        return true;
      });
    }

    const merged = filtered.sort(
      (left, right) => recencyTimestamp(right.recencyAt) - recencyTimestamp(left.recencyAt)
    );

    return agentSessionHistoryResponseSchema.parse({
      data: merged.slice(start, start + pageSize),
      totalItems: merged.length,
      visibleItems: merged.length,
      checkedAt: new Date(nowMs).toISOString()
    });
  }
}
