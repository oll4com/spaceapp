import { expect } from "vitest";
import type { Scenario } from "./harness.js";

export const historicalScenario: Scenario = {
  name: "authentic August supervisor history replays on current code",
  workflowType: "roomAgentSupervisorWorkflow", historical: true,
  async run(ctx) {
    const lifecycle: string[] = [];
    ctx.activities.markRoomAgentMissionStarted = async () => { lifecycle.push("started"); };
    ctx.activities.runCodexAppServerTurn = async () => ({
      status: "COMPLETED", message: "Synthetic verified completion",
      roomAgentOutcome: { status: "VERIFIED", statusReason: "Synthetic verified completion" }
    });
    ctx.activities.markRoomAgentMissionFinished = async ({ status }) => { lifecycle.push(status); };
    const handle = await ctx.start("roomAgentSupervisorWorkflow", {
      roomId: "synthetic-history-room", processedCount: 0,
      pending: [{ missionId: "synthetic-history-mission", turn: {
        roomId: "synthetic-history-room", paneId: "synthetic-history-pane",
        prompt: "Synthetic test only", traceId: "synthetic-history-trace",
        agentRunId: "synthetic-history-run"
      } }]
    });
    await ctx.waitFor(() => lifecycle.length === 2, "the historical turn to settle");
    expect(lifecycle).toEqual(["started", "COMPLETED"]);
    await ctx.record(handle, "authentic-20260820-supervisor");
  }
};
