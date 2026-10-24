import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { ApplicationFailure } from "@temporalio/activity";
import {
  ActivityRecorder,
  blockUntilCancelled,
  cancelAndWait,
  createTimeSkippingEnvironment,
  createSandboxWorker,
  expectContinueAsNew,
  queueItem,
  sleep,
  stopSandboxWorker,
  turnResult
} from "./support/workflow-sandbox-kit.js";

const QUEUE = "test-supervisor";
const LEGACY_QUEUE = "test-supervisor-legacy";
const ROOM = "room:test";
const PANE = "pane:test";
const WORKFLOWS_PATH = new URL("../src/workflows.ts", import.meta.url).pathname;
const PRE_PATCH_PATH = new URL("./support/pre-patch-workflows.ts", import.meta.url).pathname;

type AnyRecord = Record<string, any>;
type TrackedHandle = { cancel(): Promise<void>; result(): Promise<unknown> };

const expectCauseMessage = (error: unknown, pattern: RegExp): void => {
  const seen: string[] = [];
  let current: unknown = error;
  for (let i = 0; i < 8 && current; i++) {
    const c = current as AnyRecord;
    const text = [c.message, c.type, c.name].filter((x) => typeof x === "string" && x.length).join(" | ");
    if (text) seen.push(text);
    if (pattern.test(text)) return;
    current = c.cause;
  }
  throw new Error(`expected cause matching ${pattern}, saw: ${seen.join(" -> ")}`);
};

describe("real sandbox: roomAgentSupervisorWorkflow + roomAgentActionWorkflow", () => {
  let env: TestWorkflowEnvironment;
  const rec = new ActivityRecorder({
    checkRoomAgentSupervisorTurn: () => "RUN",
    discardRoomAgentSupervisorTurn: () => undefined,
    finishRoomAgentSupervisorTurn: () => undefined,
    prepareRoomAgentBackgroundContinuation: () => ({ state: "WAITING" }),
    runCodexAppServerTurn: () => turnResult({}) as never,
    runRoomAgentBackgroundAction: () => ({ ok: true }),
    failRoomAgentBackgroundAction: () => undefined,
    settleRoomAgentBackgroundMission: () => true,
    markRoomAgentMissionStarted: () => undefined,
    markRoomAgentMissionFinished: () => undefined,
    markRoomAgentMissionContinued: () => undefined
  });

  beforeAll(async () => {
    env = await createTimeSkippingEnvironment();
    workerBundle = await createSandboxWorker(env, { taskQueue: QUEUE, workflowsPath: WORKFLOWS_PATH, activities: rec.acts });
  }, 60_000);

  afterAll(async () => {
    await env?.teardown();
  }, 40_000);

  let workerBundle: { worker: unknown; running: Promise<void> } | undefined;
  let legacyBundle: { worker: unknown; running: Promise<void> } | undefined;
  const startedHandles: TrackedHandle[] = [];
  const track = async (startPromise: Promise<TrackedHandle>): Promise<TrackedHandle> => {
    const handle = await startPromise;
    startedHandles.push(handle);
    return handle;
  };
  afterEach(async () => {
    while (startedHandles.length) await cancelAndWait(startedHandles.pop()!);
    rec.restoreDefaults();
  });

  const startSupervisor = (
    input: Record<string, unknown>,
    workflowId = `wf:test-sup-${Math.random().toString(36).slice(2)}`,
    taskQueue = QUEUE
  ) =>
    track(env.client.workflow.start("roomAgentSupervisorWorkflow", {
      workflowId, taskQueue, args: [input], followRuns: false
    }) as unknown as Promise<TrackedHandle>);

  /** Last finish/discard call for one mission - immune to other workflows' chatter. */
  const lastFor = (name: string, missionId: string) =>
    (rec.argsOf(name) as unknown[][])
      .filter((call) => (call[0] as AnyRecord)?.item?.missionId === missionId)
      .at(-1)?.[0] as AnyRecord | undefined;

  const freshRec = (over: AnyRecord): void => {
    for (const [key, value] of Object.entries(over)) {
      (rec.impl as AnyRecord)[key] = value;
    }
  };

  /** A child-success stub that answers VERIFIED+pendingActionIds only for one agentRunId. */
  const continueReadyStub = (continueRunId: string) => {
    const seen = new Set<string>();
    return (input: AnyRecord) => {
      const id = String(input?.agentRunId ?? "");
      if (id === continueRunId && !seen.has(id)) {
        seen.add(id);
        return turnResult({
          roomAgentOutcome: { status: "VERIFIED", pendingActionIds: ["action:alloc"], executedActionCount: 1, statusReason: "Panes allocated." }
        });
      }
      return turnResult({});
    };
  };

  it("runs the queued turn and finishes it COMPLETED", async () => {
    const beforeCheck = rec.count("checkRoomAgentSupervisorTurn");
    const beforeFinish = rec.count("finishRoomAgentSupervisorTurn");
    const beforeDiscard = rec.count("discardRoomAgentSupervisorTurn");
    const item = queueItem({ missionId: "mission:basic", roomId: ROOM, paneId: PANE, agentRunId: "agent-run-1", traceId: "trace-basic-1" });
    await startSupervisor({ roomId: ROOM, pending: [item] }, "wf:test-sup-basic");
    await rec.waitFor("finishRoomAgentSupervisorTurn", beforeFinish + 1);
    expect(rec.count("checkRoomAgentSupervisorTurn") - beforeCheck).toBe(1);
    expect(rec.count("discardRoomAgentSupervisorTurn") - beforeDiscard).toBe(0);
    expect(lastFor("finishRoomAgentSupervisorTurn", "mission:basic")).toMatchObject({ status: "COMPLETED", statusReason: "Completed." });
  }, 30_000);

  it("parity: carries a prepared continuation through continueAsNew and starts it once", async () => {
    freshRec({
      runCodexAppServerTurn: continueReadyStub("agent-run-1") as never,
      prepareRoomAgentBackgroundContinuation: () => ({
        state: "READY",
        item: queueItem({
          missionId: "mission:auto", roomId: ROOM, paneId: PANE, agentRunId: "agent-run-auto", traceId: "trace-auto-1",
          roomAgentContinuation: { sourceRunId: "agent-run-1", generation: 1 }
        })
      })
    });
    let autoPrepared = false;
    freshRec({
      prepareRoomAgentBackgroundContinuation: () => {
        if (!autoPrepared) {
          autoPrepared = true;
          return {
            state: "READY",
            item: queueItem({
              missionId: "mission:auto", roomId: ROOM, paneId: PANE, agentRunId: "agent-run-auto", traceId: "trace-auto-1",
              roomAgentContinuation: { sourceRunId: "agent-run-1", generation: 1 }
            })
          };
        }
        return { state: "DONE" };
      }
    });
    const item = queueItem({ missionId: "mission:carry", roomId: ROOM, paneId: PANE, agentRunId: "agent-run-1", traceId: "trace-carry-1" });
    const handle = await startSupervisor({ roomId: ROOM, pending: [item], processedCount: 50 }, "wf:test-sup-continuation");
    const { args } = await expectContinueAsNew(handle);
    expect(args.pending).toEqual([]); // the continuation source is carried via monitoring
    expect(args.monitoringMissionIds).toEqual(["mission:carry"]);
    // The continued run is already running on the server; wait for it to finish the prepared turn.
    await rec.waitFor("finishRoomAgentSupervisorTurn", 1);
    const autoRuns = (rec.argsOf("runCodexAppServerTurn") as unknown[][]).filter((c) => (c[0] as AnyRecord)?.agentRunId === "agent-run-auto");
    expect(autoRuns).toHaveLength(1); // started exactly once
    expect(lastFor("finishRoomAgentSupervisorTurn", "mission:auto")).toMatchObject({ status: "COMPLETED" });
  }, 30_000);

  it("parity: retires a prepared run when a stop signal arrives before its activity reply", async () => {
    let releasePrepare!: (v: unknown) => void;
    const gate = new Promise((resolve) => { releasePrepare = resolve; });
    try {
      freshRec({
        runCodexAppServerTurn: continueReadyStub("agent-run-1") as never,
        prepareRoomAgentBackgroundContinuation: async () => {
          await gate;
          return {
            state: "READY",
            item: queueItem({
              missionId: "mission:auto", roomId: ROOM, paneId: PANE, agentRunId: "agent-run-auto", traceId: "trace-auto-2",
              roomAgentContinuation: { sourceRunId: "agent-run-1", generation: 1 }
            })
          };
        }
      });
      const item = queueItem({ missionId: "mission:retire", roomId: ROOM, paneId: PANE, agentRunId: "agent-run-1", traceId: "trace-retire-1" });
      const beforeChildren = rec.count("runCodexAppServerTurn");
      const handle = await startSupervisor({ roomId: ROOM, pending: [item] }, "wf:test-sup-retire");
      await rec.waitFor("prepareRoomAgentBackgroundContinuation", rec.count("prepareRoomAgentBackgroundContinuation") + 1);
      await handle.signal("stopRoomAgentMission", { missionId: null, reason: "Stop preparing." });
      await sleep(1000); // signals are processed while the prepare activity is blocked
      releasePrepare(undefined);
      await rec.waitFor("discardRoomAgentSupervisorTurn", rec.count("discardRoomAgentSupervisorTurn") + 1);
      const superseded = (rec.argsOf("discardRoomAgentSupervisorTurn") as unknown[][]).find((call) => {
        const arg = call[0] as AnyRecord;
        return arg?.item?.missionId === "mission:auto" && arg?.reason === "Superseded while preparing the automatic continuation.";
      });
      expect(superseded).toBeDefined(); // the prepared run was retired, not started
      expect(rec.count("runCodexAppServerTurn") - beforeChildren).toBe(1); // only the original turn ran
    } finally {
      releasePrepare(undefined);
    }
  }, 30_000);

  it("parity: defers continueAsNew until the carried queue fits the next run's input bounds", async () => {
    let releaseCheck!: (v: unknown) => void;
    const gate = new Promise((resolve) => { releaseCheck = resolve; });
    try {
      let calls = 0;
      freshRec({
        checkRoomAgentSupervisorTurn: async () => {
          calls += 1;
          if (calls === 1) await gate;
          // 6 drains in run 1 bring pending from 105 to 100; PAUSED in run 2 parks outside try/catch for clean cancel.
          return calls <= 6 ? "SKIP" : "PAUSED";
        }
      });
      const item0 = queueItem({ missionId: "mission:0", roomId: ROOM, paneId: PANE, agentRunId: "agent-run-0", traceId: "trace-defer-0" });
      const beforeCheck = rec.count("checkRoomAgentSupervisorTurn");
      const handle = await startSupervisor({ roomId: ROOM, pending: [item0], processedCount: 49 }, "wf:test-sup-defer");
      await rec.waitFor("checkRoomAgentSupervisorTurn", beforeCheck + 1);
      for (let i = 1; i <= 105; i++) {
        await handle.signal("enqueueRoomAgentMission", queueItem({
          missionId: `mission:${i}`, roomId: ROOM, paneId: PANE, agentRunId: `agent-run-${i}`, traceId: `trace-run-${i}`
        }));
      }
      await sleep(250);
      releaseCheck(undefined);
      const { args } = await expectContinueAsNew(handle);
      expect((args as AnyRecord).pending).toHaveLength(100); // drained to the carry limit
      // Wait for run 2's first check ("PAUSED") so run 2 parks on condition() outside try/catch before cleanup.
      await rec.waitFor("checkRoomAgentSupervisorTurn", beforeCheck + 7);
    } finally {
      releaseCheck(undefined);
    }
  }, 30_000);

  it("stop interrupts a running mission and finishes it INTERRUPTED", async () => {
    freshRec({ checkRoomAgentSupervisorTurn: () => "PAUSED" });
    const item = queueItem({ missionId: "mission:intr", roomId: ROOM, paneId: PANE, agentRunId: "agent-run-1", traceId: "trace-intr-1" });
    const beforeCheck = rec.count("checkRoomAgentSupervisorTurn");
    const beforeFinish = rec.count("finishRoomAgentSupervisorTurn");
    const handle = await startSupervisor({ roomId: ROOM, pending: [item] }, "wf:test-sup-interrupt");
    await rec.waitFor("checkRoomAgentSupervisorTurn", beforeCheck + 1);
    await sleep(50);
    await handle.signal("stopRoomAgentMission", { missionId: null, reason: "Pause everything." });
    await rec.waitFor("finishRoomAgentSupervisorTurn", beforeFinish + 1);
    expect(lastFor("finishRoomAgentSupervisorTurn", "mission:intr")).toMatchObject({ status: "INTERRUPTED", statusReason: "Pause everything." });
  }, 30_000);

  it("maps a generic child failure to ROOM_AGENT_SUPERVISOR_FAILED", async () => {
    freshRec({ runCodexAppServerTurn: (() => { throw ApplicationFailure.nonRetryable("child exploded"); }) as never });
    const item = queueItem({ missionId: "mission:gen", roomId: ROOM, paneId: PANE, agentRunId: "agent-run-1", traceId: "trace-gen-1" });
    const beforeFinish = rec.count("finishRoomAgentSupervisorTurn");
    await startSupervisor({ roomId: ROOM, pending: [item] }, "wf:test-sup-fail-generic");
    await rec.waitFor("finishRoomAgentSupervisorTurn", beforeFinish + 1);
    expect(lastFor("finishRoomAgentSupervisorTurn", "mission:gen")).toMatchObject({ status: "FAILED", errorCode: "ROOM_AGENT_SUPERVISOR_FAILED" });
  }, 30_000);

  it("passes a safe ApplicationFailure type through as the failure code", async () => {
    freshRec({ runCodexAppServerTurn: (() => { throw ApplicationFailure.nonRetryable("turn failed", "CODEX_APP_SERVER_TURN_FAILED"); }) as never });
    const item = queueItem({ missionId: "mission:typed", roomId: ROOM, paneId: PANE, agentRunId: "agent-run-1", traceId: "trace-typed-1" });
    const beforeFinish = rec.count("finishRoomAgentSupervisorTurn");
    await startSupervisor({ roomId: ROOM, pending: [item] }, "wf:test-sup-fail-typed");
    await rec.waitFor("finishRoomAgentSupervisorTurn", beforeFinish + 1);
    expect(lastFor("finishRoomAgentSupervisorTurn", "mission:typed")).toMatchObject({ status: "FAILED", errorCode: "CODEX_APP_SERVER_TURN_FAILED" });
  }, 30_000);

  it("roomAgentActionWorkflow reports a failure and rethrows it (room-background-action-failure-v1)", async () => {
    freshRec({
      runRoomAgentBackgroundAction: (() => { throw ApplicationFailure.nonRetryable("action exploded", "ACTION_EXPLODED"); }) as never,
      failRoomAgentBackgroundAction: () => undefined
    });
    await env.client.workflow.execute("roomAgentActionWorkflow", {
      workflowId: "space-room-action:action:test", taskQueue: QUEUE,
      args: [{ bridge: { roomId: ROOM, missionId: "mission:act" }, traceId: "trace-run-1" }]
    }).then(
      () => { throw new Error("expected failure"); },
      (error) => expectCauseMessage(error, /action exploded|ACTION_EXPLODED/)
    );
    const [reported] = rec.argsOf("failRoomAgentBackgroundAction").slice(-1);
    expect(reported[0]).toMatchObject({ actionId: "action:test", cancelled: false });
  }, 30_000);

  it("continues as new after 50 processed items with pending work carried", async () => {
    const items = Array.from({ length: 2 }, (_, i) => queueItem({ missionId: `mission:c50-${i}`, roomId: ROOM, paneId: PANE, agentRunId: `agent-run-${i}`, traceId: `trace-carry50-${i}` }));
    const handle = await startSupervisor({ roomId: ROOM, pending: items, processedCount: 49 }, "wf:test-sup-carry");
    const { args } = await expectContinueAsNew(handle);
    expect((args as AnyRecord).pending).toHaveLength(1);
    expect((args as AnyRecord).pending[0].turn.agentRunId).toBe("agent-run-1");
    expect((args as AnyRecord).processedCount).toBe(0);
    // The continued run drains the carried item automatically.
    await rec.waitFor("finishRoomAgentSupervisorTurn", 2);
    expect(lastFor("finishRoomAgentSupervisorTurn", "mission:c50-0")).toMatchObject({ status: "COMPLETED" });
    expect(lastFor("finishRoomAgentSupervisorTurn", "mission:c50-1")).toMatchObject({ status: "COMPLETED" });
  }, 30_000);

  it("continues as new after 250 monitoring polls with the carried state intact", async () => {
    freshRec({ prepareRoomAgentBackgroundContinuation: () => ({ state: "WAITING" }) });
    const handle = await startSupervisor(
      { roomId: ROOM, pending: [], monitoringMissionIds: ["mission:monitor"] },
      "wf:test-sup-250"
    );
    const { args } = await expectContinueAsNew(handle);
    expect(args.monitoringMissionIds).toEqual(["mission:monitor"]);
    expect(args.pending).toEqual([]);
    expect((args as AnyRecord).processedCount).toBe(0);
  }, 90_000);

  describe("pre-patch (legacy) branch", () => {
    beforeAll(async () => {
      legacyBundle = await createSandboxWorker(env, { taskQueue: LEGACY_QUEUE, workflowsPath: PRE_PATCH_PATH, activities: rec.acts });
    }, 30_000);

    afterAll(async () => {
      await stopSandboxWorker(legacyBundle as never);
      legacyBundle = undefined;
    }, 30_000);

    it("legacy: keeps the boolean settle contract (parity with mocked test)", async () => {
      let releaseSettle!: (v: unknown) => void;
      const gate = new Promise((resolve) => { releaseSettle = resolve; });
      try {
        freshRec({
          settleRoomAgentBackgroundMission: async () => {
            await gate;
            return true;
          }
        });
        const beforeSettle = rec.count("settleRoomAgentBackgroundMission");
        const beforeMark = rec.count("markRoomAgentMissionFinished");
        const beforePrepare = rec.count("prepareRoomAgentBackgroundContinuation");
        await startSupervisor({ roomId: ROOM, pending: [], monitoringMissionIds: ["mission:settle"] }, "wf:test-legacy-basic", LEGACY_QUEUE);
        await rec.waitFor("settleRoomAgentBackgroundMission", beforeSettle + 1);
        releaseSettle(undefined);
        await sleep(50);
        expect(rec.count("settleRoomAgentBackgroundMission") - beforeSettle).toBe(1); // true retires the mission
        expect(rec.count("markRoomAgentMissionFinished") - beforeMark).toBe(0);
        expect(rec.count("prepareRoomAgentBackgroundContinuation") - beforePrepare).toBe(0); // legacy never prepares continuations
      } finally {
        releaseSettle(undefined);
      }
    }, 30_000);

    it("legacy: finishes interrupted missions first without marking them started (parity)", async () => {
      let releaseChild!: (v: unknown) => void;
      const gate = new Promise((resolve) => { releaseChild = resolve; });
      try {
        freshRec({
          runCodexAppServerTurn: (async (input: AnyRecord) => {
            if (input?.agentRunId === "agent-run-active") await gate;
            return turnResult({});
          }) as never
        });
        const activeItem = queueItem({ missionId: "mission:lactive", roomId: ROOM, paneId: PANE, agentRunId: "agent-run-active", traceId: "trace-lactive-1" });
        const queuedItem = queueItem({ missionId: "mission:int", roomId: ROOM, paneId: PANE, agentRunId: "agent-run-queued", traceId: "trace-lint-1" });
        const handle = await startSupervisor({ roomId: ROOM, pending: [activeItem, queuedItem] }, "wf:test-legacy-interrupt", LEGACY_QUEUE);
        await rec.waitFor("markRoomAgentMissionStarted", 1);
        await handle.signal("stopRoomAgentMission", { missionId: "mission:int", reason: "Nope." });
        await sleep(250);
        releaseChild(undefined);
        await rec.waitFor("markRoomAgentMissionFinished", 2);
        const intFinish = (rec.argsOf("markRoomAgentMissionFinished") as unknown[][]).find((c) => (c[0] as AnyRecord)?.missionId === "mission:int");
        expect(intFinish?.[0]).toMatchObject({ missionId: "mission:int", status: "INTERRUPTED", statusReason: "Nope." });
        const intStarted = (rec.argsOf("markRoomAgentMissionStarted") as unknown[][]).find((c) => (c[0] as AnyRecord)?.missionId === "mission:int");
        expect(intStarted).toBeUndefined(); // stopped before start -> never marked started
      } finally {
        releaseChild(undefined);
      }
    }, 30_000);

    it("legacy: continueAsNew after 50 processed items carries the remaining queue", async () => {
      const itemA = queueItem({ missionId: "mission:la", roomId: ROOM, paneId: PANE, agentRunId: "agent-run-1", traceId: "trace-lc50-1" });
      const itemB = queueItem({ missionId: "mission:lb", roomId: ROOM, paneId: PANE, agentRunId: "agent-run-2", traceId: "trace-lc50-2" });
      const handle = await startSupervisor({ roomId: ROOM, pending: [itemA, itemB], processedCount: 49 }, "wf:test-legacy-carry", LEGACY_QUEUE);
      const { args } = await expectContinueAsNew(handle);
      expect((args as AnyRecord).pending).toHaveLength(1);
      expect((args as AnyRecord).pending[0].turn.agentRunId).toBe("agent-run-2");
      expect((args as AnyRecord).processedCount).toBe(0);
    }, 30_000);

    it("legacy: continueAsNew after 250 monitoring polls carries the monitoring set", async () => {
      freshRec({ settleRoomAgentBackgroundMission: () => false });
      const beforeSettle = rec.count("settleRoomAgentBackgroundMission");
      const handle = await startSupervisor(
        { roomId: ROOM, pending: [], monitoringMissionIds: ["mission:monmon"], processedCount: 0 },
        "wf:test-legacy-250", LEGACY_QUEUE
      );
      const { args } = await expectContinueAsNew(handle);
      expect(rec.count("settleRoomAgentBackgroundMission") - beforeSettle).toBeGreaterThanOrEqual(250);
      expect(args.monitoringMissionIds).toEqual(["mission:monmon"]);
      expect((args as AnyRecord).pending).toEqual([]);
    }, 90_000);
  });

  afterAll(async () => {
    await stopSandboxWorker(workerBundle as never);
    workerBundle = undefined;
  }, 30_000);
});
