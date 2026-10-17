import { describe, expect, it, vi } from "vitest";
import { spaceAgentRoomActionBridgeRequestSchema } from "@space/contracts";
import { executeBackgroundRoomAction } from "../src/room-action-bridge.js";
import { observeActivityExecution } from "../src/activity-observability.js";
import type { ServerSpan } from "@space/runtime/otlp-span-exporter";

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
  it("parents the internal HTTP request to the actual background activity attempt", async () => {
    const spans: ServerSpan[] = [];
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ id: "space-agent-room-action-bridge", results: [{
      request: bridge.actions[0], status: "EXECUTED", statusReason: "Verified", evidence: {}
    }] }));
    await observeActivityExecution({ activityId: "3", activityType: "runRoomAgentBackgroundAction", attempt: 2,
      workflowType: "roomAgentActionWorkflow", workflowExecution: { workflowId: "workflow:action", runId: "run:action" },
      currentAttemptScheduledTimestampMs: Date.now() }, [bridge],
    () => executeBackgroundRoomAction(bridge, config, fetchImpl), {
      traceCarrier: { traceparent: "00-11111111111111111111111111111111-2222222222222222-01" },
      spanExporter: { record: span => { spans.push(span); }, flush: async () => {}, close: async () => {},
        stats: () => ({ exported: spans.length, dropped: 0, failed: 0 }) }
    });
    expect(spans).toHaveLength(1);
    const [, options] = fetchImpl.mock.calls[0]!;
    expect(options.headers.traceparent).toBe(`00-${spans[0]!.traceId}-${spans[0]!.spanId}-01`);
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
