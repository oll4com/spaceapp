import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ApplicationFailure,
  defaultPayloadConverter,
  WorkflowContinuedAsNewError,
  type WorkflowHandle
} from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { DefaultLogger, Runtime, Worker } from "@temporalio/worker";
import { DeterminismViolationError } from "@temporalio/workflow";
import {
  DOT_GOAL_SIGNAL,
  MEMORY_MUTATION_TASK_QUEUE,
  ROOM_AGENT_ENQUEUE_SIGNAL,
  ROOM_AGENT_STOP_SIGNAL,
  type DummyTurnInput,
  type MemoryConsolidationRun,
  type MemoryMaintenanceResult,
  type MemoryMutationWorkflowResult,
  type RoomAgentSupervisorQueueItem
} from "@space/contracts";
import { MEMORY_MAINTENANCE_TASK_QUEUE } from "../../src/memory-maintenance-config.js";

export type History = Awaited<ReturnType<WorkflowHandle["fetchHistory"]>>;

const supportDir = path.dirname(fileURLToPath(import.meta.url));
export const workerRoot = path.resolve(supportDir, "../..");
export const repoRoot = path.resolve(workerRoot, "../..");
export const defaultHistoryFixturesDir = path.join(
  workerRoot,
  "tests",
  "fixtures",
  "workflow-histories"
);

export const WORKFLOW_MODULE_PATHS = {
  main: path.join(workerRoot, "src", "workflows.ts"),
  memoryMaintenance: path.join(workerRoot, "src", "memory-maintenance-workflows.ts"),
  memoryMutation: path.join(workerRoot, "src", "memory-mutation-workflows.ts")
} as const;

export type WorkflowModuleKey = keyof typeof WORKFLOW_MODULE_PATHS;

const disableContinuationPatchLoaderPath = path.join(
  supportDir,
  "disable-continuation-patch-loader.cjs"
);

let runtimeConfigured = false;

/**
 * Configures the global Temporal SDK Runtime with an ERROR-level logger
 * if not already configured, preventing noisy debug logs during test runs.
 */
export function ensureQuietTemporalRuntime(): void {
  if (runtimeConfigured) return;
  runtimeConfigured = true;
  try {
    Runtime.install({
      logger: new DefaultLogger("ERROR")
    });
  } catch {
    // Runtime is already installed in this process.
  }
}

/**
 * Resolves workspace package root paths for Webpack bundling when packages
 * are built from TypeScript sources during development or test execution.
 *
 * @returns Map of workspace package aliases to their entrypoints.
 */
function workspaceAliases(): Record<string, string> {
  const aliases: Record<string, string> = {};
  const packagesDir = path.join(repoRoot, "packages");
  if (!existsSync(packagesDir)) return aliases;
  for (const name of readdirSync(packagesDir)) {
    const distEntry = path.join(packagesDir, name, "dist", "index.js");
    const srcEntry = path.join(packagesDir, name, "src", "index.ts");
    if (!existsSync(distEntry) && existsSync(srcEntry)) {
      aliases[`@space/${name}$`] = srcEntry;
    }
  }
  return aliases;
}

/**
 * Creates Webpack bundler options for Temporal workers in this worktree,
 * configuring workspace aliases and optional loaders to simulate pre-patch branches.
 *
 * @param options - Bundling configuration options.
 * @param options.disableRoomBackgroundContinuationPatch - Whether to simulate the pre-patch supervisor branch.
 * @returns Bundler options object suitable for Worker.create.
 */
export function createWorktreeBundlerOptions(options?: {
  disableRoomBackgroundContinuationPatch?: boolean;
}): NonNullable<Parameters<typeof Worker.create>[0]["bundlerOptions"]> {
  const disablePatch = options?.disableRoomBackgroundContinuationPatch ?? false;
  return {
    webpackConfigHook: (config) => {
      const existingRules = config.module?.rules ?? [];
      const extraRules = disablePatch
        ? [
            {
              test: /workflows\.ts$/,
              enforce: "pre" as const,
              use: [disableContinuationPatchLoaderPath]
            }
          ]
        : [];
      return {
        ...config,
        resolve: {
          ...config.resolve,
          alias: {
            ...(config.resolve?.alias as Record<string, string> | undefined),
            ...workspaceAliases()
          }
        },
        module: {
          ...config.module,
          rules: [...existingRules, ...extraRules]
        }
      };
    }
  };
}

/**
 * Decodes the initial input payload carried over in a WorkflowExecutionContinuedAsNew
 * event in a Temporal workflow execution history.
 *
 * @template T - The expected type of the continued input.
 * @param history - Workflow execution history containing the continuation event.
 * @returns The deserialized input payload carried to the new execution.
 */
export function decodeContinueAsNewInput<T = unknown>(history: History): T {
  const events = history.events ?? [];
  const continuedEvent = events.find((event) =>
    Boolean(event.workflowExecutionContinuedAsNewEventAttributes)
  );
  const payload =
    continuedEvent?.workflowExecutionContinuedAsNewEventAttributes?.input?.payloads?.[0];
  if (!payload) {
    throw new Error("Expected WorkflowExecutionContinuedAsNew event with an input payload.");
  }
  return defaultPayloadConverter.fromPayload(payload) as T;
}

export interface RecordedWorkflowHistoryFixture {
  fileName: string;
  workflowType: string;
  workflowModule: WorkflowModuleKey;
  workflowId: string;
  branch?: "current" | "pre-patch";
  history: History;
}

export const EXPECTED_HISTORY_FIXTURES: ReadonlyArray<{
  fileName: string;
  workflowType: string;
  workflowModule: WorkflowModuleKey;
  workflowId: string;
  branch?: "current" | "pre-patch";
}> = [
  {
    fileName: "dotGoalWorkflow.json",
    workflowType: "dotGoalWorkflow",
    workflowModule: "main",
    workflowId: "replay:dot-goal"
  },
  {
    fileName: "dummyTurnWorkflow.json",
    workflowType: "dummyTurnWorkflow",
    workflowModule: "main",
    workflowId: "replay:dummy-turn"
  },
  {
    fileName: "codexAppServerTurnWorkflow.json",
    workflowType: "codexAppServerTurnWorkflow",
    workflowModule: "main",
    workflowId: "replay:codex-turn"
  },
  {
    fileName: "roomAgentSupervisorWorkflow.json",
    workflowType: "roomAgentSupervisorWorkflow",
    workflowModule: "main",
    workflowId: "replay:room-supervisor:current",
    branch: "current"
  },
  {
    fileName: "roomAgentSupervisorWorkflow-pre-patch.json",
    workflowType: "roomAgentSupervisorWorkflow",
    workflowModule: "main",
    workflowId: "replay:room-supervisor:pre-patch",
    branch: "pre-patch"
  },
  {
    fileName: "roomAgentActionWorkflow.json",
    workflowType: "roomAgentActionWorkflow",
    workflowModule: "main",
    workflowId: "space-room-action:replay-action"
  },
  {
    fileName: "memoryMaintenanceWorkflow.json",
    workflowType: "memoryMaintenanceWorkflow",
    workflowModule: "memoryMaintenance",
    workflowId: "replay:memory-maintenance"
  },
  {
    fileName: "memoryConsolidationWorkflow.json",
    workflowType: "memoryConsolidationWorkflow",
    workflowModule: "memoryMaintenance",
    workflowId: "replay:memory-consolidation"
  },
  {
    fileName: "memoryMutationWorkflow.json",
    workflowType: "memoryMutationWorkflow",
    workflowModule: "memoryMutation",
    workflowId: "replay:memory-mutation"
  }
];

/**
 * Constructs a synthetic RoomAgentSupervisorQueueItem for testing supervisor queue
 * and continuation polling behavior in real time-skipping tests.
 *
 * @param roomId - Identifier of the room under supervision.
 * @param missionId - Identifier of the background mission.
 * @param suffix - Suffix used to make turn and pane identifiers unique.
 * @returns A fully constructed supervisor queue item.
 */
function buildSampleSupervisorItem(
  roomId: string,
  missionId: string,
  suffix: string
): RoomAgentSupervisorQueueItem {
  return {
    missionId,
    turn: {
      roomId,
      paneId: `pane:${suffix}`,
      prompt: `Synthetic prompt ${suffix}`,
      roomAgentOperatorRequest: `Synthetic prompt ${suffix}`,
      artifactIds: [],
      agentRunId: `agent_run:${suffix}`,
      permissionMode: null,
      collaborationMode: "default",
      traceId: `trace:${suffix}`
    }
  };
}

/**
 * Executes all 8 registered Temporal workflows (and both roomAgentSupervisorWorkflow branches)
 * inside a time-skipping TestWorkflowEnvironment to produce canonical, deterministic execution histories.
 *
 * @param env - The active time-skipping test workflow environment.
 * @returns Array of recorded history fixtures ready for serialization.
 */
export async function generateCanonicalWorkflowHistories(
  env: TestWorkflowEnvironment
): Promise<RecordedWorkflowHistoryFixture[]> {
  ensureQuietTemporalRuntime();
  const recorded: RecordedWorkflowHistoryFixture[] = [];

  // 1. Main workflows (workflows.ts - current branch)
  const mainTaskQueue = "replay-gen-main";
  let dotStepCalls = 0;
  let dotObserveCalls = 0;
  let codexTurnCalls = 0;
  let continuationPolls = 0;

  const mainWorker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: mainTaskQueue,
    workflowsPath: WORKFLOW_MODULE_PATHS.main,
    bundlerOptions: createWorktreeBundlerOptions(),
    activities: {
      dotGoalStep: async () => {
        dotStepCalls += 1;
        if (dotStepCalls === 1) {
          return { state: "WAITING", runId: null, goalStatus: "ACTIVE" };
        }
        if (dotStepCalls === 2) {
          return { state: "RUNNING", runId: "run:dot-1", goalStatus: "ACTIVE" };
        }
        return { state: "DONE", runId: null, goalStatus: "COMPLETED" };
      },
      dotGoalObserve: async () => {
        dotObserveCalls += 1;
        return {
          run: dotObserveCalls === 1 ? "RUNNING" : "COMPLETED",
          goalStatus: "ACTIVE"
        };
      },
      recordDummyTurnStarted: async () => undefined,
      recordDummyTurnCompleted: async (input: DummyTurnInput) => ({
        workflowId: "replay:dummy-turn",
        roomId: input.roomId,
        paneId: input.paneId,
        completedAt: "2026-10-17T00:00:00.000Z",
        echoedPrompt: input.prompt
      }),
      runCodexAppServerTurn: async (input: DummyTurnInput) => {
        if (input.traceId === "trace:retry-once" && ++codexTurnCalls === 1) {
          throw ApplicationFailure.retryable("Synthetic transient turn failure", "TRANSIENT");
        }
        return {
          workflowId: `codex-turn:${input.agentRunId ?? "default"}`,
          roomId: input.roomId,
          paneId: input.paneId,
          completedAt: "2026-10-17T00:00:01.000Z",
          providerId: input.providerId ?? "codex",
          modelId: input.modelId ?? "gpt-5.6-sol",
          status: "COMPLETED" as const,
          message: `Completed ${input.prompt}`,
          roomAgentOutcome: {
            status: "VERIFIED" as const,
            executedActionCount: 1,
            statusReason: "Completed in synthetic replay fixture."
          }
        };
      },
      runOpenCodeAgentTurn: async (input: DummyTurnInput) => ({
        workflowId: "opencode-turn",
        roomId: input.roomId,
        paneId: input.paneId,
        completedAt: "2026-10-17T00:00:01.000Z",
        providerId: "opencode",
        modelId: input.modelId ?? null,
        status: "COMPLETED" as const,
        message: "OpenCode completed"
      }),
      runCliAgentTurn: async (input: DummyTurnInput) => ({
        workflowId: "cli-turn",
        roomId: input.roomId,
        paneId: input.paneId,
        completedAt: "2026-10-17T00:00:01.000Z",
        providerId: input.providerId ?? "claude-cli",
        modelId: input.modelId ?? null,
        status: "COMPLETED" as const,
        message: "CLI completed"
      }),
      checkRoomAgentSupervisorTurn: async () => "RUN" as const,
      discardRoomAgentSupervisorTurn: async () => undefined,
      finishRoomAgentSupervisorTurn: async () => undefined,
      prepareRoomAgentBackgroundContinuation: async ({ roomId, missionId }: { roomId: string; missionId: string }) => {
        continuationPolls += 1;
        if (continuationPolls === 1) {
          return {
            state: "READY" as const,
            item: buildSampleSupervisorItem(roomId, missionId, "bg-ready-1")
          };
        }
        return { state: "DONE" as const };
      },
      runRoomAgentBackgroundAction: async () => {
        throw ApplicationFailure.nonRetryable(
          "Synthetic background action failure",
          "ACTION_FAILED"
        );
      },
      failRoomAgentBackgroundAction: async () => undefined
    }
  });

  await mainWorker.runUntil(async () => {
    // 1a. dotGoalWorkflow
    const dotHandle = await env.client.workflow.start("dotGoalWorkflow", {
      taskQueue: mainTaskQueue,
      workflowId: "replay:dot-goal",
      args: [{ goalId: "goal:replay-1" }]
    });
    await dotHandle.signal(DOT_GOAL_SIGNAL);
    const dotResult = await dotHandle.result();
    if (dotResult.goalStatus !== "COMPLETED") {
      throw new Error(`Unexpected dotGoalWorkflow status: ${String(dotResult.goalStatus)}`);
    }
    recorded.push({
      fileName: "dotGoalWorkflow.json",
      workflowType: "dotGoalWorkflow",
      workflowModule: "main",
      workflowId: "replay:dot-goal",
      history: await dotHandle.fetchHistory()
    });

    // 1b. dummyTurnWorkflow
    const dummyHandle = await env.client.workflow.start("dummyTurnWorkflow", {
      taskQueue: mainTaskQueue,
      workflowId: "replay:dummy-turn",
      args: [
        {
          roomId: "room:replay",
          paneId: "pane:replay",
          prompt: "Synthetic dummy turn"
        }
      ]
    });
    await dummyHandle.result();
    recorded.push({
      fileName: "dummyTurnWorkflow.json",
      workflowType: "dummyTurnWorkflow",
      workflowModule: "main",
      workflowId: "replay:dummy-turn",
      history: await dummyHandle.fetchHistory()
    });

    // 1c. codexAppServerTurnWorkflow
    const codexHandle = await env.client.workflow.start("codexAppServerTurnWorkflow", {
      taskQueue: mainTaskQueue,
      workflowId: "replay:codex-turn",
      args: [
        {
          roomId: "room:replay",
          paneId: "pane:replay",
          prompt: "Synthetic codex turn",
          providerId: "codex",
          modelId: "gpt-5.6-sol",
          agentSessionId: "session:replay",
          agentRunId: "agent_run:replay-codex",
          traceId: "trace:retry-once"
        }
      ]
    });
    await codexHandle.result();
    recorded.push({
      fileName: "codexAppServerTurnWorkflow.json",
      workflowType: "codexAppServerTurnWorkflow",
      workflowModule: "main",
      workflowId: "replay:codex-turn",
      history: await codexHandle.fetchHistory()
    });

    // 1d. roomAgentSupervisorWorkflow (current branch with patched("room-background-continuation-v1"))
    const interruptedItem = buildSampleSupervisorItem(
      "room:replay-current",
      "mission:interrupted",
      "interrupted-1"
    );
    const supHandle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
      taskQueue: mainTaskQueue,
      workflowId: "replay:room-supervisor:current",
      followRuns: false,
      args: [
        {
          roomId: "room:replay-current",
          pending: [],
          interrupted: [{ item: interruptedItem, reason: "Stopped before run." }],
          monitoringMissionIds: ["mission:bg-1"],
          processedCount: 48
        }
      ]
    });
    await supHandle.result().catch((error: unknown) => {
      if (!(error instanceof WorkflowContinuedAsNewError)) throw error;
    });
    recorded.push({
      fileName: "roomAgentSupervisorWorkflow.json",
      workflowType: "roomAgentSupervisorWorkflow",
      workflowModule: "main",
      workflowId: "replay:room-supervisor:current",
      branch: "current",
      history: await env.client.workflow
        .getHandle("replay:room-supervisor:current", supHandle.firstExecutionRunId)
        .fetchHistory()
    });

    // 1e. roomAgentActionWorkflow (failure path with patched("room-background-action-failure-v1"))
    const actionHandle = await env.client.workflow.start("roomAgentActionWorkflow", {
      taskQueue: mainTaskQueue,
      workflowId: "space-room-action:replay-action",
      args: [
        {
          bridge: {
            roomId: "room:replay",
            missionId: "mission:replay",
            agentSessionId: "session:replay",
            agentRunId: "run:replay"
          },
          traceId: "trace:replay-action"
        }
      ]
    });
    await actionHandle.result().catch(() => undefined);
    recorded.push({
      fileName: "roomAgentActionWorkflow.json",
      workflowType: "roomAgentActionWorkflow",
      workflowModule: "main",
      workflowId: "space-room-action:replay-action",
      history: await actionHandle.fetchHistory()
    });
  });

  // 2. Pre-patch roomAgentSupervisorWorkflow (legacy branch behind !patched("room-background-continuation-v1"))
  const legacyTaskQueue = "replay-gen-legacy";
  const legacyWorker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: legacyTaskQueue,
    workflowsPath: WORKFLOW_MODULE_PATHS.main,
    bundlerOptions: createWorktreeBundlerOptions({
      disableRoomBackgroundContinuationPatch: true
    }),
    activities: {
      settleRoomAgentBackgroundMission: async () => true,
      markRoomAgentMissionStarted: async () => undefined,
      markRoomAgentMissionFinished: async () => undefined,
      markRoomAgentMissionContinued: async () => undefined,
      runCodexAppServerTurn: async (input: DummyTurnInput) => ({
        workflowId: `codex-turn:${input.agentRunId ?? "legacy"}`,
        roomId: input.roomId,
        paneId: input.paneId,
        completedAt: "2026-10-17T00:00:02.000Z",
        providerId: "codex",
        modelId: "gpt-5.6-sol",
        status: "COMPLETED" as const,
        message: "Legacy turn completed",
        roomAgentOutcome: {
          status: "VERIFIED" as const,
          executedActionCount: 1,
          statusReason: "Legacy mission verified."
        }
      })
    }
  });

  await legacyWorker.runUntil(async () => {
    const legacyItem = buildSampleSupervisorItem(
      "room:replay-legacy",
      "mission:legacy-1",
      "legacy-1"
    );
    const legacyHandle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
      taskQueue: legacyTaskQueue,
      workflowId: "replay:room-supervisor:pre-patch",
      followRuns: false,
      args: [
        {
          roomId: "room:replay-legacy",
          pending: [],
          interrupted: [],
          monitoringMissionIds: ["mission:bg-legacy"],
          processedCount: 49
        }
      ]
    });
    await env.sleep("2 seconds");
    await legacyHandle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, legacyItem);
    await legacyHandle.result().catch((error: unknown) => {
      if (!(error instanceof WorkflowContinuedAsNewError)) throw error;
    });
    recorded.push({
      fileName: "roomAgentSupervisorWorkflow-pre-patch.json",
      workflowType: "roomAgentSupervisorWorkflow",
      workflowModule: "main",
      workflowId: "replay:room-supervisor:pre-patch",
      branch: "pre-patch",
      history: await env.client.workflow
        .getHandle("replay:room-supervisor:pre-patch", legacyHandle.firstExecutionRunId)
        .fetchHistory()
    });
  });

  // 3. Memory maintenance & consolidation + mutation workflows
  let mutationAttempts = 0;
  const maintenanceWorker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
    workflowsPath: WORKFLOW_MODULE_PATHS.memoryMaintenance,
    bundlerOptions: createWorktreeBundlerOptions(),
    activities: {
      refreshMemoryGraphSnapshot: async (): Promise<MemoryMaintenanceResult> => ({
        snapshotPath: "/tmp/replay-memory-snapshot.json",
        sourceHash: "sha256:replay-source-hash",
        nodeCount: 12,
        edgeCount: 18,
        generatedAt: "2026-10-17T00:00:00.000Z"
      }),
      refreshAllMonthsMemoryGraphSnapshot: async () => {
        throw ApplicationFailure.nonRetryable(
          "Synthetic all-months snapshot failure",
          "ALL_MONTHS_FAILED"
        );
      },
      reconcileStaleSpaceAgentSessions: async () => {
        throw ApplicationFailure.nonRetryable(
          "Synthetic session reconciliation failure",
          "RECONCILE_FAILED"
        );
      },
      createScheduledMemoryAudit: async () => ({
        id: "consolidation_run:replay-child",
        workflowId: "replay:memory-consolidation-child"
      }),
      prepareMemoryConsolidation: async ({ runId }: { runId: string }) => ({
        changeSetId: `changeset:${runId}`,
        run: {
          id: runId,
          status: "APPLYING",
          trigger: "SCHEDULED",
          sourceHash: "sha256:replay-source-hash",
          findingsCount: 1,
          appliedOperationsCount: 0,
          changeSetId: `changeset:${runId}`,
          workflowId: `workflow:${runId}`,
          errorMessage: null,
          startedAt: "2026-10-17T00:00:00.000Z",
          completedAt: null,
          createdAt: "2026-10-17T00:00:00.000Z",
          updatedAt: "2026-10-17T00:00:00.000Z"
        } satisfies MemoryConsolidationRun
      }),
      finalizeMemoryRepair: async ({
        runId,
        changeSetId
      }: {
        runId: string;
        changeSetId: string;
      }): Promise<MemoryConsolidationRun> => ({
        id: runId,
        status: "COMPLETED",
        trigger: "SCHEDULED",
        sourceHash: "sha256:replay-source-hash",
        findingsCount: 1,
        appliedOperationsCount: 2,
        changeSetId,
        workflowId: `workflow:${runId}`,
        errorMessage: null,
        startedAt: "2026-10-17T00:00:00.000Z",
        completedAt: "2026-10-17T00:00:05.000Z",
        createdAt: "2026-10-17T00:00:00.000Z",
        updatedAt: "2026-10-17T00:00:05.000Z"
      })
    }
  });

  const mutationWorker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: MEMORY_MUTATION_TASK_QUEUE,
    workflowsPath: WORKFLOW_MODULE_PATHS.memoryMutation,
    bundlerOptions: createWorktreeBundlerOptions(),
    activities: {
      executePersistedMemoryChangeSet: async ({
        changeSetId,
        traceId
      }: {
        changeSetId: string;
        traceId?: string;
      }): Promise<MemoryMutationWorkflowResult> => {
        if (traceId === "trace:mutation-retry" && ++mutationAttempts === 1) {
          throw ApplicationFailure.retryable("Synthetic transient mutation lock", "LOCK_BUSY");
        }
        return {
          changeSetId,
          status: "APPLIED",
          appliedOperationsCount: 2,
          snapshotInvalidated: true,
          summary: "Applied synthetic change set"
        };
      }
    }
  });

  await mutationWorker.runUntil(async () => {
    await maintenanceWorker.runUntil(async () => {
      const maintHandle = await env.client.workflow.start("memoryMaintenanceWorkflow", {
        taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
        workflowId: "replay:memory-maintenance",
        args: [{ reason: "scheduled", traceId: "trace:replay-maint" }]
      });
      await maintHandle.result();
      recorded.push({
        fileName: "memoryMaintenanceWorkflow.json",
        workflowType: "memoryMaintenanceWorkflow",
        workflowModule: "memoryMaintenance",
        workflowId: "replay:memory-maintenance",
        history: await maintHandle.fetchHistory()
      });

      const consHandle = await env.client.workflow.start("memoryConsolidationWorkflow", {
        taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
        workflowId: "replay:memory-consolidation",
        args: [{ runId: "consolidation_run:standalone", traceId: "trace:replay-cons" }]
      });
      await consHandle.result();
      recorded.push({
        fileName: "memoryConsolidationWorkflow.json",
        workflowType: "memoryConsolidationWorkflow",
        workflowModule: "memoryMaintenance",
        workflowId: "replay:memory-consolidation",
        history: await consHandle.fetchHistory()
      });

      const mutHandle = await env.client.workflow.start("memoryMutationWorkflow", {
        taskQueue: MEMORY_MUTATION_TASK_QUEUE,
        workflowId: "replay:memory-mutation",
        args: [{ changeSetId: "changeset:standalone", traceId: "trace:mutation-retry" }]
      });
      await mutHandle.result();
      recorded.push({
        fileName: "memoryMutationWorkflow.json",
        workflowType: "memoryMutationWorkflow",
        workflowModule: "memoryMutation",
        workflowId: "replay:memory-mutation",
        history: await mutHandle.fetchHistory()
      });
    });
  });

  const byFile = new Map(recorded.map((item) => [item.fileName, item]));
  return EXPECTED_HISTORY_FIXTURES.map((expected) => {
    const match = byFile.get(expected.fileName);
    if (!match) {
      throw new Error(`Missing recorded workflow history for ${expected.fileName}`);
    }
    return match;
  });
}

const localRequire = createRequire(import.meta.url);
const workerRequire = createRequire(localRequire.resolve("@temporalio/worker"));
const proto = workerRequire("@temporalio/proto") as {
  temporal: {
    api: {
      history: {
        v1: {
          History: {
            fromObject: (obj: unknown) => unknown;
          };
        };
      };
    };
  };
};
const { patchProtobufRoot } = workerRequire("@temporalio/proto/lib/patch-protobuf-root") as {
  patchProtobufRoot: (root: unknown) => { lookupType: (typeName: string) => unknown };
};
const protoRequire = createRequire(workerRequire.resolve("@temporalio/proto"));
const { fromJson, toJson } = protoRequire("protobufjs/ext/protojson") as {
  fromJson: (
    type: unknown,
    json: unknown,
    options?: { ignoreUnknownFields?: boolean }
  ) => History | null;
  toJson: (type: unknown, message: unknown) => Record<string, unknown>;
};
const patchedProtoRoot = patchProtobufRoot(proto);
const historyProtoType = patchedProtoRoot.lookupType("temporal.api.history.v1.History");

/**
 * Converts a PascalCase identifier to CONSTANT_CASE.
 *
 * @param value - Input string in PascalCase.
 * @returns Converted string in CONSTANT_CASE.
 */
function pascalCaseToConstantCase(value: string): string {
  return value.replace(/[^\b][A-Z]/g, (match) => `${match[0]}_${match[1]}`).toUpperCase();
}

/**
 * Normalizes an enum string attribute to match the protobuf constant naming convention.
 *
 * @template O - Object containing enum attributes.
 * @param obj - Source object containing the attribute.
 * @param attr - Key of the enum property.
 * @param prefix - Protobuf enum constant prefix.
 * @returns Partial object with normalized enum value, or undefined if not present.
 */
function fixEnumValue<O extends Record<string, unknown>>(
  obj: O,
  attr: keyof O,
  prefix: string
): Partial<O> | undefined {
  const current = obj[attr];
  if (typeof current !== "string" || current.length === 0) return undefined;
  return {
    [attr]: current.startsWith(prefix)
      ? current
      : `${prefix}_${pascalCaseToConstantCase(current)}`
  } as Partial<O>;
}

/**
 * Adjusts serialized history JSON to match the strict schema expectations of the Temporal protobuf deserializer.
 *
 * @param history - Raw JSON representation of a workflow history.
 * @returns Adjusted history object ready for protobuf deserialization.
 */
function fixHistoryJsonForProto(history: Record<string, unknown>): Record<string, unknown> {
  const events = Array.isArray(history.events) ? history.events : [];
  return {
    events: events.map((rawEvent) => {
      const event = rawEvent as Record<string, unknown>;
      const attrKey = Object.keys(event).find((key) => key.endsWith("EventAttributes"));
      if (!attrKey) return event;
      const attrs = (event[attrKey] ?? {}) as Record<string, unknown>;
      const taskQueue = attrs.taskQueue as Record<string, unknown> | undefined;
      const childFailureInfo = attrs.childWorkflowExecutionFailureInfo as
        | Record<string, unknown>
        | undefined;
      return {
        ...event,
        ...fixEnumValue(event, "eventType", "EVENT_TYPE"),
        [attrKey]: {
          ...attrs,
          ...(taskQueue && {
            taskQueue: {
              ...taskQueue,
              ...fixEnumValue(taskQueue, "kind", "TASK_QUEUE_KIND")
            }
          }),
          ...fixEnumValue(attrs, "parentClosePolicy", "PARENT_CLOSE_POLICY"),
          ...fixEnumValue(attrs, "workflowIdReusePolicy", "WORKFLOW_ID_REUSE_POLICY"),
          ...fixEnumValue(attrs, "initiator", "CONTINUE_AS_NEW_INITIATOR"),
          ...fixEnumValue(attrs, "retryState", "RETRY_STATE"),
          ...(childFailureInfo && {
            childWorkflowExecutionFailureInfo: {
              ...childFailureInfo,
              ...fixEnumValue(childFailureInfo, "retryState", "RETRY_STATE")
            }
          })
        }
      };
    })
  };
}

/**
 * Serializes a Temporal History object to a standard JSON object.
 *
 * @param history - Native Temporal History object.
 * @returns JSON-serializable representation of the history.
 */
export function serializeHistoryToJsonObject(history: History): Record<string, unknown> {
  const message = proto.temporal.api.history.v1.History.fromObject(history);
  return toJson(historyProtoType, message);
}

/**
 * Deserializes a JSON-compatible history object into a native Temporal History message.
 *
 * @param history - JSON object representing the workflow history.
 * @returns Deserialized Temporal History message.
 * @throws {TypeError} If the JSON cannot be parsed into a History message.
 */
export function deserializeHistoryFromJsonObject(history: Record<string, unknown>): History {
  const loaded = fromJson(historyProtoType, fixHistoryJsonForProto(history), {
    ignoreUnknownFields: true
  });
  if (!loaded) {
    throw new TypeError("Failed to deserialize Temporal workflow History from JSON fixture");
  }
  return loaded;
}

/**
 * Recursively sanitizes non-deterministic and local environment fields (e.g. worker identities
 * and stack traces) in serialized history JSON before writing fixtures.
 *
 * @param value - Any arbitrary value from the history JSON tree.
 * @returns Sanitized value with fixed identity strings and scrubbed stack traces.
 */
function sanitizeHistoryJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeHistoryJsonValue(item));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === "identity" && typeof entry === "string" && entry.length > 0) {
        out[key] = "1000@space-test-worker";
      } else if (key === "stackTrace" && typeof entry === "string") {
        out[key] = "";
      } else {
        out[key] = sanitizeHistoryJsonValue(entry);
      }
    }
    return out;
  }
  return value;
}

/**
 * Result of recording workflow execution histories to disk.
 */
export interface WriteWorkflowHistoryFixturesResult {
  /** Array of fixtures newly written or overwritten to disk. */
  written: RecordedWorkflowHistoryFixture[];
  /** Array of filenames skipped because they already exist and overwrite was not enabled. */
  skipped: string[];
  /** All canonical fixtures generated during the run. */
  fixtures: RecordedWorkflowHistoryFixture[];
}

/**
 * Generates canonical workflow execution histories for all workflows on a time-skipping
 * test server and writes sanitized JSON fixtures to disk. Preserves existing fixture
 * files by default to prevent accidental overwrite of legacy or baseline histories.
 *
 * @param outputDir - Destination directory for writing JSON fixtures.
 * @param options - Recording options.
 * @param options.overwrite - Whether to overwrite existing fixture files (defaults to false).
 * @returns Summary of written fixtures, skipped existing files, and generated fixtures.
 */
export async function writeWorkflowHistoryFixtures(
  outputDir = defaultHistoryFixturesDir,
  options?: { overwrite?: boolean }
): Promise<WriteWorkflowHistoryFixturesResult> {
  ensureQuietTemporalRuntime();
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  const overwrite = options?.overwrite ?? false;
  try {
    const fixtures = await generateCanonicalWorkflowHistories(env);
    mkdirSync(outputDir, { recursive: true });
    const written: RecordedWorkflowHistoryFixture[] = [];
    const skipped: string[] = [];
    for (const fixture of fixtures) {
      const targetPath = path.join(outputDir, fixture.fileName);
      if (existsSync(targetPath) && !overwrite) {
        skipped.push(fixture.fileName);
        continue;
      }
      const parsed = serializeHistoryToJsonObject(fixture.history);
      const sanitized = sanitizeHistoryJsonValue(parsed);
      const jsonText = `${JSON.stringify(sanitized, null, 2)}\n`;
      writeFileSync(targetPath, jsonText, "utf8");
      written.push(fixture);
    }
    return { written, skipped, fixtures };
  } finally {
    await env.teardown();
  }
}

/**
 * Extracts the workflow type name from a deserialized history object's start event.
 *
 * @param history - Raw JSON representation of a workflow history.
 * @returns The name of the workflow type, or 'unknownWorkflow' if not found.
 */
export function extractHistoryWorkflowType(history: Record<string, unknown>): string {
  const events = Array.isArray(history.events) ? history.events : [];
  const started = events.find(
    (event) =>
      typeof event === "object" &&
      event !== null &&
      "workflowExecutionStartedEventAttributes" in event
  ) as
    | {
        workflowExecutionStartedEventAttributes?: {
          workflowType?: { name?: string };
        };
      }
    | undefined;
  return started?.workflowExecutionStartedEventAttributes?.workflowType?.name ?? "unknownWorkflow";
}

/**
 * Checks whether a serialized workflow execution history contains a marker for a given patch ID.
 *
 * @param history - Raw JSON representation of a workflow history.
 * @param patchId - The patch identifier string to search for.
 * @returns True if the patch marker is present in the history events.
 */
export function historyHasPatchMarker(
  history: Record<string, unknown>,
  patchId: string
): boolean {
  const events = Array.isArray(history.events) ? history.events : [];
  const serialized = JSON.stringify(events);
  const base64PatchId = Buffer.from(JSON.stringify(patchId), "utf8").toString("base64");
  const rawBase64PatchId = Buffer.from(patchId, "utf8").toString("base64");
  return (
    serialized.includes(patchId) ||
    serialized.includes(base64PatchId) ||
    serialized.includes(rawBase64PatchId)
  );
}

/**
 * Replays all committed JSON workflow histories against current workflow code
 * using Worker.runReplayHistories and verifies compatibility.
 *
 * @param options - Optional overrides for fixture directory or workflow module entrypoints.
 * @param options.fixtureDir - Custom directory containing JSON history fixtures.
 * @param options.workflowPathOverrides - Custom file paths for specific workflow modules.
 * @returns Summary of replayed files, distinct workflow types, and legacy branch presence.
 */
export async function replayWorkflowHistoryFixtures(options?: {
  fixtureDir?: string;
  workflowPathOverrides?: Partial<Record<WorkflowModuleKey, string>>;
}): Promise<{ replayedFiles: string[]; workflowTypes: Set<string>; hasPrePatchSupervisor: boolean }> {
  ensureQuietTemporalRuntime();
  const fixtureDir = options?.fixtureDir ?? defaultHistoryFixturesDir;
  const files = readdirSync(fixtureDir)
    .filter((file) => file.endsWith(".json"))
    .sort();
  if (files.length === 0) {
    throw new Error(`No workflow history JSON fixtures found in ${fixtureDir}`);
  }

  const moduleByWorkflowType = new Map<string, WorkflowModuleKey>([
    ["dotGoalWorkflow", "main"],
    ["dummyTurnWorkflow", "main"],
    ["codexAppServerTurnWorkflow", "main"],
    ["roomAgentSupervisorWorkflow", "main"],
    ["roomAgentActionWorkflow", "main"],
    ["memoryMaintenanceWorkflow", "memoryMaintenance"],
    ["memoryConsolidationWorkflow", "memoryMaintenance"],
    ["memoryMutationWorkflow", "memoryMutation"]
  ]);

  const grouped = new Map<
    WorkflowModuleKey,
    Array<{
      fileName: string;
      workflowType: string;
      workflowId: string;
      history: Record<string, unknown>;
    }>
  >();

  const workflowTypes = new Set<string>();
  let hasPrePatchSupervisor = false;

  for (const fileName of files) {
    const filePath = path.join(fixtureDir, fileName);
    const history = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const workflowType = extractHistoryWorkflowType(history);
    const moduleKey = moduleByWorkflowType.get(workflowType);
    if (!moduleKey) {
      throw new Error(
        `Unknown workflowType "${workflowType}" in history fixture ${fileName}`
      );
    }
    workflowTypes.add(workflowType);
    if (
      workflowType === "roomAgentSupervisorWorkflow" &&
      !historyHasPatchMarker(history, "room-background-continuation-v1")
    ) {
      hasPrePatchSupervisor = true;
    }
    const list = grouped.get(moduleKey) ?? [];
    list.push({
      fileName,
      workflowType,
      workflowId: fileName.replace(/\.json$/, ""),
      history
    });
    grouped.set(moduleKey, list);
  }

  for (const [moduleKey, entries] of grouped.entries()) {
    const workflowsPath =
      options?.workflowPathOverrides?.[moduleKey] ?? WORKFLOW_MODULE_PATHS[moduleKey];
    const byId = new Map(entries.map((entry) => [entry.workflowId, entry]));
    const results = Worker.runReplayHistories(
      {
        workflowsPath,
        bundlerOptions: createWorktreeBundlerOptions()
      },
      entries.map((entry) => ({
        workflowId: entry.workflowId,
        history: deserializeHistoryFromJsonObject(entry.history)
      }))
    );

    for await (const result of results) {
      if (result.error) {
        const entry = byId.get(result.workflowId);
        const label = entry
          ? `workflow "${entry.workflowType}" (history file: ${entry.fileName})`
          : `workflowId "${result.workflowId}"`;
        if (result.error instanceof DeterminismViolationError) {
          result.error.message = `Replay determinism violation in ${label}: ${result.error.message}`;
          throw result.error;
        }
        result.error.message = `Replay failed in ${label}: ${result.error.message}`;
        throw result.error;
      }
    }
  }

  return {
    replayedFiles: files,
    workflowTypes,
    hasPrePatchSupervisor
  };
}
