import { describe, expect, it } from "vitest";
import { dummyTurnInputSchema } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { executeClipboardActionBridge } from "../src/clipboard-action-bridge.js";

function actionBlock(actions: unknown[]): string {
  return [
    "I will use only the clipboard items the operator requested.",
    "",
    "```space-clipboard-actions",
    JSON.stringify({ version: 1, actions }),
    "```"
  ].join("\n");
}

describe("worker clipboard actions", () => {
  it("lists, gets, and saves owner-scoped clips with bounded observations", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Clipboard bridge", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const longText = `operator-only ${"x".repeat(7_000)}`;
    const existing = store.upsertClipboardItem({
      ownerUserId: "user:operator",
      text: longText,
      source: "MANUAL_NOTE"
    });
    store.upsertClipboardItem({ ownerUserId: "user:other", text: "other-user-private", source: "MANUAL_NOTE" });
    const turnInput = dummyTurnInputSchema.parse({
      roomId: room.id,
      paneId: pane.id,
      prompt: "List my clipboard, read the first item, and save an agent note.",
      agentSessionId: "agent_session:clipboard",
      operatorUserId: "user:operator",
      selectedToolIds: ["clipboard:list", "clipboard:get", "clipboard:save"],
      traceId: "trace:clipboard"
    });

    const result = await executeClipboardActionBridge({
      turnInput,
      store,
      assistantContent: actionBlock([
        { toolId: "clipboard:list", action: { type: "list", pageSize: 10 } },
        { toolId: "clipboard:get", action: { type: "get", clipboardItemId: existing.id } },
        { toolId: "clipboard:save", action: { type: "save", text: "Agent-created rollout reminder" } }
      ])
    });

    expect(result.executedActionCount).toBe(3);
    expect(result.cleanedContent).toBe("I will use only the clipboard items the operator requested.");
    expect(result.toolMessageContent).toContain("EXECUTED clipboard:list");
    expect(result.toolMessageContent).toContain("EXECUTED clipboard:get");
    expect(result.toolMessageContent).toContain("textTruncated=true");
    expect(result.toolMessageContent).toContain("EXECUTED clipboard:save");
    expect(result.toolMessageContent).not.toContain("other-user-private");
    expect(result.toolMessageContent!.length).toBeLessThanOrEqual(12_000);

    const saved = store.listClipboardItems("user:operator", { source: "AGENT_NOTE", page: 1, pageSize: 10 }).items[0]!;
    expect(saved).toMatchObject({
      text: "Agent-created rollout reminder",
      source: "AGENT_NOTE",
      roomId: room.id,
      paneId: pane.id,
      paneTitle: pane.title
    });
  });

  it("blocks clipboard actions without authenticated operator identity", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Blocked clipboard", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const turnInput = dummyTurnInputSchema.parse({
      roomId: room.id,
      paneId: pane.id,
      prompt: "save this",
      agentSessionId: "agent_session:clipboard-blocked",
      selectedToolIds: ["clipboard:save"],
      traceId: "trace:clipboard-blocked"
    });

    const result = await executeClipboardActionBridge({
      turnInput,
      store,
      assistantContent: actionBlock([
        { toolId: "clipboard:save", action: { type: "save", text: "must not save" } }
      ])
    });

    expect(result.executedActionCount).toBe(0);
    expect(result.toolMessageContent).toContain("BLOCKED");
    expect(result.toolMessageContent).toContain("authenticated operator identity");
    expect(store.snapshot().clipboardItems).toEqual([]);
  });

  it("saves a full designed plan as a PLAN clip with a title", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Plan clipboard", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const planText = `# Rollout plan\n${"y".repeat(20_000)}`;
    const turnInput = dummyTurnInputSchema.parse({
      roomId: room.id,
      paneId: pane.id,
      prompt: "Save the plan you designed.",
      agentSessionId: "agent_session:clipboard-plan",
      operatorUserId: "user:operator",
      selectedToolIds: ["clipboard:save-plan"],
      traceId: "trace:clipboard-plan"
    });

    const result = await executeClipboardActionBridge({
      turnInput,
      store,
      assistantContent: actionBlock([
        {
          toolId: "clipboard:save-plan",
          action: { type: "save-plan", text: planText, title: "Rollout plan", minimumModel: "gpt-5.6-sol" }
        }
      ])
    });

    expect(result.executedActionCount).toBe(1);
    expect(result.toolMessageContent).toContain("EXECUTED clipboard:save-plan");
    expect(result.toolMessageContent).toContain("title=Rollout plan");
    expect(result.toolMessageContent).toContain("minimumModel=gpt-5.6-sol");
    expect(result.toolMessageContent).toContain(`characters=${Array.from(planText).length}`);
    expect(result.cleanedContent).toBe("I will use only the clipboard items the operator requested.");

    const saved = store.listClipboardItems("user:operator", { source: "PLAN", page: 1, pageSize: 10 }).items[0]!;
    expect(saved).toMatchObject({
      text: planText,
      source: "PLAN",
      title: "Rollout plan",
      minimumModel: "gpt-5.6-sol",
      roomId: room.id,
      paneId: pane.id,
      paneTitle: pane.title
    });
    expect(saved.characterCount).toBe(Array.from(planText).length);
  });

  it("blocks clipboard:save-plan when the tool is not selected", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Plan gate", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const turnInput = dummyTurnInputSchema.parse({
      roomId: room.id,
      paneId: pane.id,
      prompt: "Save the plan.",
      agentSessionId: "agent_session:clipboard-plan-gate",
      operatorUserId: "user:operator",
      selectedToolIds: ["clipboard:save"],
      traceId: "trace:clipboard-plan-gate"
    });

    const result = await executeClipboardActionBridge({
      turnInput,
      store,
      assistantContent: actionBlock([
        { toolId: "clipboard:save-plan", action: { type: "save-plan", text: "plan text", minimumModel: "gpt-5.6-sol" } }
      ])
    });

    expect(result.executedActionCount).toBe(0);
    expect(result.toolMessageContent).toContain("BLOCKED clipboard:save-plan");
    expect(store.snapshot().clipboardItems).toEqual([]);
  });

  it("rejects clipboard:save-plan when minimumModel is missing", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Plan min model", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const turnInput = dummyTurnInputSchema.parse({
      roomId: room.id,
      paneId: pane.id,
      prompt: "Save the plan without min model.",
      agentSessionId: "agent_session:clipboard-plan-missing-model",
      operatorUserId: "user:operator",
      selectedToolIds: ["clipboard:save-plan"],
      traceId: "trace:clipboard-plan-missing-model"
    });

    const result = await executeClipboardActionBridge({
      turnInput,
      store,
      assistantContent: actionBlock([
        { toolId: "clipboard:save-plan", action: { type: "save-plan", text: "plan text" } }
      ])
    });

    expect(result.executedActionCount).toBe(0);
    expect(result.toolMessageContent).toContain("FAILED");
    expect(store.snapshot().clipboardItems).toEqual([]);
  });
});
