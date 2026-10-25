import { describe, expect, it } from "vitest";
import { dummyTurnInputSchema, type AuditChainEntry } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { executeChatActionBridge } from "../src/chat-action-bridge.js";

function actionBlock(actions: unknown[]): string {
  return [
    "I will update the shared chat.",
    "",
    "```space-chat-actions",
    JSON.stringify({ version: 1, actions }),
    "```"
  ].join("\n");
}

describe("worker shared chat actions", () => {
  it("sends and reads messages through the chat bridge", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Chat bridge", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const turnInput = dummyTurnInputSchema.parse({
      roomId: room.id,
      paneId: pane.id,
      prompt: "Report progress to the shared chat and read it back.",
      agentSessionId: "agent_session:chat",
      operatorUserId: "user:operator",
      selectedToolIds: ["chat:send", "chat:read"],
      traceId: "trace:chat"
    });

    const send = await executeChatActionBridge({
      turnInput,
      store,
      assistantContent: actionBlock([{ toolId: "chat:send", action: { type: "send", content: "deploy πέτυχε" } }])
    });
    expect(send.executedActionCount).toBe(1);
    expect(send.toolMessageContent).toContain("EXECUTED chat:send");

    const read = await executeChatActionBridge({
      turnInput,
      store,
      assistantContent: actionBlock([{ toolId: "chat:read", action: { type: "read", limit: 10 } }])
    });
    expect(read.executedActionCount).toBe(1);
    expect(read.toolMessageContent).toContain("deploy πέτυχε");

    const messages = store.listSharedChatMessages({ limit: 10 });
    expect(messages.items).toHaveLength(1);
    expect(messages.items[0]).toMatchObject({ senderType: "agent", kind: "message" });
  });

  it("blocks when the chat tools are not selected", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Chat block", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const turnInput = dummyTurnInputSchema.parse({
      roomId: room.id,
      paneId: pane.id,
      prompt: "Try to chat.",
      agentSessionId: "agent_session:chat",
      operatorUserId: "user:operator",
      selectedToolIds: [],
      traceId: "trace:chat"
    });
    const result = await executeChatActionBridge({
      turnInput,
      store,
      assistantContent: actionBlock([{ toolId: "chat:send", action: { type: "send", content: "secret?" } }])
    });
    expect(result.executedActionCount).toBe(0);
    expect(result.toolMessageContent).toContain("BLOCKED");
  });

  it("executes and removes an unterminated chat action fence", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Chat fence", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const turnInput = dummyTurnInputSchema.parse({
      roomId: room.id,
      paneId: pane.id,
      prompt: "Send a status update.",
      agentSessionId: "agent_session:chat-fence",
      operatorUserId: "user:operator",
      selectedToolIds: ["chat:send"],
      traceId: "trace:chat-fence"
    });
    const assistantContent = [
      "The status update was sent.",
      "",
      "```space-chat-actions",
      JSON.stringify({
        version: 1,
        actions: [{ toolId: "chat:send", action: { type: "send", content: "Status is green." } }]
      })
    ].join("\n");

    const result = await executeChatActionBridge({ turnInput, store, assistantContent });

    expect(result.cleanedContent).toBe("The status update was sent.");
    expect(result.executedActionCount).toBe(1);
    expect(result.toolMessageContent).toContain("EXECUTED chat:send");
    expect(store.listSharedChatMessages({ limit: 10 }).items[0]?.content).toBe("Status is green.");
  });

  it("appends a verifiable audit chain and detects tampering", async () => {
    const store = new InMemorySpaceStore();
    const first = store.appendAuditChainEntry({ action: "a", actor: "one" });
    const second = store.appendAuditChainEntry({ action: "b", actor: "two" });
    expect(first.prevHash).toBe("0".repeat(64));
    expect(second.prevHash).toBe(first.chainHash);
    expect(store.verifyAuditChain()).toMatchObject({ ok: true, entryCount: 2, verifiedThroughSeq: 2 });

    const entries = (store as unknown as { auditChainEntries: Map<number, AuditChainEntry> }).auditChainEntries;
    entries.set(second.seq, { ...second, metadata: { tampered: true } });
    const tampered = store.verifyAuditChain();
    expect(tampered.ok).toBe(false);
    expect(tampered.firstTamperedSeq).toBe(second.seq);
  });
});
