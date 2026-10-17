import { describe, expect, it } from "vitest";
import {
  categorizeFailureCode,
  deterministicSpanId,
  deterministicTraceId,
  deterministicTraceparent,
  dummyTurnInputSchema,
  failureCategorySchema,
  fileSearchResponseSchema,
  formatTraceparent,
  isSafeErrorCode,
  parseTraceparent,
  traceIdFromTraceparent,
  workerReadinessSchema
} from "../src/index.js";

describe("failure categories", () => {
  it.each([
    ["TIMEOUT", "TIMEOUT"],
    ["CODEX_APP_SERVER_TURN_TIMEOUT", "TIMEOUT"],
    ["OPENCODE_TURN_TIMEOUT", "TIMEOUT"],
    ["TOOL_UNAVAILABLE", "TOOL_UNAVAILABLE"],
    ["CODEX_APP_SERVER_COMMAND_UNAVAILABLE", "TOOL_UNAVAILABLE"],
    ["PERMISSION_DENIED", "PERMISSION_DENIED"],
    ["PATH_UNSAFE", "PERMISSION_DENIED"],
    ["CSRF_TOKEN_INVALID", "PERMISSION_DENIED"],
    ["NOT_FOUND", "NOT_FOUND"],
    ["ROOM_NOT_FOUND", "NOT_FOUND"],
    ["VALIDATION_ERROR", "INVALID_INPUT"],
    ["RATE_LIMITED", "RATE_LIMITED"],
    ["CODEX_TURNS_DISABLED", "DISABLED"],
    ["CODEX_APP_SERVER_NOT_IMPLEMENTED", "DISABLED"],
    ["CODEX_APP_SERVER_KEY_FILE_INVALID", "INVALID_INPUT"],
    ["SPACE_EXECUTION_STATE_UNAVAILABLE", "STATE_UNAVAILABLE"],
    ["CODEX_APP_SERVER_PROTOCOL_ERROR", "PROTOCOL_ERROR"],
    ["CODEX_APP_SERVER_EXITED", "UPSTREAM_UNAVAILABLE"],
    ["CODEX_APP_SERVER_RPC_FAILED", "PROVIDER_ERROR"],
    ["PROVIDER_ROUTE_NOT_VERIFIED", "PROVIDER_ERROR"],
    ["ROOM_AGENT_STOPPED", "CANCELLED"],
    ["TURN_START_FAILED", "INTERNAL"],
    ["INTERNAL_ERROR", "INTERNAL"],
    ["SEARCH_FAILED", "INTERNAL"]
  ])("maps %s to %s", (code, category) => {
    expect(categorizeFailureCode(code)).toBe(category);
  });

  it("never turns untrusted text into a category or a label", () => {
    for (const value of [null, undefined, "", "lower_case", "HAS SPACE", "A".repeat(200), "TOKEN=sk-live-secret"]) {
      expect(categorizeFailureCode(value)).toBe("INTERNAL");
    }
    expect(isSafeErrorCode("TOKEN=sk-live-secret")).toBe(false);
    expect(isSafeErrorCode("TURN_START_FAILED")).toBe(true);
    expect(failureCategorySchema.options).toContain("TOOL_UNAVAILABLE");
  });
});

describe("W3C traceparent", () => {
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
  const spanId = "00f067aa0ba902b7";

  it("parses a valid version-00 header and formats it back", () => {
    const header = formatTraceparent(traceId, spanId);
    expect(parseTraceparent(header)).toEqual({ traceId, parentId: spanId, flags: "01" });
    expect(parseTraceparent(header.toUpperCase())?.traceId).toBe(traceId);
    expect(traceIdFromTraceparent(header)).toBe(traceId);
  });

  it("rejects invalid, all-zero, version ff and oversized headers", () => {
    for (const value of [
      undefined,
      42,
      "garbage",
      `00-${"0".repeat(32)}-${spanId}-01`,
      `00-${traceId}-${"0".repeat(16)}-01`,
      `ff-${traceId}-${spanId}-01`,
      `00-${traceId}-${spanId}-01-extra`,
      `00-${traceId}-${spanId}-01`.padEnd(600, "x")
    ]) {
      expect(parseTraceparent(value)).toBeNull();
    }
  });

  it("accepts a future version by its version-00 prefix", () => {
    expect(parseTraceparent(`01-${traceId}-${spanId}-01-future`)?.traceId).toBe(traceId);
  });
});

describe("additive observability contract fields", () => {
  const turn = { roomId: "room:alpha01", paneId: "pane:alpha01", prompt: "hello", traceId: "req:abcdefghijkl" };

  it("keeps the traceparent on a turn input and rejects an invalid one", () => {
    const traceparent = formatTraceparent("4bf92f3577b34da6a3ce929d0e0e4736", "00f067aa0ba902b7");
    expect(dummyTurnInputSchema.parse({ ...turn, traceparent }).traceparent).toBe(traceparent);
    expect(dummyTurnInputSchema.parse(turn).traceparent).toBeUndefined();
    expect(dummyTurnInputSchema.safeParse({ ...turn, traceparent: "not-a-trace" }).success).toBe(false);
  });

  it("accepts the old and the new file search response shapes", () => {
    expect(fileSearchResponseSchema.parse({ query: "a", results: [], totalCount: 0 }).code).toBeUndefined();
    expect(fileSearchResponseSchema.parse({ query: "a", results: [], totalCount: 0, code: "EMPTY_RESULT", truncated: false }).code)
      .toBe("EMPTY_RESULT");
  });

  it("keeps worker readiness backward compatible", () => {
    const readiness = {
      id: "space-worker", status: "RUNNING", statusReason: "ok", address: "127.0.0.1:7233", namespace: "default",
      taskQueue: "space", reachable: true, workflowPollerCount: 1, activityPollerCount: 1, pollerCount: 2,
      workflowBacklogCount: 0, activityBacklogCount: 0, pollerIdentities: [], lastPollerAccessAt: null,
      checkedAt: new Date().toISOString()
    };
    expect(workerReadinessSchema.parse(readiness).workflowBacklogAgeSeconds).toBeUndefined();
    expect(workerReadinessSchema.parse({ ...readiness, workflowBacklogAgeSeconds: 2.5 }).workflowBacklogAgeSeconds).toBe(2.5);
  });

  it("derives deterministic non-zero W3C traceId, spanId, and traceparent and accepts continuation source trace fields", () => {
    const spanId = deterministicSpanId("workflow:w1:r1");
    expect(spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(spanId).not.toBe("0000000000000000");
    expect(deterministicSpanId("workflow:w1:r1")).toBe(spanId);
    expect(deterministicSpanId("workflow:w1:r2")).not.toBe(spanId);

    const traceId = deterministicTraceId("trace:bg-cont0001");
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(traceId).not.toBe("0".repeat(32));
    expect(deterministicTraceId("trace:bg-cont0001")).toBe(traceId);

    const tp = deterministicTraceparent("trace:bg-cont0001", "parent:trace:bg-cont0001");
    expect(parseTraceparent(tp)).toEqual({
      traceId,
      parentId: deterministicSpanId("parent:trace:bg-cont0001"),
      flags: "01"
    });

    const parsed = dummyTurnInputSchema.parse({
      ...turn,
      roomAgentContinuation: {
        missionId: "mission:1",
        continuationId: "cont0001",
        sourceRunId: "agent_run:1",
        sourceTraceId: "req:abcdefghijkl",
        sourceTraceparent: tp,
        generation: 1
      }
    });
    expect(parsed.roomAgentContinuation?.sourceTraceId).toBe("req:abcdefghijkl");
    expect(parsed.roomAgentContinuation?.sourceTraceparent).toBe(tp);
  });
});

