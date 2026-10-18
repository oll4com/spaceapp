import { describe, expect, it } from "vitest";
import {
  SPAN_CONTEXT_HEADER,
  decodeSpanContextHeader,
  encodeSpanContextHeader,
  fnv1a64Hex,
  workflowSpanCorrelation,
  workflowSpanId,
  workflowTraceId,
  WORKFLOW_SPAN_ATTRIBUTE_ALLOWLIST
} from "../src/workflow-span-context.js";

const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const secretPrompt = "PRIVATE PROMPT: deploy with token sk-live-worker-secret-123";

describe("deterministic workflow span ids", () => {
  it("hashes FNV-1a 64-bit into 16 lowercase hex digits, matching reference vectors", () => {
    expect(fnv1a64Hex("")).toBe("cbf29ce484222325");
    expect(fnv1a64Hex("a")).toBe("af63dc4c8601ec8c");
    expect(fnv1a64Hex("foobar")).toBe("85944171f73967e8");
  });

  it("derives stable 32-hex trace ids and 16-hex span ids per run", () => {
    const trace = workflowTraceId("workflow:codex-app-server:room:a", "run-uuid-1");
    expect(trace).toMatch(/^[0-9a-f]{32}$/);
    expect(workflowTraceId("workflow:codex-app-server:room:a", "run-uuid-1")).toBe(trace);
    expect(workflowTraceId("workflow:codex-app-server:room:a", "run-uuid-2")).not.toBe(trace);
    expect(workflowSpanId("workflow:codex-app-server:room:a", "run-uuid-1")).toMatch(/^[0-9a-f]{16}$/);
    expect(workflowSpanId("workflow:codex-app-server:room:a", "run-uuid-1")).toBe(workflowSpanId("workflow:codex-app-server:room:a", "run-uuid-1"));
    expect(workflowSpanId("workflow:codex-app-server:room:a", "run-uuid-2")).not.toBe(workflowSpanId("workflow:codex-app-server:room:a", "run-uuid-1"));
  });
});

describe("workflow span correlation", () => {
  it("reads allowlisted ids and trace context from workflow input, never prompts or free text", () => {
    const turn = {
      roomId: "room:alpha01",
      paneId: "pane:alpha01",
      prompt: secretPrompt,
      traceId: "req:abcdefghijkl",
      traceparent,
      missionId: "mission:1",
      roomAgentContinuation: { sourceRunId: "agent_run:1", generation: 3 }
    };
    const correlation = workflowSpanCorrelation([{ turn }]);
    expect(correlation.traceparent).toEqual({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736", parentId: "00f067aa0ba902b7", flags: "01" });
    expect(correlation.sourceTraceparent).toBeNull();
    expect(correlation.attributes).toEqual({
      "space.room_id": "room:alpha01",
      "space.pane_id": "pane:alpha01",
      "space.mission_id": "mission:1",
      "space.space_trace_id": "req:abcdefghijkl",
      "space.continuation_generation": 3
    });
    const serialized = JSON.stringify(correlation);
    expect(serialized).not.toContain("sk-live-worker-secret-123");
    expect(serialized).not.toContain("PRIVATE PROMPT");
  });

  it("keeps the source trace context of a background continuation and prefers a supervisor queue item mission", () => {
    const sourceTraceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
    const correlation = workflowSpanCorrelation([
      { item: { missionId: "mission:2", turn: { roomId: "room:beta02", traceparent, sourceTraceparent, roomAgentContinuation: { sourceRunId: "agent_run:2", generation: 2 } } } }
    ]);
    expect(correlation.traceparent?.parentId).toBe("00f067aa0ba902b7");
    expect(correlation.sourceTraceparent).toEqual({ traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", parentId: "bbbbbbbbbbbbbbbb", flags: "01" });
    expect(correlation.attributes["space.mission_id"]).toBe("mission:2");
    expect(correlation.attributes["space.room_id"]).toBe("room:beta02");
    expect(correlation.attributes["space.continuation_generation"]).toBe(2);
  });

  it("exports nothing from unknown shapes", () => {
    expect(workflowSpanCorrelation([{ prompt: secretPrompt }, "goal:positional", { roomId: "has spaces in it" }])).toEqual({
      traceparent: null,
      sourceTraceparent: null,
      spaceTraceId: null,
      attributes: {}
    });
  });
});

describe("span-context header payload", () => {
  it("names the Temporal header space.span-context", () => {
    expect(SPAN_CONTEXT_HEADER).toBe("space.span-context");
  });

  it("round-trips a parent header and a link header as json/plain payloads", () => {
    for (const kind of ["parent", "link"] as const) {
      const header = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", kind };
      const payload = encodeSpanContextHeader(header);
      expect(new TextDecoder().decode(payload.metadata.encoding)).toBe("json/plain");
      expect(decodeSpanContextHeader(payload)).toEqual(header);
    }
  });

  it("rejects malformed payloads instead of guessing", () => {
    expect(decodeSpanContextHeader(null)).toBeNull();
    expect(decodeSpanContextHeader({})).toBeNull();
    expect(decodeSpanContextHeader({ data: new TextEncoder().encode("not json") })).toBeNull();
    expect(decodeSpanContextHeader({ data: new TextEncoder().encode(JSON.stringify({ traceId: "x", spanId: "y", kind: "parent" })) })).toBeNull();
    expect(decodeSpanContextHeader({ data: new TextEncoder().encode(JSON.stringify({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", kind: "other" })) })).toBeNull();
    expect(decodeSpanContextHeader(encodeSpanContextHeader({ traceId: "00000000000000000000000000000000", spanId: "0000000000000000", kind: "parent" }))).toEqual({
      traceId: "00000000000000000000000000000000", spanId: "0000000000000000", kind: "parent"
    });
  });

  it("keeps the exported attribute allowlist closed", () => {
    expect(WORKFLOW_SPAN_ATTRIBUTE_ALLOWLIST).toEqual([
      "space.workflow_type",
      "space.activity_type",
      "space.outcome",
      "space.attempt",
      "space.reason_code",
      "space.category",
      "space.room_id",
      "space.pane_id",
      "space.mission_id",
      "space.goal_id",
      "space.dot_id",
      "space.space_trace_id",
      "space.continuation_generation"
    ]);
  });
});
