import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, DefaultLogger, Runtime, Worker, type WorkflowBundle } from "@temporalio/worker";
import { temporal } from "@temporalio/proto";
import { heartbeat, sleep } from "@temporalio/activity";
import { MEMORY_MUTATION_TASK_QUEUE, roomAgentSupervisorInputSchema } from "@space/contracts";
import { MEMORY_MAINTENANCE_TASK_QUEUE } from "../src/memory-maintenance-config.js";

import { continuationFixture } from "./room-continuation-fixture.js";
import { discardSupervisorTurn, finishSupervisorTurn, prepareBackgroundContinuation, supervisorTurnState } from "../src/room-background-continuation.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, "fixtures/workflow-histories");
const record = process.env.SPACE_RECORD_WORKFLOW_HISTORIES === "1";
const History = temporal.api.history.v1.History;
type Handle = Awaited<ReturnType<TestWorkflowEnvironment["client"]["workflow"]["start"]>>;
type Activities = Record<string, (...args: any[]) => any>;
let env: TestWorkflowEnvironment;
let bundle: WorkflowBundle;
let legacyBundle: WorkflowBundle;
let negativeBundle: WorkflowBundle;
const turn = (id = "one") => ({
  roomId: "room:synthetic", paneId: "pane:synthetic", prompt: "Synthetic fixture only",
  traceId: `trace:${id}`, agentRunId: `agent-run:${id}`, artifactIds: [], permissionMode: null,
  collaborationMode: "default"
});
const item = (id = "one") => ({ missionId: `mission:${id}`, turn: turn(id) });
const completed = { status: "COMPLETED", message: "Synthetic completion", roomAgentOutcome: {
  status: "VERIFIED", executedActionCount: 1, statusReason: "Synthetic completion"
} };

async function compile(variant?: "legacy" | "negative") {
  return bundleWorkflowCode({
    workflowsPath: resolve(here, "support/sandbox-workflows.ts"),
    webpackConfigHook(config) {
      if (variant) config.module!.rules!.push({
        test: /[/\\]src[/\\]workflows\.ts$/,
        enforce: "pre",
        use: [{ loader: resolve(here, "support/historical-workflow-loader.cjs"), options: { variant } }]
      });
      return config;
    }
  });
}

beforeAll(async () => {
  Runtime.install({ logger: new DefaultLogger("ERROR") });
  [bundle, legacyBundle, negativeBundle] = await Promise.all([compile(), compile("legacy"), compile("negative")]);
}, 90_000);
beforeEach(async () => { env = await TestWorkflowEnvironment.createTimeSkipping(); }, 30_000);
afterEach(async () => { await env?.teardown(); }, 30_000);

async function save(name: string, handle: Handle) {
  const history = await handle.fetchHistory();
  if (name.startsWith("supervisor-")) {
    expect(history.events?.some(e => e.workflowExecutionFailedEventAttributes || e.workflowExecutionTimedOutEventAttributes), name).toBe(false);
  }
  if (record) {
    await mkdir(fixtures, { recursive: true });
    await writeFile(resolve(fixtures, `${name.replaceAll(":", "-")}.json`), JSON.stringify({
      workflowId: handle.workflowId, history: History.toObject(history, { longs: String, enums: String, bytes: String })
    }, null, 2) + "\n");
  }
  return history;
}

async function withWorker(activities: Activities, body: (queue: string) => Promise<void>, code = bundle) {
  const queue = `sandbox-${randomUUID()}`;
  const worker = await Worker.create({ connection: env.nativeConnection, workflowBundle: code,
    taskQueue: queue, activities, shutdownGraceTime: "1 second" });
  await worker.runUntil(() => body(queue));
}

async function start(queue: string, type: string, arg: unknown) {
  const h = await env.client.workflow.start(type, {
    workflowId: `synthetic-${type}-${randomUUID()}`, taskQueue: queue, args: [arg]
  });
  // Pin histories to the first execution, even when result() follows a continuation.
  return env.client.workflow.getHandle(h.workflowId, h.firstExecutionRunId);
}

async function terminate(handle: Handle) {
  try { await handle.terminate(); }
  catch (error) { if (!(error instanceof Error) || error.name !== "WorkflowNotFoundError") throw error; }
}

async function eventually(check: () => Promise<boolean>) {
  const deadline = Date.now() + 30_000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error("Synthetic workflow did not reach the expected event");
    await new Promise(r => setTimeout(r, 10));
  }
}

// Bound virtual-clock advancement: waiting for an infinite supervisor result
// lets the test server jump to its execution timeout after the queue drains.
async function advanceUntil(check: () => Promise<boolean>) {
  await eventually(async () => {
    if (await check()) return true;
    await env.sleep("1 second");
    return false;
  });
}

it("runs dummy turns with a real activity failure and retry", async () => {
  let attempts = 0;
  await withWorker({
    recordDummyTurnStarted() { if (++attempts === 1) throw new Error("Synthetic transient failure"); },
    recordDummyTurnCompleted: () => ({ status: "COMPLETED" })
  }, async queue => {
    const h = await start(queue, "dummyTurnWorkflow", turn());
    expect(await h.result()).toEqual({ status: "COMPLETED" });
    expect(attempts).toBe(2);
    await save("dummy-turn-retry", h);
  });
}, 30_000);

it("routes all turn providers in the real sandbox", async () => {
  const routes: string[] = [];
  await withWorker({
    runOpenCodeAgentTurn: () => { routes.push("opencode"); return completed; },
    runCliAgentTurn: () => { routes.push("cli"); return completed; },
    runCodexAppServerTurn: () => { routes.push("codex"); return completed; }
  }, async queue => {
    for (const providerId of ["opencode", "cli:claude", "codex"]) {
      const h = await start(queue, "codexAppServerTurnWorkflow", { ...turn(providerId), providerId });
      expect(await h.result()).toEqual(completed);
      await save(`turn-${providerId}`, h);
    }
  });
  expect(routes).toEqual(["opencode", "cli", "codex"]);
}, 30_000);

it.each(["signal", "timeout"])("wakes a paused goal through %s", async mode => {
  let steps = 0;
  let h: Handle;
  await withWorker({ dotGoalStep: async () => {
    if (++steps === 1) return { state: "PAUSED", runId: null, goalStatus: "PAUSED" };
    return { state: "DONE", runId: null, goalStatus: "COMPLETED" };
  } }, async queue => {
    h = await start(queue, "dotGoalWorkflow", { goalId: "goal:synthetic" });
    await eventually(async () => steps === 1);
    if (mode === "signal") await h.signal("dotGoalWake");
    expect(await h.result()).toEqual({ goalStatus: "COMPLETED" });
    expect(steps).toBe(2);
    const history = await save(`goal-${mode}`, h);
    const fired = history.events?.filter(e => e.timerFiredEventAttributes).length ?? 0;
    expect(fired).toBe(mode === "timeout" ? 1 : 0);
  });
}, 30_000);

it("continues unfinished goals as a new run after the iteration bound", async () => {
  let steps = 0;
  await withWorker({ dotGoalStep: () => {
    steps++;
    return steps > 300 ? { state: "DONE", runId: null, goalStatus: "COMPLETED" }
      : { state: "WAITING", runId: null, goalStatus: "ACTIVE" };
  } }, async queue => {
    const h = await start(queue, "dotGoalWorkflow", { goalId: "goal:synthetic" });
    expect(await h.result()).toEqual({ goalStatus: "COMPLETED" });
    const history = await save("goal-continue-as-new", h);
    expect(history.events?.some(e => e.workflowExecutionContinuedAsNewEventAttributes)).toBe(true);
  });
}, 45_000);

it.each([true, false])("persists background action failure after all real retries (explicit action id: %s)", async explicit => {
  let attempts = 0;
  const failures: unknown[] = [];
  await withWorker({
    runRoomAgentBackgroundAction() { attempts++; throw new Error("Synthetic transport failure"); },
    failRoomAgentBackgroundAction: (input: unknown) => { failures.push(input); }
  }, async queue => {
    const h = await start(queue, "roomAgentActionWorkflow", {
      bridge: { roomId: "room:synthetic", missionId: "mission:synthetic" },
      ...(explicit ? { actionId: "action:synthetic" } : {}), traceId: "trace:synthetic"
    });
    await expect(h.result()).rejects.toThrow();
    expect(attempts).toBe(5);
    expect(failures).toEqual([{ roomId: "room:synthetic", missionId: "mission:synthetic",
      actionId: explicit ? "action:synthetic" : h.workflowId, cancelled: false }]);
    await save(explicit ? "room-action-failure" : "room-action-legacy-id-failure", h);
  });
}, 30_000);

it("runs memory maintenance despite failed optional refreshes and runs its child", async () => {
  let refreshAttempts = 0;
  let reconcileAttempts = 0;
  let childCalls = 0;
  const snapshot = { sourceHash: "synthetic-source" };
  const worker = await Worker.create({ connection: env.nativeConnection, workflowBundle: bundle,
    taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE, activities: {
      refreshMemoryGraphSnapshot: () => snapshot,
      refreshAllMonthsMemoryGraphSnapshot() { refreshAttempts++; throw new Error("Synthetic refresh failure"); },
      reconcileStaleSpaceAgentSessions() { reconcileAttempts++; throw new Error("Synthetic reconciliation failure"); },
      createScheduledMemoryAudit: () => ({ id: "audit:synthetic", workflowId: `consolidate-${randomUUID()}` }),
      prepareMemoryConsolidation: () => { childCalls++; return { changeSetId: null, run: { id: "audit:synthetic" } }; }
    } });
  await worker.runUntil(async () => {
    const h = await start(MEMORY_MAINTENANCE_TASK_QUEUE, "memoryMaintenanceWorkflow", { traceId: "trace:synthetic" });
    expect(await h.result()).toEqual(snapshot);
    expect([refreshAttempts, reconcileAttempts, childCalls]).toEqual([3, 3, 1]);
    const history = await save("memory-maintenance", h);
    expect(history.events?.some(e => e.childWorkflowExecutionCompletedEventAttributes)).toBe(true);
  });
}, 30_000);

it("runs consolidation with a change set and retries mutation work", async () => {
  let attempts = 0;
  const mutation = { status: "APPLIED" };
  const mutationWorker = await Worker.create({ connection: env.nativeConnection, workflowBundle: bundle,
    taskQueue: MEMORY_MUTATION_TASK_QUEUE, activities: {
      executePersistedMemoryChangeSet() { if (++attempts === 1) throw new Error("Synthetic mutation failure"); return mutation; }
    } });
  await mutationWorker.runUntil(() => withWorker({
    prepareMemoryConsolidation: () => ({ changeSetId: "changes:synthetic", run: { id: "audit:synthetic" } }),
    finalizeMemoryRepair: (input: any) => ({ id: input.runId, mutationResult: input.mutationResult })
  }, async queue => {
    const h = await start(queue, "memoryConsolidationWorkflow", { runId: "audit:synthetic", traceId: "trace:synthetic" });
    expect(await h.result()).toEqual({ id: "audit:synthetic", mutationResult: mutation });
    expect(attempts).toBe(2);
    await save("memory-consolidation", h);
  }));
  await withWorker({ executePersistedMemoryChangeSet: () => mutation }, async queue => {
    const h = await start(queue, "memoryMutationWorkflow", { changeSetId: "changes:synthetic", traceId: "trace:synthetic" });
    expect(await h.result()).toEqual(mutation);
    await save("memory-mutation", h);
  });
}, 30_000);

it.each(["current", "legacy"])("carries queued supervisor state across the 50-item bound (%s)", async variant => {
  const pending = [item("one"), item("two")];
  const seen: string[] = [];
  const code = variant === "legacy" ? legacyBundle : bundle;
  await withWorker({
    checkRoomAgentSupervisorTurn: () => "RUN",
    finishRoomAgentSupervisorTurn: () => undefined,
    markRoomAgentMissionStarted: () => undefined,
    markRoomAgentMissionFinished: () => undefined,
    runCodexAppServerTurn: (input: any) => { seen.push(input.agentRunId); return completed; }
  }, async queue => {
    const h = await start(queue, "roomAgentSupervisorWorkflow", roomAgentSupervisorInputSchema.parse({
      roomId: "room:synthetic", pending, processedCount: 49
    }));
    try {
      await advanceUntil(async () => seen.length === 2);
      const history = await save(`supervisor-${variant}-continue`, h);
      const continued = history.events?.find(e => e.workflowExecutionContinuedAsNewEventAttributes);
      expect(continued).toBeDefined();
      const carried = continued!.workflowExecutionContinuedAsNewEventAttributes!.input!.payloads![0]!;
      const state = JSON.parse(Buffer.from(carried.data!).toString());
      expect(state.pending).toEqual([pending[1]]);
      expect(state.processedCount).toBe(0);
      expect(seen).toEqual(["agent-run:one", "agent-run:two"]);
    } finally { await terminate(env.client.workflow.getHandle(h.workflowId)); }
  }, code);
}, 30_000);

it.each(["current", "legacy"])("continues supervisor monitoring after 250 real polling timers (%s)", async variant => {
  let polls = 0;
  await withWorker({
    prepareRoomAgentBackgroundContinuation: () => { polls++; return { state: "WAITING" }; },
    settleRoomAgentBackgroundMission: () => { polls++; return false; }
  }, async queue => {
    const h = await start(queue, "roomAgentSupervisorWorkflow", roomAgentSupervisorInputSchema.parse({
      roomId: "room:synthetic", monitoringMissionIds: ["mission:synthetic"]
    }));
    try {
      await advanceUntil(async () => polls >= 250 && Boolean((await h.fetchHistory()).events?.some(e => e.workflowExecutionContinuedAsNewEventAttributes))).catch(async error => { throw new Error(`${variant}: ${polls} polls; ${(await h.fetchHistory()).events?.length} events`, { cause: error }); });
      const history = await save(`supervisor-${variant}-polling`, h);
      expect(history.events?.filter(e => e.timerFiredEventAttributes)).toHaveLength(250);
      const continued = history.events?.find(e => e.workflowExecutionContinuedAsNewEventAttributes);
      expect(continued).toBeDefined();
      const payload = continued!.workflowExecutionContinuedAsNewEventAttributes!.input!.payloads![0]!;
      expect(JSON.parse(Buffer.from(payload.data!).toString()).monitoringMissionIds).toEqual(["mission:synthetic"]);
    } finally { await terminate(env.client.workflow.getHandle(h.workflowId)); }
  }, variant === "legacy" ? legacyBundle : bundle);
}, 50_000);

it.each(["current", "legacy"])("handles enqueue, duplicate, wrong-room and active stop signals (%s)", async variant => {
  let active = false;
  const finished: any[] = [];
  await withWorker({
    checkRoomAgentSupervisorTurn: () => "RUN",
    markRoomAgentMissionStarted: () => undefined,
    discardRoomAgentSupervisorTurn: () => undefined,
    finishRoomAgentSupervisorTurn: (input: any) => { finished.push(input); },
    markRoomAgentMissionFinished: (input: any) => { finished.push(input); },
    runCodexAppServerTurn: async () => {
      active = true;
      const timer = setInterval(() => heartbeat(), 10);
      try { await sleep("1 day"); return completed; }
      finally { clearInterval(timer); }
    }
  }, async queue => {
    const h = await start(queue, "roomAgentSupervisorWorkflow", roomAgentSupervisorInputSchema.parse({ roomId: "room:synthetic" }));
    try {
      const queued = item("active");
      await h.signal("enqueueRoomAgentMission", queued);
      await advanceUntil(async () => active);
      await h.signal("enqueueRoomAgentMission", queued);
      await h.signal("enqueueRoomAgentMission", { ...item("wrong"), turn: { ...turn("wrong"), roomId: "room:wrong" } });
      await h.signal("stopRoomAgentMission", { missionId: null, reason: "Synthetic operator stop" });
      await advanceUntil(async () => finished.length >= 1);
      expect(finished.every(entry => entry.status === "INTERRUPTED")).toBe(true);
      expect(finished.every(entry => (entry.item?.missionId ?? entry.missionId) === queued.missionId)).toBe(true);
    } finally { await terminate(h); }
    await save(`supervisor-${variant}-signals`, h);
  }, variant === "legacy" ? legacyBundle : bundle);
}, 30_000);

it.each(["stop", "follow-up"])("discards a prepared automatic continuation when %s wins the race", async mode => {
  let h: Handle;
  const discarded: any[] = [];
  const executed: string[] = [];
  const automatic = { ...item("automatic"), turn: { ...turn("automatic"), roomAgentContinuation: { sourceRunId: "run:source", generation: 1 } } };
  let prepared = false;
  await withWorker({
    prepareRoomAgentBackgroundContinuation: async () => {
      if (prepared) return { state: "DONE" };
      prepared = true;
      if (mode === "stop") await h.signal("stopRoomAgentMission", { missionId: null, reason: "Synthetic stop during preparation" });
      else await h.signal("enqueueRoomAgentMission", item("follow-up"));
      return { state: "READY", item: automatic };
    },
    discardRoomAgentSupervisorTurn: (input: any) => { discarded.push(input); },
    checkRoomAgentSupervisorTurn: () => "RUN",
    finishRoomAgentSupervisorTurn: () => undefined,
    runCodexAppServerTurn: (input: any) => { executed.push(input.agentRunId); return completed; }
  }, async queue => {
    h = await start(queue, "roomAgentSupervisorWorkflow", roomAgentSupervisorInputSchema.parse({
      roomId: "room:synthetic", monitoringMissionIds: [automatic.missionId]
    }));
    try {
      await advanceUntil(async () => discarded.length > 0 && (mode === "stop" || executed.length > 0));
      expect(discarded[0].item).toEqual(automatic);
      expect(executed).not.toContain("agent-run:automatic");
    } finally { await terminate(h); }
    await save(`supervisor-race-${mode}`, h);
  });
}, 30_000);

it("uses the legacy boolean settle contract without preparing a continuation", async () => {
  let settled = 0;
  let prepared = 0;
  await withWorker({
    settleRoomAgentBackgroundMission: () => { settled++; return true; },
    prepareRoomAgentBackgroundContinuation: () => { prepared++; return { state: "DONE" }; }
  }, async queue => {
    const h = await start(queue, "roomAgentSupervisorWorkflow", roomAgentSupervisorInputSchema.parse({
      roomId: "room:synthetic", monitoringMissionIds: ["mission:synthetic"]
    }));
    try {
      await advanceUntil(async () => settled === 1);
      expect(prepared).toBe(0);
      await save("supervisor-legacy-settled", h);
    } finally { await terminate(h); }
  }, legacyBundle);
}, 30_000);

function persistedSupervisorDriver() {
  const c = continuationFixture();
  const prepared: any[] = [];
  let executions = 0;
  const activities: Activities = {
    prepareRoomAgentBackgroundContinuation: async (input: any) => {
      const result = await prepareBackgroundContinuation(input, c.store);
      if (result.state === "READY") prepared.push(result.item);
      return result;
    },
    checkRoomAgentSupervisorTurn: (item: any) => supervisorTurnState(item, c.store),
    discardRoomAgentSupervisorTurn: ({ item, reason }: any) => discardSupervisorTurn(item, reason, c.store),
    finishRoomAgentSupervisorTurn: (input: any) => finishSupervisorTurn(input, c.store),
    runCodexAppServerTurn: (input: any) => {
      executions++;
      c.store.updateSpaceAgentRun(input.agentRunId, { status: "COMPLETED" });
      return completed;
    }
  };
  return { ...c, activities, prepared, executions: () => executions,
    input: roomAgentSupervisorInputSchema.parse({ roomId: c.room.id, monitoringMissionIds: [c.initial.mission.id] }) };
}

it("persists allocation, send and verification through real supervisor child workflows", async () => {
  const c = persistedSupervisorDriver();
  let executions = 0;
  c.activities.runCodexAppServerTurn = (input: any) => {
    executions++;
    c.store.updateSpaceAgentRun(input.agentRunId, { status: "COMPLETED" });
    if (executions === 1) {
      expect(input.prompt).toContain("Open CLI and Chat, then send a story");
      c.store.createRoomAgentAction({ ...c.action, actionId: "action:send", idempotencyKey: "send-once", actionType: "SEND",
        evidence: { cli: "Story complete", chat: "Story complete" }, statusReason: "Both tasks completed." });
      return { ...completed, roomAgentOutcome: { ...completed.roomAgentOutcome, pendingActionIds: ["action:send"] } };
    }
    return completed;
  };
  await withWorker(c.activities, async queue => {
    const h = await start(queue, "roomAgentSupervisorWorkflow", c.input);
    try {
      await advanceUntil(async () => c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status === "COMPLETED");
      expect(executions).toBe(2);
      expect(c.store.listRoomAgentActions(c.initial.mission.id).filter(a => a.actionType === "SEND")).toHaveLength(1);
      await save("supervisor-allocation-send-verification", h);
    } finally { await terminate(h); }
  });
}, 40_000);

it("carries a persisted prepared continuation into the next execution exactly once", async () => {
  const c = persistedSupervisorDriver();
  await withWorker(c.activities, async queue => {
    const h = await start(queue, "roomAgentSupervisorWorkflow", { ...c.input, processedCount: 50 });
    try {
      await advanceUntil(async () => c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status === "COMPLETED");
      const history = await save("supervisor-prepared-continue", h);
      const continued = history.events!.find(e => e.workflowExecutionContinuedAsNewEventAttributes)!;
      const payload = continued.workflowExecutionContinuedAsNewEventAttributes!.input!.payloads![0]!;
      const carried = JSON.parse(Buffer.from(payload.data!).toString());
      expect(carried.pending).toHaveLength(1);
      expect(carried.pending[0]).toEqual(c.prepared[0]);
      expect(c.executions()).toBe(1);
      expect(history.events!.some(e => e.startChildWorkflowExecutionInitiatedEventAttributes)).toBe(false);
    } finally { await terminate(env.client.workflow.getHandle(h.workflowId)); }
  });
}, 40_000);

it.each(["stop", "follow-up"])("retires the persisted prepared run when %s arrives before the activity reply", async mode => {
  const c = persistedSupervisorDriver();
  let h: Handle;
  let first = true;
  let retired = false;
  const prepare = c.activities.prepareRoomAgentBackgroundContinuation!;
  const discard = c.activities.discardRoomAgentSupervisorTurn!;
  c.activities.prepareRoomAgentBackgroundContinuation = async (input: any) => {
    const response = await prepare(input);
    if (first) {
      first = false;
      if (mode === "stop") {
        c.store.updateRoomAgentMission(c.initial.mission.id, { status: "INTERRUPTED" });
        await h.signal("stopRoomAgentMission", { missionId: null, reason: "Synthetic stop" });
      } else {
        const follow = c.enqueue("follow-up", "Only inspect the room.");
        await h.signal("enqueueRoomAgentMission", follow.queueItem);
      }
    }
    return response;
  };
  c.activities.discardRoomAgentSupervisorTurn = async (input: any) => { await discard(input); retired = true; };
  await withWorker(c.activities, async queue => {
    h = await start(queue, "roomAgentSupervisorWorkflow", c.input);
    try {
      await advanceUntil(async () => retired && (mode === "stop" || c.executions() > 0));
      const prepared = c.prepared[0];
      expect(c.store.getRoomAgentTurn(c.initial.mission.id, prepared.turn.agentRunId)?.run.status).toBe("INTERRUPTED");
      if (mode === "stop") expect(c.executions()).toBe(0);
      await save(`supervisor-persisted-race-${mode}`, h);
    } finally { await terminate(h); }
  });
}, 40_000);

it("drains a signalled queue until continue-as-new input fits without dropping work", async () => {
  let h: Handle;
  let checked = 0;
  let flooded = false;
  const queued = (index: number) => ({ ...item(`flood-${index}`), missionId: "mission:flood" });
  await withWorker({
    checkRoomAgentSupervisorTurn: async () => {
      checked++;
      if (!flooded) {
        flooded = true;
        for (let index = 1; index <= 105; index++) await h.signal("enqueueRoomAgentMission", queued(index));
      }
      return "SKIP";
    },
    discardRoomAgentSupervisorTurn: () => undefined,
    finishRoomAgentSupervisorTurn: () => undefined
  }, async queue => {
    h = await start(queue, "roomAgentSupervisorWorkflow", roomAgentSupervisorInputSchema.parse({
      roomId: "room:synthetic", pending: [queued(0)], processedCount: 49
    }));
    try {
      await advanceUntil(async () => Boolean((await h.fetchHistory()).events?.some(e => e.workflowExecutionContinuedAsNewEventAttributes)));
      const history = await save("supervisor-queue-bound", h);
      const next = history.events!.find(e => e.workflowExecutionContinuedAsNewEventAttributes)!.workflowExecutionContinuedAsNewEventAttributes!;
      const carried = JSON.parse(Buffer.from(next.input!.payloads![0]!.data!).toString());
      expect(carried.pending).toHaveLength(100);
      expect(carried.pending).toEqual(Array.from({ length: 100 }, (_, i) => queued(i + 6)));
      expect(() => roomAgentSupervisorInputSchema.parse(carried)).not.toThrow();
      const checks = history.events!.filter(e => e.activityTaskScheduledEventAttributes?.activityType?.name === "checkRoomAgentSupervisorTurn");
      expect(checks).toHaveLength(6);
      expect(checked).toBeGreaterThanOrEqual(6);
    } finally { await terminate(env.client.workflow.getHandle(h.workflowId)); }
  });
}, 40_000);

it("replays every committed synthetic history against production code", async () => {
  const names = (await readdir(fixtures)).filter(n => n.endsWith(".json"));
  expect(names).toEqual(expect.arrayContaining([
    "dummy-turn-retry.json", "goal-continue-as-new.json", "turn-codex.json",
    "supervisor-current-continue.json", "supervisor-legacy-continue.json",
    "room-action-failure.json", "memory-maintenance.json",
    "memory-consolidation.json", "memory-mutation.json"
  ]));
  const inputs = await Promise.all(names.map(async name => {
    const data = JSON.parse(await readFile(resolve(fixtures, name), "utf8"));
    return { workflowId: `${name}:${data.workflowId}`, history: History.fromObject(data.history) };
  }));
  const results = [];
  for await (const result of Worker.runReplayHistories({ workflowBundle: bundle }, inputs)) results.push(result);
  expect(results).toHaveLength(names.length);
  for (const result of results) expect(result.error, result.workflowId).toBeUndefined();
}, 30_000);

it("rejects an unpatched added timer with DeterminismViolationError", async () => {
  const fixture = JSON.parse(await readFile(resolve(fixtures, "dummy-turn-retry.json"), "utf8"));
  await expect(Worker.runReplayHistory({ workflowBundle: negativeBundle }, History.fromObject(fixture.history)))
    .rejects.toMatchObject({ name: "DeterminismViolationError" });
}, 30_000);
