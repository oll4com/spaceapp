import { describe, expect, it } from "vitest";
import { dummyTurnInputSchema } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { executeTaskActionBridge } from "../src/task-action-bridge.js";

function actionBlock(actions: unknown[]): string {
  return [
    "I will only manage the task the operator requested.",
    "",
    "```space-task-actions",
    JSON.stringify({ version: 1, actions }),
    "```"
  ].join("\n");
}

describe("worker task actions", () => {
  it("lists, gets, saves, and updates owner-scoped tasks with bounded observations", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Task bridge", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const longObjective = `operator-only ${"x".repeat(7_000)}`;
    const existing = store.upsertTaskItem({
      ownerUserId: "user:operator",
      title: "Existing task",
      objective: longObjective,
      status: "OPEN",
      source: "MANUAL"
    });
    store.upsertTaskItem({ ownerUserId: "user:other", title: "Other private task", objective: "other-user-private", status: "OPEN", source: "MANUAL" });
    const turnInput = dummyTurnInputSchema.parse({
      roomId: room.id,
      paneId: pane.id,
      prompt: "List my tasks, read the first, save a new task, and mark it done.",
      agentSessionId: "agent_session:task",
      operatorUserId: "user:operator",
      selectedToolIds: ["tasks:list", "tasks:get", "tasks:save", "tasks:update"],
      traceId: "trace:task"
    });

    const result = await executeTaskActionBridge({
      turnInput,
      store,
      assistantContent: actionBlock([
        { toolId: "tasks:list", action: { type: "list", pageSize: 10 } },
        { toolId: "tasks:get", action: { type: "get", taskItemId: existing.id } },
        { toolId: "tasks:save", action: { type: "save", title: "Agent task", objective: "Ship the task dock" } }
      ])
    });

    expect(result.executedActionCount).toBe(3);
    expect(result.cleanedContent).toBe("I will only manage the task the operator requested.");
    expect(result.toolMessageContent).toContain("EXECUTED tasks:list");
    expect(result.toolMessageContent).toContain("EXECUTED tasks:get");
    expect(result.toolMessageContent).toContain("objectiveTruncated=true");
    expect(result.toolMessageContent).toContain("EXECUTED tasks:save");
    expect(result.toolMessageContent).not.toContain("other-user-private");
    expect(result.toolMessageContent!.length).toBeLessThanOrEqual(12_000);

    const saved = store.listTaskItems("user:operator", { page: 1, pageSize: 10 }).items[0]!;
    expect(saved).toMatchObject({
      title: "Agent task",
      objective: "Ship the task dock",
      status: "OPEN",
      source: "AGENT",
      roomId: room.id,
      paneId: pane.id,
      paneTitle: pane.title
    });

    const updated = await executeTaskActionBridge({
      turnInput,
      store,
      assistantContent: actionBlock([
        { toolId: "tasks:update", action: { type: "update", taskItemId: saved.id, status: "DONE" } }
      ])
    });
    expect(updated.executedActionCount).toBe(1);
    expect(updated.toolMessageContent).toContain("EXECUTED tasks:update");
    expect(store.getTaskItem("user:operator", saved.id)?.status).toBe("DONE");
  });

  it("blocks task actions without authenticated operator identity", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Blocked task", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const turnInput = dummyTurnInputSchema.parse({
      roomId: room.id,
      paneId: pane.id,
      prompt: "save this",
      agentSessionId: "agent_session:task-blocked",
      selectedToolIds: ["tasks:save"],
      traceId: "trace:task-blocked"
    });

    const result = await executeTaskActionBridge({
      turnInput,
      store,
      assistantContent: actionBlock([
        { toolId: "tasks:save", action: { type: "save", title: "Must not save", objective: "blocked" } }
      ])
    });

    expect(result.executedActionCount).toBe(0);
    expect(result.toolMessageContent).toContain("BLOCKED");
    expect(result.toolMessageContent).toContain("authenticated operator identity");
    expect(store.snapshot().taskItems).toEqual([]);
  });

  it("blocks task actions when the tool is not selected", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Task gate", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const turnInput = dummyTurnInputSchema.parse({
      roomId: room.id,
      paneId: pane.id,
      prompt: "Save a task.",
      agentSessionId: "agent_session:task-gate",
      operatorUserId: "user:operator",
      selectedToolIds: ["tasks:list"],
      traceId: "trace:task-gate"
    });

    const result = await executeTaskActionBridge({
      turnInput,
      store,
      assistantContent: actionBlock([
        { toolId: "tasks:save", action: { type: "save", title: "Gate task", objective: "must not save" } }
      ])
    });

    expect(result.executedActionCount).toBe(0);
    expect(result.toolMessageContent).toContain("BLOCKED tasks:save");
    expect(store.snapshot().taskItems).toEqual([]);
  });
});
