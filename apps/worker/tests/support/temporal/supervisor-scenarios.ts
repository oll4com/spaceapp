import assert from "node:assert/strict";
import { Context } from "@temporalio/activity";
import { WorkflowContinuedAsNewError } from "@temporalio/client";
import { ApplicationFailure, TimeoutFailure, TimeoutType } from "@temporalio/common";
import { ROOM_AGENT_ENQUEUE_SIGNAL, ROOM_AGENT_STOP_SIGNAL, roomAgentSupervisorInputSchema } from "@space/contracts";
import { activityTypes, continuedInput, currentHistory, events, Harness, untilContinued, waitFor, type Handlers } from "./harness.js";
import { done, turn, type Capture } from "./basic-scenarios.js";

const item = (id: string, missionId = `mission:${id}`) => ({ missionId, turn: { ...turn(id), roomAgentMissionId: missionId } });
const input = (extra: Record<string, unknown> = {}) => roomAgentSupervisorInputSchema.parse({ roomId: "room:synthetic", ...extra });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; };
export async function supervisorScenarios(h: Harness, queue: string, capture: Capture, legacy = false) {
  const finished = legacy ? "markRoomAgentMissionFinished" : "finishRoomAgentSupervisorTurn";
  const poll = legacy ? "settleRoomAgentBackgroundMission" : "prepareRoomAgentBackgroundContinuation";
  const defaults = (): Handlers => ({ checkRoomAgentSupervisorTurn: () => "RUN", runCodexAppServerTurn: () => done,
    discardRoomAgentSupervisorTurn: () => undefined, finishRoomAgentSupervisorTurn: () => undefined,
    markRoomAgentMissionStarted: () => undefined, markRoomAgentMissionFinished: () => undefined,
    markRoomAgentMissionContinued: () => undefined, settleRoomAgentBackgroundMission: () => true,
    prepareRoomAgentBackgroundContinuation: () => ({ state: "DONE" }) });

  // Signal delivery, deduplication and correct-room validation use real signal tasks.
  await h.restart();
  h.reset(defaults());
  let handle = await h.start("roomAgentSupervisorWorkflow", input(), queue);
  const queued = item(`signal-${legacy}`);
  await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, { ...queued, turn: { ...queued.turn, roomId: "room:wrong" } });
  await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, queued);
  await waitFor(() => h.countCalls(finished).length === 1, "signaled mission finished");
  assert.equal(h.countCalls("runCodexAppServerTurn").length, 1);
  assert.equal(h.countCalls(finished)[0]!.args[0].status, "COMPLETED");
  await h.stop(handle);
  const firstHistory = await currentHistory(handle, h);
  assert.equal(events(firstHistory, "EVENT_TYPE_CHILD_WORKFLOW_EXECUTION_COMPLETED").length, 1);
  const types = activityTypes(firstHistory);
  assert.ok(types.includes(legacy ? "markRoomAgentMissionStarted" : "checkRoomAgentSupervisorTurn"));
  if (legacy) assert.ok(!types.includes("checkRoomAgentSupervisorTurn"));
  capture(legacy ? "roomAgentSupervisorWorkflow-legacy" : "roomAgentSupervisorWorkflow", handle.workflowId, firstHistory);

  // Each supervisor scenario gets an isolated server, including cancellation.
  async function cancellationScenario() {
  // Stop a genuinely running child. Heartbeats deliver cancellation to its stub activity.
  const started = deferred(); const cancelled = deferred();
  await h.restart();
  h.reset({ ...defaults(), runCodexAppServerTurn: async () => {
    const ctx = Context.current();
    const heartbeat = setInterval(() => ctx.heartbeat(), 5);
    started.resolve();
    try { await ctx.cancelled; } finally { clearInterval(heartbeat); cancelled.resolve(); }
  } });
  const active = item(`active-${legacy}`);
  handle = await h.start("roomAgentSupervisorWorkflow", input({ pending: [active] }), queue);
  await started.promise;
  // Queue a second mission then stop it as well while the first child is active.
  const pending = item(`pending-${legacy}`);
  await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, pending);
  await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, pending);
  await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: null, reason: "Synthetic operator stop" });
  await waitFor(() => h.countCalls(finished).length === 2, "active and pending stop persisted");
  assert.equal(h.countCalls("runCodexAppServerTurn").length, 1);
  assert.deepEqual(h.countCalls(finished).map(c => c.args[0].status), ["INTERRUPTED", "INTERRUPTED"]);
  assert.ok(h.countCalls(finished).every(c => c.args[0].statusReason === "Synthetic operator stop"));
  assert.deepEqual(h.countCalls(finished).map(c => legacy ? c.args[0].missionId : c.args[0].item.missionId).sort(), [active.missionId, pending.missionId].sort());
  await cancelled.promise;
  await h.stop(handle);

  }
  // The exact 50-item boundary must carry a pending item and monitoring membership.
  await h.restart();
  h.reset(defaults());
  const carried = item(`carry-${legacy}`);
  handle = await h.start("roomAgentSupervisorWorkflow", input({ processedCount: 49, pending: [item(`boundary-${legacy}`), carried], monitoringMissionIds: ["mission:monitor"] }), queue);
  const old = await untilContinued(handle, h);
  const next = continuedInput(old);
  assert.equal(next.input.processedCount, 0);
  assert.deepEqual(next.input.pending, [carried]);
  assert.deepEqual(next.input.monitoringMissionIds, ["mission:monitor"]);
  roomAgentSupervisorInputSchema.parse(next.input);
  await waitFor(() => h.countCalls("runCodexAppServerTurn").length === 2 && h.countCalls(finished).length === 2, "carried item executes exactly once");
  assert.equal(h.countCalls("runCodexAppServerTurn").filter(c => c.args[0].agentRunId === carried.turn.agentRunId).length, 1);
  assert.equal(h.countCalls(legacy ? "markRoomAgentMissionStarted" : "checkRoomAgentSupervisorTurn").find(c => legacy ? c.args[0].missionId === carried.missionId : c.args[0].turn.agentRunId === carried.turn.agentRunId)!.runId, next.runId);
  await h.stop(handle);

  capture(`roomAgentSupervisorWorkflow-${legacy ? "legacy" : "current"}-rollover`, handle.workflowId, old);
  capture(`roomAgentSupervisorWorkflow-${legacy ? "legacy" : "current"}-successor`, handle.workflowId,
    await h.env.client.workflow.getHandle(handle.workflowId, next.runId).fetchHistory());

  // 250 one-second polling timers trigger the other rollover boundary.
  await h.restart();
  h.reset({ ...defaults(), [poll]: () => legacy ? false : ({ state: "WAIT" }) });
  handle = await h.start("roomAgentSupervisorWorkflow", input({ processedCount: 7, monitoringMissionIds: ["mission:still-running"] }), queue);
  // Waiting on this fixed run unlocks virtual time only until the exact boundary.
  await assert.rejects(h.env.client.workflow.result(handle.workflowId, handle.firstExecutionRunId, { followRuns: false }), WorkflowContinuedAsNewError);
  const pollingHistory = await untilContinued(handle, h);
  const pollingNext = continuedInput(pollingHistory);
  assert.equal(h.countCalls(poll).filter(c => c.runId === handle.firstExecutionRunId).length, 250);
  assert.equal(events(pollingHistory, "EVENT_TYPE_TIMER_FIRED").length, 250);
  assert.deepEqual(pollingNext.input.monitoringMissionIds, ["mission:still-running"]);
  assert.deepEqual(pollingNext.input.pending, []);
  assert.equal(pollingNext.input.processedCount, legacy ? 7 : 0);
  await h.env.sleep("1 second");
  await waitFor(() => h.countCalls(poll).some(c => c.runId === pollingNext.runId), "successor polls carried mission");
  const successorPoll = h.countCalls(poll).find(c => c.runId === pollingNext.runId)!;
  assert.equal(successorPoll.args[0].missionId, "mission:still-running");
  await h.stop(handle);

  if (legacy) {
    // The legacy boolean contract is deliberately distinct from the current READY/DONE API.
    await h.restart();
  h.reset(defaults());
    handle = await h.start("roomAgentSupervisorWorkflow", input({ monitoringMissionIds: ["mission:legacy-monitor"] }), queue);
    await h.env.sleep("2 seconds");
    await waitFor(() => h.countCalls(poll).length === 1, "legacy boolean settle");
    assert.equal(h.countCalls("prepareRoomAgentBackgroundContinuation").length, 0);
    await h.stop(handle);
    capture("roomAgentSupervisorWorkflow-legacy-settle", handle.workflowId, await currentHistory(handle, h));
    await cancellationScenario();
    return;
  }

  // Allocation -> send -> verification: one mission, two real child runs, no repeated SEND.
  const automatic1 = { ...item("automatic-one", "mission:allocation"), turn: { ...turn("automatic-one"), roomAgentMissionId: "mission:allocation", roomAgentContinuation: { sourceRunId: "agent_run:allocation", generation: 1 } } };
  const automatic2 = { ...item("automatic-two", "mission:allocation"), turn: { ...turn("automatic-two"), roomAgentMissionId: "mission:allocation", roomAgentContinuation: { sourceRunId: "agent_run:automatic-one", generation: 2 } } };
  let prepared = 0;
  let sends = 0;
  await h.restart();
  h.reset({ ...defaults(), prepareRoomAgentBackgroundContinuation: () => ({ state: "READY", item: ++prepared === 1 ? automatic1 : automatic2 }),
    runCodexAppServerTurn: input => { if (input.agentRunId === automatic1.turn.agentRunId) { sends++; return { ...done, roomAgentOutcome: { ...done.roomAgentOutcome, pendingActionIds: ["action:send"] } }; } return done; } });
  handle = await h.start("roomAgentSupervisorWorkflow", input({ monitoringMissionIds: ["mission:allocation"] }), queue);
  await h.env.sleep("3 seconds");
  await waitFor(() => h.countCalls(finished).length === 1, "automatic verification finishes mission");
  assert.equal(sends, 1); assert.equal(h.countCalls("runCodexAppServerTurn").length, 2);
  assert.equal(h.countCalls(finished)[0]!.args[0].status, "COMPLETED");
  await h.stop(handle);

  // A typed timeout cause tests serialized cause-chain mapping, not a server-fired timeout.
  // Throwing TimeoutFailure directly from an activity is normalized to ApplicationFailure.
  for (const [kind, failure, code] of [
    ["plain", ApplicationFailure.nonRetryable("Synthetic plain failure"), "ROOM_AGENT_SUPERVISOR_FAILED"],
    ["timeout", ApplicationFailure.create({ message: "Synthetic activity failure with timeout cause", type: "SyntheticActivityFailure", nonRetryable: true, cause: new TimeoutFailure("Synthetic timeout cause", undefined, TimeoutType.START_TO_CLOSE) }), "ROOM_AGENT_SUPERVISOR_TIMEOUT"],
    ["typed", ApplicationFailure.nonRetryable("Synthetic typed failure", "CODEX_APP_SERVER_TURN_TIMEOUT"), "CODEX_APP_SERVER_TURN_TIMEOUT"]
  ] as const) {
    await h.restart();
  h.reset({ ...defaults(), runCodexAppServerTurn: () => { throw failure; } });
    handle = await h.start("roomAgentSupervisorWorkflow", input({ pending: [item(`failure-${kind}`)] }), queue);
    // Allow the real parent/child task chain to settle while virtual time advances.
    await h.env.sleep("20 seconds");
    await waitFor(() => h.countCalls(finished).length === 1, `${kind} failure recorded`);
    const finish = h.countCalls(finished)[0]!.args[0];
    assert.equal(finish.status, "FAILED"); assert.equal(finish.errorCode, code);
    assert.equal(h.countCalls("discardRoomAgentSupervisorTurn")[0]!.args[0].errorCode, code);
    await h.stop(handle);
  }

  // Hold an activity reply while real signals change the revision. Stale prepared work must retire.
  for (const kind of ["stop", "follow-up"] as const) {
    const gate = deferred();
    const prepared = item(`prepared-${kind}`, `mission:race-${kind}`);
    await h.restart();
  h.reset({ ...defaults(), prepareRoomAgentBackgroundContinuation: async () => { await gate.promise; return { state: "READY", item: prepared }; } });
    handle = await h.start("roomAgentSupervisorWorkflow", input({ monitoringMissionIds: [prepared.missionId] }), queue);
    const advancing = h.env.sleep("2 seconds");
    await waitFor(() => h.countCalls("prepareRoomAgentBackgroundContinuation").length === 1, "preparation held");
    const followUp = item(`operator-${kind}`, prepared.missionId);
    if (kind === "stop") await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: null, reason: "Synthetic stop during preparation" });
    else await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, followUp);
    // Waiting for signal events to be completed ensures the signal precedes the activity reply.
    await waitFor(async () => events(await currentHistory(handle, h), "EVENT_TYPE_WORKFLOW_EXECUTION_SIGNALED").length === 1, "signal persisted");
    gate.resolve(); await advancing;
    await waitFor(() => h.countCalls("discardRoomAgentSupervisorTurn").length > 0, "stale continuation discarded");
    assert.equal(h.countCalls("discardRoomAgentSupervisorTurn")[0]!.args[0].item.turn.agentRunId, prepared.turn.agentRunId);
    if (kind === "stop") assert.equal(h.countCalls("runCodexAppServerTurn").length, 0);
    else { await waitFor(() => h.countCalls("runCodexAppServerTurn").length === 1, "operator child starts"); assert.equal(h.countCalls("runCodexAppServerTurn")[0]!.args[0].agentRunId, followUp.turn.agentRunId); }
    await h.stop(handle);
  }

  // A prepared continuation crosses continue-as-new and starts exactly once in its successor.
  let prepareCount = 0;
  await h.restart();
  h.reset({ ...defaults(), prepareRoomAgentBackgroundContinuation: () => ++prepareCount === 1 ? ({ state: "READY", item: automatic1 }) : ({ state: "DONE" }) });
  handle = await h.start("roomAgentSupervisorWorkflow", input({ processedCount: 50, monitoringMissionIds: [automatic1.missionId] }), queue);
  await h.env.sleep("2 seconds");
  const history = await untilContinued(handle, h);
  const successor = continuedInput(history);
  assert.deepEqual(successor.input.pending, [automatic1]);
  await waitFor(() => h.countCalls("runCodexAppServerTurn").length === 1, "continued prepared turn runs once");
  assert.equal(h.countCalls("checkRoomAgentSupervisorTurn")[0]!.runId, successor.runId);
  assert.equal(h.countCalls("checkRoomAgentSupervisorTurn").filter(c => c.runId === handle.firstExecutionRunId).length, 0);
  await waitFor(() => h.countCalls(finished).length === 1, "successor verifies prepared mission");
  assert.equal(h.countCalls(finished)[0]!.runId, successor.runId);
  assert.equal(h.countCalls(finished)[0]!.args[0].status, "COMPLETED");
  assert.equal(h.countCalls(finished)[0]!.args[0].item.turn.agentRunId, automatic1.turn.agentRunId);
  await h.stop(handle);

  await h.restart();
  h.reset(defaults());
  const interruptedA = { item: item("interrupted-a"), reason: "Synthetic carried interruption" };
  const interruptedB = { item: item("interrupted-b"), reason: "Synthetic carried interruption" };
  handle = await h.start("roomAgentSupervisorWorkflow", input({ processedCount: 49, interrupted: [interruptedA, interruptedB] }), queue);
  const interruptedHistory = await untilContinued(handle, h);
  const interruptedNext = continuedInput(interruptedHistory);
  assert.deepEqual(interruptedNext.input.interrupted, [interruptedB]);
  await waitFor(() => h.countCalls(finished).length === 2, "carried interruption completed");
  assert.equal(h.countCalls(finished)[1]!.runId, interruptedNext.runId);
  assert.equal(h.countCalls(finished)[1]!.args[0].status, "INTERRUPTED");
  assert.equal(h.countCalls("runCodexAppServerTurn").length, 0);
  await h.stop(handle);

  // Flood while the first check is held, preventing the worker from draining before delivery.
  const floodGate = deferred(); let checks = 0;
  await h.restart();
  h.reset({ ...defaults(), checkRoomAgentSupervisorTurn: async () => { if (++checks === 1) await floodGate.promise; return "SKIP"; } });
  handle = await h.start("roomAgentSupervisorWorkflow", input({ processedCount: 49, pending: [item("flood-0", "mission:flood")] }), queue);
  await waitFor(() => checks === 1, "held flood check");
  for (let n = 1; n <= 105; n++) await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item(`flood-${n}`, "mission:flood"));
  floodGate.resolve();
  const floodHistory = await untilContinued(handle, h);
  const floodNext = continuedInput(floodHistory);
  assert.equal(floodNext.input.pending.length, 100);
  assert.equal(h.countCalls("checkRoomAgentSupervisorTurn").filter(c => c.runId === handle.firstExecutionRunId).length, 6);
  roomAgentSupervisorInputSchema.parse(floodNext.input);
  assert.deepEqual(floodNext.input.pending.map((x: any) => x.turn.agentRunId), Array.from({ length: 100 }, (_, i) => `agent_run:flood-${i + 6}`));
  await h.stop(handle);
  await cancellationScenario();
}
