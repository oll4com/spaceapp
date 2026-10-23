/** Real Temporal sandbox + deterministic histories, not mocked workflow APIs.
 * Records only synthetic test data when SPACE_TEMPORAL_RECORD_HISTORIES=1.
 * Checked-in histories are immutable in ordinary CI: only change alongside a
 * documented `patched()` workflow change, never to hide a replay regression.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import temporalProto from "@temporalio/proto";
import { DeterminismViolationError } from "@temporalio/workflow";
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { MEMORY_MUTATION_TASK_QUEUE, DOT_GOAL_SIGNAL, ROOM_AGENT_ENQUEUE_SIGNAL, ROOM_AGENT_STOP_SIGNAL, roomAgentSupervisorInputSchema,
  roomAgentSupervisorQueueItemSchema } from "@space/contracts";

const here = dirname(fileURLToPath(import.meta.url));
const workflowPath = resolve(here, "support/bounty-real-temporal-workflows.ts");
const legacyPath = resolve(here, "support/bounty-legacy-supervisor-workflows.ts");
const brokenPath = resolve(here, "support/bounty-replay-broken.ts");
const historiesDir = resolve(here, "fixtures/workflow-histories");
const record = process.env.SPACE_TEMPORAL_RECORD_HISTORIES === "1";
const scenarios = [
  "dot-goal", "dummy-turn", "codex-turn", "room-supervisor-current",
  "room-supervisor-legacy", "room-action-failed", "memory-maintenance",
  "memory-consolidation", "memory-mutation"
] as const;

let env: TestWorkflowEnvironment;
beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
}, 120_000);

afterAll(async () => { await env?.teardown(); }, 45_000);

async function sandbox<T>(
  name: string,
  activities: Record<string, (...args: any[]) => any>,
  action: (taskQueue: string) => Promise<T>,
  additionalQueues: string[] = [],
  selectedWorkflowPath = workflowPath
): Promise<T> {
  const taskQueue = `bounty-${name}-${randomUUID()}`;
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowsPath: selectedWorkflowPath,
    activities
  });
  const auxiliaryWorkers = await Promise.all(additionalQueues.map(queue => Worker.create({
    connection: env.nativeConnection, taskQueue: queue, workflowsPath: workflowPath, activities
  })));
  const auxiliaryRuns = auxiliaryWorkers.map(aux => aux.run());
  try { return await worker.runUntil(() => action(taskQueue)); }
  finally {
    await Promise.all(auxiliaryWorkers.map(aux => aux.shutdown()));
    await Promise.allSettled(auxiliaryRuns);
  }
}

function saveHistory(name: string, history: Awaited<ReturnType<ReturnType<typeof env.client.workflow.getHandle>["fetchHistory"]>>) {
  // Pin one synthetic history per production workflow plus the old supervisor
  // branch. The 250-poll scenario alone produces ~50,000 JSON lines: execute
  // that case on the real sandbox but do not bloat the long-lived replay corpus.
  if (!record || !(scenarios as readonly string[]).includes(name)) return;
  mkdirSync(historiesDir, { recursive: true });
  const json = temporalProto.temporal.api.history.v1.History.toObject(history, {
    longs: String, enums: String, bytes: String
  });
  writeFileSync(join(historiesDir, `${name}.json`), JSON.stringify(redactFixtureIdentity(json), null, 2) + "\n");
}

/** Remove host/PID and absolute native stack paths from synthetic replay fixtures.
 * Keep event IDs, payloads and deterministic failure codes unchanged; changing
 * those would conceal a workflow replay regression rather than sanitizing it.
 */
function redactFixtureIdentity(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactFixtureIdentity);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (key === "identity" && typeof entry === "string") return [key, "synthetic@temporal-sandbox"];
    if (key === "stackTrace" && typeof entry === "string") return [key, "Synthetic test failure: stack trace redacted"];
    return [key, redactFixtureIdentity(entry)];
  }));
}

function loadHistory(name: string) {
  return temporalProto.temporal.api.history.v1.History.fromObject(
    JSON.parse(readFileSync(join(historiesDir, `${name}.json`), "utf8"))
  );
}

function id(name: string) { return `bounty-${name}-${randomUUID()}`; }
function dummyInput() { return {
  roomId: "room:synthetic", paneId: "pane:synthetic", prompt: "Synthetic offline workflow",
  agentSessionId: "session:synthetic", traceId: "trace:synthetic"
}; }

async function executeAndCapture(taskQueue: string, workflowType: string, scenario: string, args: any[] = []) {
  const handle = await env.client.workflow.start(workflowType, { workflowId: id(scenario), taskQueue, args });
  const result = await handle.result();
  saveHistory(scenario, await handle.fetchHistory());
  return result;
}

describe("real Temporal sandbox (CORE-006)", () => {
  it("dotGoalWorkflow completes after real time-skipping wait, not a mocked condition", async () => {
    let steps = 0;
    await sandbox("dot", {
      dotGoalStep: async () => (++steps === 1
        ? { state: "WAITING", runId: null, goalStatus: "RUNNING" }
        : { state: "DONE", runId: null, goalStatus: "DONE" }),
      dotGoalObserve: async () => ({ run: "DONE", goalStatus: "DONE" })
    }, async (q) => {
      const output = await executeAndCapture(q, "dotGoalWorkflow", "dot-goal", [{ goalId: "goal:synthetic" }]);
      expect(output).toEqual({ goalStatus: "DONE" });
    });
    expect(steps).toBe(2);
  }, 90_000);

  it("dotGoalWorkflow consumes a wake signal without waiting out the full poll timeout", async () => {
    let steps = 0;
    await sandbox("dot-wake", {
      dotGoalStep: async () => (++steps === 1
        ? { state: "PAUSED", runId: null, goalStatus: "PAUSED" }
        : { state: "DONE", runId: null, goalStatus: "DONE" }),
      dotGoalObserve: async () => ({ run: "DONE", goalStatus: "DONE" })
    }, async q => {
      const handle = await env.client.workflow.start("dotGoalWorkflow", {
        workflowId: id("dot-goal-wake"), taskQueue: q, args: [{ goalId: "goal:synthetic-wake" }]
      });
      await handle.signal(DOT_GOAL_SIGNAL);
      expect(await handle.result()).toEqual({ goalStatus: "DONE" });
      const history = await handle.fetchHistory();
      expect(history.events?.some(e => e.workflowExecutionSignaledEventAttributes)).toBe(true);
      saveHistory("dot-goal-wake", history);
    });
    expect(steps).toBe(2);
  }, 90_000);

  it("dotGoalWorkflow continues as new on a still-unfinished goal and later finishes", async () => {
    // The goal remains WAITING through the entire original 300-iteration
    // history budget, so this exercises real Temporal continueAsNew rather
    // than a mocked callback or a manually injected continue command.
    let steps = 0;
    await sandbox("dot-continuation", {
      dotGoalStep: async () => (++steps <= 300
        ? { state: "WAITING", runId: null, goalStatus: "RUNNING" }
        : { state: "DONE", runId: null, goalStatus: "DONE" }),
      dotGoalObserve: async () => ({ run: "DONE", goalStatus: "DONE" })
    }, async taskQueue => {
      const workflowId = id("dot-goal-continue");
      const handle = await env.client.workflow.start("dotGoalWorkflow", {
        workflowId, taskQueue, args: [{ goalId: "goal:synthetic-still-running" }]
      });
      const first = env.client.workflow.getHandle(workflowId, handle.firstExecutionRunId);
      expect(await handle.result()).toEqual({ goalStatus: "DONE" });
      const history = await first.fetchHistory();
      expect(history.events?.some(event => event.workflowExecutionContinuedAsNewEventAttributes)).toBe(true);
      expect(steps).toBe(301);
    });
  }, 150_000);

  it("dummyTurnWorkflow retries its real Temporal activity and records completion", async () => {
    let starts = 0;
    await sandbox("dummy", {
      recordDummyTurnStarted: async () => { if (++starts < 3) throw Error("synthetic transient failure"); },
      recordDummyTurnCompleted: async () => ({ status: "COMPLETED", message: "synthetic verified" })
    }, async (q) => {
      const out: any = await executeAndCapture(q, "dummyTurnWorkflow", "dummy-turn", [dummyInput()]);
      expect(out.status).toBe("COMPLETED");
    });
    expect(starts).toBe(3);
  }, 90_000);

  it("codexAppServerTurnWorkflow dispatches through real workflow sandbox", async () => {
    let count = 0;
    await sandbox("codex", {
      runOpenCodeAgentTurn: async () => { count++; return { status: "COMPLETED", message: "offline" }; }
    }, async (q) => {
      const out: any = await executeAndCapture(q, "codexAppServerTurnWorkflow", "codex-turn", [{ ...dummyInput(), providerId: "opencode" }]);
      expect(out.status).toBe("COMPLETED");
    });
    expect(count).toBe(1);
  }, 90_000);

  it("roomAgentActionWorkflow persists a real failure branch", async () => {
    let recorded = 0;
    await sandbox("action", {
      runRoomAgentBackgroundAction: async () => { throw Error("synthetic action failure"); },
      failRoomAgentBackgroundAction: async () => { recorded++; }
    }, async (q) => {
      const handle = await env.client.workflow.start("roomAgentActionWorkflow", { workflowId: id("action"), taskQueue: q,
        args: [{ bridge: { roomId: "room:synthetic", missionId: "mission:synthetic" }, actionId: "action:synthetic" }] });
      await expect(handle.result()).rejects.toThrow();
      saveHistory("room-action-failed", await handle.fetchHistory());
    });
    expect(recorded).toBe(1);
  }, 90_000);

  it("memoryMutationWorkflow uses real activity retry policy", async () => {
    let count = 0;
    await sandbox("mutation", {
      executePersistedMemoryChangeSet: async () => { if (++count === 1) throw Error("synthetic transient"); return { changed: true }; }
    }, async (q) => {
      const out: any = await executeAndCapture(q, "memoryMutationWorkflow", "memory-mutation", [{ changeSetId: "change:synthetic", traceId: "trace:synthetic" }]);
      expect(out.changed).toBe(true);
    });
    expect(count).toBe(2);
  }, 90_000);

  it("memoryConsolidationWorkflow executes a change set on the true activity path", async () => {
    await sandbox("consolidation", {
      prepareMemoryConsolidation: async () => ({ changeSetId: "change:synthetic", run: { id: "run:synthetic" } }),
      executePersistedMemoryChangeSet: async () => ({ applied: 1 }),
      finalizeMemoryRepair: async () => ({ id: "run:synthetic", status: "COMPLETE" })
    }, async (q) => {
      const out: any = await executeAndCapture(q, "memoryConsolidationWorkflow", "memory-consolidation", [{ runId: "run:synthetic", traceId: "trace:synthetic" }]);
      expect(out.status).toBe("COMPLETE");
    }, [MEMORY_MUTATION_TASK_QUEUE]);
  }, 90_000);

  it("memoryMaintenanceWorkflow tolerates both independent recoverable failures and starts child", async () => {
    const seen: string[] = [];
    await sandbox("maintenance", {
      refreshMemoryGraphSnapshot: async () => ({ sourceHash: "synthetic" }),
      refreshAllMonthsMemoryGraphSnapshot: async () => { seen.push("all-months"); throw Error("synthetic failure"); },
      reconcileStaleSpaceAgentSessions: async () => { seen.push("reconcile"); throw Error("synthetic failure"); },
      createScheduledMemoryAudit: async () => ({ id: "run:synthetic", workflowId: id("memory-child") }),
      prepareMemoryConsolidation: async () => ({ changeSetId: null, run: { id: "run:synthetic", status: "COMPLETE" } })
    }, async (q) => {
      const out: any = await executeAndCapture(q, "memoryMaintenanceWorkflow", "memory-maintenance", [{ traceId: "trace:synthetic" }]);
      expect(out.sourceHash).toBe("synthetic");
    }, ["space-memory-maintenance"]);
    // Both independent noncritical activities exhausted their three real
    // Temporal retries, and the workflow still launched the child.
    expect(seen).toEqual(["all-months", "all-months", "all-months", "reconcile", "reconcile", "reconcile"]);
  }, 90_000);

  for (const [name, caseName] of [["current", "room-supervisor-current"], ["legacy", "room-supervisor-legacy"]] as const) {
    it(`roomAgentSupervisorWorkflow runs real ${name} branch and continues after 50 processed items`, async () => {
      let actions = 0;
      const roomId = "room:synthetic";
      const input = roomAgentSupervisorInputSchema.parse({ roomId, processedCount: 49 });
      const item = roomAgentSupervisorQueueItemSchema.parse({ missionId: "mission:synthetic", turn: {
        ...dummyInput(), roomId, agentRunId: id("agent-run"), traceId: id("trace")
      } });
      await sandbox(caseName, {
        checkRoomAgentSupervisorTurn: async () => "SKIP",
        discardRoomAgentSupervisorTurn: async () => { actions++; },
        finishRoomAgentSupervisorTurn: async () => undefined,
        markRoomAgentMissionStarted: async () => { actions++; },
        markRoomAgentMissionFinished: async () => { actions++; },
        runCodexAppServerTurn: async () => ({ status: "COMPLETED", message: "synthetic",
          roomAgentOutcome: { status: "VERIFIED", statusReason: "synthetic verified" } })
      }, async (q) => {
        const workflowId = id(caseName);
        const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", { workflowId, taskQueue: q, args: [input] });
        await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item);
        const first = env.client.workflow.getHandle(workflowId, handle.firstExecutionRunId);
        let history = await first.fetchHistory();
        for (let i = 0; i < 10 && !history.events?.some(e => e.workflowExecutionContinuedAsNewEventAttributes); i++) {
          await env.sleep("1 second");
          history = await first.fetchHistory();
        }
        expect(history.events?.some(e => e.workflowExecutionContinuedAsNewEventAttributes)).toBe(true);
        expect(actions).toBeGreaterThan(0);
        saveHistory(caseName, history);
        await env.client.workflow.getHandle(workflowId).terminate("synthetic continuation test complete");
      }, [], name === "legacy" ? legacyPath : workflowPath);
    }, 90_000);
  }

  it("carries a prepared Room Agent turn through real continue-as-new and executes it exactly once", async () => {
    let prepared = 0;
    let childTurns = 0;
    let finishedTurns = 0;
    let resolveFinished!: () => void;
    const finished = new Promise<void>(resolve => { resolveFinished = resolve; });
    const roomId = "room:carry-real";
    const missionId = "mission:carry-real";
    const preparedItem = roomAgentSupervisorQueueItemSchema.parse({
      missionId,
      turn: {
        ...dummyInput(), roomId, agentRunId: id("prepared-child"),
        roomAgentContinuation: { sourceRunId: "agent_run:synthetic-source", generation: 1 }
      }
    });
    await sandbox("room-carry-state", {
      prepareRoomAgentBackgroundContinuation: async () => {
        prepared++;
        return { state: "READY", item: preparedItem };
      },
      checkRoomAgentSupervisorTurn: async () => "READY",
      runCodexAppServerTurn: async () => {
        childTurns++;
        return { status: "COMPLETED", message: "synthetic completed" };
      },
      finishRoomAgentSupervisorTurn: async () => { finishedTurns++; resolveFinished(); },
      discardRoomAgentSupervisorTurn: async () => undefined
    }, async taskQueue => {
      const workflowId = id("supervisor-carried-real");
      const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
        workflowId, taskQueue,
        args: [{ roomId, processedCount: 50, monitoringMissionIds: [missionId] }]
      });
      const first = env.client.workflow.getHandle(workflowId, handle.firstExecutionRunId);
      await finished;
      const history = await first.fetchHistory();
      const continuation = history.events?.find(event => event.workflowExecutionContinuedAsNewEventAttributes);
      expect(continuation).toBeDefined();
      const payload = continuation?.workflowExecutionContinuedAsNewEventAttributes?.input?.payloads?.[0];
      expect(payload?.data).toBeDefined();
      const carried = roomAgentSupervisorInputSchema.parse(JSON.parse(Buffer.from(payload!.data!).toString("utf8")));
      expect(carried.roomId).toBe(roomId);
      expect(carried.pending).toEqual([preparedItem]);
      expect(carried.monitoringMissionIds).toContain(missionId);
      expect(prepared).toBe(1);
      expect(childTurns).toBe(1);
      expect(finishedTurns).toBe(1);
      await handle.terminate("synthetic carried turn completed");
    });
  }, 90_000);

  it("room supervisor stop interrupts a pending mission inside the true sandbox", async () => {
    let discarded = 0;
    let interrupted = 0;
    const taskQueue = `bounty-supervisor-stop-${randomUUID()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection, taskQueue, workflowsPath: workflowPath,
      activities: {
        discardRoomAgentSupervisorTurn: async () => { discarded++; },
        finishRoomAgentSupervisorTurn: async (event: { status?: string }) => {
          if (event.status === "INTERRUPTED") interrupted++;
        },
        checkRoomAgentSupervisorTurn: async () => "SKIP"
      }
    });
    const workflowId = id("room-supervisor-stop");
    const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
      workflowId, taskQueue, args: [{ roomId: "room:synthetic" }]
    });
    const item = roomAgentSupervisorQueueItemSchema.parse({ missionId: "mission:synthetic-stop", turn: {
      ...dummyInput(), agentRunId: id("agent-run-stop")
    } });
    // Buffer both signals on the REAL Temporal service before starting worker
    // polling; a concurrent SKIP activity could otherwise finish the mission
    // before STOP is received, producing a false-negative race.
    await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item);
    await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: item.missionId, reason: "Synthetic stop" });
    await worker.runUntil(async () => {
      for (let i = 0; i < 10 && !interrupted; i++) await env.sleep("1 second");
      expect(interrupted).toBeGreaterThan(0);
    });
    expect(discarded).toBeGreaterThan(0);
    await handle.terminate("synthetic stop observed");
    saveHistory("room-supervisor-stop", await handle.fetchHistory());
  }, 90_000);

  it("room supervisor bounds history after 250 real timed polls and carries monitoring IDs", async () => {
    // This scenario advances the ephemeral server clock by several minutes.
    // Isolate it from prior tests' gRPC keepalive timers: otherwise the
    // accelerated clock can trip the test server's excess-ping throttle.
    await env.teardown();
    env = await TestWorkflowEnvironment.createTimeSkipping();
    let polls = 0;
    const workflowId = id("room-supervisor-poll250");
    await sandbox("supervisor-poll250", {
      prepareRoomAgentBackgroundContinuation: async () => { polls++; return { state: "PENDING" }; }
    }, async q => {
      const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
        workflowId, taskQueue: q, args: [{ roomId: "room:synthetic", monitoringMissionIds: ["mission:synthetic-monitor"] }]
      });
      const first = env.client.workflow.getHandle(workflowId, handle.firstExecutionRunId);
      let history = await first.fetchHistory();
      for (let attempt = 0; attempt < 4 && !history.events?.some(e => e.workflowExecutionContinuedAsNewEventAttributes); attempt++) {
        await env.sleep("251 seconds");
        history = await first.fetchHistory();
      }
      expect(polls).toBeGreaterThanOrEqual(250);
      const continuation = history.events?.find(e => e.workflowExecutionContinuedAsNewEventAttributes);
      expect(continuation).toBeDefined();
      saveHistory("room-supervisor-poll250", history);
      await env.client.workflow.getHandle(workflowId).terminate("synthetic 250-poll test complete");
    });
  }, 120_000);
});

describe("recorded synthetic history replay gate", () => {
  it("does not commit recorder machine identities or absolute stack paths in synthetic histories", () => {
    for (const name of scenarios) {
      const text = readFileSync(join(historiesDir, `${name}.json`), "utf8");
      const object = JSON.parse(text);
      expect(text).not.toMatch(/\"identity\": \"\d+@/);
      expect(text).not.toMatch(/\/home\/[^\s"\\]+/);
      expect(text).not.toMatch(/\"stackTrace\": \"[^\"]*\n/);
      // The recorded syntax must remain valid for the native replay decoder.
      expect(temporalProto.temporal.api.history.v1.History.fromObject(object)).toBeDefined();
    }
  });
  it("replays each pinned real sandbox history against production workflows", async () => {
    if (record) return;
    const names = scenarios.filter(x => readdirSync(historiesDir).includes(`${x}.json`));
    expect(names).toHaveLength(scenarios.length);
    const histories = names.map(name => ({ workflowId: `replay-${name}`,
      history: loadHistory(name) }));
    const outcomes = [];
    for await (const output of Worker.runReplayHistories({ workflowsPath: workflowPath }, histories)) outcomes.push(output);
    expect(outcomes).toHaveLength(scenarios.length);
    expect(outcomes.filter(result => result.error)).toEqual([]);
  }, 120_000);

  it("detects an extra timer in the test-only workflow as determinism violation", async () => {
    if (record) return;
    const history = loadHistory("dummy-turn");
    await expect(Worker.runReplayHistory({ workflowsPath: brokenPath }, history, "replay-dummy-turn"))
      .rejects.toBeInstanceOf(DeterminismViolationError);
  }, 60_000);
});
