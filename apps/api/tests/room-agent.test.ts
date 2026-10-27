import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoomAgentSupervisorQueueItem } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { InMemoryRoomAgentMonitorRepository } from "@space/db";
import { createApp } from "../src/app.js";
import { completeRoomAgentPrompt, type RoomAgentWorkflowCoordinator } from "../src/room-agent.js";
import type { RoomAgentChatBody, RoomAgentChatModel } from "../src/room-agent-chat.js";

/** A conversation model that answers every turn with one sentence and keeps the requests it saw. */
function answeringModel(answer = "Ready.") {
  const bodies: RoomAgentChatBody[] = [];
  const model: RoomAgentChatModel & { bodies: RoomAgentChatBody[] } = {
    supportsTools: true,
    bodies,
    async *stream(body) { bodies.push(structuredClone(body)); yield { content: answer }; }
  };
  return model;
}

const csrfHeaderName = "x-space-csrf-token";
const ownedApps: Array<Awaited<ReturnType<typeof createApp>>> = [];
afterEach(async()=>{await Promise.all(ownedApps.splice(0).map(app=>app.close()));});

async function setup(options: { failFirstEnqueue?: boolean; failStop?: boolean; monitorRepository?: InMemoryRoomAgentMonitorRepository } = {}) {
  const chatModel = answeringModel();
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Room Agent", initialPaneCount: 2 }, "trace:room-agent-test");
  const enqueued: RoomAgentSupervisorQueueItem[] = [];
  const stopped: Array<{ roomId: string; reason: string }> = [];
  const stoppedActions: Array<{ roomId: string; reason: string; traceId: string }> = [];
  const pausedActions: Array<{ roomId: string; reason: string; traceId: string }> = [];
  const resumedActions: Array<{ roomId: string; traceId: string }> = [];
  const stopOrder: string[] = [];
  let enqueueAttempts = 0;
  const workflow: RoomAgentWorkflowCoordinator = {
    async enqueue(item) {
      enqueueAttempts += 1;
      enqueued.push(item);
      if (options.failFirstEnqueue && enqueueAttempts === 1) {
        throw new Error("Temporal acknowledgement was lost.");
      }
      return { workflowId: `room-supervisor:${item.turn.roomId}`, runId: "run:room-agent-test" };
    },
    async stop(roomId, reason) {
      stopOrder.push("workflow");
      stopped.push({ roomId, reason });
      if (options.failStop) throw new Error("Temporal stop signal failed.");
    }
  };
  const app = await createApp({
    store,
    roomAgentWorkflow: workflow,
    roomActionExecutor: {
      execute: async () => {
        throw new Error("Room action execution is not expected in this API test.");
      },
      async stopMission(roomId: string, reason: string, traceId: string) {
        stopOrder.push("actions");
        stoppedActions.push({ roomId, reason, traceId });
        return { missionId: null, interruptedPaneIds: [] };
      },
      async pauseMission(roomId: string, reason: string, traceId: string) {
        pausedActions.push({ roomId, reason, traceId });
        const mission = store.listRoomAgentMissions(roomId).find((candidate) => candidate.status === "RUNNING");
        if (mission) store.updateRoomAgentMission(mission.id, { status: "PAUSED", statusReason: reason });
        return { missionId: mission?.id ?? null, interruptedPaneIds: [] };
      },
      async resumeMission(roomId: string, traceId: string) {
        resumedActions.push({ roomId, traceId });
        const mission = store.listRoomAgentMissions(roomId).find((candidate) => candidate.status === "PAUSED");
        if (mission) store.updateRoomAgentMission(mission.id, { status: "RUNNING", statusReason: "Room Agent goal resumed." });
        return { missionId: mission?.id ?? null };
      }
    } as never,
    auth: { sessionSecret: "test-secret-with-enough-length", devLogin: true, secureCookies: false },
    roomAgentChatModel: chatModel,
    ...(options.monitorRepository ? { roomAgentMonitorRepository: options.monitorRepository } : {})
  });
  ownedApps.push(app);
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "space@space.local", password: "space-dev" }
  });
  const sessionCookie = login.cookies.find((c) => c.name === "space_session");
  const cookie = `space_session=${sessionCookie?.value}`;
  const csrf = await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie } });
  return {
    app,
    cookie,
    csrfToken: csrf.json().csrfToken as string,
    room,
    store,
    enqueued,
    stopped,
    stoppedActions,
    pausedActions,
    resumedActions,
    stopOrder,
    chatModel,
    enqueueAttempts: () => enqueueAttempts
  };
}

/** Live goals are the only way to start a mission; messages are conversation. */
async function startMission(
  app: Awaited<ReturnType<typeof createApp>>,
  cookie: string,
  csrfToken: string,
  roomId: string,
  objective: string,
  clientRequestId: string
) {
  return app.inject({
    method: "POST",
    url: `/api/rooms/${roomId}/room-agent/missions`,
    headers: { cookie, [csrfHeaderName]: csrfToken },
    payload: { objective, clientRequestId }
  });
}

async function waitForAnswer(app: Awaited<ReturnType<typeof createApp>>, cookie: string, roomId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const session = (await app.inject({ method: "GET", url: `/api/rooms/${roomId}/room-agent`, headers: { cookie } })).json();
    if (!session.activeTurn && session.status !== "RUNNING") return session;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("The Room Agent did not finish its answer.");
}

async function sendRoomAgentMessage(
  app: Awaited<ReturnType<typeof createApp>>,
  cookie: string,
  csrfToken: string,
  roomId: string,
  content: string,
  clientRequestId: string
) {
  return app.inject({
    method: "POST",
    url: `/api/rooms/${roomId}/room-agent/messages`,
    headers: { cookie, [csrfHeaderName]: csrfToken },
    payload: { content, clientRequestId }
  });
}

describe("Live durable mission entrypoint", () => {
  it("restores an inactive bound session without resetting its native conversation", async () => {
    const c = await setup();
    const first = await c.app.inject({ method: "GET", url: `/api/rooms/${c.room.id}/room-agent`, headers: { cookie: c.cookie } });
    const id = first.json().sessionId;
    c.store.updateSpaceAgentSession(id, { isActive: false, threadId: "native:existing-thread" });
    const restored = await c.app.inject({ method: "GET", url: `/api/rooms/${c.room.id}/room-agent`, headers: { cookie: c.cookie } });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({ sessionId: id, threadId: "native:existing-thread" });
  });
  it("inspects an empty room without creating a supervisor pane or invoking a model", async () => {
    const c = await setup();
    const before = c.store.listPanes(c.room.id, true);
    const read = await c.app.inject({ method: "GET", url: `/api/rooms/${c.room.id}/room-agent/missions`, headers: { cookie: c.cookie } });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({ roomId: c.room.id, snapshot: null });
    expect(c.store.listPanes(c.room.id, true)).toEqual(before);
    expect(c.enqueued).toHaveLength(0);
  });
  it("persists an explicit goal and returns authoritative state without mini routing", async () => {
    const c = await setup();
    const start = await c.app.inject({ method: "POST", url: `/api/rooms/${c.room.id}/room-agent/missions`,
      headers: { cookie: c.cookie, [csrfHeaderName]: c.csrfToken },
      payload: { objective: "Έλεγξε είκοσι βήματα και συνέχισε μέχρι τέλους.", clientRequestId: "live:mission-request" } });
    expect(start.statusCode).toBe(202);
    expect(c.enqueued).toHaveLength(1);
    const snapshot = start.json().missionSnapshot;
    expect(snapshot).toMatchObject({ source: "LIVE", objective: "Έλεγξε είκοσι βήματα και συνέχισε μέχρι τέλους.",
      completionVerified: false, actions: [], actionCount: 0, mission: { status: "QUEUED" } });
    const persisted = c.store.listRoomAgentMissions(c.room.id)[0]!;
    expect(persisted.executionState).toMatchObject({ source: "LIVE", objective: snapshot.objective, ownerId: "user:dev-operator" });
    const replay = await c.app.inject({ method: "POST", url: `/api/rooms/${c.room.id}/room-agent/missions`,
      headers: { cookie: c.cookie, [csrfHeaderName]: c.csrfToken },
      payload: { objective: snapshot.objective, clientRequestId: "live:mission-request" } });
    expect(replay.statusCode).toBe(202);
    expect(c.enqueued).toHaveLength(1);
    expect(replay.json().missionSnapshot.mission.id).toBe(persisted.id);
  });

  it("rejects another goal and request-ID reuse with changed intent", async () => {
    const c = await setup();
    const start = (objective: string, clientRequestId: string) => c.app.inject({ method: "POST",
      url: `/api/rooms/${c.room.id}/room-agent/missions`, headers: { cookie: c.cookie, [csrfHeaderName]: c.csrfToken },
      payload: { objective, clientRequestId } });
    expect((await start("Complete this goal.", "live:first-goal")).statusCode).toBe(202);
    expect((await start("A different goal.", "live:second-goal")).statusCode).toBe(409);
    expect((await start("Changed intent.", "live:first-goal")).statusCode).toBe(409);
    expect(c.store.listRoomAgentMissions(c.room.id)).toHaveLength(1);
    expect(c.enqueued).toHaveLength(1);
  });

  it("recovers the original queued turn when Temporal acknowledgement is lost", async () => {
    const c = await setup({ failFirstEnqueue: true });
    const start = () => c.app.inject({ method: "POST", url: `/api/rooms/${c.room.id}/room-agent/missions`,
      headers: { cookie: c.cookie, [csrfHeaderName]: c.csrfToken },
      payload: { objective: "Complete the full checklist.", clientRequestId: "live:lost-ack" } });
    expect((await start()).statusCode).toBe(500);
    expect((await start()).statusCode).toBe(202);
    expect(c.enqueued).toHaveLength(2);
    expect(c.enqueued[1]).toEqual(c.enqueued[0]);
    expect(c.store.listRoomAgentMissions(c.room.id)).toHaveLength(1);
  });

  it("retains completed mission receipts after the active mission disappears", async () => {
    const c = await setup();
    await c.app.inject({ method: "POST", url: `/api/rooms/${c.room.id}/room-agent/missions`,
      headers: { cookie: c.cookie, [csrfHeaderName]: c.csrfToken },
      payload: { objective: "Sort panes.", clientRequestId: "live:complete-goal" } });
    const mission = c.store.listRoomAgentMissions(c.room.id)[0]!;
    const action = c.store.createRoomAgentAction({ actionId: "action:live-complete", missionId: mission.id, roomId: c.room.id,
      paneId: null, idempotencyKey: "live:complete-sort", actionType: "CONTROL", status: "RUNNING", requestPayload: {},
      evidence: { controlOperationId: "operation:live-sort" }, attemptCount: 1, statusReason: "Waiting for control." });
    c.store.updateRoomAgentMission(mission.id, { status: "COMPLETED", statusReason: "Supervisor returned." });
    const read = () => c.app.inject({ method: "GET", url: `/api/rooms/${c.room.id}/room-agent`, headers: { cookie: c.cookie } });
    const unverified = (await read()).json();
    expect(unverified.activeMission).toBeNull();
    expect(unverified.missionSnapshot).toMatchObject({ completionVerified: false, actions: [{ status: "RUNNING", controlOperationId: "operation:live-sort" }] });
    c.store.updateRoomAgentAction(action.actionId, { status: "COMPLETED", statusReason: "Verified control." });
    expect((await read()).json().missionSnapshot).toMatchObject({ completionVerified: true, objective: "Sort panes.", actionCount: 1 });
  });

  it("never reports low-quality or unevaluated task results as verified success", async () => {
    const c = await setup();
    await c.app.inject({ method: "POST", url: `/api/rooms/${c.room.id}/room-agent/missions`,
      headers: { cookie: c.cookie, [csrfHeaderName]: c.csrfToken },
      payload: { objective: "Run three checked tasks.", clientRequestId: "live:quality-goal" } });
    const mission = c.store.listRoomAgentMissions(c.room.id)[0]!;
    const pane = c.store.listPanes(c.room.id)[0]!;
    const steps = ["checked", "low", "unscored"];
    // Every pane step executed: execution success alone must not read as verified.
    c.store.createRoomAgentAction({ actionId: "action:quality-orchestrate", missionId: mission.id, roomId: c.room.id, paneId: null,
      idempotencyKey: "live:quality-orchestrate", actionType: "ORCHESTRATE", status: "COMPLETED",
      requestPayload: { action: { steps: steps.map((stepId) => ({ stepId })) } },
      evidence: { steps: steps.map((stepId) => ({ stepId, status: "EXECUTED" })) }, attemptCount: 1, statusReason: "All steps executed." });
    const at = new Date().toISOString();
    const task = (stepId: string, state: "COMPLETED" | "LOW_QUALITY", qualityScore: number | null) => c.store.upsertRoomAgentTaskRun({
      runId: `room_agent_task_run:${stepId}`, missionId: mission.id, roomId: c.room.id, stepId, paneId: pane.id, label: `Task ${stepId}`,
      instruction: "Complete the checked task.", status: state, state, modelId: "gpt-5.6-sol", reasoningEffort: "high", qualityScore,
      qualityUnavailableReason: qualityScore === null ? "The exact completed native turn has no readable final response; quality was not evaluated." : null,
      reliabilityScore: 90, combinedScore: qualityScore === null ? null : qualityScore * 0.7 + 27, rubric: null, queueMs: 0, firstResponseMs: 10,
      executionMs: 100, totalMs: 100, retries: 0, recoveries: 0, stalls: 0, queuedAt: at, startedAt: at, firstResponseAt: at, completedAt: at,
      verificationSummary: qualityScore === null ? "Quality unavailable after 0 evaluator attempt(s)." : `Quality ${qualityScore}/100.` });
    task("checked", "COMPLETED", 92);
    task("low", "LOW_QUALITY", 40);
    task("unscored", "COMPLETED", null);
    c.store.updateRoomAgentMission(mission.id, { status: "COMPLETED", statusReason: "Ordered room orchestration completed with durable evidence for every step." });
    const read = async () => (await c.app.inject({ method: "GET", url: `/api/rooms/${c.room.id}/room-agent`, headers: { cookie: c.cookie } })).json();
    const mixed = await read();
    expect(mixed.missionSummary).toMatchObject({ totalTasks: 3, completedTasks: 3, verifiedTasks: 1, lowQualityTasks: 1, unevaluatedTasks: 1 });
    expect(mixed.missionSummary.successRate).toBeCloseTo(100 / 3, 5);
    expect(mixed.missionSnapshot).toMatchObject({ completionVerified: false, mission: { status: "COMPLETED" } });
    task("low", "COMPLETED", 85);
    expect((await read()).missionSnapshot.completionVerified).toBe(false);
    task("unscored", "COMPLETED", 80);
    const verified = await read();
    expect(verified.missionSummary).toMatchObject({ verifiedTasks: 3, lowQualityTasks: 0, unevaluatedTasks: 0, successRate: 100 });
    expect(verified.missionSnapshot.completionVerified).toBe(true);
  });

  it("requires authentication and CSRF before persisting any mission", async () => {
    const c = await setup();
    const request = { method: "POST" as const, url: `/api/rooms/${c.room.id}/room-agent/missions`,
      payload: { objective: "Sort panes.", clientRequestId: "live:unauthorized" } };
    expect((await c.app.inject(request)).statusCode).toBe(401);
    expect((await c.app.inject({ ...request, headers: { cookie: c.cookie } })).statusCode).toBe(403);
    expect(c.enqueued).toHaveLength(0);
    expect(c.store.listRoomAgentMissions(c.room.id)).toHaveLength(0);
  });
});

describe("Room Agent API", () => {
  it("loads one compact fixed-model supervisor session per room", async () => {
    const { app, cookie, room, store } = await setup();
    const response = await app.inject({ method: "GET", url: `/api/rooms/${room.id}/room-agent`, headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      roomId: room.id,
      status: "IDLE",
      modelId: expect.stringMatching(/^(gpt-5\.6-sol|gemini-3\.8-flash|opencode\/.*)$/),
      reasoningEffort: expect.stringMatching(/^(high|medium|low|default|.*)$/),
      messages: [],
      queuedMissionCount: 0,
      capabilities: { canSend: true, canStop: false }
    });
    expect(response.json()).not.toHaveProperty("modelOptions");
    expect(response.json()).not.toHaveProperty("permissionOptions");
    expect(response.json()).not.toHaveProperty("history");
    const strip = response.json().paneStrip as Array<{ paneId: string; activity: string; mode: string }>;
    expect(strip.map((item) => item.paneId)).toEqual(store.listPanes(room.id).map((pane) => pane.id));
    expect(strip.every((item) => ["WORKING", "WAITING", "DONE", "IDLE", "UNKNOWN", "NONE"].includes(item.activity))).toBe(true);
    expect(store.listPanes(room.id)).toHaveLength(2);
    expect(store.listPanes(room.id, true)).toHaveLength(3);
  });

  it("answers messages as conversation, never as missions, and deduplicates client retries", async () => {
    const { app, cookie, csrfToken, room, enqueued, store, chatModel } = await setup();
    const first = await sendRoomAgentMessage(app, cookie, csrfToken, room.id, "Finish every pane in dependency order.", "room-agent-client-0001");
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ status: "RUNNING", activeTurn: { requestId: "room-agent-client-0001" } });
    const answered = await waitForAnswer(app, cookie, room.id);
    expect(answered.messages.map((message: { role: string; kind: string; content: string }) => [message.role, message.kind, message.content])).toEqual([
      ["user", "CHAT", "Finish every pane in dependency order."], ["assistant", "CHAT", "Ready."]]);
    const duplicate = await sendRoomAgentMessage(app, cookie, csrfToken, room.id, "Finish every pane in dependency order.", "room-agent-client-0001");
    expect(duplicate.statusCode).toBe(202);
    expect(duplicate.json().directCommand).toMatchObject({ status: "REPLAYED" });
    expect((await sendRoomAgentMessage(app, cookie, csrfToken, room.id, "A changed retry.", "room-agent-client-0001")).statusCode).toBe(409);
    expect(chatModel.bodies).toHaveLength(1);
    expect(enqueued).toHaveLength(0);
    expect(store.listRoomAgentMissions(room.id)).toHaveLength(0);
    expect(store.getRoomAgentRequest(room.id, "room-agent-client-0001")).toMatchObject({ missionId: null, directAction: { type: "CHAT" } });
  });

  it("builds the Live mission turn from the whole room and the Space Control guide", async () => {
    const { app, cookie, csrfToken, room, enqueued } = await setup();
    expect((await startMission(app, cookie, csrfToken, room.id, "Finish every pane in dependency order.", "room-agent-live-0001")).statusCode).toBe(202);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.turn).toMatchObject({
      roomId: room.id,
      modelId: expect.stringMatching(/^(gpt-5\.6-sol|gemini-3\.8-flash|opencode\/.*)$/),
      permissionMode: "full_access",
      selectedToolIds: expect.arrayContaining([
        "room:inspect",
        "room:orchestrate",
        "room:interrupt",
        "space-readonly:space_status",
        "space-readonly:space_logs",
        "space-readonly:space_authenticated_ui_proof"
      ])
    });
    expect(enqueued[0]?.turn.prompt).toContain("Finish every pane in dependency order.");
    expect(enqueued[0]?.turn.prompt).toContain("Full-room supervisor");
    expect(enqueued[0]?.turn.prompt).toContain("Structured active plan inventory:");
    expect(enqueued[0]?.turn.prompt).toMatch(/Room activity at \S+: 2 open panes/);
    expect(enqueued[0]?.turn.prompt).toContain("Open room panes with live activity");
    expect(enqueued[0]?.turn.prompt).toContain("Reply in the language of the operator request.");
    for (const tool of ["space_watches:", "space_debug:", "space_describe_pane_types:", "space_list_mcp_tools:", "space_test_mcp_tools:"]) {
      expect(enqueued[0]?.turn.prompt).toContain(tool);
    }
    expect(enqueued[0]?.turn.prompt).not.toContain("space_screenshot:");
    expect(enqueued[0]?.turn.prompt).toContain("expectedPromptFingerprint");
    expect(enqueued[0]?.turn.prompt).not.toContain("Initial room context truncated");
    expect(enqueued[0]?.turn.prompt).toContain("Default changes to AFTER_TURN");
    expect(enqueued[0]?.turn.prompt).toContain("room:restart");
    expect(enqueued[0]?.turn.prompt).toContain("stepId");
    expect(enqueued[0]?.turn.prompt).toContain("dependsOn");
    expect(enqueued[0]?.turn.traceId).toMatch(/^req:/);
  });

  it("signals the durable supervisor to stop active and queued work", async () => {
    const { app, cookie, csrfToken, room, stopped, stoppedActions, stopOrder } = await setup();
    await startMission(app, cookie, csrfToken, room.id, "Run until done.", "room-agent-stop-0001");
    const response = await app.inject({
      method: "POST",
      url: `/api/rooms/${room.id}/room-agent/stop`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { reason: "Operator stopped the room supervisor." }
    });

    expect(response.statusCode).toBe(200);
    expect(stopped).toEqual([{ roomId: room.id, reason: "Operator stopped the room supervisor." }]);
    expect(stoppedActions).toEqual([
      expect.objectContaining({ roomId: room.id, reason: "Operator stopped the room supervisor.", traceId: expect.any(String) })
    ]);
    expect(stopOrder).toEqual(["actions", "workflow"]);
  });

  it("pauses and resumes the same goal without creating another mission", async () => {
    const { app, cookie, csrfToken, room, store, pausedActions, resumedActions } = await setup();
    await startMission(app, cookie, csrfToken, room.id, "Run all safe plans.", "room-agent-control-0001");
    const [mission] = store.listRoomAgentMissions(room.id);
    store.updateRoomAgentMission(mission!.id, { status: "RUNNING", statusReason: "Goal running." });

    const paused = await app.inject({
      method: "POST",
      url: `/api/rooms/${room.id}/room-agent/control`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { action: "PAUSE", reason: "Pause now." }
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toMatchObject({
      status: "PAUSED",
      activeMission: { id: mission!.id, status: "PAUSED" },
      capabilities: { canPause: false, canResume: true, canStop: true }
    });

    const resumed = await app.inject({
      method: "POST",
      url: `/api/rooms/${room.id}/room-agent/control`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { action: "RESUME" }
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({
      status: "RUNNING",
      activeMission: { id: mission!.id, status: "RUNNING" },
      capabilities: { canPause: true, canResume: false, canStop: true }
    });
    expect(store.listRoomAgentMissions(room.id)).toHaveLength(1);
    expect(pausedActions).toEqual([expect.objectContaining({ roomId: room.id, reason: "Pause now." })]);
    expect(resumedActions).toEqual([expect.objectContaining({ roomId: room.id })]);
  });

  it("clears only the visible transcript and preserves the durable goal records", async () => {
      const { app, cookie, csrfToken, room, store } = await setup();
      await startMission(app, cookie, csrfToken, room.id, "Keep this goal running.", "room-agent-clear-0001");
      const mission = store.listRoomAgentMissions(room.id)[0]!;
      const targetPane = store.listPanes(room.id)[0]!;
      store.createRoomAgentAction({
        actionId: "room_agent_action:clear",
        missionId: mission.id,
        roomId: room.id,
        paneId: null,
        idempotencyKey: "room-agent-clear-action-0001",
        actionType: "ORCHESTRATE",
        status: "RUNNING",
        requestPayload: { action: { steps: [{ stepId: "clear-step" }] } },
        evidence: { peakConcurrency: 3 },
        attemptCount: 1,
        statusReason: "Task is running before clear."
      });
      const taskRun = store.upsertRoomAgentTaskRun({
        runId: "room_agent_task_run:clear",
        missionId: mission.id,
        roomId: room.id,
        stepId: "clear-step",
        paneId: targetPane.id,
        label: "Visible before clear",
        instruction: "Keep monitoring this task.",
        status: "RUNNING",
        state: "RUNNING",
        modelId: "gpt-5.6-sol",
        reasoningEffort: "high",
        qualityScore: null,
        qualityUnavailableReason: "Evaluation pending.",
        reliabilityScore: 0,
        combinedScore: null,
        rubric: null,
        queueMs: 0,
        firstResponseMs: null,
        executionMs: 0,
        totalMs: 0,
        retries: 0,
        recoveries: 0,
        stalls: 0,
        queuedAt: "2026-07-14T12:00:00.000Z",
        startedAt: "2026-07-14T12:00:00.000Z",
        firstResponseAt: null,
        completedAt: null,
        verificationSummary: "Task is running before clear."
      });
      const before = await app.inject({ method: "GET", url: `/api/rooms/${room.id}/room-agent`, headers: { cookie } });
      expect(before.json().messages).toHaveLength(2);
      expect(before.json().taskResults).toHaveLength(1);
      expect(before.json().missionSummary).toMatchObject({ peakConcurrency: 3 });
      const durableMessagesBefore = structuredClone(store.listSpaceAgentMessages(before.json().sessionId));
      const durableMissionsBefore = structuredClone(store.listRoomAgentMissions(room.id));
      const durableActionsBefore = structuredClone(store.listRoomAgentActions(mission.id));
      const durableTaskRunsBefore = structuredClone(store.listRoomAgentTaskRuns(mission.id));

      const cleared = await app.inject({
        method: "DELETE",
        url: `/api/rooms/${room.id}/room-agent/transcript`,
        headers: { cookie, [csrfHeaderName]: csrfToken }
      });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json().messages).toEqual([]);
      expect(cleared.json().taskResults).toEqual([]);
      expect(cleared.json().missionSummary).toBeNull();
      expect(cleared.json().progress.runningSteps).toBe(1);
      expect(store.listRoomAgentMissions(room.id)).toHaveLength(1);
      expect(store.listSpaceAgentMessages(cleared.json().sessionId)).toHaveLength(2);
      expect(store.listRoomAgentTaskRuns(mission.id)).toHaveLength(1);
      expect(store.listSpaceAgentMessages(cleared.json().sessionId)).toEqual(durableMessagesBefore);
      expect(store.listRoomAgentMissions(room.id)).toEqual(durableMissionsBefore);
      expect(store.listRoomAgentActions(mission.id)).toEqual(durableActionsBefore);
      expect(store.listRoomAgentTaskRuns(mission.id)).toEqual(durableTaskRunsBefore);

      const transcriptClearedAt = await store.getRoomAgentTranscriptClearedAt(room.id);
      expect(transcriptClearedAt).not.toBeNull();
      expect(taskRun.updatedAt <= transcriptClearedAt!).toBe(true);
      const clockDeadline = Date.now() + 1_000;
      while (new Date().toISOString() <= transcriptClearedAt!) {
        if (Date.now() >= clockDeadline) throw new Error("Clock did not advance beyond the transcript watermark.");
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      const updatedTaskRun = store.upsertRoomAgentTaskRun({ ...taskRun, verificationSummary: "Task updated after clear." });
      const secondTaskRun = store.upsertRoomAgentTaskRun({
        ...taskRun,
        runId: "room_agent_task_run:clear-second",
        stepId: "clear-step-second",
        label: "Second visible task",
        verificationSummary: "Second task started after clear."
      });
      const refreshed = await app.inject({ method: "GET", url: `/api/rooms/${room.id}/room-agent`, headers: { cookie } });
      expect(refreshed.json().messages).toEqual([]);
      expect(refreshed.json().taskResults).toEqual([
        expect.objectContaining({ stepId: "clear-step", verificationSummary: "Task updated after clear." }),
        expect.objectContaining({ stepId: "clear-step-second", verificationSummary: "Second task started after clear." })
      ]);
      expect(refreshed.json().missionSummary).toMatchObject({ peakConcurrency: 2 });
      expect(store.listSpaceAgentMessages(refreshed.json().sessionId)).toEqual(durableMessagesBefore);
      expect(store.listRoomAgentMissions(room.id)).toEqual(durableMissionsBefore);
      expect(store.listRoomAgentActions(mission.id)).toEqual(durableActionsBefore);
      expect(store.listRoomAgentTaskRuns(mission.id)).toEqual([updatedTaskRun, secondTaskRun]);
  });

  it("exposes persisted orchestration progress and every active pane", async () => {
    const { app, cookie, csrfToken, room, store } = await setup();
    await startMission(app, cookie, csrfToken, room.id, "Run the graph.", "room-agent-progress-0001");
    const [mission] = store.listRoomAgentMissions(room.id);
    const targetPane = store.listPanes(room.id)[0]!;
    store.updateRoomAgentMission(mission!.id, { status: "RUNNING", statusReason: "Graph running." });
    store.createRoomAgentAction({
      actionId: "room_agent_action:progress-root",
      missionId: mission!.id,
      roomId: room.id,
      paneId: null,
      idempotencyKey: "room-agent-progress-root-0001",
      actionType: "ORCHESTRATE",
      status: "RUNNING",
      requestPayload: {
        action: {
          steps: [{ stepId: "a" }, { stepId: "b" }, { stepId: "c" }]
        }
      },
      evidence: { peakConcurrency: 2, steps: [{ stepId: "a", status: "EXECUTED" }] },
      attemptCount: 1,
      statusReason: "One plan complete."
    });
    store.createRoomAgentAction({
      actionId: "room_agent_action:progress-running",
      missionId: mission!.id,
      roomId: room.id,
      paneId: targetPane.id,
      idempotencyKey: "room-agent-progress-running-0001",
      actionType: "SEND",
      status: "RUNNING",
      requestPayload: {},
      evidence: {},
      attemptCount: 1,
      statusReason: "Plan running."
    });

    const response = await app.inject({ method: "GET", url: `/api/rooms/${room.id}/room-agent`, headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      activePaneIds: [targetPane.id],
      progress: {
        totalSteps: 3,
        completedSteps: 1,
        runningSteps: 1,
        queuedSteps: 1,
        blockedSteps: 0,
        peakConcurrency: 2
      }
    });
  });

  it("blocks local room actions even when the Temporal stop signal fails", async () => {
    const { app, cookie, csrfToken, room, stoppedActions } = await setup({ failStop: true });
    await startMission(app, cookie, csrfToken, room.id, "Run until stopped.", "room-agent-stop-failure-0001");

    const response = await app.inject({
      method: "POST",
      url: `/api/rooms/${room.id}/room-agent/stop`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { reason: "Fail closed while Temporal is unavailable." }
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    expect(stoppedActions).toEqual([
      expect.objectContaining({ roomId: room.id, reason: "Fail closed while Temporal is unavailable." })
    ]);
  });

  it("explains a mission runtime failure and stops blocking once the Room Agent answers again", async () => {
    const { app, cookie, csrfToken, room, store } = await setup();
    const send = (content: string, clientRequestId: string) => app.inject({ method: "POST", url: `/api/rooms/${room.id}/room-agent/messages`,
      headers: { cookie, [csrfHeaderName]: csrfToken }, payload: { content, clientRequestId } });
    await startMission(app, cookie, csrfToken, room.id, "Complete and verify the room.", "room-agent-runtime-failure-0001");
    const [mission] = store.listRoomAgentMissions(room.id);
    store.updateRoomAgentMission(mission!.id, { status: "FAILED", completedAt: "2026-07-11T18:00:00.000Z",
      statusReason: "Codex App Server exited before the turn completed. Run the Codex App Server handshake/turn smoke and inspect space-worker logs." });
    const read = async () => (await app.inject({ method: "GET", url: `/api/rooms/${room.id}/room-agent`, headers: { cookie } })).json();
    expect(await read()).toMatchObject({ status: "BLOCKED",
      statusReason: "Missions could not start: the Room Agent's mission runtime (Codex App Server) is not available here. Questions, @mentions and direct commands still work." });
    expect((await send("τι βλέπεις στο δωμάτιο;", "room-agent-runtime-failure-0002")).statusCode).toBe(202);
    await waitForAnswer(app, cookie, room.id);
    expect(await read()).toMatchObject({ status: "IDLE", statusReason: "Room Agent is ready to supervise this room." });
  });

  it("returns to idle after a successful mission supersedes an older failure", async () => {
    const { app, cookie, csrfToken, room, store } = await setup();
    const send = (clientRequestId: string) => startMission(app, cookie, csrfToken, room.id, "Complete and verify the room.", clientRequestId);

    await send("room-agent-terminal-state-0001");
    const [failedMission] = store.listRoomAgentMissions(room.id);
    store.updateRoomAgentMission(failedMission!.id, {
      status: "FAILED",
      statusReason: "An earlier mission failed.",
      completedAt: "2026-07-11T18:00:00.000Z"
    });

    await send("room-agent-terminal-state-0002");
    const completedMission = store.listRoomAgentMissions(room.id)[1]!;
    store.updateRoomAgentMission(completedMission.id, {
      status: "COMPLETED",
      statusReason: "The latest mission completed successfully.",
      completedAt: "2026-07-11T18:01:00.000Z"
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/rooms/${room.id}/room-agent`,
      headers: { cookie }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "IDLE",
      statusReason: "Room Agent is ready to supervise this room.",
      activeMission: null,
      queuedMissionCount: 0
    });
  });

  it("does not re-signal a durable mission that already left the queue", async () => {
    const { app, cookie, csrfToken, room, store, enqueueAttempts } = await setup({ failFirstEnqueue: true });
    const clientRequestId = "room-agent-terminal-retry-0001";

    expect((await startMission(app, cookie, csrfToken, room.id, "Finish once.", clientRequestId)).statusCode).toBe(500);
    const [mission] = store.listRoomAgentMissions(room.id);
    store.updateRoomAgentMission(mission!.id, {
      status: "COMPLETED",
      statusReason: "The originally accepted signal completed.",
      completedAt: "2026-07-11T18:02:00.000Z"
    });
    const retry = await startMission(app, cookie, csrfToken, room.id, "Finish once.", clientRequestId);

    expect(retry.statusCode).toBe(202);
    expect(enqueueAttempts()).toBe(1);
    expect(store.listRoomAgentMissions(room.id)).toHaveLength(1);
  });

  it("recovers a committed unsignaled room mission once when a new API app starts", async () => {
    const first = await setup({ failFirstEnqueue: true });
    await startMission(first.app, first.cookie, first.csrfToken, first.room.id, "Recover this mission after restart.", "room-agent-startup-recovery-0001");
    expect(first.store.listUnsignaledRoomAgentEnqueues()).toHaveLength(1);
    await first.app.close();

    const recoveredSignals: RoomAgentSupervisorQueueItem[] = [];
    const createRecoveredApp = () => createApp({
      store: first.store,
      roomAgentWorkflow: {
        async enqueue(item) {
          recoveredSignals.push(item);
          return { workflowId: `room-supervisor:${item.turn.roomId}`, runId: "run:startup-recovery" };
        },
        async stop() {}
      },
      roomActionExecutor: {
        execute: async () => {
          throw new Error("Room action execution is not expected during startup recovery.");
        },
        async stopMission() {
          return { missionId: null, interruptedPaneIds: [] };
        }
      } as never,
      auth: { sessionSecret: "test-secret-with-enough-length", devLogin: true, secureCookies: false }
    });

    const recoveredApp = await createRecoveredApp();
    ownedApps.push(recoveredApp);
    await recoveredApp.ready();
    expect(recoveredSignals).toEqual(first.enqueued);
    expect(first.store.listUnsignaledRoomAgentEnqueues()).toEqual([]);

    const secondRestart = await createRecoveredApp();
    ownedApps.push(secondRestart);
    await secondRestart.ready();
    expect(recoveredSignals).toHaveLength(1);
    await recoveredApp.close();
    await secondRestart.close();
  }, 20_000); // Three full API starts and shutdowns; assertions still require exact-once recovery.

  it("creates one persistent session under concurrent first use", async () => {
    const { app, cookie, room, store } = await setup();

    const responses = await Promise.all([
      app.inject({ method: "GET", url: `/api/rooms/${room.id}/room-agent`, headers: { cookie } }),
      app.inject({ method: "GET", url: `/api/rooms/${room.id}/room-agent`, headers: { cookie } })
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(new Set(responses.map((response) => response.json().sessionId)).size).toBe(1);
    expect(store.listSpaceAgentHistory(room.id)).toHaveLength(1);
  });

  it("bounds accumulated closed-pane context so a maximum-size operator request can still be queued", async () => {
    const { app, cookie, csrfToken, room, store, enqueued } = await setup();
    for (let index = 0; index < 48; index += 1) {
      const pane = store.createPane({
        roomId: room.id,
        title: `Closed pane ${index} ${"x".repeat(90)}`,
        mode: "CHAT"
      });
      store.updatePane(pane.id, { isClosed: true });
    }

    const response = await startMission(app, cookie, csrfToken, room.id, "y".repeat(4000), "room-agent-oversized-prompt-0001");
    const sessionId = (await app.inject({
      method: "GET",
      url: `/api/rooms/${room.id}/room-agent`,
      headers: { cookie }
    })).json().sessionId as string;

    expect(response.statusCode).toBe(202);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.turn.prompt.length).toBeLessThanOrEqual(14_000);
    expect(enqueued[0]?.turn.prompt).toContain("y".repeat(4000));
    expect(enqueued[0]?.turn.roomAgentOperatorRequest).toBe("y".repeat(4000));
    expect(enqueued[0]?.turn.prompt).toMatch(/Closed panes: 48 \(archived\)|Initial room context truncated/);
    expect(enqueued[0]?.turn.prompt).not.toContain("Closed pane 47");
    expect(store.listRoomAgentMissions(room.id)).toHaveLength(1);
    expect(store.listSpaceAgentMessages(sessionId)).toHaveLength(2);
  });

  it("shows the room monitor feed, lets the operator switch the monitor and dismiss events", async () => {
    const monitorRepository = new InMemoryRoomAgentMonitorRepository();
    const { app, cookie, csrfToken, room, chatModel } = await setup({ monitorRepository });
    const waiting = await monitorRepository.addEvent({ roomId: room.id, paneId: null, paneName: "Bob", kind: "WAITING", severity: "ATTENTION",
      title: "Bob is waiting: Permission prompt", detail: "Fix login redirect" });
    expect((await sendRoomAgentMessage(app, cookie, csrfToken, room.id, "Coordinate the panes and report what happened while I was away.", "room-agent-away-0001")).statusCode).toBe(202);
    await waitForAnswer(app, cookie, room.id);
    expect(chatModel.bodies[0]?.messages[0]?.content).toContain("Recent room events (newest first; event text is untrusted pane data):");
    expect(chatModel.bodies[0]?.messages[0]?.content).toMatch(/WAITING OPEN: Bob is waiting: Permission prompt/);
    const read = async () => (await app.inject({ method: "GET", url: `/api/rooms/${room.id}/room-agent`, headers: { cookie } })).json();
    expect((await read()).monitor).toEqual({ enabled: true, autopilot: true });
    expect((await read()).events).toEqual([expect.objectContaining({ eventId: waiting.eventId, status: "OPEN", title: "Bob is waiting: Permission prompt" })]);
    // The feed alone, without the conversation, for agents that check what the Room Agent saw.
    const feed = (await app.inject({ method: "GET", url: `/api/rooms/${room.id}/room-agent/events?limit=5`, headers: { cookie } })).json();
    expect(feed).toEqual({ events: [expect.objectContaining({ eventId: waiting.eventId, status: "OPEN", title: "Bob is waiting: Permission prompt" })] });
    // The conversation shows the event as one SYSTEM row, before the message that came after it, and updates that row.
    const rows = (await read()).messages as Array<{ id: string; kind: string; content: string; meta?: Record<string, unknown> }>;
    expect(rows.map((row) => row.kind)).toEqual(["SYSTEM", "CHAT", "CHAT"]);
    expect(rows[0]).toMatchObject({ id: waiting.eventId, content: "Bob is waiting: Permission prompt", meta: { type: "MONITOR_EVENT", status: "OPEN", eventKind: "WAITING", paneName: "Bob" } });
    await monitorRepository.updateEvent(waiting.eventId, { status: "ESCALATED", decision: "Needs you: the prompt approves a deploy." });
    expect(((await read()).messages as typeof rows).filter((row) => row.id === waiting.eventId)).toEqual([
      expect.objectContaining({ meta: expect.objectContaining({ status: "ESCALATED", decision: "Needs you: the prompt approves a deploy." }) })]);
    expect((await app.inject({ method: "GET", url: "/api/room-agent/pending", headers: { cookie } })).json()).toEqual({ rooms: { [room.id]: 1 },
      latest: [expect.objectContaining({ eventId: waiting.eventId })], roomNames: { [room.id]: room.name } });

    const off = await app.inject({ method: "PATCH", url: `/api/rooms/${room.id}/room-agent/monitor`, headers: { cookie, [csrfHeaderName]: csrfToken }, payload: { enabled: false } });
    expect(off.statusCode).toBe(200);
    expect(off.json().monitor).toEqual({ enabled: false, autopilot: true });
    expect(await monitorRepository.monitorEnabled(room.id)).toBe(false);
    const autopilotOff = await app.inject({ method: "PATCH", url: `/api/rooms/${room.id}/room-agent/monitor`, headers: { cookie, [csrfHeaderName]: csrfToken }, payload: { autopilot: false } });
    expect(autopilotOff.json().monitor).toEqual({ enabled: false, autopilot: false });
    const empty = await app.inject({ method: "PATCH", url: `/api/rooms/${room.id}/room-agent/monitor`, headers: { cookie, [csrfHeaderName]: csrfToken }, payload: {} });
    expect(empty.statusCode).toBe(422);

    const ack = await app.inject({ method: "POST", url: `/api/rooms/${room.id}/room-agent/events/${waiting.eventId}/ack`, headers: { cookie, [csrfHeaderName]: csrfToken } });
    expect(ack.statusCode).toBe(200);
    expect(ack.json().events[0].status).toBe("ACKED");
    expect(ack.json().messages.some((row: { id: string }) => row.id === waiting.eventId)).toBe(false);
    expect((await app.inject({ method: "GET", url: "/api/room-agent/pending", headers: { cookie } })).json()).toEqual({ rooms: {}, latest: [], roomNames: {} });
    const foreign = await app.inject({ method: "POST", url: `/api/rooms/${room.id}/room-agent/events/room_agent_event:missing/ack`, headers: { cookie, [csrfHeaderName]: csrfToken } });
    expect(foreign.statusCode).toBe(404);
  });

  it("answers pane questions only for open questions of CLI panes", async () => {
    const monitorRepository = new InMemoryRoomAgentMonitorRepository();
    const { app, cookie, csrfToken, room, store } = await setup({ monitorRepository });
    const chatPane = store.createPane({ roomId: room.id, title: "Chat", mode: "CHAT" });
    const post = (eventId: string, payload: unknown) => app.inject({ method: "POST", url: `/api/rooms/${room.id}/room-agent/events/${eventId}/answer`,
      headers: { cookie, [csrfHeaderName]: csrfToken }, payload });
    const noPane = await monitorRepository.addEvent({ roomId: room.id, paneId: null, paneName: null, kind: "WAITING", severity: "ATTENTION", title: "Someone is waiting", detail: null });
    expect((await post(noPane.eventId, { answer: "1" })).json().error.message).toBe("This event has no pane to answer.");
    const chat = await monitorRepository.addEvent({ roomId: room.id, paneId: chatPane.id, paneName: "Chat", kind: "WAITING", severity: "ATTENTION", title: "Chat is waiting", detail: null });
    expect((await post(chat.eventId, { decline: true })).json().error.message).toBe("Only CLI panes can be answered from the Room Agent.");
    expect((await monitorRepository.getEvent(chat.eventId))?.status).toBe("OPEN");
    await monitorRepository.updateEvent(chat.eventId, { status: "HANDLED" });
    expect((await post(chat.eventId, { decline: true })).json().error.message).toBe("This question was already handled.");
    expect((await post(chat.eventId, {})).statusCode).toBe(422);
    expect((await app.inject({ method: "GET", url: "/api/room-agent/pending", headers: { cookie } })).json().latest.map((event: { eventId: string }) => event.eventId))
      .toEqual([noPane.eventId]);
  });

  it("returns only the newest 500 room-agent messages", async () => {
    const { app, cookie, room, store } = await setup();
    const initial = await app.inject({ method: "GET", url: `/api/rooms/${room.id}/room-agent`, headers: { cookie } });
    const sessionId = initial.json().sessionId as string;
    for (let index = 0; index < 501; index += 1) {
      store.createSpaceAgentMessage({ sessionId, role: "user", content: `message-${String(index).padStart(3, "0")}` });
    }

    const response = await app.inject({ method: "GET", url: `/api/rooms/${room.id}/room-agent`, headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(response.json().messages).toHaveLength(500);
    expect(response.json().messages[0].content).toBe("message-001");
    expect(response.json().messages.at(-1).content).toBe("message-500");
  });
});

describe("completeRoomAgentPrompt", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  it("gives the gateway the caller's whole timeout", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"action":"ESCALATE"}' } }] }))));
    expect(await completeRoomAgentPrompt({ systemPrompt: "s", content: "c", codexLbBaseUrl: "http://127.0.0.1:9", codexLbKeyFile: "/nonexistent/key",
      modelSelection: { providerId: null, modelId: "gpt-5.6-sol", reasoningEffort: null, providerName: null, modelName: "gpt-5.6-sol", tier: "CODEX" },
      timeoutMs: 45_000 })).toBe('{"action":"ESCALATE"}');
    expect(timeout).toHaveBeenCalledWith(45_000);
  });

  it("asks the injected OpenCode (the CLI container's on public installs) for the OPENCODE tier", async () => {
    const runOpenCode = vi.fn(async () => " answer ");
    expect(await completeRoomAgentPrompt({ systemPrompt: "s", content: "c", timeoutMs: 1_000, runOpenCode,
      modelSelection: { providerId: "cli:opencode", modelId: "opencode/big-pickle", reasoningEffort: null, providerName: "OpenCode", modelName: "opencode/big-pickle", tier: "OPENCODE" } }))
      .toBe("answer");
    expect(runOpenCode).toHaveBeenCalledExactlyOnceWith("opencode/big-pickle", "s\n\nUser request: c", 1_000);
  });
});
