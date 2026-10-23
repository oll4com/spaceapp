import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker, type WorkerOptions } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, "../src");

/**
 * Real Temporal workflow sandbox, time-skipping, stub activities.
 *
 * Production points each worker at a single workflow module
 * (`worker.ts` -> workflows.js, `memory-mutation-worker.ts` ->
 * memory-mutation-workflows.js, `memory-maintenance-worker.ts` ->
 * memory-maintenance-workflows.js). These tests use the same modules, so the
 * bundle under test is the bundle that ships.
 */
const TURN_QUEUE = "space-turns";
const DOT_QUEUE = "space-dot-goals";
const MAINTENANCE_QUEUE = "space-memory-maintenance";
const MUTATION_QUEUE = "space-memory-mutations";

const WORKFLOWS = path.join(SRC, "workflows.ts");
const MAINTENANCE = path.join(SRC, "memory-maintenance-workflows.ts");
const MUTATION = path.join(SRC, "memory-mutation-workflows.ts");

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
}, 300_000);

afterAll(async () => {
  await env?.teardown();
});

async function withWorker(
  options: Pick<WorkerOptions, "taskQueue" | "activities" | "workflowsPath">,
  run: () => Promise<void>
): Promise<void> {
  const worker = await Worker.create({ connection: env.nativeConnection, ...options });
  await worker.runUntil(run());
}

function turn(overrides: Record<string, unknown> = {}) {
  return {
    roomId: "room:test",
    paneId: "pane:test",
    prompt: "hello",
    roomAgentOperatorRequest: "hello",
    modelId: "gpt-5.6-sol",
    reasoningEffort: "high",
    agentSessionId: "session:test",
    agentRunId: "agent_run:test",
    agentUserMessageId: "agent_msg:user-test",
    agentAssistantMessageId: "agent_msg:assistant-test",
    traceId: "trace:test",
    ...overrides
  };
}

describe("memoryMutationWorkflow", () => {
  it("returns the activity result unchanged", async () => {
    await withWorker(
      {
        taskQueue: MUTATION_QUEUE,
        workflowsPath: MUTATION,
        activities: {
          executePersistedMemoryChangeSet: async (input: { changeSetId: string }) => ({
            changeSetId: input.changeSetId,
            applied: true
          })
        }
      },
      async () => {
        const result = await env.client.workflow.execute("memoryMutationWorkflow", {
          args: [{ changeSetId: "cs:1", traceId: "trace:1" }],
          taskQueue: MUTATION_QUEUE,
          workflowId: "wf:mutation:1"
        });
        expect(result).toEqual({ changeSetId: "cs:1", applied: true });
      }
    );
  }, 180_000);

  it("retries the activity three times before the workflow fails", async () => {
    let attempts = 0;
    await withWorker(
      {
        taskQueue: MUTATION_QUEUE,
        workflowsPath: MUTATION,
        activities: {
          executePersistedMemoryChangeSet: async () => {
            attempts += 1;
            throw new Error("activity exploded");
          }
        }
      },
      async () => {
        const failure = await env.client.workflow
          .execute("memoryMutationWorkflow", {
            args: [{ changeSetId: "cs:retry", traceId: "trace:retry" }],
            taskQueue: MUTATION_QUEUE,
            workflowId: "wf:mutation:retry"
          })
          .then(
            () => null,
            (error: unknown) => error as { cause?: { cause?: { message?: string } } }
          );
        expect(failure).not.toBeNull();
        // The activity message survives in the failure cause chain.
        expect(JSON.stringify(failure?.cause ?? {})).toContain("activity exploded");
      }
    );
    expect(attempts).toBe(3);
  }, 240_000);
});

describe("memoryMaintenanceWorkflow", () => {
  it("survives the two optional refreshes and runs consolidation as a child", async () => {
    const calls: string[] = [];
    await withWorker(
      {
        taskQueue: MAINTENANCE_QUEUE,
        workflowsPath: MAINTENANCE,
        activities: {
          refreshMemoryGraphSnapshot: async () => {
            calls.push("refresh");
            return { sourceHash: "hash:1" };
          },
          refreshAllMonthsMemoryGraphSnapshot: async () => {
            calls.push("all-months");
            throw new Error("all months unavailable");
          },
          reconcileStaleSpaceAgentSessions: async () => {
            calls.push("reconcile");
            throw new Error("reconcile unavailable");
          },
          createScheduledMemoryAudit: async () => {
            calls.push("audit");
            return { id: "run:1", workflowId: "wf:consolidation:1" };
          },
          prepareMemoryConsolidation: async () => {
            calls.push("prepare");
            return { run: { runId: "run:1" }, changeSetId: null };
          }
        }
      },
      async () => {
        const result = await env.client.workflow.execute("memoryMaintenanceWorkflow", {
          args: [{ traceId: "trace:maintenance" }],
          taskQueue: MAINTENANCE_QUEUE,
          workflowId: "wf:maintenance:1"
        });
        expect(result).toEqual({ sourceHash: "hash:1" });
      }
    );
    // Both optional failures are retried three times, then swallowed; the run
    // still reaches the audit and starts the consolidation child.
    expect(calls[0]).toBe("refresh");
    expect(calls.slice(1, 4)).toEqual(["all-months", "all-months", "all-months"]);
    expect(calls.slice(4, 7)).toEqual(["reconcile", "reconcile", "reconcile"]);
    expect(calls.slice(7)).toEqual(["audit", "prepare"]);
  }, 240_000);
});

describe("dotGoalWorkflow", () => {
  it("returns the goal status as soon as a step reports DONE", async () => {
    await withWorker(
      {
        taskQueue: DOT_QUEUE,
        workflowsPath: WORKFLOWS,
        activities: {
          dotGoalStep: async () => ({ state: "DONE", runId: null, goalStatus: "COMPLETED" }),
          dotGoalObserve: async () => ({ run: "COMPLETED", goalStatus: "COMPLETED" })
        }
      },
      async () => {
        const result = await env.client.workflow.execute("dotGoalWorkflow", {
          args: [{ goalId: "goal:1" }],
          taskQueue: DOT_QUEUE,
          workflowId: "wf:dot:done"
        });
        expect(result).toEqual({ goalStatus: "COMPLETED" });
      }
    );
  }, 180_000);

  it("ends a 30 second pause early when the wake signal arrives", async () => {
    let steps = 0;
    await withWorker(
      {
        taskQueue: DOT_QUEUE,
        workflowsPath: WORKFLOWS,
        activities: {
          dotGoalStep: async () => {
            steps += 1;
            if (steps === 1) return { state: "WAITING", runId: null, goalStatus: "ACTIVE" };
            return { state: "DONE", runId: null, goalStatus: "COMPLETED" };
          },
          dotGoalObserve: async () => ({ run: "COMPLETED", goalStatus: "COMPLETED" })
        }
      },
      async () => {
        const handle = await env.client.workflow.start("dotGoalWorkflow", {
          args: [{ goalId: "goal:wait" }],
          taskQueue: DOT_QUEUE,
          workflowId: "wf:dot:wait"
        });
        await env.sleep("1 second");
        await handle.signal("dotGoalWakeSignal");
        expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
      }
    );
    expect(steps).toBeGreaterThanOrEqual(2);
  }, 180_000);

  it("polls a running step until the run settles, then finishes", async () => {
    let observed = 0;
    let stepCalls = 0;
    await withWorker(
      {
        taskQueue: DOT_QUEUE,
        workflowsPath: WORKFLOWS,
        activities: {
          dotGoalStep: async () => {
            stepCalls += 1;
            // First step hands out a run to poll; the second one closes the goal.
            if (stepCalls === 1) return { state: "RUNNING", runId: "run:1", goalStatus: "ACTIVE" };
            return { state: "DONE", runId: null, goalStatus: "COMPLETED" };
          },
          dotGoalObserve: async () => {
            observed += 1;
            return observed < 3
              ? { run: "RUNNING", goalStatus: "ACTIVE" }
              : { run: "COMPLETED", goalStatus: "COMPLETED" };
          }
        }
      },
      async () => {
        const result = await env.client.workflow.execute("dotGoalWorkflow", {
          args: [{ goalId: "goal:poll" }],
          taskQueue: DOT_QUEUE,
          workflowId: "wf:dot:poll"
        });
        expect(result).toEqual({ goalStatus: "COMPLETED" });
      }
    );
    expect(observed).toBe(3);
  }, 180_000);

  it("continues as new while the goal is still unfinished, keeping the goal id", async () => {
    // runDotGoalLoop gives up after its 300-iteration bound and returns a null
    // status, which is the workflow's cue to continue as new rather than close.
    let stepCalls = 0;
    await withWorker(
      {
        taskQueue: DOT_QUEUE,
        workflowsPath: WORKFLOWS,
        activities: {
          dotGoalStep: async () => {
            stepCalls += 1;
            // First run never settles; the carried run finishes, proving the
            // goal id survived the continue-as-new boundary.
            return stepCalls <= 300
              ? { state: "WAITING", runId: null, goalStatus: "ACTIVE" }
              : { state: "DONE", runId: null, goalStatus: "COMPLETED" };
          },
          dotGoalObserve: async () => ({ run: "COMPLETED", goalStatus: "COMPLETED" })
        }
      },
      async () => {
        const handle = await env.client.workflow.start("dotGoalWorkflow", {
          args: [{ goalId: "goal:continue" }],
          taskQueue: DOT_QUEUE,
          workflowId: "wf:dot:continue"
        });
        const result = await handle.result();
        expect(result).toEqual({ goalStatus: "COMPLETED" });
      }
    );
    // Each run is bounded at 300 loop iterations. More than that means the
    // workflow closed its first run with continueAsNew and the carried goal id
    // resumed in a second run, which then finished.
    expect(stepCalls).toBeGreaterThan(300);
  }, 300_000);
});

describe("dummyTurnWorkflow", () => {
  it("records the start and the completion around one turn", async () => {
    const calls: string[] = [];
    await withWorker(
      {
        taskQueue: TURN_QUEUE,
        workflowsPath: WORKFLOWS,
        activities: {
          recordDummyTurnStarted: async () => {
            calls.push("started");
            return { workflowId: "wf:turn" };
          },
          recordDummyTurnCompleted: async () => {
            calls.push("completed");
            return {
              workflowId: "wf:turn",
              roomId: "room:test",
              paneId: "pane:test",
              traceId: "trace:test"
            };
          }
        }
      },
      async () => {
        await env.client.workflow.execute("dummyTurnWorkflow", {
          args: [turn()],
          taskQueue: TURN_QUEUE,
          workflowId: "wf:dummy-turn:1"
        });
      }
    );
    expect(calls).toEqual(["started", "completed"]);
  }, 180_000);
});
