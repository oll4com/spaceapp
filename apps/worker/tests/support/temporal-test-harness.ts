import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultPayloadConverter,
  WorkflowContinuedAsNewError,
  type WorkflowHandle
} from "@temporalio/client";
import proto from "@temporalio/proto";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { DefaultLogger, Runtime, Worker, type WorkerOptions } from "@temporalio/worker";
import { DeterminismViolationError } from "@temporalio/workflow";
import {
  DOT_GOAL_SIGNAL,
  ROOM_AGENT_ENQUEUE_SIGNAL,
  ROOM_AGENT_STOP_SIGNAL,
  type DummyTurnInput,
  type MemoryConsolidationRun,
  type MemoryMaintenanceInput,
  type MemoryMaintenanceResult,
  type MemoryMutationWorkflowResult,
  type RoomAgentSupervisorInput,
  type RoomAgentSupervisorQueueItem
} from "@space/contracts";
import { MEMORY_MAINTENANCE_TASK_QUEUE } from "../../src/memory-maintenance-config.js";
import { MEMORY_MUTATION_TASK_QUEUE } from "../../src/memory-mutation-config.js";

const supportDir = path.dirname(fileURLToPath(import.meta.url));
export const workerRoot = path.resolve(supportDir, "../..");
export const repoRoot = path.resolve(workerRoot, "../..");
export const workflowHistoriesDir = path.resolve(workerRoot, "tests/fixtures/workflow-histories");

export type WorkflowsFileKey =
  | "workflows.ts"
  | "memory-maintenance-workflows.ts"
  | "memory-mutation-workflows.ts";

export const WORKFLOW_SOURCE_PATHS: Record<WorkflowsFileKey, string> = {
  "workflows.ts": path.resolve(workerRoot, "src/workflows.ts"),
  "memory-maintenance-workflows.ts": path.resolve(workerRoot, "src/memory-maintenance-workflows.ts"),
  "memory-mutation-workflows.ts": path.resolve(workerRoot, "src/memory-mutation-workflows.ts")
};

const prePatchLoaderPath = path.resolve(supportDir, "pre-patch-workflow-loader.cjs");

export type WorkflowLoaderMode = "pre-patch" | "inject-sleep" | "inject-activity";

let runtimeInstalled = false;

export function installQuietTemporalRuntime(): void {
  if (runtimeInstalled) return;
  runtimeInstalled = true;
  try {
    Runtime.install({ logger: new DefaultLogger("ERROR") });
  } catch {
    // Runtime is already initialized in this process.
  }
}

function workspaceSourceAliases(): Record<string, string> {
  const aliases: Record<string, string> = {};
  const packagesDir = path.join(repoRoot, "packages");
  for (const name of readdirSync(packagesDir)) {
    const entry = path.join(packagesDir, name, "src", "index.ts");
    if (existsSync(entry)) {
      aliases[`@space/${name}$`] = entry;
    }
  }
  return aliases;
}

export function workflowBundlerOptions(
  loaderMode?: WorkflowLoaderMode
): NonNullable<WorkerOptions["bundlerOptions"]> {
  const aliases = workspaceSourceAliases();
  return {
    webpackConfigHook: (config) => {
      const rules = [...(config.module?.rules ?? [])];
      if (loaderMode) {
        rules.push({
          test: /workflows\.ts$/,
          enforce: "pre",
          use: [
            {
              loader: prePatchLoaderPath,
              options: { mode: loaderMode }
            }
          ]
        });
      }
      return {
        ...config,
        resolve: {
          ...config.resolve,
          alias: {
            ...(config.resolve?.alias as Record<string, string> | undefined),
            ...aliases
          }
        },
        module: {
          ...config.module,
          rules
        }
      };
    }
  };
}

export async function extractContinuedAsNewInput<T>(handle: WorkflowHandle): Promise<T> {
  const history = await handle.fetchHistory();
  const event = history.events?.find((candidate) => candidate.workflowExecutionContinuedAsNewEventAttributes);
  const payload = event?.workflowExecutionContinuedAsNewEventAttributes?.input?.payloads?.[0];
  if (!payload) {
    throw new Error("Expected workflow history to contain a WorkflowExecutionContinuedAsNew event with input payload.");
  }
  return defaultPayloadConverter.fromPayload<T>(payload);
}

export interface RecordedWorkflowHistoryFixture {
  fileName: string;
  workflowType: string;
  workflowsFile: WorkflowsFileKey;
  workflowId: string;
  description: string;
  history: Record<string, unknown>;
}

const { History } = proto.temporal.api.history.v1;

function sanitizeHistoryNode(value: unknown, runIdMap: Map<string, string>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeHistoryNode(item, runIdMap));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "identity" && typeof child === "string") {
        out[key] = "space-test-worker";
      } else if (
        (key === "originalExecutionRunId" ||
          key === "firstExecutionRunId" ||
          key === "newExecutionRunId" ||
          key === "continuedExecutionRunId" ||
          key === "initiatedExecutionRunId" ||
          key === "runId") &&
        typeof child === "string" &&
        child.length > 0
      ) {
        let mapped = runIdMap.get(child);
        if (!mapped) {
          mapped = `00000000-0000-4000-8000-${String(runIdMap.size + 1).padStart(12, "0")}`;
          runIdMap.set(child, mapped);
        }
        out[key] = mapped;
      } else if (key === "eventTime" && child && typeof child === "object") {
        out[key] = { seconds: 1767225600, nanos: 0 };
      } else {
        out[key] = sanitizeHistoryNode(child, runIdMap);
      }
    }
    return out;
  }
  return value;
}

export function serializeWorkflowHistoryFixture(input: {
  fileName: string;
  workflowType: string;
  workflowsFile: WorkflowsFileKey;
  workflowId: string;
  description: string;
  history: proto.temporal.api.history.v1.IHistory;
  sanitizeRunIds?: boolean;
}): RecordedWorkflowHistoryFixture {
  const plain = History.toObject(History.fromObject(input.history), {
    longs: Number,
    enums: String,
    bytes: String,
    defaults: false
  }) as Record<string, unknown>;
  const runIdMap = new Map<string, string>();
  const sanitized = (input.sanitizeRunIds === false
    ? sanitizeIdentityAndTimestampsOnly(plain)
    : sanitizeHistoryNode(plain, runIdMap)) as Record<string, unknown>;
  return {
    fileName: input.fileName,
    workflowType: input.workflowType,
    workflowsFile: input.workflowsFile,
    workflowId: input.workflowId,
    description: input.description,
    history: sanitized
  };
}

function sanitizeIdentityAndTimestampsOnly(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeIdentityAndTimestampsOnly(item));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "identity" && typeof child === "string") {
        out[key] = "space-test-worker";
      } else if (key === "eventTime" && child && typeof child === "object") {
        out[key] = { seconds: 1767225600, nanos: 0 };
      } else {
        out[key] = sanitizeIdentityAndTimestampsOnly(child);
      }
    }
    return out;
  }
  return value;
}

export function loadRecordedHistoryFixtures(dir = workflowHistoriesDir): RecordedWorkflowHistoryFixture[] {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  return files.map((fileName) => {
    const raw = JSON.parse(readFileSync(path.join(dir, fileName), "utf8")) as RecordedWorkflowHistoryFixture;
    return {
      ...raw,
      fileName
    };
  });
}

export async function replayHistoryFixtures(
  fixtures: RecordedWorkflowHistoryFixture[],
  options: { loaderMode?: WorkflowLoaderMode } = {}
): Promise<void> {
  installQuietTemporalRuntime();
  const byFile = new Map<WorkflowsFileKey, RecordedWorkflowHistoryFixture[]>();
  for (const fixture of fixtures) {
    const group = byFile.get(fixture.workflowsFile) ?? [];
    group.push(fixture);
    byFile.set(fixture.workflowsFile, group);
  }

  for (const [workflowsFile, group] of byFile) {
    const workflowsPath = WORKFLOW_SOURCE_PATHS[workflowsFile];
    const fixtureByWorkflowId = new Map<string, RecordedWorkflowHistoryFixture>();
    const replayInputs = group.map((fixture) => {
      const replayWorkflowId = `${fixture.workflowId}:${fixture.fileName}`;
      fixtureByWorkflowId.set(replayWorkflowId, fixture);
      return {
        workflowId: replayWorkflowId,
        history: History.fromObject(fixture.history)
      };
    });

    const results = Worker.runReplayHistories(
      {
        workflowsPath,
        replayName: `replay-${workflowsFile.replace(/\W+/g, "-")}`,
        bundlerOptions: workflowBundlerOptions(options.loaderMode)
      },
      replayInputs
    );

    for await (const result of results) {
      if (!result.error) continue;
      const fixture = fixtureByWorkflowId.get(result.workflowId);
      const label = fixture
        ? `${fixture.workflowType} (${fixture.fileName})`
        : result.workflowId;
      if (result.error instanceof DeterminismViolationError) {
        throw new DeterminismViolationError(
          `Replay determinism violation in ${label}: ${result.error.message}`
        );
      }
      throw new Error(`Replay failed in ${label}: ${result.error.message}`, {
        cause: result.error
      });
    }
  }
}

export function sampleQueueItem(roomId: string, missionId: string, suffix: string): RoomAgentSupervisorQueueItem {
  return {
    missionId,
    turn: {
      roomId,
      paneId: "pane:room-agent-test",
      prompt: `Execute room mission ${suffix}`,
      roomAgentOperatorRequest: `Execute room mission ${suffix}`,
      artifactIds: [],
      modelId: "gpt-5.6-sol",
      providerId: null,
      reasoningEffort: "high",
      permissionMode: null,
      collaborationMode: "default",
      agentSessionId: "agent_session:room-test",
      agentThreadId: null,
      agentRunId: `agent_run:${suffix}`,
      agentUserMessageId: `agent_msg:user-${suffix}`,
      agentAssistantMessageId: `agent_msg:assistant-${suffix}`,
      roomAgentMissionId: missionId,
      selectedToolIds: ["room:inspect"],
      traceId: `trace:room-${suffix}`
    }
  };
}

export async function generateSyntheticWorkflowHistories(): Promise<RecordedWorkflowHistoryFixture[]> {
  installQuietTemporalRuntime();
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  try {
    const fixtures: RecordedWorkflowHistoryFixture[] = [];

    // 1–5: Workflows in src/workflows.ts (current branch)
    let dotStepCount = 0;
    let dotObserveCount = 0;
    let supervisorPollCount = 0;
    const mainWorker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: "record-main-queue",
      workflowsPath: WORKFLOW_SOURCE_PATHS["workflows.ts"],
      bundlerOptions: workflowBundlerOptions(),
      activities: {
        dotGoalStep: async () => {
          dotStepCount += 1;
          if (dotStepCount === 1) return { state: "PAUSED", runId: null, goalStatus: "PAUSED" };
          if (dotStepCount === 2) return { state: "STARTED", runId: "run:dot-1", goalStatus: "ACTIVE" };
          return { state: "DONE", runId: null, goalStatus: "COMPLETED" };
        },
        dotGoalObserve: async () => {
          dotObserveCount += 1;
          return {
            run: dotObserveCount === 1 ? "RUNNING" : "COMPLETED",
            goalStatus: "ACTIVE"
          };
        },
        recordDummyTurnStarted: async () => undefined,
        recordDummyTurnCompleted: async (input: DummyTurnInput) => ({
          workflowId: "replay-fixture:dummy-turn",
          roomId: input.roomId,
          paneId: input.paneId,
          echoedPrompt: input.prompt,
          completedAt: "2026-01-01T00:00:00.000Z"
        }),
        runOpenCodeAgentTurn: async () => ({
          workflowId: "replay-fixture:opencode-turn",
          threadId: "thread:opencode-1",
          turnId: "turn:opencode-1",
          status: "COMPLETED" as const,
          message: "OpenCode turn completed.",
          completedAt: "2026-01-01T00:00:00.000Z"
        }),
        runCliAgentTurn: async () => ({
          workflowId: "replay-fixture:cli-turn",
          threadId: "thread:cli-1",
          turnId: "turn:cli-1",
          status: "COMPLETED" as const,
          message: "CLI turn completed.",
          completedAt: "2026-01-01T00:00:00.000Z"
        }),
        runCodexAppServerTurn: async () => ({
          workflowId: "replay-fixture:codex-turn",
          threadId: "thread:codex-1",
          turnId: "turn:codex-1",
          status: "COMPLETED" as const,
          message: "Verified room turn.",
          completedAt: "2026-01-01T00:00:00.000Z",
          roomAgentOutcome: {
            status: "VERIFIED" as const,
            executedActionCount: 1,
            statusReason: "Room verification succeeded."
          }
        }),
        runRoomAgentBackgroundAction: async () => {
          throw new Error("background transport failed");
        },
        failRoomAgentBackgroundAction: async () => undefined,
        checkRoomAgentSupervisorTurn: async () => "READY" as const,
        discardRoomAgentSupervisorTurn: async () => undefined,
        finishRoomAgentSupervisorTurn: async () => undefined,
        prepareRoomAgentBackgroundContinuation: async () => {
          supervisorPollCount += 1;
          if (supervisorPollCount === 1) {
            return {
              state: "READY" as const,
              item: {
                ...sampleQueueItem("room:supervisor-current", "mission:supervisor-current", "bg-1"),
                turn: {
                  ...sampleQueueItem("room:supervisor-current", "mission:supervisor-current", "bg-1").turn,
                  roomAgentContinuation: { sourceRunId: "agent_run:init-1", generation: 1 }
                }
              }
            };
          }
          return { state: "DONE" as const };
        }
      }
    });

    await mainWorker.runUntil(async () => {
      // 1. dotGoalWorkflow
      const dotHandle = await env.client.workflow.start("dotGoalWorkflow", {
        taskQueue: "record-main-queue",
        workflowId: "replay-fixture:dot-goal",
        args: [{ goalId: "dot_goal:fixture01" }]
      });
      await env.sleep("5 seconds");
      await dotHandle.signal(DOT_GOAL_SIGNAL);
      await dotHandle.result();
      fixtures.push(
        serializeWorkflowHistoryFixture({
          fileName: "dot-goal-workflow.json",
          workflowType: "dotGoalWorkflow",
          workflowsFile: "workflows.ts",
          workflowId: "replay-fixture:dot-goal",
          description: "dotGoalWorkflow waking on signal during PAUSED wait, polling dotGoalObserve, and finishing COMPLETED.",
          history: await dotHandle.fetchHistory()
        })
      );

      // 2. dummyTurnWorkflow
      const dummyHandle = await env.client.workflow.start("dummyTurnWorkflow", {
        taskQueue: "record-main-queue",
        workflowId: "replay-fixture:dummy-turn",
        args: [
          {
            roomId: "room:dummy-fixture",
            paneId: "pane:dummy-fixture",
            prompt: "Synthetic dummy prompt",
            traceId: "trace:dummy-fixture-0001"
          }
        ]
      });
      await dummyHandle.result();
      fixtures.push(
        serializeWorkflowHistoryFixture({
          fileName: "dummy-turn-workflow.json",
          workflowType: "dummyTurnWorkflow",
          workflowsFile: "workflows.ts",
          workflowId: "replay-fixture:dummy-turn",
          description: "dummyTurnWorkflow recording turn start and completion.",
          history: await dummyHandle.fetchHistory()
        })
      );

      // 3. codexAppServerTurnWorkflow
      const codexHandle = await env.client.workflow.start("codexAppServerTurnWorkflow", {
        taskQueue: "record-main-queue",
        workflowId: "replay-fixture:codex-turn",
        args: [
          {
            roomId: "room:codex-fixture",
            paneId: "pane:codex-fixture",
            prompt: "Synthetic codex turn",
            agentSessionId: "agent_session:codex-fixture",
            agentAssistantMessageId: "agent_msg:codex-fixture",
            traceId: "trace:codex-fixture-0001"
          }
        ]
      });
      await codexHandle.result();
      fixtures.push(
        serializeWorkflowHistoryFixture({
          fileName: "codex-app-server-turn-workflow.json",
          workflowType: "codexAppServerTurnWorkflow",
          workflowsFile: "workflows.ts",
          workflowId: "replay-fixture:codex-turn",
          description: "codexAppServerTurnWorkflow executing a native chat turn.",
          history: await codexHandle.fetchHistory()
        })
      );

      // 4. roomAgentActionWorkflow (failure path with room-background-action-failure-v1)
      const actionHandle = await env.client.workflow.start("roomAgentActionWorkflow", {
        taskQueue: "record-main-queue",
        workflowId: "space-room-action:action:fixture-1",
        args: [
          {
            bridge: {
              roomId: "room:action-fixture",
              missionId: "mission:action-fixture"
            },
            traceId: "trace:action-fixture-0001"
          }
        ],
        retry: { maximumAttempts: 1 }
      });
      await actionHandle.result().catch(() => undefined);
      fixtures.push(
        serializeWorkflowHistoryFixture({
          fileName: "room-agent-action-workflow.json",
          workflowType: "roomAgentActionWorkflow",
          workflowsFile: "workflows.ts",
          workflowId: "space-room-action:action:fixture-1",
          description: "roomAgentActionWorkflow failure path recording failure via failRoomAgentBackgroundAction behind room-background-action-failure-v1.",
          history: await actionHandle.fetchHistory()
        })
      );

      // 5. roomAgentSupervisorWorkflow (current branch behind room-background-continuation-v1)
      const supervisorInput: RoomAgentSupervisorInput = {
        roomId: "room:supervisor-current",
        pending: [],
        interrupted: [],
        monitoringMissionIds: ["mission:supervisor-current"],
        processedCount: 49
      };
      const supHandle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
        taskQueue: "record-main-queue",
        workflowId: "replay-fixture:room-supervisor-current",
        args: [supervisorInput]
      });
      const supUnfollowed = env.client.workflow.getHandle(
        "replay-fixture:room-supervisor-current",
        supHandle.firstExecutionRunId,
        { followRuns: false }
      );
      await supUnfollowed.result().catch((err) => {
        if (!(err instanceof WorkflowContinuedAsNewError)) throw err;
      });
      await supHandle.terminate();
      // Preserve originalExecutionRunId because uuid4() inside the workflow is seeded from it.
      fixtures.push(
        serializeWorkflowHistoryFixture({
          fileName: "room-agent-supervisor-workflow.json",
          workflowType: "roomAgentSupervisorWorkflow",
          workflowsFile: "workflows.ts",
          workflowId: "replay-fixture:room-supervisor-current",
          description: "roomAgentSupervisorWorkflow (current patched branch) polling background continuation, executing child turn workflow, and continuing as new at 50 processed items.",
          history: await supUnfollowed.fetchHistory(),
          sanitizeRunIds: false
        })
      );
    });

    // 6: Pre-patch roomAgentSupervisorWorkflow branch (!patched("room-background-continuation-v1"))
    const prePatchWorker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: "record-pre-patch-queue",
      workflowsPath: WORKFLOW_SOURCE_PATHS["workflows.ts"],
      bundlerOptions: workflowBundlerOptions("pre-patch"),
      activities: {
        settleRoomAgentBackgroundMission: async () => true,
        markRoomAgentMissionStarted: async () => undefined,
        markRoomAgentMissionContinued: async () => undefined,
        markRoomAgentMissionFinished: async () => undefined,
        runCodexAppServerTurn: async () => ({
          workflowId: "replay-fixture:pre-patch-child",
          threadId: "thread:pre-patch-1",
          turnId: "turn:pre-patch-1",
          status: "COMPLETED" as const,
          message: "Pre-patch turn completed.",
          completedAt: "2026-01-01T00:00:00.000Z",
          roomAgentOutcome: {
            status: "VERIFIED" as const,
            executedActionCount: 1,
            statusReason: "Pre-patch verification succeeded."
          }
        })
      }
    });

    await prePatchWorker.runUntil(async () => {
      const prePatchInput: RoomAgentSupervisorInput = {
        roomId: "room:supervisor-legacy",
        pending: [],
        interrupted: [],
        monitoringMissionIds: ["mission:supervisor-legacy"],
        processedCount: 48
      };
      const preHandle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
        taskQueue: "record-pre-patch-queue",
        workflowId: "replay-fixture:room-supervisor-pre-patch",
        args: [prePatchInput]
      });
      // Let the 1-second monitoring poll run settleRoomAgentBackgroundMission
      await env.sleep("2 seconds");
      // Enqueue an item and stop another before reaching processedCount 50 -> continueAsNew
      await preHandle.signal(
        ROOM_AGENT_ENQUEUE_SIGNAL,
        sampleQueueItem("room:supervisor-legacy", "mission:legacy-2", "legacy-run-1")
      );
      await env.sleep("1 second");
      await preHandle.signal(
        ROOM_AGENT_ENQUEUE_SIGNAL,
        sampleQueueItem("room:supervisor-legacy", "mission:legacy-3", "legacy-run-2")
      );
      await preHandle.signal(ROOM_AGENT_STOP_SIGNAL, {
        missionId: "mission:legacy-3",
        reason: "Stopped queued legacy mission."
      });
      const preUnfollowed = env.client.workflow.getHandle(
        "replay-fixture:room-supervisor-pre-patch",
        preHandle.firstExecutionRunId,
        { followRuns: false }
      );
      await preUnfollowed.result().catch((err) => {
        if (!(err instanceof WorkflowContinuedAsNewError)) throw err;
      });
      await preHandle.terminate();
      fixtures.push(
        serializeWorkflowHistoryFixture({
          fileName: "room-agent-supervisor-pre-patch.json",
          workflowType: "roomAgentSupervisorWorkflow",
          workflowsFile: "workflows.ts",
          workflowId: "replay-fixture:room-supervisor-pre-patch",
          description: "roomAgentSupervisorWorkflow pre-patch branch (!patched('room-background-continuation-v1')) settling monitored mission, running a child turn, and continuing as new.",
          history: await preUnfollowed.fetchHistory()
        })
      );
    });

    // 7–8: Memory maintenance, consolidation, and mutation workflows
    const sampleConsolidationRun: MemoryConsolidationRun = {
      id: "memory_consolidation_run:fixture-1",
      mode: "REPAIR",
      triggerKind: "SCHEDULED",
      status: "SUCCEEDED",
      workflowId: "space-memory-consolidation:scheduled:2026-01-01",
      dedupeKey: "scheduled:2026-01-01",
      sourceHash: "a".repeat(64),
      progressCompleted: 1,
      progressTotal: 1,
      findingCount: 1,
      appliedOperationCount: 1,
      skippedOperationCount: 0,
      failedOperationCount: 0,
      modelId: null,
      aiVerified: false,
      aiEvidence: {},
      metrics: {},
      statusReason: null,
      actorUserId: "user:operator-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z"
    };

    const sampleMaintenanceResult: MemoryMaintenanceResult = {
      status: "REFRESHED",
      generatedAt: "2026-01-01T00:00:00.000Z",
      sourceHash: "a".repeat(64),
      previousSourceHash: null,
      summary: {
        recordCount: 3,
        activeCount: 3,
        archivedCount: 0,
        candidateCount: 0,
        cacheRecordCount: 0,
        unlinkedCacheCount: 0,
        conflictCount: 0,
        staleCount: 0,
        duplicateCount: 0,
        issueCount: 1
      },
      durationMs: 12
    };

    const sampleMutationResult: MemoryMutationWorkflowResult = {
      status: "APPLIED",
      changeSetId: "memory_change:fixture0000000000000001",
      resultingSourceHash: "b".repeat(64),
      reason: null
    };

    const maintenanceWorker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
      workflowsPath: WORKFLOW_SOURCE_PATHS["memory-maintenance-workflows.ts"],
      bundlerOptions: workflowBundlerOptions(),
      activities: {
        refreshMemoryGraphSnapshot: async () => sampleMaintenanceResult,
        refreshAllMonthsMemoryGraphSnapshot: async () => sampleMaintenanceResult,
        reconcileStaleSpaceAgentSessions: async () => 2,
        createScheduledMemoryAudit: async () => ({
          ...sampleConsolidationRun,
          status: "QUEUED" as const
        }),
        prepareMemoryConsolidation: async () => ({
          run: { ...sampleConsolidationRun, status: "RUNNING" as const },
          changeSetId: sampleMutationResult.changeSetId
        }),
        finalizeMemoryRepair: async () => sampleConsolidationRun
      }
    });

    const mutationWorker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: MEMORY_MUTATION_TASK_QUEUE,
      workflowsPath: WORKFLOW_SOURCE_PATHS["memory-mutation-workflows.ts"],
      bundlerOptions: workflowBundlerOptions(),
      activities: {
        executePersistedMemoryChangeSet: async () => sampleMutationResult
      }
    });

    const maintenanceRun = maintenanceWorker.run();
    const mutationRun = mutationWorker.run();
    try {
      const maintenanceInput: MemoryMaintenanceInput = {
        trigger: "SCHEDULED",
        scheduledAt: "2026-01-01T00:00:00.000Z",
        traceId: "trace:memory-maintenance-fixture"
      };
      const maintHandle = await env.client.workflow.start("memoryMaintenanceWorkflow", {
        taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
        workflowId: "replay-fixture:memory-maintenance",
        args: [maintenanceInput]
      });
      await maintHandle.result();
      fixtures.push(
        serializeWorkflowHistoryFixture({
          fileName: "memory-maintenance-workflow.json",
          workflowType: "memoryMaintenanceWorkflow",
          workflowsFile: "memory-maintenance-workflows.ts",
          workflowId: "replay-fixture:memory-maintenance",
          description: "memoryMaintenanceWorkflow refreshing snapshots, reconciling sessions, creating audit run, and executing child memoryConsolidationWorkflow.",
          history: await maintHandle.fetchHistory()
        })
      );

      const consolidationHandle = await env.client.workflow.start("memoryConsolidationWorkflow", {
        taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
        workflowId: "replay-fixture:memory-consolidation",
        args: [{ runId: sampleConsolidationRun.id, traceId: "trace:memory-consolidation-fixture" }]
      });
      await consolidationHandle.result();
      fixtures.push(
        serializeWorkflowHistoryFixture({
          fileName: "memory-consolidation-workflow.json",
          workflowType: "memoryConsolidationWorkflow",
          workflowsFile: "memory-maintenance-workflows.ts",
          workflowId: "replay-fixture:memory-consolidation",
          description: "memoryConsolidationWorkflow preparing repair, executing persisted change set on the mutation queue, and finalizing repair.",
          history: await consolidationHandle.fetchHistory()
        })
      );

      const mutationHandle = await env.client.workflow.start("memoryMutationWorkflow", {
        taskQueue: MEMORY_MUTATION_TASK_QUEUE,
        workflowId: "replay-fixture:memory-mutation",
        args: [{ changeSetId: sampleMutationResult.changeSetId, traceId: "trace:memory-mutation-fixture" }]
      });
      await mutationHandle.result();
      fixtures.push(
        serializeWorkflowHistoryFixture({
          fileName: "memory-mutation-workflow.json",
          workflowType: "memoryMutationWorkflow",
          workflowsFile: "memory-mutation-workflows.ts",
          workflowId: "replay-fixture:memory-mutation",
          description: "memoryMutationWorkflow executing a persisted memory change set.",
          history: await mutationHandle.fetchHistory()
        })
      );
    } finally {
      maintenanceWorker.shutdown();
      mutationWorker.shutdown();
      await Promise.all([maintenanceRun, mutationRun]);
    }

    return fixtures;
  } finally {
    await env.teardown();
  }
}
