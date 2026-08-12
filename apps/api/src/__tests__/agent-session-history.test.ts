import { describe, expect, it } from "vitest";
import type { AgentSessionHistoryItem, CodexHistoryItem } from "@space/contracts";
import { AgentSessionHistoryService } from "../agent-session-history.js";
import type { CodexParityService } from "../codex-parity.js";
import type { UnifiedCliTask, UnifiedCliTaskRegistry } from "../unified-cli-task-registry.js";

function codexItem(overrides: Partial<CodexHistoryItem> = {}): CodexHistoryItem {
  return {
    id: "thread-1",
    rolloutPath: null,
    title: "Codex task",
    preview: "preview",
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
    cwd: "/Users/Admin",
    archived: false,
    source: "local",
    modelProvider: "codex",
    threadSource: "local",
    firstUserMessage: "first user message",
    updatedAt: "2026-08-07T10:00:00.000Z",
    recencyAt: "2026-08-07T10:00:00.000Z",
    ...overrides
  };
}

function cliTask(overrides: Partial<UnifiedCliTask> = {}): UnifiedCliTask {
  return {
    id: "task-1",
    taskId: "task-1",
    revisionId: "rev-1",
    title: "OpenCode task",
    runtimeId: "cli:opencode",
    providerId: "opencode",
    providerLabel: "OpenCode",
    modelProvider: "opencode",
    preview: "preview",
    firstUserMessage: "first user message",
    cwd: "/opt/spaceapp",
    model: "deepseek-v4-flash-free",
    reasoningEffort: "medium",
    updatedAt: "2026-08-07T11:00:00.000Z",
    recencyAt: "2026-08-07T11:00:00.000Z",
    archived: false,
    source: "space",
    threadSource: "cli:opencode",
    rolloutPath: null,
    ...overrides
  };
}

function fakeCodexParity(rows: CodexHistoryItem[]): CodexParityService {
  return {
    listHistory: async (input) => {
      const q = input?.q?.trim();
      const filtered = q
        ? rows.filter((row) => `${row.title} ${row.firstUserMessage}`.toLowerCase().includes(q.toLowerCase()))
        : rows;
      return {
        data: filtered,
        totalItems: filtered.length,
        visibleItems: filtered.filter((row) => !row.archived).length,
        checkedAt: "2026-08-07T12:00:00.000Z"
      };
    },
    getHistoryThread: async (id) => codexItem({ id }),
    getThread: async (id) => ({ thread: codexItem({ id }), items: [], checkedAt: "2026-08-07T12:00:00.000Z" }),
    renameThread: async (id, title) => codexItem({ id, title }),
    archiveThread: async (id) => codexItem({ id, archived: true }),
    getEnvironment: async () =>
      ({
        isCodexEnabled: true,
        checkedAt: "2026-08-07T12:00:00.000Z",
        cliVersion: "1.0.0",
        appServerCommand: null,
        lbRoute: null,
        rollouts: [],
        home: "/var/lib/spaceapp-user/.codex"
      }) as never
  };
}

function fakeRegistry(tasks: UnifiedCliTask[]): UnifiedCliTaskRegistry {
  return {
    listAllTasks: async (options: { q?: string } = {}) => ({
      tasks: options.q ? tasks.filter((task) => task.title.includes(options.q ?? "")) : tasks,
      total: tasks.length,
      page: 1,
      pageSize: 50
    }),
    findLatestTaskForPane: async () => null,
    getTask: async () => {
      throw new Error("not used");
    },
    listResumableCodexThreadIds: async (threadIds: string[]) => new Set(threadIds)
  } as unknown as UnifiedCliTaskRegistry;
}

describe("AgentSessionHistoryService", () => {
  it("merges codex threads and CLI tasks sorted by recency", async () => {
    const service = new AgentSessionHistoryService({
      codexParity: fakeCodexParity([codexItem()]),
      unifiedCliTaskRegistry: fakeRegistry([cliTask()])
    });
    const result = await service.list({ page: 1, pageSize: 50, runtimeIds: ["cli:opencode"] });
    expect(result.totalItems).toBe(2);
    expect(result.visibleItems).toBe(2);
    expect(result.data).toHaveLength(2);
    expect(result.data[0]).toMatchObject({ kind: "cli", id: "cli:task-1" });
    expect(result.data[1]).toMatchObject({ kind: "codex", id: "codex:thread-1" });
  });

  it("maps codex and cli items with stable ids and provider labels", async () => {
    const service = new AgentSessionHistoryService({
      codexParity: fakeCodexParity([codexItem()]),
      unifiedCliTaskRegistry: fakeRegistry([cliTask()])
    });
    const result = await service.list({ page: 1, pageSize: 50 });
    const byId = new Map(result.data.map((item) => [item.id, item]));
    const codex = byId.get("codex:thread-1") as AgentSessionHistoryItem;
    const cli = byId.get("cli:task-1") as AgentSessionHistoryItem;
    expect(codex).toMatchObject({ kind: "codex", threadId: "thread-1", providerLabel: "Codex" });
    expect(cli).toMatchObject({ kind: "cli", taskId: "task-1", providerLabel: "OpenCode" });
    expect(cli.threadSource).toBe("cli:opencode");
  });

  it("filters by query on both sources", async () => {
    const service = new AgentSessionHistoryService({
      codexParity: fakeCodexParity([
        codexItem({ id: "t1", title: "Alpha plan" }),
        codexItem({ id: "t2", title: "Beta plan" })
      ]),
      unifiedCliTaskRegistry: fakeRegistry([
        cliTask({ taskId: "c1", title: "Alpha task" }),
        cliTask({ taskId: "c2", title: "Gamma task" })
      ])
    });
    const result = await service.list({ page: 1, pageSize: 50, q: "Alpha" });
    expect(result.data.map((item) => item.title).sort()).toEqual(["Alpha plan", "Alpha task"]);
  });

  it("paginates the merged list", async () => {
    const codexRows = Array.from({ length: 3 }, (_, index) =>
      codexItem({ id: `t${index}`, recencyAt: `2026-08-07T0${index}:00:00.000Z` })
    );
    const cliRows = Array.from({ length: 3 }, (_, index) =>
      cliTask({ taskId: `c${index}`, recencyAt: `2026-08-07T0${index + 3}:00:00.000Z` })
    );
    const service = new AgentSessionHistoryService({
      codexParity: fakeCodexParity(codexRows),
      unifiedCliTaskRegistry: fakeRegistry(cliRows)
    });
    const page1 = await service.list({ page: 1, pageSize: 4 });
    const page2 = await service.list({ page: 2, pageSize: 4 });
    expect(page1.data).toHaveLength(4);
    expect(page2.data).toHaveLength(2);
    const page1Ids = new Set(page1.data.map((item) => item.id));
    const page2Ids = new Set(page2.data.map((item) => item.id));
    expect([...page1Ids].filter((id) => page2Ids.has(id))).toHaveLength(0);
  });
});
