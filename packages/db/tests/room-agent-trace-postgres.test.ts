// The trace lookup on a real, disposable PostgreSQL (migration 0206 on top of the full chain): a Room Agent mission
// keeps the request trace and its first error code, and a background continuation, which keeps its own trace, is
// found through the run it continues. Skips with a reason when Docker or the image is missing.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCodexAppServerTurnWorkflowId, roomAgentSupervisorQueueItemSchema } from "@space/contracts";
import { PostgresSpaceStore } from "../src/space-store.js";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const unavailable = disposablePostgresUnavailableReason();

describe.skipIf(unavailable !== null)(`Room Agent trace lookup on PostgreSQL${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;
  let store: PostgresSpaceStore;

  beforeAll(async () => {
    server = await startDisposablePostgres("trace-ids");
    await server.createDatabase("space_trace");
    pool = server.pool("space_trace", 4);
    const client = await pool.connect();
    try {
      await applyPendingMigrations(client, await loadMigrations());
    } finally {
      client.release();
    }
    store = new PostgresSpaceStore(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await server?.stop();
  });

  it("finds the mission by its trace and follows the background continuation", async () => {
    const traceId = "req:traceids0001";
    const room = await store.createRoom({ kind: "AGENT_PROOF", name: "AGENT_PROOF trace lookup", initialPaneCount: 0 });
    const pane = await store.getOrCreateRoomAgentPane(room.id);
    const session = await store.createSpaceAgentSession({ paneId: pane.id, roomId: room.id, title: "Room Agent",
      selectedProviderId: null, selectedModelId: null, selectedModelConfigId: null,
      selectedProviderName: null, selectedModelName: null, selectedReasoningKey: null });
    const missionId = `mission:${room.id}`;
    const input = (suffix: string, turnTrace: string, sourceRunId?: string) => {
      const id = `${room.id}-${suffix}`;
      const queueItem = roomAgentSupervisorQueueItemSchema.parse({ missionId, turn: {
        roomId: room.id, paneId: pane.id, prompt: "Send the stories.", roomAgentOperatorRequest: "Send the stories.",
        modelId: "gpt-5.6-sol", reasoningEffort: "high", agentSessionId: session.sessionId,
        agentRunId: `run:${id}`, agentUserMessageId: `message:context-${id}`, agentAssistantMessageId: `message:response-${id}`,
        roomAgentMissionId: missionId, traceId: turnTrace,
        ...(sourceRunId ? { roomAgentContinuation: { sourceRunId, generation: 1 } } : {})
      } });
      return { requestId: `request:${id}`, clientRequestId: `client:${id}`, content: "Continue the request.",
        supervisorWorkflowId: `room-supervisor:${room.id}`, childWorkflowId: buildCodexAppServerTurnWorkflowId(queueItem.turn),
        promptMessageId: queueItem.turn.agentUserMessageId!, responseMessageId: queueItem.turn.agentAssistantMessageId!,
        runId: queueItem.turn.agentRunId!, queueItem };
    };
    const first = input("first", traceId);
    const initial = await store.enqueueRoomAgentMission(first, traceId);
    await store.updateRoomAgentMission(missionId, { status: "RUNNING" });
    await store.updateSpaceAgentRun(initial.run.runId, { status: "COMPLETED" });
    // The continuation's own trace: its workflow id embeds it, so it cannot be the request's.
    const continuation = input("continued", "trace:bg-traceids0001", initial.run.runId);
    await store.enqueueRoomAgentMission(continuation, continuation.queueItem.turn.traceId);
    await store.updateRoomAgentMission(missionId, { status: "FAILED", errorCode: "ROOM_AGENT_TOKEN_LIMIT", statusReason: "Budget reached." });
    await store.updateRoomAgentMission(missionId, { errorCode: "LATER_CODE" });
    // The request's event names the turn workflow in its payload, as started Room Agent turns do.
    await pool.query(`INSERT INTO events (id, room_id, trace_id, event_type, message, payload, created_at)
      VALUES ('event:traceids0001', $1, $2, 'TURN_STARTED', 'started', $3::jsonb, now())`,
    [room.id, traceId, JSON.stringify({ workflowId: first.childWorkflowId })]);

    const records = await store.listTraceRecords(traceId);
    expect(records.agentRuns.map((run) => [run.runId, run.continuationOf])).toEqual([
      [initial.run.runId, null], [continuation.runId, initial.run.runId]
    ]);
    expect(records.roomAgentMissions).toEqual([expect.objectContaining({ missionId, roomId: room.id, status: "FAILED",
      errorCode: "ROOM_AGENT_TOKEN_LIMIT" })]);
    expect((await store.listTraceRecords("req:othertrace01")).roomAgentMissions).toEqual([]);
  }, 60_000);

  it("finds the CLI sessions a request allocated, with their task and revision (migration 0258)", async () => {
    const traceId = "req:clitrace0001";
    const room = await store.createRoom({ kind: "AGENT_PROOF", name: "AGENT_PROOF CLI trace", initialPaneCount: 0 });
    const pane = await store.createPane({ roomId: room.id, title: "Codex CLI", mode: "TERMINAL" });
    const input = { sessionId: "cli_session:clitrace0001", paneId: pane.id, roomId: room.id, runtimeId: "cli:codex", providerId: "codex-cli",
      agentId: "codex", reasoningEffort: "medium" as const, launchMode: "FRESH" as const };
    const session = await store.createPaneCliSession(input, traceId);
    await store.createPaneCliSession({ ...input, sessionId: "cli_session:clitrace0002" }, "req:clitrace0002");
    await store.createPaneCliSession({ ...input, sessionId: "cli_session:untraced01" });
    const records = await store.listTraceRecords(traceId);
    expect(records.cliSessions).toEqual([expect.objectContaining({ sessionId: session.sessionId, paneId: pane.id, runtimeId: "cli:codex",
      cliTaskId: session.cliTaskId, cliTaskRevisionId: session.cliTaskRevisionId, launchMode: "FRESH" })]);
    expect((await store.listTraceRecords("req:clitrace0002")).cliSessions.map((row) => row.sessionId)).toEqual(["cli_session:clitrace0002"]);
    expect((await store.listTraceRecords("req:clitrace0003")).cliSessions).toEqual([]);
  }, 60_000);
});
