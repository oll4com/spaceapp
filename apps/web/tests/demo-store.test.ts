import {
  agentPaneSessionSchema,
  artifactSchema,
  codexAppServerHandshakeCheckSchema,
  codexAppServerStatusSchema,
  codexAppServerTurnSmokeCheckSchema,
  clipboardItemListResponseSchema,
  clipboardItemSchema,
  taskItemListResponseSchema,
  taskItemSchema,
  cliSessionReapResponseSchema,
  cliSessionStatsSchema,
  cliRuntimeDisablePreviewSchema,
  codexHistoryPurgePreviewResponseSchema,
  codexHistoryPurgeResponseSchema,
  codexLbSpeedDefaultsResponseSchema,
  codexEnvironmentSchema,
  codexResetCreditAvailabilitySchema,
  codexResetCreditRedemptionResponseSchema,
  codexHistoryResponseSchema,
  codexThreadResponseSchema,
  codexUsageAccountListSchema,
  deleteRoomMediaResponseSchema,
  hostMemoryDetailsSchema,
  launchReadinessSchema,
  mcpDiscoverySmokeCheckSchema,
  mcpGatewayStatusSchema,
  mcpToolExecutionResultSchema,
  memoryEmbeddingSmokeCheckSchema,
  memoryChangeSetSchema,
  memoryChangeSetSummarySchema,
  memoryConsolidationCommandResponseSchema,
  memoryConsolidationDetailSchema,
  memoryGraphIssueSchema,
  memoryGraphNodeDetailSchema,
  memoryGraphOverviewPayloadSchema,
  memoryGraphPayloadSchema,
  memoryReclaimResponseSchema,
  memoryVectorReadinessSchema,
  observabilitySnapshotSchema,
  providerSettingsSchema,
  roomCliActivityResponseSchema,
  serviceRestartResponseSchema,
  storageReadinessSchema,
  systemAnalyticsCliSessionsResponseSchema,
  systemAnalyticsModelsResponseSchema,
  systemAnalyticsOverviewResponseSchema,
  systemAnalyticsProcessesResponseSchema,
  systemAnalyticsResourcesResponseSchema,
  telegramIntegrationStatusSchema,
  telegramPairingResponseSchema,
  updateCliRuntimeSettingResultSchema,
  userLinkListResponseSchema,
  userLinkSchema,
  voiceTranscriptionSettingsSchema,
  workerReadinessSchema
} from "@space/contracts";
import { describe, expect, it } from "vitest";
import { DEMO_LOCAL_REPLY, DEMO_WARNING, DemoStore } from "../src/demo/DemoStore.js";
import { DEMO_FIXTURE_VERSION } from "../src/demo/demo-fixture.js";

describe("Space deterministic demo store", () => {
  it("starts from the versioned Graphite ADMIN focus fixture", async () => {
    const store = new DemoStore();
    const me = await store.api.me();
    const rooms = await store.api.rooms();
    const panes = await store.api.panes(rooms.data[0]!.id);

    expect(DEMO_FIXTURE_VERSION).toBe("space-demo-v1");
    expect(me).toMatchObject({ isAuthenticated: true, user: { role: "ADMIN" } });
    expect(rooms.data[0]).toMatchObject({ name: "Launch Control", paneLayoutColumns: 3, paneCap: 16 });
    expect(panes.data.filter((pane) => !pane.isMinimized)).toHaveLength(6);
    expect(panes.data.filter((pane) => pane.isMinimized)).toHaveLength(1);
    expect((await store.api.admin()).storageWarning).toBe(DEMO_WARNING);
  });

  it("enforces the production pane cap and reset restores the canonical fixture", async () => {
    const store = new DemoStore();
    const room = (await store.api.rooms()).data[0]!;

    while ((await store.api.panes(room.id)).data.length < 16) {
      await store.api.createPane(room.id, "Local pane", "CHAT");
    }
    await expect(store.api.createPane(room.id, "Pane 17", "CHAT")).rejects.toMatchObject({
      code: "PANE_CAP_REACHED"
    });

    store.reset();
    expect((await store.api.panes(room.id)).data).toHaveLength(7);
  });

  it("creates mixed pane batches atomically through the demo adapter", async () => {
    const store = new DemoStore();
    const room = await store.api.createRoom("Batch demo", 0);
    const result = await store.api.createRoomPanes(room.id, {
      panes: [
        { mode: "TERMINAL", terminalRuntimeId: "cli:codex" },
        { mode: "TERMINAL", terminalRuntimeId: "cli:opencode" },
        { mode: "CHAT" }
      ]
    });

    expect(result.data.map((pane) => ({ title: pane.title, runtime: pane.terminalRuntimeId, cwd: pane.cwd }))).toEqual([
      { title: "Codex CLI 1", runtime: "cli:codex", cwd: "/etc" },
      { title: "OpenCode CLI 2", runtime: "cli:opencode", cwd: "/etc" },
      { title: "Chat 3", runtime: null, cwd: null }
    ]);
    expect((await store.api.panes(room.id)).data).toHaveLength(3);
  });

  it("exposes all thirteen CLI runtimes in canonical order and restores hidden runtimes unchanged", async () => {
    const store = new DemoStore();
    const runtimes = await store.api.cliRuntimes();

    expect(runtimes.data.filter((runtime) => runtime.id !== "cli:root").map((runtime) => runtime.id)).toEqual([
      "cli:opencode",
      "cli:codex",
      "cli:claude",
      "cli:gemini",
      "cli:autohand",
      "cli:qwen",
      "cli:kimi",
      "cli:grok",
      "cli:deepseek",
      "cli:cursor",
      "cli:copilot",
      "cli:hermes",
      "cli:omp",
      "cli:qoder",
      "cli:muse",
      "cli:droid"
    ]);

    const preview = await store.api.cliRuntimeDisablePreview("cli:deepseek");
    expect(preview).toMatchObject({ runtimeId: "cli:deepseek", activeSessionCount: 0, openPaneCount: 0 });
    await store.api.updateCliRuntimeSetting("cli:deepseek", {
      enabled: false,
      confirmationToken: preview.confirmationToken
    });
    expect((await store.api.cliRuntimes()).data.some((runtime) => runtime.id === "cli:deepseek")).toBe(false);
    expect((await store.api.cliRuntimeSettings()).settings.find((setting) => setting.runtimeId === "cli:deepseek")?.enabled).toBe(false);

    await store.api.updateCliRuntimeSetting("cli:deepseek", { enabled: true });
    expect((await store.api.cliRuntimes()).data.find((runtime) => runtime.id === "cli:deepseek"))
      .toMatchObject({ displayName: "DeepSeek CLI", defaultModelId: null });
  });

  it("exposes synchronous CLI runtime settings cache helpers in demo mode", async () => {
    const store = new DemoStore();
    const snapshot = store.api.cliRuntimeSettingsSnapshot();

    expect(snapshot?.settings).toHaveLength(16);
    expect(snapshot?.runtimes).toHaveLength(16);
    expect(store.api.invalidateCliRuntimeSettings()).toBeUndefined();
    expect(store.api.warmCliRuntimeSettings()).toBeUndefined();
    expect(store.api.resetCliRuntimeSettingsCache()).toBeUndefined();
    await expect(store.api.cliRuntimeSettings({ forceRefresh: true })).resolves.toEqual(snapshot);
  });

  it("reports deterministic running CLI counts for every demo room", async () => {
    const store = new DemoStore();
    const emptyRoom = await store.api.createRoom("Empty demo room", 0);

    expect(
      roomCliActivityResponseSchema.parse(await store.api.roomCliActivity()).data
    ).toContainEqual({ roomId: emptyRoom.id, runningCliCount: 0, paneCount: 0, runtimeIds: [] });

    await store.api.createPane(emptyRoom.id, "OpenCode CLI", "TERMINAL", {
      terminalRuntimeId: "cli:opencode"
    });
    expect((await store.api.roomCliActivity()).data).toContainEqual({
      roomId: emptyRoom.id,
      runningCliCount: 1,
      paneCount: 1,
      runtimeIds: ["cli:opencode"]
    });
  });

  it("does not mutate demo panes when a later batch runtime is unavailable", async () => {
    const store = new DemoStore();
    const room = await store.api.createRoom("Rejected batch demo", 0);

    await expect(store.api.createRoomPanes(room.id, {
      panes: [
        { mode: "CHAT" },
        { mode: "TERMINAL", terminalRuntimeId: "cli:root" }
      ]
    })).rejects.toMatchObject({ code: "CONFLICT" });

    expect((await store.api.panes(room.id)).data).toHaveLength(0);
  });

  it("handles every free-form send locally with the fixed disclosure", async () => {
    const store = new DemoStore();
    const room = (await store.api.rooms()).data[0]!;
    const chat = (await store.api.panes(room.id)).data.find((pane) => pane.mode === "CHAT")!;

    const session = await store.api.sendAgentMessage(chat.id, "Run production deploy");
    expect(session.messages.at(-1)?.content).toBe(DEMO_LOCAL_REPLY);
  });

  it("returns contract-valid deterministic toolbar metrics", async () => {
    const store = new DemoStore();
    const environment = await store.api.codexEnvironment();

    expect(codexEnvironmentSchema.parse(environment)).toEqual(environment);
    expect(environment.config.modelProvider).toBe("space-gateway");
    expect(environment.hostStats?.cliSessions).toEqual({ active: 3, attached: 2, detached: 1, status: "OK" });
  });

  it("returns contract-valid global system analytics fixtures", async () => {
    const store = new DemoStore();
    const overview = await store.api.systemAnalyticsOverview("1h");
    const models = await store.api.systemAnalyticsModels("7d");
    const resources = await store.api.systemAnalyticsResources("30d");
    const processes = await store.api.systemAnalyticsProcesses({ sort: "cpu" });
    const sessions = await store.api.systemAnalyticsCliSessions("10m");

    expect(systemAnalyticsOverviewResponseSchema.parse(overview)).toEqual(overview);
    expect(systemAnalyticsModelsResponseSchema.parse(models)).toEqual(models);
    expect(systemAnalyticsResourcesResponseSchema.parse(resources)).toEqual(resources);
    expect(systemAnalyticsProcessesResponseSchema.parse(processes)).toEqual(processes);
    expect(systemAnalyticsCliSessionsResponseSchema.parse(sessions)).toEqual(sessions);
    expect(resources.entities.map((entity) => entity.paneTitle).filter(Boolean)).toContain("Codex CLI");
  });

  it("simulates two reset credits locally with deterministic idempotency", async () => {
    const store = new DemoStore();
    const idempotencyKey = "9943e22b-97a3-48b6-ae84-1a2cced6a353";

    const before = await store.api.toolbarResetCredits();
    const first = await store.api.redeemToolbarResetCredit("account:demo-public", idempotencyKey);
    const retry = await store.api.redeemToolbarResetCredit("account:demo-public", idempotencyKey);
    const after = await store.api.toolbarResetCredits();

    expect(codexResetCreditAvailabilitySchema.parse(before)).toEqual(before);
    expect(codexResetCreditRedemptionResponseSchema.parse(first)).toEqual(first);
    expect(first).toEqual(retry);
    expect(before.data).toEqual([{ accountId: "account:demo-public", availableCreditCount: 2 }]);
    expect(after.data).toEqual([{ accountId: "account:demo-public", availableCreditCount: 1 }]);

    store.reset();
    expect((await store.api.toolbarResetCredits()).data[0]?.availableCreditCount).toBe(2);
  });

  it("keeps the Codex-Off demo state local and does not reopen panes when enabled again", async () => {
    const store = new DemoStore();
    const preview = await store.api.cliRuntimeDisablePreview("cli:codex");
    const disabled = await store.api.updateCliRuntimeSetting("cli:codex", {
      enabled: false,
      confirmationToken: preview.confirmationToken
    });

    expect(cliRuntimeDisablePreviewSchema.parse(preview)).toEqual(preview);
    expect(updateCliRuntimeSettingResultSchema.parse(disabled)).toEqual(disabled);
    expect(preview).toMatchObject({ activeSessionCount: 1, openPaneCount: 1, openChatPaneCount: 2 });
    expect((await store.api.codexEnvironment()).isCodexEnabled).toBe(false);
    expect((await store.api.cliRuntimes()).data.find((runtime) => runtime.id === "cli:codex")).toMatchObject({
      id: "cli:codex",
      displayName: "Codex CLI"
    });
    expect((await store.api.panes("room:demo-launch")).data.some((pane) =>
      pane.mode === "CHAT" || pane.terminalRuntimeId === "codex" || pane.terminalRuntimeId === "cli:codex"
    )).toBe(false);

    await store.api.updateCliRuntimeSetting("cli:codex", { enabled: true });
    expect((await store.api.codexEnvironment()).isCodexEnabled).toBe(true);
    expect((await store.api.panes("room:demo-launch")).data.some((pane) =>
      pane.mode === "CHAT" || pane.terminalRuntimeId === "codex" || pane.terminalRuntimeId === "cli:codex"
    )).toBe(false);
  });

  it("returns contract-valid local Codex history and transcript data", async () => {
    const store = new DemoStore();
    const history = await store.api.codexHistory();
    const thread = await store.api.codexThread(history.data[0]!.id, "chat");

    expect(codexHistoryResponseSchema.parse(history)).toEqual(history);
    expect(codexThreadResponseSchema.parse(thread)).toEqual(thread);
    expect(thread.items.at(-1)?.content).toBe(DEMO_LOCAL_REPLY);
  });

  it("returns contract-valid local storage and launch readiness", async () => {
    const store = new DemoStore();
    const storage = await store.api.storage();
    const launchReadiness = await store.api.launchReadiness();

    expect(storageReadinessSchema.parse(storage)).toEqual(storage);
    expect(launchReadinessSchema.parse(launchReadiness)).toEqual(launchReadiness);
  });

  it("returns contract-valid toolbar detail and no-mutation action results", async () => {
    const store = new DemoStore();

    const usage = await store.api.toolbarUsageAccounts();
    const cli = await store.api.toolbarCliSessions();
    const cliReap = await store.api.reapToolbarCliSessions();
    const memory = await store.api.toolbarHostMemory();
    const memoryReclaim = await store.api.reclaimToolbarMemory();
    const speedDefaults = await store.api.codexLbSpeedDefaults();
    const updatedSpeedDefaults = await store.api.updateCodexLbSpeedDefault("gpt-5.5", "FAST");

    expect(codexUsageAccountListSchema.parse(usage)).toEqual(usage);
    expect(cliSessionStatsSchema.parse(cli)).toEqual(cli);
    expect(cliSessionReapResponseSchema.parse(cliReap)).toEqual(cliReap);
    expect(cliReap.status).toBe("NOOP");
    expect(hostMemoryDetailsSchema.parse(memory)).toEqual(memory);
    expect(memoryReclaimResponseSchema.parse(memoryReclaim)).toEqual(memoryReclaim);
    expect(memoryReclaim.status).toBe("NOOP");
    expect(codexLbSpeedDefaultsResponseSchema.parse(speedDefaults)).toEqual(speedDefaults);
    expect(codexLbSpeedDefaultsResponseSchema.parse(updatedSpeedDefaults)).toEqual(updatedSpeedDefaults);
    expect(updatedSpeedDefaults).toEqual(speedDefaults);
  });

  it("returns contract-valid local admin diagnostics and keeps protected actions as no-ops", async () => {
    const store = new DemoStore();
    const readinessBefore = await store.api.readyz();
    const mcp = await store.api.mcp();
    const mcpSmoke = await store.api.runMcpDiscoverySmoke();
    const vectorReadiness = await store.api.memoryVectorReadiness();
    const embeddingSmoke = await store.api.runMemoryEmbeddingSmoke();
    const codexStatus = await store.api.codexAppServer();
    const codexHandshake = await store.api.runCodexAppServerHandshake();
    const codexTurnSmoke = await store.api.runCodexAppServerTurnSmoke();
    const mcpExecution = await store.api.executeMcpTool({
      toolId: "mcp-gateway:execution-gate-smoke",
      arguments: {},
      approvalReason: "Demo admin diagnostics proof."
    });
    const observability = await store.api.observability();
    const worker = await store.api.worker();
    const historyPreview = await store.api.previewCodexHistoryPurge();
    const historyPurge = await store.api.executeCodexHistoryPurge(historyPreview.previewId, "PURGE HISTORY");
    const restart = await store.api.restartCoreServices();
    const readinessAfter = await store.api.readyz();

    expect(mcpGatewayStatusSchema.parse(mcp.gateway)).toEqual(mcp.gateway);
    expect(mcpDiscoverySmokeCheckSchema.parse(mcpSmoke)).toEqual(mcpSmoke);
    expect(memoryVectorReadinessSchema.parse(vectorReadiness.data)).toEqual(vectorReadiness.data);
    expect(memoryEmbeddingSmokeCheckSchema.parse(embeddingSmoke)).toEqual(embeddingSmoke);
    expect(codexAppServerStatusSchema.parse(codexStatus)).toEqual(codexStatus);
    expect(codexAppServerHandshakeCheckSchema.parse(codexHandshake)).toEqual(codexHandshake);
    expect(codexAppServerTurnSmokeCheckSchema.parse(codexTurnSmoke)).toEqual(codexTurnSmoke);
    expect(mcpToolExecutionResultSchema.parse(mcpExecution)).toEqual(mcpExecution);
    expect(observabilitySnapshotSchema.parse(observability)).toEqual(observability);
    expect(workerReadinessSchema.parse(worker)).toEqual(worker);
    expect(codexHistoryPurgePreviewResponseSchema.parse(historyPreview)).toEqual(historyPreview);
    expect(codexHistoryPurgeResponseSchema.parse(historyPurge)).toEqual(historyPurge);
    expect(serviceRestartResponseSchema.parse(restart)).toEqual(restart);
    expect(historyPurge).toMatchObject({
      status: "NOOP",
      purged: { threads: 0, cliTasks: 0, indexEntries: 0, rolloutFiles: 0, shellSnapshots: 0 }
    });
    expect(readinessAfter).toEqual(readinessBefore);
    expect([
      mcp.gateway.statusReason,
      mcpSmoke.message,
      embeddingSmoke.message,
      codexStatus.statusReason,
      codexHandshake.message,
      codexTurnSmoke.message,
      mcpExecution.message
    ]).toEqual(Array(7).fill(DEMO_LOCAL_REPLY));
  });

  it("returns contract-valid deterministic Memory workspace data", async () => {
    const store = new DemoStore();
    const overview = await store.api.memoryGraphOverview();
    const graph = await store.api.memoryGraph({ page: 1, pageSize: 100 });
    const filteredGraph = await store.api.memoryGraph({
      q: "public launch",
      nodeType: "MEMORY",
      scope: "ROOM",
      roomId: "room:demo-launch",
      sourcePath: "/demo/memory/public-launch.md",
      lifecycleStatus: "ACTIVE",
      relationMode: "CLUSTERED",
      page: 1,
      pageSize: 1
    });
    const issues = await store.api.memoryGraphIssues({ status: "OPEN", pageSize: 100 });
    const detail = await store.api.memoryGraphNode("memory:demo-public-launch");
    const changeSets = await store.api.memoryChangeSets({ page: 1, pageSize: 25 });
    const changeSet = await store.api.memoryChangeSet("memory_change:demo-public-launch");
    const issueAfterResolve = await store.api.updateMemoryGraphIssue("memory_issue:demo-review", {
      status: "RESOLVED",
      reason: null,
      expectedVersion: 1
    });
    const audit = await store.api.createMemoryConsolidation({ mode: "AUDIT" }, "memory-audit:demo-test");
    const auditDetail = await store.api.memoryConsolidation(audit.run.id);
    const proposal = await store.api.createMemoryNodeChangeSet("memory:demo-public-launch", {
      kind: "ARCHIVE",
      expectedContentHash: "b".repeat(64),
      reason: "Archive only in the local demo."
    }, "memory-node:archive:demo-test");
    const reviewed = await store.api.reviewMemoryChangeSet("memory_change:demo-public-launch", { status: "APPROVED" });
    const execution = await store.api.executeMemoryChangeSet("memory_change:demo-public-launch", "memory-execute:demo-test");
    const unchangedChangeSet = await store.api.memoryChangeSet("memory_change:demo-public-launch");

    expect(memoryGraphOverviewPayloadSchema.parse(overview.data)).toEqual(overview.data);
    expect(memoryGraphPayloadSchema.parse(graph.data)).toEqual(graph.data);
    expect(memoryGraphPayloadSchema.parse(filteredGraph.data)).toEqual(filteredGraph.data);
    expect(issues.data.map((issue) => memoryGraphIssueSchema.parse(issue))).toEqual(issues.data);
    expect(memoryGraphNodeDetailSchema.parse(detail)).toEqual(detail);
    expect(changeSets.data.map((item) => memoryChangeSetSummarySchema.parse(item))).toEqual(changeSets.data);
    expect(memoryChangeSetSchema.parse(changeSet)).toEqual(changeSet);
    expect(memoryGraphIssueSchema.parse(issueAfterResolve)).toEqual(issueAfterResolve);
    expect(memoryConsolidationCommandResponseSchema.parse(audit)).toEqual(audit);
    expect(memoryConsolidationDetailSchema.parse(auditDetail)).toEqual(auditDetail);
    expect(memoryChangeSetSummarySchema.parse(proposal)).toEqual(proposal);
    expect(memoryChangeSetSummarySchema.parse(reviewed)).toEqual(reviewed);
    expect(overview.data.nodes.map((node) => node.id)).toContain("memory:demo-public-launch");
    expect(filteredGraph.data.nodes.map((node) => node.id)).toEqual(["memory:demo-public-launch"]);
    expect(filteredGraph.data.filters).toMatchObject({
      q: "public launch",
      nodeType: "MEMORY",
      scope: "ROOM",
      roomId: "room:demo-launch",
      lifecycleStatus: "ACTIVE",
      relationMode: "CLUSTERED"
    });
    expect(changeSets.mutationsEnabled).toBe(false);
    expect(issueAfterResolve).toMatchObject({ status: "OPEN", statusReason: DEMO_LOCAL_REPLY, stateVersion: 1 });
    expect(audit.run).toMatchObject({ status: "SUCCEEDED", statusReason: DEMO_LOCAL_REPLY });
    expect(proposal).toMatchObject({ kind: "ARCHIVE", status: "PROPOSED", statusReason: DEMO_LOCAL_REPLY });
    expect(reviewed).toMatchObject({ status: "PROPOSED", statusReason: DEMO_LOCAL_REPLY });
    expect(execution).toEqual({ status: "ALREADY_SCHEDULED", workflowId: "memory-demo:no-op", runId: null });
    expect(unchangedChangeSet).toEqual(changeSet);
  });

  it("keeps Links and Clipboard CRUD local, deterministic, and contract-valid", async () => {
    const store = new DemoStore();

    const initialLinks = await store.api.links();
    const createdLink = await store.api.createLink({
      title: "Demo runbook",
      description: "A session-only public demo link.",
      url: "https://demo.invalid/runbook",
      openMode: "EMBEDDED",
      category: "GENERAL",
      isQuick: false
    });
    const updatedLink = await store.api.updateLink(createdLink.id, { isQuick: true });
    const filteredLinks = await store.api.links({ q: "RUNBOOK", isQuick: true, page: 1, pageSize: 1 });
    const deletedLink = await store.api.deleteLink(createdLink.id);
    const linksAfterDelete = await store.api.links();

    expect(userLinkListResponseSchema.parse(initialLinks)).toEqual(initialLinks);
    expect(userLinkSchema.parse(createdLink)).toEqual(createdLink);
    expect(userLinkSchema.parse(updatedLink)).toEqual(updatedLink);
    expect(updatedLink.isQuick).toBe(true);
    expect(filteredLinks).toMatchObject({
      data: [{ id: createdLink.id }],
      pagination: { page: 1, pageSize: 1, totalItems: 1, totalPages: 1 }
    });
    expect(deletedLink).toEqual({ id: createdLink.id, deleted: true });
    expect(userLinkListResponseSchema.parse(linksAfterDelete)).toEqual(linksAfterDelete);
    expect(linksAfterDelete.data.some((link) => link.id === createdLink.id)).toBe(true);

    const createdClip = await store.api.createClipboardItem({
      text: "Session-only public demo note",
      source: "MANUAL_NOTE"
    });
    const initialClips = await store.api.clipboardItems();
    const deletedClip = await store.api.deleteClipboardItem(createdClip.id);
    const clearedClips = await store.api.clearClipboardItems();
    const clipsAfterDestructiveActions = await store.api.clipboardItems();

    expect(clipboardItemSchema.parse(createdClip)).toEqual(createdClip);
    expect(clipboardItemListResponseSchema.parse(initialClips)).toEqual(initialClips);
    expect(deletedClip).toEqual({ id: createdClip.id, deleted: true });
    expect(clearedClips).toEqual({ deletedCount: 0 });
    expect(clipboardItemListResponseSchema.parse(clipsAfterDestructiveActions)).toEqual(clipsAfterDestructiveActions);
    expect(clipsAfterDestructiveActions.data.some((item) => item.id === createdClip.id)).toBe(true);

    store.reset();
    expect((await store.api.links()).data.some((link) => link.id === createdLink.id)).toBe(false);
    expect((await store.api.clipboardItems()).data.some((item) => item.id === createdClip.id)).toBe(false);
  });

  it("returns local task fixtures and keeps destructive task actions contract-valid in demo mode", async () => {
    const store = new DemoStore();
    const initialTasks = await store.api.taskItems();
    expect(taskItemListResponseSchema.parse(initialTasks)).toEqual(initialTasks);
    expect(initialTasks.data.length).toBeGreaterThan(0);
    expect(initialTasks.data[0]).toMatchObject({ status: "OPEN", source: "MANUAL" });

    const createdTask = await store.api.createTaskItem({
      title: "Demo task",
      objective: "Session-only public demo task",
      status: "OPEN"
    });
    const tasksAfterCreate = await store.api.taskItems();
    expect(taskItemSchema.parse(createdTask)).toEqual(createdTask);
    expect(createdTask).toMatchObject({ title: "Demo task", status: "OPEN", source: "MANUAL" });
    expect(tasksAfterCreate.data.some((item) => item.id === createdTask.id)).toBe(true);

    const updatedTask = await store.api.updateTaskItem(createdTask.id, { status: "RUNNING" });
    expect(updatedTask).toMatchObject({ id: createdTask.id, status: "RUNNING" });
    expect(updatedTask.characterCount).toBe(createdTask.characterCount);

    const objectiveTask = await store.api.updateTaskItem(createdTask.id, { objective: "Replaced objective" });
    expect(objectiveTask).toMatchObject({ objective: "Replaced objective", characterCount: 18 });

    const deletedTask = await store.api.deleteTaskItem(createdTask.id);
    const clearedTasks = await store.api.clearTaskItems();
    const tasksAfterDestructiveActions = await store.api.taskItems();

    expect(deletedTask).toEqual({ id: createdTask.id, deleted: true });
    expect(clearedTasks).toEqual({ deletedCount: 0 });
    expect(taskItemListResponseSchema.parse(tasksAfterDestructiveActions)).toEqual(tasksAfterDestructiveActions);
    expect(tasksAfterDestructiveActions.data.some((item) => item.id === createdTask.id)).toBe(true);

    store.reset();
    expect((await store.api.taskItems()).data.some((item) => item.id === createdTask.id)).toBe(false);
  });

  it("returns local Media fixtures and keeps room-wide deletion as a contract-valid no-op", async () => {
    const store = new DemoStore();
    const roomId = (await store.api.rooms()).data[0]!.id;

    const media = await store.api.artifacts({ roomId, page: 1, pageSize: 1, sortOrder: "desc" });
    const ascendingMedia = await store.api.artifacts({ roomId, pageSize: 100, sortOrder: "asc" });
    const exportMedia = await store.api.artifacts({
      roomId,
      paneId: "pane:demo-codex",
      kind: "EXPORT",
      pageSize: 100,
      sortOrder: "desc"
    });
    const otherRoomMedia = await store.api.artifacts({ roomId: "room:demo-research", pageSize: 100 });
    const deleted = await store.api.deleteArtifact(media.data[0]!.id);
    const cleared = await store.api.deleteRoomMedia(roomId);
    const mediaAfterClear = await store.api.artifacts({ roomId, pageSize: 100, sortOrder: "desc" });

    expect(media.data).toHaveLength(1);
    expect(media.data[0]!.id).toBe("artifact:demo-launch-image");
    expect(artifactSchema.parse(media.data[0])).toEqual(media.data[0]);
    expect(media.pagination).toMatchObject({ page: 1, pageSize: 1, totalItems: 2, totalPages: 2 });
    expect(ascendingMedia.data.map((artifact) => artifact.id)).toEqual([
      "artifact:demo-launch-notes",
      "artifact:demo-launch-image"
    ]);
    expect(exportMedia.data.map((artifact) => artifact.id)).toEqual(["artifact:demo-launch-notes"]);
    expect(otherRoomMedia.data).toEqual([]);
    expect(store.api.artifactFileUrl(media.data[0]!.id)).toMatch(/^data:image\/svg\+xml,/);
    expect(deleted).toEqual({ ok: true, artifactId: media.data[0]!.id });
    expect(deleteRoomMediaResponseSchema.parse(cleared)).toEqual(cleared);
    expect(cleared).toEqual({
      ok: true,
      roomId,
      matchedCount: 0,
      deletedCount: 0,
      failedCount: 0,
      failedArtifactIds: []
    });
    expect(mediaAfterClear.data).toHaveLength(2);
  });

  it("returns typed Settings fixtures, persists reversible controls, and keeps disconnect as a no-op", async () => {
    const store = new DemoStore();

    const initialProviderSettings = await store.api.providerSettings();
    const updatedProviderSettings = await store.api.updateProviderSettings({ defaultProviderId: "demo-direct" });
    const telegram = await store.api.telegramIntegration();
    const telegramAfterTest = await store.api.sendTelegramTestDelivery();
    const telegramAfterDisconnect = await store.api.disconnectTelegramIntegration();
    const telegramPairing = await store.api.createTelegramPairing("123456:demo_token_value_000000000");
    const telegramAfterPairing = await store.api.checkTelegramPairing(telegramPairing.pairing.id);
    const voice = await store.api.voiceTranscriptionSettings();
    const agent = await store.api.agentSession("pane:demo-chat");
    const agentAfterToggle = await store.api.updateAgentSettings("pane:demo-chat", { selectedToolIds: [] });

    expect(providerSettingsSchema.parse(initialProviderSettings)).toEqual(initialProviderSettings);
    expect(initialProviderSettings.defaultProviderId).toBe("demo-codex");
    expect(providerSettingsSchema.parse(updatedProviderSettings)).toEqual(updatedProviderSettings);
    expect((await store.api.providerSettings()).defaultProviderId).toBe("demo-direct");
    expect(telegramIntegrationStatusSchema.parse(telegram)).toEqual(telegram);
    expect(telegram.connectionStatus).toBe("CONNECTED");
    expect(telegramAfterTest).toEqual(telegram);
    expect(telegramAfterDisconnect).toEqual(telegram);
    expect(telegramPairingResponseSchema.parse(telegramPairing)).toEqual(telegramPairing);
    expect(telegramPairing.integration.connectionStatus).toBe("PAIRING");
    expect(telegramIntegrationStatusSchema.parse(telegramAfterPairing)).toEqual(telegramAfterPairing);
    expect(telegramAfterPairing.connectionStatus).toBe("CONNECTED");
    expect(voiceTranscriptionSettingsSchema.parse(voice)).toEqual(voice);
    expect(voice).toMatchObject({ enabled: false, defaultLanguage: "auto" });
    expect(agentPaneSessionSchema.parse(agent)).toEqual(agent);
    expect(agent.toolOptions).toHaveLength(2);
    expect(agent.selectedToolIds).toEqual(["space-readonly:space_status"]);
    expect(agentPaneSessionSchema.parse(agentAfterToggle)).toEqual(agentAfterToggle);
    expect(agentAfterToggle.selectedToolIds).toEqual([]);

    store.reset();
    expect((await store.api.providerSettings()).defaultProviderId).toBe("demo-codex");
    expect((await store.api.agentSession("pane:demo-chat")).selectedToolIds).toEqual(["space-readonly:space_status"]);
  });
});

it("keeps demo Dot session identity immutable and rejects cross-Dot/room restores", async () => {
  const store = new DemoStore();
  const { dots } = await store.api.dots();
  const first = await store.api.agentSession("pane:demo-research-chat");
  expect(first.dotId).toBe(dots[0]!.dotId);
  const nova = await store.api.createAgentSession("pane:demo-research-chat", { dotId: dots[1]!.dotId, sessionId: null });
  expect(nova.dotId).toBe(dots[1]!.dotId); expect(nova.messages).toEqual([]);
  expect((await store.api.dotCollection(dots[1]!.dotId, "sessions")).items.every(item => item.dotId === dots[1]!.dotId)).toBe(true);
  await expect(store.api.createAgentSession("pane:demo-research-chat", { dotId: dots[1]!.dotId, sessionId: first.binding.sessionId })).rejects.toThrow();
  await expect(store.api.sendAgentMessage("pane:demo-research-chat", "Old context", null, [], [], "request:demo-old", undefined,
    { sessionId: first.binding.sessionId!, dotId: dots[0]!.dotId })).rejects.toThrow();
});

it("moves a restored Dot session without sharing messages with its previous pane, including after reload", async () => {
  const store = new DemoStore();
  const room = (await store.api.rooms()).data[0]!;
  const source = await store.api.createPane(room.id, "Source", "CHAT");
  const destination = await store.api.createPane(room.id, "Destination", "CHAT");
  const original = await store.api.agentSession(source.id);
  await store.api.sendAgentMessage(source.id, "Source history");
  const moved = await store.api.createAgentSession(destination.id, { dotId: original.dotId!, sessionId: original.binding.sessionId });
  expect(moved.messages.some(message => message.content === "Source history")).toBe(true);
  const snapshotBeforeRepair = store.snapshot();
  expect(JSON.parse(snapshotBeforeRepair).activeDotSessions.some(([paneId]: [string, string]) => paneId === source.id)).toBe(false);
  const repaired = await store.api.agentSession(source.id);
  expect(repaired.binding.sessionId).not.toBe(moved.binding.sessionId);
  expect(repaired.messages.some(message => message.content === "Source history")).toBe(false);
  await store.api.sendAgentMessage(source.id, "Separate source message");
  expect((await store.api.agentSession(destination.id)).messages.some(message => message.content === "Separate source message")).toBe(false);
  const reloaded = new DemoStore(); reloaded.restoreSnapshot(store.snapshot());
  expect(await reloaded.api.agentSession(source.id)).toEqual(await store.api.agentSession(source.id));
  expect(await reloaded.api.agentSession(destination.id)).toEqual(await store.api.agentSession(destination.id));
  // Legacy snapshots can still contain the old mapping: repair without overwriting the moved record.
  const legacy = JSON.parse(snapshotBeforeRepair);
  legacy.activeDotSessions.push([source.id, moved.binding.sessionId]);
  const legacyReload = new DemoStore(); legacyReload.restoreSnapshot(JSON.stringify(legacy));
  expect((await legacyReload.api.agentSession(source.id)).binding.sessionId).not.toBe(moved.binding.sessionId);
  expect((await legacyReload.api.agentSession(destination.id)).messages).toEqual(moved.messages);
});
