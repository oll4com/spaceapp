import { describe, expect, it } from "vitest";
import { dummyTurnInputSchema } from "@space/contracts";
import { getCodexAppServerTurnActivityConfig } from "../src/activities.js";
import { executeRoomActionBridge } from "../src/room-action-bridge.js";

describe("Room Agent visible action receipts", () => {
  it("shows each actual result, target and layout instead of a generic receipt", async () => {
    const actions = [
      { toolId: "room:layout", action: { type: "layout", paneLayoutColumns: 3, paneIds: ["pane:one", "pane:two"] } },
      { toolId: "room:close_pane", action: { type: "close_pane", paneId: "pane:old" } },
      { toolId: "room:open_types", action: { type: "open_types", kinds: ["TERMINAL"], runtimeIds: ["cli:codex", "cli:gemini"] } }
    ];
    const result = await executeRoomActionBridge({
      turnInput: dummyTurnInputSchema.parse({ roomId: "room:proof", paneId: "pane:agent", prompt: "Rearrange", traceId: "trace:action-summary",
        agentSessionId: "agent_session:proof", roomAgentMissionId: "mission:proof", selectedToolIds: actions.map(a => a.toolId) }),
      assistantContent: "```space-room-actions\n" + JSON.stringify({ version: 1, actions }) + "\n```",
      config: { ...getCodexAppServerTurnActivityConfig({}), internalApiToken: "test-only" },
      fetchImpl: async () => Response.json({ id: "space-agent-room-action-bridge", results: actions.map((request, i) => ({
        request, status: i === 1 ? "BLOCKED" : "EXECUTED", statusReason: "Recorded evidence",
        evidence: i === 1 ? { paneTitle: "Analysis" } : i === 2 ? { phase: "QUEUED", actionId: "action:open" } : {}
      })) })
    });
    expect(result.cleanedContent).toContain("Completed: Layout — 3 columns; reorder 2 panes");
    expect(result.cleanedContent).toContain("Blocked: Close pane “Analysis” (pane:old)");
    expect(result.cleanedContent).toContain("Queued: Open terminal panes: codex, gemini");
    expect(result.cleanedContent).not.toContain("Requested Space room actions");
    expect(result.cleanedContent).not.toContain("test-only");
  });
});
