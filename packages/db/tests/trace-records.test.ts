import { describe, expect, it } from "vitest";
import { PostgresSpaceStore, type PgClientLike, type PgPoolLike } from "../src/index.js";

class RecordingPool implements PgPoolLike {
  readonly calls: Array<{ sql: string; values: unknown[] }> = [];

  async query<T>(sql: string, values: unknown[] = []) {
    this.calls.push({ sql, values });
    const now = new Date("2026-10-11T10:00:00.000Z");
    if (sql.includes("FROM events")) {
      return { rows: [{ id: "event:abcdef01", roomId: "room:abcdef01", paneId: "pane:abcdef01", turnId: "turn:abcdef01", workflowId: "workflow:abcdef01",
        traceId: values[0], type: "TURN_FAILED", message: "failed", payload: { reasonCode: "TIMEOUT" }, createdAt: now }] as T[], rowCount: 1 };
    }
    if (sql.includes("FROM space_agent_runs") && sql.includes("run_id = ANY")) {
      return { rows: [{ runId: "agent_run:bg-continued01", workflowId: "workflow:bg-continued01", status: "COMPLETED", errorCode: null,
        createdAt: now, completedAt: now }] as T[], rowCount: 1 };
    }
    if (sql.includes("FROM space_agent_runs")) {
      return { rows: [{ runId: "agent_run:abcdef01", workflowId: "workflow:abcdef01", status: "FAILED", errorCode: "TOOL_UNAVAILABLE",
        createdAt: now, completedAt: now }] as T[], rowCount: 1 };
    }
    if (sql.includes("FROM room_agent_requests")) {
      // One background continuation of the traced run, and none of the continuation itself.
      const sources = values[0] as string[];
      return sources.includes("agent_run:abcdef01")
        ? { rows: [{ runId: "agent_run:bg-continued01", sourceRunId: "agent_run:abcdef01" }] as T[], rowCount: 1 }
        : { rows: [] as T[], rowCount: 0 };
    }
    if (sql.includes("FROM room_agent_missions")) {
      return { rows: [{ missionId: "room_agent_mission:abcdef01", roomId: "room:abcdef01", status: "FAILED", errorCode: "ROOM_AGENT_TOKEN_LIMIT",
        queuedAt: now, completedAt: now }] as T[], rowCount: 1 };
    }
    if (sql.includes("FROM room_agent_task_runs")) {
      return { rows: [{ runId: "room_agent_task_run:abcdef01", missionId: "room_agent_mission:abcdef01", roomId: "room:abcdef01",
        status: "COMPLETED", errorCode: null, queuedAt: now, completedAt: null }] as T[], rowCount: 1 };
    }
    if (sql.includes("FROM audit_events")) {
      return { rows: [{ id: "audit:abcdef01", actorUserId: null, traceId: values[0], action: "turn.queue", targetType: "workflow",
        targetId: "workflow:abcdef01", metadata: {}, createdAt: now }] as T[], rowCount: 1 };
    }
    return { rows: [{ workflowId: "workflow:abcdef01", runId: null, type: "AGENT_TURN", taskQueue: "q", status: "FAILED", roomId: "room:abcdef01",
      paneId: "pane:abcdef01", traceId: values[0], startedAt: now, closedAt: now }] as T[], rowCount: 1 };
  }

  async connect(): Promise<PgClientLike> {
    return this;
  }
}

describe("PostgresSpaceStore.listTraceRecords", () => {
  it("runs bounded, parameterized lookups by trace id and maps every record kind", async () => {
    const pool = new RecordingPool();
    const store = new PostgresSpaceStore(pool);
    const records = await store.listTraceRecords("req:abcdefghijkl", { limit: 9_999, sinceDays: 0 });

    expect(records.events).toEqual([expect.objectContaining({ id: "event:abcdef01", traceId: "req:abcdefghijkl", type: "TURN_FAILED" })]);
    expect(records.auditEvents).toEqual([expect.objectContaining({ id: "audit:abcdef01", action: "turn.queue" })]);
    expect(records.workflows).toEqual([expect.objectContaining({ workflowId: "workflow:abcdef01", status: "FAILED" })]);
    // Agent runs carry no trace id: they join through the trace's workflow ids.
    const runCall = pool.calls.find((call) => call.sql.includes("FROM space_agent_runs") && call.sql.includes("workflow_id = ANY"))!;
    expect(runCall.values).toEqual([["workflow:abcdef01"], 500]);
    expect(runCall.sql).toContain("workflow_id = ANY($1::text[])");
    expect(records.agentRuns).toEqual([
      { runId: "agent_run:abcdef01", workflowId: "workflow:abcdef01", status: "FAILED", errorCode: "TOOL_UNAVAILABLE",
        createdAt: "2026-10-11T10:00:00.000Z", completedAt: "2026-10-11T10:00:00.000Z", continuationOf: null },
      // A background continuation keeps its own trace and is found through the run it continues.
      { runId: "agent_run:bg-continued01", workflowId: "workflow:bg-continued01", status: "COMPLETED", errorCode: null,
        createdAt: "2026-10-11T10:00:00.000Z", completedAt: "2026-10-11T10:00:00.000Z", continuationOf: "agent_run:abcdef01" }
    ]);
    const continuationCalls = pool.calls.filter((call) => call.sql.includes("FROM room_agent_requests"));
    expect(continuationCalls.map((call) => call.values[0])).toEqual([["agent_run:abcdef01"], ["agent_run:bg-continued01"]]);
    expect(continuationCalls[0]!.sql).toContain("turn_payload->'turn'->'roomAgentContinuation'->>'sourceRunId' = ANY($1::text[])");
    expect(records.roomAgentMissions).toEqual([{ missionId: "room_agent_mission:abcdef01", roomId: "room:abcdef01", status: "FAILED",
      errorCode: "ROOM_AGENT_TOKEN_LIMIT", queuedAt: "2026-10-11T10:00:00.000Z", completedAt: "2026-10-11T10:00:00.000Z" }]);
    expect(records.roomAgentTaskRuns).toEqual([{ runId: "room_agent_task_run:abcdef01", missionId: "room_agent_mission:abcdef01",
      roomId: "room:abcdef01", status: "COMPLETED", errorCode: null, queuedAt: "2026-10-11T10:00:00.000Z", completedAt: null }]);
    const byRunId = (call: { sql: string }) => call.sql.includes("FROM room_agent_requests") || call.sql.includes("run_id = ANY");
    for (const call of pool.calls.filter((entry) => entry !== runCall && !byRunId(entry))) {
      expect(call.values[0]).toBe("req:abcdefghijkl");
      expect(call.sql).not.toContain("req:abcdefghijkl");
      expect(call.sql).toMatch(/trace_id = \$1/);
      expect(call.sql).toMatch(/LIMIT \$\d/);
    }
    const eventCall = pool.calls.find((call) => call.sql.includes("FROM events"))!;
    // Limits are clamped: 500 rows at most, default 14-day event window for invalid input.
    expect(eventCall.values).toEqual(["req:abcdefghijkl", 14, 500]);
    expect(eventCall.sql).toContain("created_at >= now() - make_interval(days => $2::int)");
  });

  it("writes the trace id and the first error code of Room Agent missions and task runs", async () => {
    const pool = new RecordingPool();
    const store = new PostgresSpaceStore(pool);
    const taskRun = { runId: "room_agent_task_run:abcdef01", missionId: "room_agent_mission:abcdef01", roomId: "room:abcdef01",
      stepId: "step-1", paneId: "pane:abcdef01", label: "Build", instruction: "Build it", status: "QUEUED", state: "RUNNING",
      modelId: null, reasoningEffort: null, qualityScore: null, qualityUnavailableReason: null, reliabilityScore: 0, combinedScore: null,
      rubric: null, queueMs: 0, firstResponseMs: null, executionMs: 0, totalMs: 0, retries: 0, recoveries: 0, stalls: 0,
      completedAt: null, verificationSummary: "Queued.", queuedAt: "2026-10-11T10:00:00.000Z", startedAt: null, firstResponseAt: null };
    await store.upsertRoomAgentTaskRun({ ...taskRun, errorCode: "TIMEOUT" } as never, "req:abcdefghijkl").catch(() => undefined);
    const upsert = pool.calls.find((call) => call.sql.includes("INSERT INTO room_agent_task_runs"))!;
    expect(upsert.sql).toContain("trace_id = COALESCE(room_agent_task_runs.trace_id, EXCLUDED.trace_id)");
    expect(upsert.values.slice(-2)).toEqual(["req:abcdefghijkl", "TIMEOUT"]);
    await store.updateRoomAgentMission("room_agent_mission:abcdef01", { errorCode: "ROOM_AGENT_TOKEN_LIMIT" }).catch(() => undefined);
    const update = pool.calls.find((call) => call.sql.includes("UPDATE room_agent_missions"))!;
    expect(update.sql).toContain("error_code = COALESCE(error_code, $18)");
    expect(update.values[17]).toBe("ROOM_AGENT_TOKEN_LIMIT");
  });
});
