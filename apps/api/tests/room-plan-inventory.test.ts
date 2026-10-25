import { describe, expect, it } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createRoomPlanInventoryProvider } from "../src/room-plan-inventory.js";

describe("Room plan inventory", () => {
  it("excludes pending plans from inactive historical CLI sessions", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Plans", initialPaneCount: 0 }, "trace:plans");
    const pane = store.createPane({ roomId: room.id, title: "Mobile maximize photo 2", mode: "TERMINAL" }, "trace:plans");
    store.createPaneCliSession({
      paneId: pane.id,
      roomId: room.id,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: null,
      reasoningEffort: "high",
      codexThreadId: "019f4434-0000-7000-8000-000000000001"
    });
    store.createPaneCliSession({
      paneId: pane.id,
      roomId: room.id,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: null,
      reasoningEffort: "high",
      codexThreadId: "019f4434-0000-7000-8000-000000000002"
    });

    const provider = createRoomPlanInventoryProvider({
      store,
      findPlanState: async (threadId) => threadId === "019f4434-0000-7000-8000-000000000001"
        ? {
            status: "READY",
            title: "Mobile Full-Pane Maximize",
            text: "# Mobile Full-Pane Maximize",
            threadTurnId: "turn:plan",
            updatedAt: "2026-07-12T05:31:00.000Z"
          }
        : null
    });

    await expect(provider.inspect(room.id)).resolves.toMatchObject({
      totalPanes: 1,
      plannedPanes: 0,
      pendingPlans: 0,
      readyPlans: 0,
      pausedPlans: 0,
      runningPlans: 0,
      plans: []
    });
  });

  it("reports only the plan attached to the active CLI session", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Active plans", initialPaneCount: 0 }, "trace:active-plans");
    const pane = store.createPane({ roomId: room.id, title: "Current task", mode: "TERMINAL" }, "trace:active-plans");
    const historical = store.createPaneCliSession({
      paneId: pane.id,
      roomId: room.id,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: null,
      reasoningEffort: "high",
      codexThreadId: "019f4434-0000-7000-8000-000000000010"
    });
    const active = store.createPaneCliSession({
      paneId: pane.id,
      roomId: room.id,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: null,
      reasoningEffort: "high",
      codexThreadId: "019f4434-0000-7000-8000-000000000011"
    });

    const provider = createRoomPlanInventoryProvider({
      store,
      findPlanState: async (threadId) => ({
        status: "READY",
        title: threadId === active.codexThreadId ? "Current active plan" : "Superseded historical plan",
        text: "# Plan",
        threadTurnId: "turn:plan",
        updatedAt: "2026-07-12T08:00:00.000Z"
      })
    });

    const inventory = await provider.inspect(room.id);

    expect(inventory).toMatchObject({
      totalPanes: 1,
      plannedPanes: 1,
      pendingPlans: 1,
      readyPlans: 1,
      pausedPlans: 0,
      plans: [{ sessionId: active.sessionId, threadId: active.codexThreadId, title: "Current active plan", status: "READY" }]
    });
    expect(inventory.plans.some((plan) => plan.sessionId === historical.sessionId)).toBe(false);
  });
});
