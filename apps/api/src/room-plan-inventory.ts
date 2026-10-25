import {
  roomAgentRoomInventorySchema,
  type RoomAgentRoomInventory,
  type RoomAgentRoomPlan
} from "@space/contracts";
import { nowIso, type SpaceStore } from "@space/runtime";
import type { CodexCliPlanState } from "./codex-rollout-diagnostics.js";

export interface RoomPlanInventoryProvider {
  inspect(roomId: string): Promise<RoomAgentRoomInventory>;
}

export function createRoomPlanInventoryProvider(options: {
  store: SpaceStore;
  findPlanState: (threadId: string) => Promise<CodexCliPlanState | null>;
  planStateCacheMs?: number;
  isCliRuntimeEnabled?: (runtimeId: string) => Promise<boolean>;
}): RoomPlanInventoryProvider {
  const planStateCacheMs = options.planStateCacheMs ?? 5_000;
  const planStateCache = new Map<string, { expiresAt: number; value: Promise<CodexCliPlanState | null> }>();

  function findPlanState(threadId: string): Promise<CodexCliPlanState | null> {
    const cached = planStateCache.get(threadId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = options.findPlanState(threadId);
    planStateCache.set(threadId, { expiresAt: Date.now() + planStateCacheMs, value });
    if (planStateCache.size > 512) {
      const oldestKey = planStateCache.keys().next().value;
      if (typeof oldestKey === "string") planStateCache.delete(oldestKey);
    }
    return value;
  }

  async function inspect(roomId: string): Promise<RoomAgentRoomInventory> {
    const candidates = (await options.store.listPanes(roomId, true)).filter((pane) => !pane.isClosed && pane.mode === "TERMINAL");
    const panes = (await Promise.all(candidates.map(async (pane) => ({
      pane,
      visible: !pane.terminalRuntimeId || !options.isCliRuntimeEnabled || await options.isCliRuntimeEnabled(pane.terminalRuntimeId)
    })))).filter((candidate) => candidate.visible).map((candidate) => candidate.pane);
    const plans = (await Promise.all(panes.map(async (pane): Promise<RoomAgentRoomPlan | null> => {
      const session = await options.store.getActivePaneCliSession(pane.id);
      if (!session?.codexThreadId) return null;
      const plan = await findPlanState(session.codexThreadId);
      if (!plan) return null;
      return {
        paneId: pane.id,
        paneTitle: pane.title,
        sessionId: session.sessionId,
        threadId: session.codexThreadId,
        status: plan.status,
        title: plan.title,
        updatedAt: plan.updatedAt
      };
    }))).filter((plan): plan is RoomAgentRoomPlan => Boolean(plan));

    const readyPlans = plans.filter((plan) => plan.status === "READY").length;
    const pausedPlans = plans.filter((plan) => plan.status === "PAUSED_BY_ROOM_AGENT").length;
    return roomAgentRoomInventorySchema.parse({
      totalPanes: panes.length,
      plannedPanes: plans.length,
      pendingPlans: readyPlans + pausedPlans,
      readyPlans,
      pausedPlans,
      runningPlans: plans.filter((plan) => plan.status === "RUNNING").length,
      checkedAt: nowIso(),
      plans
    });
  }

  return { inspect };
}
