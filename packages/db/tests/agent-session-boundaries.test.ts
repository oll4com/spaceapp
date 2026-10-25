import { describe, expect, it } from "vitest";
import type { Pane, SpaceAgentRunRecord, SpaceAgentSessionRecord, UpdateSpaceAgentSessionInput } from "@space/contracts";
import { InMemorySpaceStore } from "../../runtime/src/store.js";
import { PostgresSpaceStore, type PgPoolLike } from "../src/space-store.js";

// A bounded SQL fixture exercises the real Postgres session updater without a live database.
class SessionPool implements PgPoolLike {
  constructor(readonly panes: Pane[], readonly sessions: SpaceAgentSessionRecord[], readonly runs: SpaceAgentRunRecord[]) {}
  async connect() { return this; }
  release() {}
  async query<T = unknown>(sql: string, values: unknown[] = []) {
    let rows: unknown[] = [];
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] as T[], rowCount: null };
    if (sql.includes("FROM panes")) {
      rows = this.panes.filter(pane => pane.id === values[0]);
    } else if (sql.includes("FROM space_agent_sessions")) {
      rows = this.sessions.filter(session => session.sessionId === values[0]);
    } else if (sql.includes("FROM space_agent_runs")) {
      if (sql.includes("WHERE workflow_id = $1")) rows = this.runs.filter(run => run.workflowId === values[0]);
      else if (sql.includes("WHERE run_id = $1")) rows = this.runs.filter(run => run.runId === values[0]);
      else {
        const paneIds = Array.isArray(values[0]) ? values[0] : [values[0]];
        rows = this.runs.filter(run => paneIds.includes(run.paneId) && ["QUEUED", "RUNNING"].includes(run.status));
      }
    } else if (sql.includes("UPDATE space_agent_runs")) {
      const run = this.runs.find(item => item.runId === values[0])!;
      Object.assign(run, { temporalRunId: values[1], codexThreadId: values[2], codexTurnId: values[3],
        status: values[4], errorCode: values[5], errorMessage: values[6], updatedAt: values[7],
        completedAt: values[8], runtimeModelAtStart: values[9], ledger: JSON.parse(values[10] as string) });
      rows = [run];
    } else if (sql.includes("SET is_active = false")) {
      for (const session of this.sessions) {
        if (session.paneId === values[0] && session.sessionId !== values[1]) session.isActive = false;
      }
    } else if (sql.includes("UPDATE space_agent_sessions")) {
      const session = this.sessions.find(item => item.sessionId === values[0])!;
      Object.assign(session, {
        paneId: values[1], roomId: values[2], status: values[3], title: values[4], threadId: values[5],
        isActive: values[15], lastSyncedAt: values[16], updatedAt: values[17]
      });
      rows = [session];
    } else {
      throw new Error(`Unexpected session fixture query: ${sql}`);
    }
    return { rows: rows as T[], rowCount: rows.length };
  }
}

async function fixture(backend: "memory" | "postgres", status: "QUEUED" | "RUNNING") {
  const memory = new InMemorySpaceStore();
  const room = memory.createRoom({ name: "Session checkpoint boundaries", initialPaneCount: 2 });
  const [pane, otherPane] = memory.listPanes(room.id) as [Pane, Pane];
  const selection = {
    selectedProviderId: null, selectedModelId: null, selectedModelConfigId: null,
    selectedProviderName: null, selectedModelName: null, selectedReasoningKey: null, selectedToolIds: null
  };
  const active = memory.createSpaceAgentSession({ ...selection, paneId: pane.id, roomId: room.id, title: "Active" });
  const remembered = memory.createSpaceAgentSession({ ...selection, paneId: pane.id, roomId: room.id, title: "Remembered", isActive: false });
  const incoming = memory.createSpaceAgentSession({ ...selection, paneId: otherPane.id, roomId: room.id, title: "Incoming" });
  const prompt = memory.createSpaceAgentMessage({ sessionId: active.sessionId, role: "user", content: "Work", status: "COMPLETED" });
  const response = memory.createSpaceAgentMessage({ sessionId: active.sessionId, role: "assistant", content: "", status: "RUNNING" });
  const run = memory.createSpaceAgentRun({ sessionId: active.sessionId, paneId: pane.id, roomId: room.id,
    workflowId: "workflow:checkpoint", status, promptMessageId: prompt.messageId, responseMessageId: response.messageId });
  memory.updateSpaceAgentSession(active.sessionId, { status: "RUNNING" });
  const pool = new SessionPool([pane, otherPane], [active, remembered, incoming].map(session => ({ ...memory.getSpaceAgentSession(session.sessionId)! })), [{ ...run }]);
  const store = backend === "memory" ? memory : new PostgresSpaceStore(pool);
  // Exercise the worker's actual run-before-session checkpoint methods on both stores.
  await store.updateSpaceAgentRunByWorkflowId(run.workflowId, { codexThreadId: "thread:checkpoint", codexTurnId: "turn:checkpoint" });
  const update = async (sessionId: string, input: UpdateSpaceAgentSessionInput) => store.updateSpaceAgentSession(sessionId, input);
  return { update, active, remembered, incoming, pane, otherPane, memory, pool };
}

describe.each(["memory", "postgres"] as const)("%s active session boundaries", backend => {
  it.each(["QUEUED", "RUNNING"] as const)("accepts the own-run thread checkpoint while %s", async status => {
    const f = await fixture(backend, status);
    const updated = await f.update(f.active.sessionId, { threadId: "thread:checkpoint", lastSyncedAt: "2026-10-09T00:00:00.000Z" });
    expect(updated).toMatchObject({ sessionId: f.active.sessionId, paneId: f.pane.id, isActive: true, threadId: "thread:checkpoint", status: "RUNNING" });
    expect((await f.update(f.active.sessionId, { title: "Still working" })).threadId).toBe("thread:checkpoint");
  });
  it("rejects thread changes absent from the active run checkpoint", async () => {
    const f = await fixture(backend, "RUNNING");
    await expect(f.update(f.active.sessionId, { threadId: "thread:unrelated" })).rejects.toThrow("Finish or stop");
    expect((await f.update(f.active.sessionId, { title: "Unchanged binding" })).threadId).toBeNull();
  });
  it("rejects reactivating another session even when its thread matches the checkpoint", async () => {
    const f = await fixture(backend, "RUNNING");
    await expect(f.update(f.remembered.sessionId, { isActive: true, threadId: "thread:checkpoint" })).rejects.toThrow("Finish or stop");
    expect((await f.update(f.active.sessionId, { title: "Still active" })).isActive).toBe(true);
  });
  it("rejects a checkpoint when another session has active work on the same pane", async () => {
    const f = await fixture(backend, "RUNNING");
    const prompt = f.memory.createSpaceAgentMessage({ sessionId: f.remembered.sessionId, role: "user", content: "Other work", status: "COMPLETED" });
    const response = f.memory.createSpaceAgentMessage({ sessionId: f.remembered.sessionId, role: "assistant", content: "", status: "RUNNING" });
    const foreign = f.memory.createSpaceAgentRun({ sessionId: f.remembered.sessionId, paneId: f.pane.id, roomId: f.pane.roomId,
      workflowId: "workflow:foreign", status: "RUNNING", codexThreadId: "thread:checkpoint",
      promptMessageId: prompt.messageId, responseMessageId: response.messageId });
    f.pool.runs.push({ ...foreign });
    await expect(f.update(f.active.sessionId, { threadId: "thread:checkpoint" })).rejects.toThrow("Finish or stop");
    expect((await f.update(f.active.sessionId, { title: "Own session preserved" })).threadId).toBeNull();
  });
  it("rejects moving either the running session or another session across a busy pane", async () => {
    const f = await fixture(backend, "RUNNING");
    await expect(f.update(f.active.sessionId, { paneId: f.otherPane.id, threadId: "thread:checkpoint" })).rejects.toThrow("Finish or stop");
    await expect(f.update(f.incoming.sessionId, { paneId: f.pane.id, threadId: "thread:checkpoint" })).rejects.toThrow("Finish or stop");
    expect((await f.update(f.active.sessionId, { title: "Still in original pane" })).paneId).toBe(f.pane.id);
  });
  it("rejects clearing a checkpointed thread while its run is active", async () => {
    const f = await fixture(backend, "RUNNING");
    await f.update(f.active.sessionId, { threadId: "thread:checkpoint" });
    await expect(f.update(f.active.sessionId, { threadId: null })).rejects.toThrow("Finish or stop");
  });
});
