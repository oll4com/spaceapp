// The traced runs shared by the OTLP tests: production workflows on the three
// worker task queues with stub activities, started the way the API starts them
// (traceparent in the input and the correlation memo) or the way the
// maintenance scheduler does (no request).
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { buildCodexAppServerTurnWorkflowId, type DummyTurnInput } from "@space/contracts";
import type { SpanExporter } from "@space/runtime";
import { DEFAULT_TASK_QUEUE } from "../../src/constants.js";
import { MEMORY_MAINTENANCE_TASK_QUEUE } from "../../src/memory-maintenance-config.js";
import { MEMORY_MUTATION_TASK_QUEUE } from "../../src/memory-mutation-config.js";
import { continuedRunTraceparent } from "../../src/room-background-continuation.js";
import { runTraced, tracedWorker, type FakeCollector } from "./otlp-temporal.js";

/** The API request: its SERVER span is the parent the workflow must name. */
export const apiTraceId = "4bf92f3577b34da6a3ce929d0e0e4736";
export const apiSpanId = "00f067aa0ba902b7";
export const apiTraceparent = `00-${apiTraceId}-${apiSpanId}-01`;

/** Seeded user text: must never appear in anything exported. */
export const secretPrompt = "PROMPT-SEED please summarise my tax return for 2026";
export const secretPath = "/home/ci/private/notes-SEED.txt";
export const secretMessage = "upstream said: token=sk-SEED-0001 at https://internal.example/secret";

export const turn: DummyTurnInput = {
  roomId: "room:otlp",
  paneId: "pane:otlp",
  prompt: `${secretPrompt} ${secretPath}`,
  artifactIds: [],
  agentRunId: "agent_run:otlp-1",
  roomAgentMissionId: "mission:otlp",
  traceId: "req:otlpturn0001",
  traceparent: apiTraceparent,
  permissionMode: null,
  collaborationMode: "default"
} as DummyTurnInput;

/** The correlation memo the API sets when it starts a workflow for a request. */
const apiMemo = (traceId: string) => ({ spaceTraceId: traceId, traceparent: apiTraceparent, w3cTraceId: apiTraceId });

export interface ScenarioIds {
  turnWorkflowId: string;
  continuationWorkflowId: string;
  maintenanceWorkflowId: string;
  consolidationWorkflowId: string;
  mutationWorkflowId: string;
  dotGoalWorkflowId: string;
  actionWorkflowId: string;
}

/**
 * Stub activities for the three workers. The turn activity fails its first
 * attempt with a stable code and a message full of seeded user data; the Dots
 * Goal step waits once so the Goal continues as new.
 */
function activities() {
  let firstDotGoalRun: string | null = null;
  const main = {
    async runCodexAppServerTurn(_input: DummyTurnInput) {
      // First attempt fails with a stable code and a message full of user data.
      if (Context.current().info.attempt === 1) {
        throw ApplicationFailure.create({ type: "CODEX_APP_SERVER_TURN_TIMEOUT", message: `${secretMessage} ${secretPath}` });
      }
      return { status: "COMPLETED" };
    },
    async runRoomAgentBackgroundAction() {
      return { status: "COMPLETED" };
    },
    async dotGoalStep() {
      const runId = Context.current().info.workflowExecution.runId;
      firstDotGoalRun ??= runId;
      return runId === firstDotGoalRun
        ? { state: "WAITING", runId: null, goalStatus: "ACTIVE" }
        : { state: "DONE", runId: null, goalStatus: "COMPLETED" };
    },
    async dotGoalObserve() {
      return { run: "COMPLETED", goalStatus: "ACTIVE" };
    }
  };
  const maintenance = {
    async refreshMemoryGraphSnapshot() { return { sourceHash: "hash:otlp", status: "REFRESHED" }; },
    async refreshAllMonthsMemoryGraphSnapshot() { return {}; },
    async reconcileStaleSpaceAgentSessions() { return 0; },
    async createScheduledMemoryAudit() { return { id: "memory_run:otlp", workflowId: "memory-consolidation:memory_run:otlp" }; },
    async prepareMemoryConsolidation() { return { changeSetId: "change_set:otlp", run: { id: "memory_run:otlp" } }; },
    async finalizeMemoryRepair() { return { id: "memory_run:otlp" }; }
  };
  const mutation = {
    async executePersistedMemoryChangeSet() { return { status: "APPLIED" }; }
  };
  return { main, maintenance, mutation };
}

export interface ScenarioOptions {
  collector: FakeCollector;
  /** Replace the main worker's exporter (backpressure tests). */
  mainExporter?: SpanExporter;
  only?: Array<keyof ScenarioIds>;
}

/**
 * Runs the API-started turn (with a retried activity), a background
 * continuation of it, the scheduled maintenance workflow with its child
 * consolidation and the mutation activity on the third worker, an API-started
 * memory mutation, a Dots Goal that continues as new, and a room action.
 */
export async function runTracedScenarios(env: TestWorkflowEnvironment, options: ScenarioOptions): Promise<ScenarioIds> {
  const stubs = activities();
  /** True when the scenario `name` is selected (all of them without `only`). */
  const want = (name: keyof ScenarioIds) => !options.only || options.only.includes(name);
  const workers = [
    await tracedWorker(env, { collectorUrl: options.collector.url, service: "space-worker", taskQueue: DEFAULT_TASK_QUEUE,
      workflows: "workflows.ts", activities: stubs.main, ...(options.mainExporter ? { exporter: options.mainExporter } : {}) }),
    await tracedWorker(env, { collectorUrl: options.collector.url, service: "space-memory-maintenance-worker", taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
      workflows: "memory-maintenance-workflows.ts", activities: stubs.maintenance }),
    await tracedWorker(env, { collectorUrl: options.collector.url, service: "space-memory-mutation-worker", taskQueue: MEMORY_MUTATION_TASK_QUEUE,
      workflows: "memory-mutation-workflows.ts", activities: stubs.mutation })
  ];
  const continuation = { ...turn, traceId: "req:otlpturn0002", agentRunId: "agent_run:otlp-bg-1",
    roomAgentContinuation: { sourceRunId: "agent_run:otlp-1", generation: 1 }, continuesTraceparent: continuedRunTraceparent(turn)! } as DummyTurnInput;
  const ids: ScenarioIds = {
    turnWorkflowId: buildCodexAppServerTurnWorkflowId(turn),
    continuationWorkflowId: buildCodexAppServerTurnWorkflowId(continuation),
    maintenanceWorkflowId: "memory-maintenance:otlp",
    consolidationWorkflowId: "memory-consolidation:memory_run:otlp",
    mutationWorkflowId: "memory-mutation:change_set:otlp-api",
    dotGoalWorkflowId: "dot-goal:otlp",
    actionWorkflowId: "space-room-action:room_agent_action:otlp"
  };
  const client = env.client;
  await runTraced(workers, async () => {
    if (want("turnWorkflowId")) {
      await client.workflow.execute("codexAppServerTurnWorkflow", { taskQueue: DEFAULT_TASK_QUEUE, workflowId: ids.turnWorkflowId,
        args: [turn], memo: apiMemo(turn.traceId) });
    }
    if (want("continuationWorkflowId")) {
      await client.workflow.execute("codexAppServerTurnWorkflow", { taskQueue: DEFAULT_TASK_QUEUE, workflowId: ids.continuationWorkflowId,
        args: [continuation], memo: apiMemo(continuation.traceId) });
    }
    if (want("maintenanceWorkflowId")) {
      await client.workflow.execute("memoryMaintenanceWorkflow", { taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE, workflowId: ids.maintenanceWorkflowId,
        args: [{ traceId: "maintenance:otlp", reason: "SCHEDULED" }] });
    }
    if (want("mutationWorkflowId")) {
      await client.workflow.execute("memoryMutationWorkflow", { taskQueue: MEMORY_MUTATION_TASK_QUEUE, workflowId: ids.mutationWorkflowId,
        args: [{ changeSetId: "change_set:otlp-api", traceId: "req:otlpmutation1" }], memo: apiMemo("req:otlpmutation1") });
    }
    if (want("dotGoalWorkflowId")) {
      await client.workflow.execute("dotGoalWorkflow", { taskQueue: DEFAULT_TASK_QUEUE, workflowId: ids.dotGoalWorkflowId,
        args: [{ goalId: "dot_goal:otlp" }], memo: apiMemo("req:otlpdotgoal01") });
    }
    if (want("actionWorkflowId")) {
      await client.workflow.execute("roomAgentActionWorkflow", { taskQueue: DEFAULT_TASK_QUEUE, workflowId: ids.actionWorkflowId,
        args: [{ actionId: "room_agent_action:otlp", traceId: "req:otlpaction001", bridge: { roomId: turn.roomId, missionId: "mission:otlp",
          agentPaneId: turn.paneId, agentSessionId: "agent_session:otlp", requestId: turn.traceId, selectedToolIds: [], actions: [], backgroundExecution: true } }],
        memo: apiMemo("req:otlpaction001") });
    }
  });
  return ids;
}
