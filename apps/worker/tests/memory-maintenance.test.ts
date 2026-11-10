import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  MemoryConsolidationFinding,
  MemoryConsolidationOperation,
  MemoryConsolidationRun
} from "@space/contracts";
import { buildMemoryGraphSnapshot, createMemoryGraphSnapshotStore } from "@space/memory-graph";
import { InMemorySpaceStore } from "@space/runtime";
import {
  createScheduledMemoryAudit,
  executeMemoryConsolidation,
  finalizeMemoryRepair,
  prepareMemoryConsolidation,
  reconcileStaleSpaceAgentSessions,
  refreshAllMonthsMemoryGraphSnapshot,
  refreshMemoryGraphSnapshot
} from "../src/memory-maintenance-activities.js";
import { executePersistedMemoryChangeSet } from "../src/memory-mutation-activity.js";
import {
  MEMORY_MAINTENANCE_ACTIVITY_CONCURRENCY,
  MEMORY_MAINTENANCE_TASK_QUEUE,
  MEMORY_MAINTENANCE_WORKFLOW_TYPE,
  memoryMaintenanceWorkerOptions
} from "../src/memory-maintenance-config.js";
import { scheduleMemoryMaintenance } from "../src/memory-maintenance-scheduler-lib.js";

describe("Space memory maintenance worker", () => {
  it("reconciles stale space agent sessions through the maintenance store", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Agents", initialPaneCount: 0 }, "trace:room");
    const closedPane = store.createPane({ roomId: room.id, title: "Stale Chat", mode: "CHAT" }, "trace:pane");
    store.updatePane(closedPane.id, { isClosed: true, status: "CLOSED" }, "trace:close");
    store.createSpaceAgentSession({
      paneId: closedPane.id,
      roomId: room.id,
      status: "RUNNING",
      title: "Stale Chat",
      threadId: null,
      selectedProviderId: "codex-lb",
      selectedModelId: "gpt-5.6-sol",
      selectedModelConfigId: "gpt-5.6-sol:high",
      selectedProviderName: null,
      selectedModelName: "GPT-5.6",
      selectedReasoningKey: "high",
      selectedToolIds: [],
      isActive: true,
      lastSyncedAt: "2026-08-12T00:00:00.000Z"
    });
    const env = { SPACE_MEMORY_GRAPH_ENABLED: "true", SPACE_MEMORY_MAINTENANCE_ENABLED: "true" };

    const deactivated = await reconcileStaleSpaceAgentSessions({ store, env });

    expect(deactivated).toBe(1);
  });

  it("creates one durable scheduled AUDIT run per Athens calendar day", async () => {
    const store = new InMemorySpaceStore();
    const input = {
      scheduledAt: "2026-07-12T21:15:00.000Z",
      traceId: "trace:memory-maintenance-2026-07-13",
      sourceHash: "a".repeat(64)
    };

    const env = { SPACE_MEMORY_GRAPH_ENABLED: "true", SPACE_MEMORY_MAINTENANCE_ENABLED: "true" };
    const first = await createScheduledMemoryAudit(input, { store, env });
    const replay = await createScheduledMemoryAudit(input, { store, env });

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      mode: "AUDIT",
      triggerKind: "SCHEDULED",
      status: "QUEUED",
      workflowId: "space-memory-consolidation:scheduled:2026-07-13",
      dedupeKey: "scheduled:2026-07-13",
      sourceHash: "a".repeat(64),
      actorUserId: null
    });
  });

  it("persists one redacted finding per deterministic issue for an AUDIT run without creating operations", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-memory-consolidation-audit-"));
    const snapshotRoot = join(root, "snapshot");
    const sourcePath = join(root, "gemini_history_2026-07.md");
    const snapshot = buildMemoryGraphSnapshot({
      generatedAt: "2026-07-13T02:00:00.000Z",
      sources: [
        { path: join(root, "gemini_history.md"), kind: "INDEX", content: "# Canonical memory\n" },
        { path: sourcePath, kind: "MONTHLY", content: "## Undated memory\n\n- token=supersecretvalue\n" }
      ]
    });
    expect(snapshot.issues).toHaveLength(1);
    snapshot.issues[0]!.evidence = `token=supersecretvalue ${"x".repeat(3_950)}`;
    await createMemoryGraphSnapshotStore({ rootDir: snapshotRoot }).write(snapshot);

    let current: MemoryConsolidationRun = {
      id: "memory_consolidation:audit-1",
      mode: "AUDIT",
      triggerKind: "OPERATOR",
      status: "QUEUED",
      workflowId: "workflow:memory-consolidation-audit-1",
      dedupeKey: "operator:memory-consolidation-audit-1",
      sourceHash: null,
      actorUserId: "user:operator",
      progressCompleted: 0,
      progressTotal: 0,
      findingCount: 0,
      appliedOperationCount: 0,
      skippedOperationCount: 0,
      failedOperationCount: 0,
      metrics: {},
      modelId: null,
      aiVerified: false,
      aiEvidence: {},
      statusReason: null,
      createdAt: "2026-07-13T02:01:00.000Z",
      startedAt: null,
      completedAt: null,
      updatedAt: "2026-07-13T02:01:00.000Z"
    };
    const findings: MemoryConsolidationFinding[] = [];
    const operations: MemoryConsolidationOperation[] = [];
    const statuses: MemoryConsolidationRun["status"][] = [];
    const store = {
      async getMemoryConsolidationRun() { return current; },
      async updateMemoryConsolidationRun(_runId: string, input: Partial<MemoryConsolidationRun> & { status: MemoryConsolidationRun["status"] }) {
        statuses.push(input.status);
        current = {
          ...current,
          ...input,
          startedAt: input.status === "RUNNING" ? "2026-07-13T02:02:00.000Z" : current.startedAt,
          completedAt: input.status === "SUCCEEDED" ? "2026-07-13T02:03:00.000Z" : current.completedAt,
          updatedAt: "2026-07-13T02:03:00.000Z"
        };
        return current;
      },
      async createMemoryConsolidationFinding(input: Omit<MemoryConsolidationFinding, "id" | "status" | "createdAt" | "updatedAt">) {
        const finding: MemoryConsolidationFinding = {
          ...input,
          id: `memory_finding:${findings.length + 1}`,
          status: "OPEN",
          createdAt: "2026-07-13T02:02:00.000Z",
          updatedAt: "2026-07-13T02:02:00.000Z"
        };
        findings.push(finding);
        return finding;
      },
      async createMemoryConsolidationOperation(input: Omit<MemoryConsolidationOperation, "id" | "status" | "changeSetId" | "statusReason" | "createdAt" | "updatedAt" | "appliedAt">) {
        const operation: MemoryConsolidationOperation = {
          ...input,
          id: `memory_operation:${operations.length + 1}`,
          status: "PROPOSED",
          changeSetId: null,
          statusReason: null,
          createdAt: "2026-07-13T02:02:00.000Z",
          updatedAt: "2026-07-13T02:02:00.000Z",
          appliedAt: null
        };
        operations.push(operation);
        return operation;
      }
    };

    const result = await executeMemoryConsolidation(
      { runId: current.id, traceId: "trace:memory-consolidation-audit-1" },
      {
        env: { SPACE_MEMORY_GRAPH_ENABLED: "true", SPACE_MEMORY_MAINTENANCE_ENABLED: "true" },
        rootDir: snapshotRoot,
        store,
        runAiAudit: async () => ({
          status: "VERIFIED",
          verified: true,
          modelId: "gpt-5.5",
          suggestionCount: 1,
          downgradedCount: 1,
          evidence: { providerSmoke: "PASSED", outputValidation: "PASSED" }
        })
      }
    );

    expect(statuses).toEqual(["RUNNING", "SUCCEEDED"]);
    expect(result).toMatchObject({
      status: "SUCCEEDED",
      sourceHash: snapshot.sourceHash,
      progressCompleted: 1,
      progressTotal: 1,
      findingCount: 1,
      appliedOperationCount: 0,
      skippedOperationCount: 0,
      failedOperationCount: 0,
      metrics: {
        snapshotVersion: 2,
        deterministicIssueCount: 1,
        findingsCreated: 1,
        operationsCreated: 0,
        aiStatus: "VERIFIED",
        aiSuggestionCount: 1,
        aiDowngradedCount: 1
      },
      modelId: "gpt-5.5",
      aiVerified: true,
      aiEvidence: {
        status: "VERIFIED",
        providerSmoke: "PASSED",
        outputValidation: "PASSED"
      }
    });
    expect(findings).toEqual([
      expect.objectContaining({
        runId: current.id,
        issueId: snapshot.issues[0]!.id,
        findingType: "MISSING_TIMESTAMP",
        recordIds: [snapshot.issues[0]!.recordId],
        sourcePath,
        evidence: expect.stringContaining("token:[REDACTED]")
      })
    ]);
    expect(findings[0]!.evidence).not.toContain("supersecretvalue");
    expect(findings[0]!.evidence.length).toBeLessThanOrEqual(4_000);
    expect(operations).toEqual([]);
  });

  it("routes exact duplicate repair through a journaled change set and skips ambiguous conflicts", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-memory-consolidation-repair-"));
    const snapshotRoot = join(root, "snapshot");
    const indexPath = join(root, "gemini_history.md");
    const monthlyPath = join(root, "gemini_history_2026-07.md");
    const journalRoot = join(root, "journals");
    const lockPath = join(root, "memory.lock");
    const indexContent = "# Canonical memory\n";
    const monthlyContent = [
      "<!-- space-memory:id=memory:duplicate-a -->",
      "## 2026-07-13 05:00 EEST - Duplicate",
      "- Same exact body",
      "",
      "<!-- space-memory:id=memory:duplicate-b -->",
      "## 2026-07-13 05:00 EEST - Duplicate",
      "- Same exact body",
      "",
      "<!-- space-memory:id=memory:conflict-a -->",
      "## 2026-07-13 05:10 EEST - Conflict",
      "- conflicts_with=memory:duplicate-a",
      ""
    ].join("\n");
    await writeFile(indexPath, indexContent, "utf8");
    await writeFile(monthlyPath, monthlyContent, "utf8");
    const snapshot = buildMemoryGraphSnapshot({
      generatedAt: "2026-07-13T02:15:00.000Z",
      sources: [
        { path: indexPath, kind: "INDEX", content: indexContent },
        { path: monthlyPath, kind: "MONTHLY", content: monthlyContent }
      ]
    });
    expect(snapshot.issues.map((issue) => issue.type).sort()).toEqual(["CONFLICT", "EXACT_DUPLICATE"]);
    await createMemoryGraphSnapshotStore({ rootDir: snapshotRoot }).write(snapshot);

    const store = new InMemorySpaceStore();
    store.upsertUser({ id: "user:operator", email: "operator@example.com", role: "OPERATOR" });
    const run = store.createMemoryConsolidationRun({
      mode: "REPAIR",
      triggerKind: "OPERATOR",
      workflowId: "workflow:memory-consolidation-repair-1",
      dedupeKey: "operator:memory-consolidation-repair-1",
      actorUserId: "user:operator",
      sourceHash: null
    });
    const env = {
      SPACE_MEMORY_GRAPH_ENABLED: "true",
      SPACE_MEMORY_MAINTENANCE_ENABLED: "true",
      SPACE_MEMORY_MUTATIONS_ENABLED: "true"
    };
    const sources = [
      { path: indexPath, kind: "INDEX" as const },
      { path: monthlyPath, kind: "MONTHLY" as const }
    ];

    const prepared = await prepareMemoryConsolidation(
      { runId: run.id, traceId: "trace:memory-consolidation-repair-1" },
      { env, rootDir: snapshotRoot, store, sources }
    );

    expect(await readFile(monthlyPath, "utf8")).toBe(monthlyContent);
    expect(prepared).toMatchObject({ run: { status: "RUNNING" }, changeSetId: expect.any(String) });
    const changeSet = store.getMemoryChangeSet(prepared.changeSetId!);
    expect(changeSet).toMatchObject({
      status: "APPROVED",
      kind: "ARCHIVE",
      sourcePath: monthlyPath,
      expectedSourceHash: snapshot.sourceHash,
      resolvesIssueIds: [snapshot.issues.find((issue) => issue.type === "EXACT_DUPLICATE")!.id]
    });
    expect(changeSet.beforeSnapshot).toBe(monthlyContent);
    expect(changeSet.afterSnapshot).toContain("lifecycle_status=ARCHIVED");
    expect(store.listMemoryConsolidationOperations(run.id)
      .map((operation) => [operation.operationKind, operation.status])
      .sort(([leftKind], [rightKind]) => leftKind.localeCompare(rightKind)))
      .toEqual([
        ["ARCHIVE_EXACT_DUPLICATE", "APPLYING"],
        ["REPORT_ISSUE", "SKIPPED"]
      ]);

    const mutationResult = await executePersistedMemoryChangeSet(
      { changeSetId: changeSet.id, traceId: "trace:memory-consolidation-repair-execute-1" },
      {
        env,
        store,
        coreOptions: { sources, journalRoot, lockPath }
      }
    );
    const completed = await finalizeMemoryRepair(
      { runId: run.id, changeSetId: changeSet.id, mutationResult },
      { store }
    );

    expect(mutationResult.status).toBe("APPLIED");
    expect(completed).toMatchObject({
      status: "SUCCEEDED",
      findingCount: 2,
      appliedOperationCount: 1,
      skippedOperationCount: 1,
      failedOperationCount: 0
    });
    expect(await readFile(monthlyPath, "utf8")).toContain("lifecycle_status=ARCHIVED");
    expect(store.listMemoryConsolidationOperations(run.id)
      .map((operation) => [operation.operationKind, operation.status])
      .sort(([leftKind], [rightKind]) => leftKind.localeCompare(rightKind)))
      .toEqual([
        ["ARCHIVE_EXACT_DUPLICATE", "APPLIED"],
        ["REPORT_ISSUE", "SKIPPED"]
      ]);
    expect(store.listMemoryConsolidationFindings(run.id).map((finding) => [finding.findingType, finding.status]))
      .toEqual([
        ["EXACT_DUPLICATE", "APPLIED"],
        ["CONFLICT", "SKIPPED"]
      ]);
  });

  it("backfills only unique exact cache matches and snapshots cache mismatches with bounded reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-memory-cache-backfill-"));
    const indexPath = join(root, "gemini_history.md");
    const monthlyPath = join(root, "gemini_history_2026-07.md");
    const snapshotRoot = join(root, "snapshot");
    await writeFile(indexPath, "# Canonical memory\n\n## Current month\n", "utf8");
    await writeFile(monthlyPath, [
      "# July",
      "",
      "<!-- space-memory:id=memory:exact-record -->",
      "## 2026-07-13 - Space canonical memory: Exact cache",
      "- Source: Space API memory.save; original_scope=SYSTEM; provenance=operator; trace=req:exact.",
      "- Exact body",
      "",
      "<!-- space-memory:id=memory:ambiguous-a -->",
      "## 2026-07-13 - Space canonical memory: Ambiguous cache",
      "- Source: Space API memory.save; original_scope=SYSTEM; provenance=operator; trace=req:a.",
      "- Ambiguous body",
      "",
      "<!-- space-memory:id=memory:ambiguous-b -->",
      "## 2026-07-13 - Space canonical memory: Ambiguous cache",
      "- Source: Space API memory.save; original_scope=SYSTEM; provenance=operator; trace=req:b.",
      "- Ambiguous body",
      ""
    ].join("\n"), "utf8");

    const cacheRows = [
      {
        id: "memory:cache-exact",
        scope: "SYSTEM" as const,
        roomId: null,
        title: "Exact cache",
        body: "Exact body",
        provenance: "api-cache",
        createdAt: "2026-07-13T00:00:00.000Z"
      },
      {
        id: "memory:cache-ambiguous",
        scope: "SYSTEM" as const,
        roomId: null,
        title: "Ambiguous cache",
        body: "Ambiguous body",
        provenance: "api-cache",
        createdAt: "2026-07-13T00:00:01.000Z"
      },
      {
        id: "memory:cache-unmatched",
        scope: "SYSTEM" as const,
        roomId: null,
        title: "Unmatched cache",
        body: "No canonical body",
        provenance: "api-cache",
        createdAt: "2026-07-13T00:00:02.000Z"
      }
    ];
    const links: Array<{
      memoryRecordId: string;
      canonicalMemoryId: string;
      linkSource: "EXACT_BACKFILL";
      linkedAt: string;
    }> = [];
    const entryLimits: number[] = [];
    const linkQueries: Array<{ memoryRecordIds?: string[]; limit: number }> = [];
    const store = {
      listMemoryEntries(_query: unknown, options: { limit?: number } = {}) {
        entryLimits.push(options.limit ?? 0);
        return cacheRows;
      },
      listMemoryCacheLinks(query: { memoryRecordIds?: string[]; limit: number }) {
        linkQueries.push(query);
        const selected = new Set(query.memoryRecordIds);
        return links.filter((link) => selected.has(link.memoryRecordId)).slice(0, query.limit);
      },
      linkMemoryCacheRecord(input: Omit<(typeof links)[number], "linkedAt">) {
        const existing = links.find((link) => link.memoryRecordId === input.memoryRecordId);
        if (existing) return existing;
        const link = { ...input, linkedAt: "2026-07-13T00:30:01.000Z" };
        links.push(link);
        return link;
      }
    };
    const baseOptions = { rootDir: snapshotRoot, indexPath, monthlyPath, store };

    const first = await refreshMemoryGraphSnapshot(
      { scheduledAt: "2026-07-13T00:30:00.000Z", traceId: "trace:memory-cache-backfill-1" },
      { ...baseOptions, now: () => new Date("2026-07-13T00:30:01.000Z") }
    );
    const firstSnapshot = JSON.parse(await readFile(join(snapshotRoot, "snapshot.json"), "utf8"));

    expect(first.status).toBe("REFRESHED");
    expect(entryLimits).toEqual([500]);
    expect(linkQueries[0]).toEqual({ memoryRecordIds: cacheRows.map((row) => row.id), limit: 500 });
    expect(links).toEqual([
      expect.objectContaining({
        memoryRecordId: "memory:cache-exact",
        canonicalMemoryId: "memory:exact-record",
        linkSource: "EXACT_BACKFILL"
      })
    ]);
    expect(firstSnapshot.nodes.filter((node: { type: string }) => node.type === "CACHE_RECORD")).toHaveLength(3);
    expect(firstSnapshot.issues.filter((issue: { type: string }) => issue.type === "CACHE_MISMATCH")).toHaveLength(2);

    cacheRows.push({
      id: "memory:cache-new-unmatched",
      scope: "SYSTEM",
      roomId: null,
      title: "New unmatched cache",
      body: "Still no canonical body",
      provenance: "api-cache",
      createdAt: "2026-07-13T00:00:03.000Z"
    });
    const second = await refreshMemoryGraphSnapshot(
      { scheduledAt: "2026-07-13T00:30:00.000Z", traceId: "trace:memory-cache-backfill-2" },
      { ...baseOptions, now: () => new Date("2026-07-13T00:30:02.000Z") }
    );
    const secondSnapshot = JSON.parse(await readFile(join(snapshotRoot, "snapshot.json"), "utf8"));
    const third = await refreshMemoryGraphSnapshot(
      { scheduledAt: "2026-07-13T00:30:00.000Z", traceId: "trace:memory-cache-backfill-3" },
      { ...baseOptions, now: () => new Date("2026-07-13T00:30:03.000Z") }
    );
    const thirdSnapshot = JSON.parse(await readFile(join(snapshotRoot, "snapshot.json"), "utf8"));

    expect(second).toMatchObject({ status: "REFRESHED", sourceHash: first.sourceHash });
    expect({ ...thirdSnapshot, generatedAt: null }).toEqual({ ...secondSnapshot, generatedAt: null });
    expect(third).toMatchObject({ status: "UNCHANGED", sourceHash: first.sourceHash });
    expect(links).toHaveLength(1);
  });

  it("refreshes the persisted graph snapshot without mutating canonical sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-memory-maintenance-"));
    const indexPath = join(root, "gemini_history.md");
    const monthlyPath = join(root, "gemini_history_2026-07.md");
    const snapshotRoot = join(root, "snapshot");
    const indexContent = "# Canonical memory\n\n## Current month\n";
    const monthlyContent = "# July\n\n## 2026-07-13 03:30 EEST - Scheduled maintenance\n\nWorker snapshot refresh.\n";
    await writeFile(indexPath, indexContent, "utf8");
    await writeFile(monthlyPath, monthlyContent, "utf8");

    const first = await refreshMemoryGraphSnapshot(
      { scheduledAt: "2026-07-13T00:30:00.000Z", traceId: "trace:memory-maintenance-2026-07-13" },
      {
        rootDir: snapshotRoot,
        indexPath,
        monthlyPath,
        now: () => new Date("2026-07-13T00:30:01.000Z")
      }
    );
    const second = await refreshMemoryGraphSnapshot(
      { scheduledAt: "2026-07-13T00:30:00.000Z", traceId: "trace:memory-maintenance-2026-07-13" },
      {
        rootDir: snapshotRoot,
        indexPath,
        monthlyPath,
        now: () => new Date("2026-07-13T00:30:02.000Z")
      }
    );

    expect(first).toMatchObject({ status: "REFRESHED", previousSourceHash: null, summary: { sourceCount: 2, recordCount: 1 } });
    expect(second).toMatchObject({ status: "UNCHANGED", sourceHash: first.sourceHash, previousSourceHash: first.sourceHash });
    expect(JSON.parse(await readFile(join(snapshotRoot, "snapshot.json"), "utf8"))).toMatchObject({
      version: 2,
      layoutVersion: 2,
      taxonomyVersion: 2,
      revisionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      sourceHash: first.sourceHash
    });
    expect(await readFile(indexPath, "utf8")).toBe(indexContent);
    expect(await readFile(monthlyPath, "utf8")).toBe(monthlyContent);
  });

  it("builds the all-months archive snapshot from every monthly file without mutating sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-memory-maintenance-archive-"));
    const indexPath = join(root, "gemini_history.md");
    const snapshotRoot = join(root, "snapshot");
    const indexContent = "# Canonical memory\n\n## Current month\n";
    await writeFile(indexPath, indexContent, "utf8");
    await writeFile(join(root, "gemini_history_2026-06.md"), "# June\n\n## 2026-06-13 03:30 EEST - June archive\n\nJune body.\n", "utf8");
    await writeFile(join(root, "gemini_history_2026-07.md"), "# July\n\n## 2026-07-13 03:30 EEST - July archive\n\nJuly body.\n", "utf8");

    const input = { scheduledAt: "2026-07-13T00:30:00.000Z", traceId: "trace:memory-all-months-2026-07-13" };
    const first = await refreshAllMonthsMemoryGraphSnapshot(
      input,
      { rootDir: snapshotRoot, indexPath, memoryDir: root, now: () => new Date("2026-07-13T00:30:01.000Z") }
    );
    const second = await refreshAllMonthsMemoryGraphSnapshot(
      input,
      { rootDir: snapshotRoot, indexPath, memoryDir: root, now: () => new Date("2026-07-13T00:30:02.000Z") }
    );

    expect(first).toMatchObject({
      status: "REFRESHED",
      previousSourceHash: null,
      summary: { sourceCount: 3, recordCount: 2 }
    });
    expect(second).toMatchObject({ status: "UNCHANGED", sourceHash: first.sourceHash, previousSourceHash: first.sourceHash });

    const archived = JSON.parse(await readFile(join(snapshotRoot, "snapshot-all-months.json"), "utf8"));
    expect(archived).toMatchObject({
      version: 2,
      layoutVersion: 2,
      taxonomyVersion: 2,
      revisionHash: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(archived.nodes.filter((node: { type: string }) => node.type === "SOURCE")).toHaveLength(3);
    expect(archived.nodes.map((node: { sourcePath: string }) => node.sourcePath)).toEqual(
      expect.arrayContaining([join(root, "gemini_history_2026-06.md"), join(root, "gemini_history_2026-07.md")])
    );
    expect(await readFile(indexPath, "utf8")).toBe(indexContent);
  });

  it("schedules one idempotent Athens-day workflow only when both kill switches are enabled", async () => {
    const starts: Array<{ workflowType: string; options: Record<string, unknown> }> = [];
    const enabledEnv = {
      SPACE_MEMORY_GRAPH_ENABLED: "true",
      SPACE_MEMORY_MAINTENANCE_ENABLED: "true"
    };
    const scheduled = await scheduleMemoryMaintenance({
      env: enabledEnv,
      now: () => new Date("2026-07-12T21:15:00.000Z"),
      startWorkflow: async (workflowType, options) => {
        starts.push({ workflowType, options });
        return { workflowId: String(options.workflowId), firstExecutionRunId: "run:memory-maintenance" };
      }
    });
    const disabled = await scheduleMemoryMaintenance({
      env: { ...enabledEnv, SPACE_MEMORY_MAINTENANCE_ENABLED: "false" },
      now: () => new Date("2026-07-12T21:15:00.000Z"),
      startWorkflow: async () => {
        throw new Error("disabled scheduling must not call Temporal");
      }
    });
    const duplicate = await scheduleMemoryMaintenance({
      env: enabledEnv,
      now: () => new Date("2026-07-12T21:15:00.000Z"),
      startWorkflow: async () => {
        const error = new Error("already scheduled");
        error.name = "WorkflowExecutionAlreadyStartedError";
        throw error;
      }
    });

    expect(scheduled).toMatchObject({ status: "SCHEDULED", workflowId: "space-memory-maintenance:2026-07-13" });
    expect(starts).toEqual([
      {
        workflowType: MEMORY_MAINTENANCE_WORKFLOW_TYPE,
        options: expect.objectContaining({
          taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
          workflowId: "space-memory-maintenance:2026-07-13",
          workflowIdReusePolicy: "ALLOW_DUPLICATE_FAILED_ONLY",
          workflowIdConflictPolicy: "USE_EXISTING"
        })
      }
    ]);
    expect(disabled.status).toBe("DISABLED");
    expect(duplicate.status).toBe("ALREADY_SCHEDULED");
  });

  // The worker and timer units it ships: memory-worker-units.test.ts (deploy files, not in the public tree).
  it("serializes maintenance activities", async () => {
    expect(MEMORY_MAINTENANCE_ACTIVITY_CONCURRENCY).toBe(1);
    expect(memoryMaintenanceWorkerOptions).toMatchObject({
      maxConcurrentActivityTaskExecutions: 1,
      maxConcurrentLocalActivityExecutions: 1,
      maxConcurrentActivityTaskPolls: 1
    });
  });
});
