import { describe, expect, it } from "vitest";
import type { CodexParityService } from "../src/codex-parity.js";
import type { UnifiedCliTask } from "../src/unified-cli-task-registry.js";
import type { UnifiedCliTaskRegistry } from "../src/unified-cli-task-registry.js";
import { AgentSessionHistoryService } from "../src/agent-session-history.js";

interface CodexHistoryRow {
  id: string;
  title: string | null;
  preview: string | null;
  model: string | null;
  modelProvider: string | null;
  cwd: string | null;
  source: string;
  threadSource: string;
  firstUserMessage: string | null;
  archived: boolean;
  updatedAt: string;
  recencyAt: string;
}

function codexRow(overrides: Partial<CodexHistoryRow> & { id: string }): CodexHistoryRow {
  return {
    title: null,
    preview: "preview",
    model: null,
    modelProvider: null,
    cwd: null,
    source: "LOCAL",
    threadSource: "local",
    firstUserMessage: "hi",
    archived: false,
    updatedAt: "2026-08-07T10:00:00.000Z",
    recencyAt: "2026-08-07T10:00:00.000Z",
    ...overrides
  };
}

function makeCodexParity(rows: CodexHistoryRow[]): CodexParityService {
  return {
    listHistory: async (input: any) => {
      const page = input?.page ?? 1;
      const pageSize = input?.pageSize ?? 100;
      const start = (page - 1) * pageSize;
      const sorted = [...rows].sort((a, b) => b.recencyAt.localeCompare(a.recencyAt));
      return {
        data: sorted.slice(start, start + pageSize),
        totalItems: rows.length,
        visibleItems: rows.length,
        pagination: {
          page,
          pageSize,
          totalItems: rows.length,
          totalPages: Math.ceil(rows.length / pageSize)
        },
        checkedAt: new Date().toISOString()
      };
    }
  } as unknown as CodexParityService;
}

function makeCliTask(taskId: string, minutesAgo: number): UnifiedCliTask {
  const updatedAt = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  return {
    id: `cli:${taskId}`,
    taskId,
    revisionId: `cli_task_revision:${taskId}`,
    title: `Cli task ${taskId}`,
    preview: "preview",
    providerLabel: "OpenCode",
    model: "model",
    modelProvider: "provider",
    cwd: "/opt/spaceapp",
    source: "LOCAL",
    threadSource: "local",
    firstUserMessage: "hi",
    archived: false,
    updatedAt,
    recencyAt: updatedAt
  };
}

function makeRegistry(resumableThreadIds: string[], cliTasks: UnifiedCliTask[]): UnifiedCliTaskRegistry {
  return {
    listAllTasks: async () => ({ tasks: cliTasks, total: cliTasks.length, page: 1, pageSize: 100 }),
    listResumableCodexThreadIds: async (threadIds: string[]) =>
      new Set(threadIds.filter((id) => resumableThreadIds.includes(id)))
  } as unknown as UnifiedCliTaskRegistry;
}

describe("AgentSessionHistoryService", () => {
  it("filters out codex threads without a real space session claim", async () => {
    const service = new AgentSessionHistoryService({
      codexParity: makeCodexParity([
        codexRow({ id: "thread-claimed", title: "Claimed thread" }),
        codexRow({ id: "thread-ghost", title: "Ghost thread" }),
        codexRow({ id: "thread-ghost-2", title: "Ghost thread 2" })
      ]),
      unifiedCliTaskRegistry: makeRegistry(["thread-claimed"], [])
    });

    const result = await service.list({ page: 1, pageSize: 50 });
    expect(result.data.map((item) => item.id)).toEqual(["codex:thread-claimed"]);
    expect(result.totalItems).toBe(1);
    expect(result.visibleItems).toBe(1);
  });

  it("includes cli tasks alongside claimed codex threads", async () => {
    const service = new AgentSessionHistoryService({
      codexParity: makeCodexParity([
        codexRow({ id: "thread-claimed", title: "Claimed" }),
        codexRow({ id: "thread-ghost", title: "Ghost" })
      ]),
      unifiedCliTaskRegistry: makeRegistry(["thread-claimed"], [makeCliTask("task-1", 5)])
    });

    const result = await service.list({ page: 1, pageSize: 50 });
    expect(result.data.map((item) => item.id).sort()).toEqual(["cli:task-1", "codex:thread-claimed"]);
  });

  it("skips ahead across pages when claimed threads are sparse", async () => {
    const rows: CodexHistoryRow[] = [];
    for (let i = 0; i < 10; i += 1) {
      rows.push(codexRow({ id: `ghost-${i}`, title: `Ghost ${i}`, recencyAt: `2026-08-07T10:00:0${i}.000Z` }));
    }
    rows.push(
      codexRow({ id: "deep-claimed", title: "Deep claimed", recencyAt: "2026-08-07T09:00:00.000Z" })
    );
    const service = new AgentSessionHistoryService({
      codexParity: makeCodexParity(rows),
      unifiedCliTaskRegistry: makeRegistry(["deep-claimed"], [])
    });

    const result = await service.list({ page: 1, pageSize: 50 });
    expect(result.data.map((item) => item.id)).toEqual(["codex:deep-claimed"]);
  });
});
