import { describe, expect, it, vi } from "vitest";
import { spaceAgentRoomActionBridgeRequestSchema } from "@space/contracts";
import { executeBackgroundRoomAction } from "../src/room-action-bridge.js";

const bridge = spaceAgentRoomActionBridgeRequestSchema.parse({
  roomId: "room:proof", missionId: "mission:proof", agentPaneId: "pane:agent",
  agentSessionId: "session:agent", requestId: "request:stable", actionIndex: "2",
  selectedToolIds: ["room:inspect"], actions: [{ toolId: "room:inspect", action: { type: "inspect" } }]
});
const config = { internalApiBaseUrl: "http://127.0.0.1:4910/", internalApiToken: "test-only" };

describe("Background transport", () => {
  it("preserves the exact foreground identity and idempotency key", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ id: "space-agent-room-action-bridge", results: [{
      request: bridge.actions[0], status: "EXECUTED", statusReason: "Verified", evidence: {}
    }] }));
    await executeBackgroundRoomAction(bridge, config, fetchImpl);
    const [url, options] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:4910/api/internal/agent/room-actions");
    expect(JSON.parse(options.body)).toEqual({ ...bridge, backgroundExecution: true });
  });
  it.each([
    ["Room Agent session session:agent was not found in room room:proof.", "agent session unavailable"],
    ["Room Agent pane pane:agent was not found in room room:proof.", "agent pane mismatch"],
    ["Internal API route is not available.", "internal API disabled"],
    ["sensitive upstream text", "request rejected"]
  ])("reports a safe diagnostic category: %s", async (message, category) => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ error: { message } }, { status: 404 }));
    await expect(executeBackgroundRoomAction(bridge, config, fetchImpl)).rejects.toThrow(`HTTP 404 (${category})`);
  });
});
