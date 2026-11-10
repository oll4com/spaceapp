import { expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createRoomPaneController } from "../src/room-pane-control.js";

it("forwards a fresh native evidence request without changing ordinary inspection", async () => {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Native proof", initialPaneCount: 0 });
  const pane = store.createPane({ roomId: room.id, title: "CLI", mode: "TERMINAL" });
  const inspectCli = vi.fn(async () => ({ tasks: [] }));
  const controller = createRoomPaneController({ store, inspectCli } as never);
  await controller.inspect(pane, { fresh: true });
  expect(inspectCli).toHaveBeenLastCalledWith(pane, { fresh: true });
  await controller.inspect(pane);
  expect(inspectCli).toHaveBeenLastCalledWith(pane, undefined);
});

it.each(["default", "plan"] as const)("exposes the real Chat model choices and effective %s mode for Room Agent catalog queries", async mode => {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Chat catalog", initialPaneCount: 0 });
  const pane = store.createPane({ roomId: room.id, title: "Chat", mode: "CHAT" });
  const session = store.createSpaceAgentSession({ paneId: pane.id, roomId: room.id, title: "Chat",
    selectedModelId: "model-one", selectedModelConfigId: "one:medium", selectedProviderId: null,
    selectedProviderName: null, selectedModelName: "One", selectedReasoningKey: "medium", selectedToolIds: [] });
  const loadSession = vi.fn(async () => ({ binding: { sessionId: session.sessionId }, collaborationMode: mode,
    selectedModelConfigId: "one:medium", modelProviders: [{ providerId: "codex", isCurrent: true }],
    modelOptions: [
      { id: "one:medium", model: "model-one", reasoningKey: "medium", isDefault: true },
      { id: "two:low", model: "model-two", reasoningKey: "low", isDefault: false },
      { id: "two:high", model: "model-two", reasoningKey: "high", isDefault: false }
    ] }));
  const controller = createRoomPaneController({ store, chat: { loadSession } } as never);
  const observation = await controller.inspect(pane);
  expect(observation).toMatchObject({ sessionId: session.sessionId, runtimeId: "codex", modelId: "model-one",
    nativeMode: mode, modes: ["default", "plan"], models: [
      { id: "model-one", supportedReasoningEfforts: ["medium"], defaultReasoningEffort: "medium" },
      { id: "model-two", supportedReasoningEfforts: ["low", "high"] }
    ] });
  expect(store.getActiveSpaceAgentSession(pane.id)?.sessionId).toBe(session.sessionId);
});

it("does not allocate a Chat session while inspecting an unprepared pane", async () => {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Unprepared Chat", initialPaneCount: 0 });
  const pane = store.createPane({ roomId: room.id, title: "Chat", mode: "CHAT" });
  const loadSession = vi.fn();
  const observation = await createRoomPaneController({ store, chat: { loadSession } } as never).inspect(pane);
  expect(observation.sessionId).toBeNull();
  expect(loadSession).not.toHaveBeenCalled();
});

it("controls a copilot pane's CLI as a CLI, so its model can be set (Nous, 2026-10-17)", async () => {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Freelance", initialPaneCount: 0 });
  const pane = store.createPane({ roomId: room.id, title: "Freelance", mode: "FREELANCE_COPILOT", terminalRuntimeId: "cli:claude" } as never);
  const inspectCli = vi.fn(async () => ({ sessionId: "cli-session:1", state: "IDLE", tasks: [] }));
  const configureCli = vi.fn(async () => ({ modelId: "claude-opus-5-5" }));
  const controller = createRoomPaneController({ store, inspectCli, configureCli } as never);
  expect((await controller.inspect(pane)).sessionId).toBe("cli-session:1");
  const action = { type: "configure_pane", paneId: pane.id, expectedSessionId: "cli-session:1", modelId: "claude-opus-5-5", when: "NOW" } as never;
  await controller.configure(pane, action, "trace:1");
  expect(configureCli).toHaveBeenCalledWith(pane, action, "trace:1");
});

it("reads a Chat run's ledger usage, never its text, so Control can verify a turn's receipt (CTX-001)", async () => {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Receipt", initialPaneCount: 0 });
  const pane = store.createPane({ roomId: room.id, title: "Chat", mode: "CHAT" });
  const session = store.createSpaceAgentSession({ paneId: pane.id, roomId: room.id, title: "Chat",
    selectedModelId: null, selectedModelConfigId: null, selectedProviderId: "cli:claude",
    selectedProviderName: null, selectedModelName: null, selectedReasoningKey: null, selectedToolIds: [] });
  const prompt = store.createSpaceAgentMessage({ sessionId: session.sessionId, role: "user", content: "Reply OK", status: "COMPLETED" });
  const answer = store.createSpaceAgentMessage({ sessionId: session.sessionId, role: "assistant", content: "OK", status: "RUNNING" });
  const run = store.createSpaceAgentRun({ sessionId: session.sessionId, roomId: room.id, paneId: pane.id, workflowId: "workflow:receipt",
    status: "RUNNING", promptMessageId: prompt.messageId, responseMessageId: answer.messageId });
  const usage = { status: "MEASURED" as const, inputTokens: 1690, cachedInputTokens: 0, outputTokens: 4, reasoningOutputTokens: 0,
    totalTokens: 1694, source: "claude-cli:result", observedAt: new Date().toISOString(), model: "claude-opus-5-5" };
  store.updateSpaceAgentRun(run.runId, { status: "COMPLETED", usage });
  const controller = createRoomPaneController({ store, chat: { loadSession: vi.fn(async () => null) } } as never);
  const [task] = (await controller.inspect(pane)).tasks;
  expect(task).toMatchObject({ taskId: run.runId, status: "COMPLETED", usage });
});
