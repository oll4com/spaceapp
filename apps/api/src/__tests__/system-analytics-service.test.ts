import { describe, expect, it } from "vitest";
import type { Pane, PaneCliSession, Room } from "@space/contracts";
import { InMemorySystemAnalyticsRepository } from "@space/db";
import type { SpaceStore } from "@space/runtime";
import {
  SystemAnalyticsService,
  parseCodexNativeTurns,
  type SystemAnalyticsLiveSession,
  type SystemAnalyticsProcessRow
} from "../system-analytics-service.js";

const sampledAt = "2027-01-15T08:00:00.000Z";

function fixture() {
  const room: Room = {
    id: "room:analytics-test",
    name: "Analytics Room",
    description: null,
    kind: "WORKSPACE",
    order: 0,
    paneLayoutColumns: 2,
    createdAt: sampledAt,
    updatedAt: sampledAt,
    archivedAt: null,
    paneCap: 16,
    traceId: "req:analytics-test"
  };
  const pane: Pane = {
    id: "pane:analytics-test",
    roomId: room.id,
    title: "Claude Planning Pane",
    titleSource: "manual",
    mode: "TERMINAL",
    status: "RUNNING",
    providerId: "anthropic",
    modelId: "claude-sonnet-4",
    terminalRuntimeId: "cli:claude",
    reasoningEffort: "high",
    cwd: "/etc",
    order: 0,
    columnSpan: 1,
    isMaximized: false,
    isMinimized: false,
    isClosed: false,
    split: { parentId: null, direction: null, size: null },
    categoryColor: null,
    createdAt: sampledAt,
    updatedAt: sampledAt
  };
  const session: PaneCliSession = {
    sessionId: "cli_session:analytics-test",
    paneId: pane.id,
    roomId: room.id,
    runtimeId: "cli:claude",
    providerId: "anthropic",
    agentId: "agent:claude",
    modelId: "claude-sonnet-4",
    reasoningEffort: "high",
    launchMode: "FRESH",
    purpose: "NORMAL",
    cwd: "/etc",
    codexThreadId: null,
    cliTaskId: null,
    cliTaskRevisionId: null,
    status: "RUNNING",
    statusReason: null,
    exitCode: null,
    isActive: true,
    startedAt: "2027-01-15T07:30:00.000Z",
    updatedAt: sampledAt,
    endedAt: null
  };
  const live: SystemAnalyticsLiveSession = {
    cliSessionId: session.sessionId,
    paneId: pane.id,
    roomId: room.id,
    runtimeId: session.runtimeId,
    codexThreadId: null,
    modelId: session.modelId,
    reasoningEffort: session.reasoningEffort,
    pid: 200,
    status: "RUNNING",
    attachmentCount: 1,
    startedAt: session.startedAt,
    detachedAt: null,
    endedAt: null
  };
  return { live, pane, room, session };
}

function createStore(input: ReturnType<typeof fixture>): SpaceStore {
  return {
    listRooms: () => [input.room],
    listPanes: () => [input.pane],
    listActivePaneCliSessions: (runtimeId: string) => runtimeId === input.session.runtimeId ? [input.session] : [],
    listPaneCliSessions: () => [input.session]
  } as unknown as SpaceStore;
}

describe("SystemAnalyticsService", () => {
  it("groups the full descendant tree under the actual room and pane name", async () => {
    const input = fixture();
    const processes: SystemAnalyticsProcessRow[] = [
      { pid: 200, parentPid: 1, rssBytes: 100, virtualBytes: 1_000, swapBytes: 0, uptimeSeconds: 120, threadCount: 2, cpuOneCorePercent: 20, state: "S", name: "claude", commandLine: "claude-vscode-parity" },
      { pid: 201, parentPid: 200, rssBytes: 50, virtualBytes: 500, swapBytes: 4, uptimeSeconds: 110, threadCount: 1, cpuOneCorePercent: 5, state: "S", name: "node", commandLine: "node worker.js --secret hidden" },
      { pid: 300, parentPid: 1, rssBytes: 80, virtualBytes: 800, swapBytes: 0, uptimeSeconds: 500, threadCount: 3, cpuOneCorePercent: 4, state: "S", name: "opencode", commandLine: "opencode-vscode-parity serve" },
      { pid: 350, parentPid: 1, rssBytes: 30, virtualBytes: 300, swapBytes: 0, uptimeSeconds: 300, threadCount: 1, cpuOneCorePercent: 2, state: "S", name: "node", commandLine: "node /var/lib/spaceapp-user/.codex/cache/maintenance-worker.js" },
      { pid: 400, parentPid: 1, rssBytes: 70, virtualBytes: 700, swapBytes: 0, uptimeSeconds: 900, threadCount: 1, cpuOneCorePercent: 1, state: "S", name: "postgres", commandLine: "postgres --config secret" }
    ];
    const service = new SystemAnalyticsService({
      repository: new InMemorySystemAnalyticsRepository(),
      store: createStore(input),
      liveSessions: async () => [input.live],
      now: () => new Date(sampledAt),
      coreCount: 4,
      readProcessTable: async () => processes,
      readMeminfo: async () => "MemTotal: 1000 kB\nMemAvailable: 400 kB\nCached: 200 kB\nShmem: 10 kB\nSwapTotal: 100 kB\nSwapFree: 75 kB\n",
      readProcStat: async () => "cpu  100 0 100 800 0 0 0 0 0 0\n"
    });

    await service.sample();
    const resources = await service.resources("10m");
    const cli = resources.entities.find((entity) => entity.entityType === "CLI_SESSION");
    expect(cli).toMatchObject({
      roomName: "Analytics Room",
      paneTitle: "Claude Planning Pane",
      runtimeId: "cli:claude",
      processCount: 2,
      rssBytes: 150,
      cpuOneCorePercent: 25
    });
    expect(resources.entities.find((entity) => entity.entityType === "SHARED_RUNTIME")).toMatchObject({
      runtimeId: "cli:opencode",
      processCount: 1,
      rssBytes: 80
    });

    const liveProcesses = await service.processes({ page: 1, pageSize: 100, sort: "pid", direction: "asc" });
    expect(liveProcesses.data.find((process) => process.pid === 201)).toMatchObject({
      ownership: "SPACE_CLI",
      roomName: "Analytics Room",
      paneTitle: "Claude Planning Pane"
    });
    expect(liveProcesses.data.find((process) => process.pid === 350)).toMatchObject({ ownership: "OTHER" });
    expect(JSON.stringify(liveProcesses)).not.toContain("--secret hidden");

    const models = await service.models("10m");
    expect(models.models.find((model) => model.modelId === "claude-sonnet-4")).toMatchObject({
      providerId: "anthropic",
      coverage: "SESSION_ONLY",
      activeSessions: 1
    });
    await service.dispose();
  });

  it("marks native-capable sessions as SESSION_ONLY until native events actually exist", async () => {
    const input = fixture();
    input.session.runtimeId = "cli:codex";
    input.session.providerId = "codex";
    input.session.modelId = "gpt-5.6-sol";
    input.session.codexThreadId = null;
    input.live.runtimeId = "cli:codex";
    input.live.modelId = "gpt-5.6-sol";
    input.live.codexThreadId = null;
    const service = new SystemAnalyticsService({
      repository: new InMemorySystemAnalyticsRepository(),
      store: createStore(input),
      liveSessions: async () => [input.live],
      now: () => new Date(sampledAt),
      coreCount: 4,
      readProcessTable: async () => [],
      readMeminfo: async () => "MemTotal: 1000 kB\nMemAvailable: 400 kB\nCached: 200 kB\nShmem: 10 kB\nSwapTotal: 100 kB\nSwapFree: 75 kB\n",
      readProcStat: async () => "cpu  100 0 100 800 0 0 0 0 0 0\n"
    });

    await service.sample();
    await expect(service.models("10m")).resolves.toMatchObject({
      models: [expect.objectContaining({ modelId: "gpt-5.6-sol", coverage: "SESSION_ONLY", activeSessions: 1 })]
    });
    await service.dispose();
  });

  it("keeps stale RUNNING native rows out of current model analytics", async () => {
    const input = fixture();
    const repository = new InMemorySystemAnalyticsRepository();
    await repository.upsertModelEvents([{
      eventKey: "codex:stale:turn",
      source: "codex",
      runtimeId: "cli:codex",
      providerId: "codex-lb",
      modelId: "stale-model",
      roomId: null,
      paneId: null,
      sessionId: "cli_session:stale",
      turnId: "turn:stale",
      status: "RUNNING",
      coverage: "NATIVE",
      turnCount: 1,
      startedAt: "2026-12-01T00:00:00.000Z",
      endedAt: null,
      tokensIn: 100,
      tokensOut: 10,
      tokensReasoning: 0,
      ttftMs: null,
      durationMs: null,
      updatedAt: "2026-12-01T00:00:00.000Z"
    }]);
    const service = new SystemAnalyticsService({
      repository,
      store: createStore(input),
      liveSessions: async () => [input.live],
      now: () => new Date(sampledAt),
      coreCount: 4,
      readProcessTable: async () => [],
      readMeminfo: async () => "MemTotal: 1000 kB\nMemAvailable: 400 kB\nCached: 200 kB\nShmem: 10 kB\nSwapTotal: 100 kB\nSwapFree: 75 kB\n",
      readProcStat: async () => "cpu  100 0 100 800 0 0 0 0 0 0\n"
    });

    await service.sample();
    expect((await service.models("30d")).models.some((model) => model.modelId === "stale-model")).toBe(false);
    await service.dispose();
  });

  it("shows a running host session even while its database row is temporarily unavailable", async () => {
    const input = fixture();
    const store = {
      listRooms: () => [input.room],
      listPanes: () => [input.pane],
      listActivePaneCliSessions: () => [],
      listPaneCliSessions: () => []
    } as unknown as SpaceStore;
    const service = new SystemAnalyticsService({
      repository: new InMemorySystemAnalyticsRepository(),
      store,
      liveSessions: async () => [input.live],
      now: () => new Date(sampledAt),
      coreCount: 4,
      readProcessTable: async () => [],
      readMeminfo: async () => "MemTotal: 1000 kB\nMemAvailable: 400 kB\nCached: 200 kB\nShmem: 10 kB\nSwapTotal: 100 kB\nSwapFree: 75 kB\n",
      readProcStat: async () => "cpu  100 0 100 800 0 0 0 0 0 0\n"
    });

    await service.sample();
    await expect(service.cliSessions("10m")).resolves.toMatchObject({
      summary: { running: 1 },
      sessions: [expect.objectContaining({ sessionId: input.live.cliSessionId, paneTitle: input.pane.title })]
    });
    await service.dispose();
  });
});

describe("parseCodexNativeTurns", () => {
  it("keeps native provider identity and active/aborted lifecycle events", () => {
    const content = [
      JSON.stringify({ timestamp: "2027-01-15T07:59:40.000Z", type: "session_meta", payload: { model_provider: "codex-lb" } }),
      JSON.stringify({ timestamp: "2027-01-15T07:59:42.000Z", type: "turn_context", payload: { turn_id: "turn:one", model: "gpt-5.6-sol" } }),
      JSON.stringify({ timestamp: "2027-01-15T07:59:43.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn:one" } }),
      JSON.stringify({ timestamp: "2027-01-15T07:59:45.000Z", type: "event_msg", payload: { type: "token_count", turn_id: "turn:one", info: { last_token_usage: { input_tokens: 200, output_tokens: 20, reasoning_output_tokens: 5 } } } }),
      JSON.stringify({ timestamp: "2027-01-15T07:59:50.000Z", type: "event_msg", payload: { type: "turn_aborted", turn_id: "turn:one" } }),
      JSON.stringify({ timestamp: "2027-01-15T07:59:52.000Z", type: "turn_context", payload: { turn_id: "turn:two", model: "gpt-5.6-sol" } }),
      JSON.stringify({ timestamp: "2027-01-15T07:59:53.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn:two" } })
    ].join("\n");
    const turns = parseCodexNativeTurns(content, Date.parse("2027-01-15T07:50:00.000Z"), Date.parse(sampledAt));
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ providerId: "codex-lb", modelId: "gpt-5.6-sol", status: "ABORTED", tokensIn: 200, tokensOut: 20 });
    expect(turns[1]).toMatchObject({ providerId: "codex-lb", modelId: "gpt-5.6-sol", status: "RUNNING" });
  });
});
