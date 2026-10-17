import { describe, expect, it } from "vitest";
import {
  backgroundContinuationFromArgs,
  sanitizeSpanAttributes,
  SPAN_ATTRIBUTE_ALLOWLIST,
  spanIdFromRunId,
  TRACEPARENT_HEADER,
  traceIdFromRunId,
  traceparentFromArgs,
  traceparentFromHeaders,
  traceparentFromMemo,
  traceparentHeaderPayload
} from "../src/otlp-span-context.js";

describe("OTLP span context", () => {
  describe("spanIdFromRunId", () => {
    it("derives a deterministic 16-hex span id from a Temporal run id", () => {
      const runId = "3052d9a6-d70b-419b-a010-ca81414e0f01";
      const first = spanIdFromRunId(runId);
      const second = spanIdFromRunId(runId);
      expect(first).toBe(second);
      expect(first).toMatch(/^[0-9a-f]{16}$/);
      expect(first).not.toBe("0000000000000000");
    });

    it("changes when the run id changes", () => {
      const a = spanIdFromRunId("11111111-1111-1111-1111-111111111111");
      const b = spanIdFromRunId("22222222-2222-2222-2222-222222222222");
      expect(a).not.toBe(b);
    });
  });

  describe("traceIdFromRunId", () => {
    it("derives a deterministic 32-hex trace id for runs without an inbound traceparent", () => {
      const runId = "3052d9a6-d70b-419b-a010-ca81414e0f01";
      const first = traceIdFromRunId(runId);
      const second = traceIdFromRunId(runId);
      expect(first).toBe(second);
      expect(first).toMatch(/^[0-9a-f]{32}$/);
      expect(first).not.toBe("00000000000000000000000000000000");
    });
  });

  describe("sanitizeSpanAttributes", () => {
    it("retains allowlisted identifiers and numbers, dropping unknown or sensitive fields", () => {
      const input = {
        "space.workflow_id": "wf-1",
        "space.run_id": "run-1",
        "space.attempt": 2,
        "space.outcome": "COMPLETED",
        "space.duration_ms": 150.5,
        prompt: "secret user prompt that must never be exported",
        user_message: "hello agent",
        url: "https://example.com/secret",
        path: "/private/data.json",
        "space.unknown_key": "drop me"
      };
      const sanitized = sanitizeSpanAttributes(input);
      expect(Object.keys(sanitized).sort()).toEqual([
        "space.attempt",
        "space.duration_ms",
        "space.outcome",
        "space.run_id",
        "space.workflow_id"
      ]);
      expect(sanitized["space.attempt"]).toBe(2);
      expect(sanitized["space.duration_ms"]).toBe(150.5);
      expect(JSON.stringify(sanitized)).not.toMatch(/secret|hello|example|private/);
    });

    it("drops non-finite numbers and empty strings", () => {
      const input = {
        "space.duration_ms": Number.NaN,
        "space.queue_ms": Number.POSITIVE_INFINITY,
        "space.room_id": ""
      };
      expect(sanitizeSpanAttributes(input)).toEqual({});
    });

    it("drops string values for numeric measurement keys", () => {
      const input = {
        "space.attempt": "1",
        "space.duration_ms": "100"
      };
      expect(sanitizeSpanAttributes(input as Record<string, unknown>)).toEqual({});
    });

    it("truncates string attributes that exceed 256 characters", () => {
      const longId = "x".repeat(300);
      const sanitized = sanitizeSpanAttributes({ "space.action_id": longId });
      expect(sanitized["space.action_id"]).toHaveLength(256);
    });

    it("contains only expected keys in the SPAN_ATTRIBUTE_ALLOWLIST", () => {
      expect(SPAN_ATTRIBUTE_ALLOWLIST.has("space.workflow_type")).toBe(true);
      expect(SPAN_ATTRIBUTE_ALLOWLIST.has("space.activity_type")).toBe(true);
      expect(SPAN_ATTRIBUTE_ALLOWLIST.has("prompt")).toBe(false);
      expect(SPAN_ATTRIBUTE_ALLOWLIST.has("content")).toBe(false);
    });
  });

  describe("Temporal header encoding and decoding", () => {
    it("round-trips a traceparent string through binary Temporal header encoding", () => {
      const original = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
      const payload = traceparentHeaderPayload(original);
      const headers = { [TRACEPARENT_HEADER]: payload };
      const decoded = traceparentFromHeaders(headers);
      expect(decoded).toBe(original);
    });

    it("returns null for missing or invalid header payload", () => {
      expect(traceparentFromHeaders(undefined)).toBeNull();
      expect(traceparentFromHeaders({})).toBeNull();
      expect(traceparentFromHeaders({ [TRACEPARENT_HEADER]: { data: undefined } })).toBeNull();
      expect(traceparentFromHeaders({ [TRACEPARENT_HEADER]: { metadata: { encoding: new TextEncoder().encode("json/protobuf") }, data: new Uint8Array([1]) } })).toBeNull();
    });
  });

  describe("traceparent extraction from workflow args and memo", () => {
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const parentId = "00f067aa0ba902b7";
    const traceparent = `00-${traceId}-${parentId}-01`;

    it("extracts traceparent from direct args, nested turn, item turn, or input", () => {
      expect(traceparentFromArgs([{ traceparent }])).toEqual(expect.objectContaining({ traceId, parentId }));
      expect(traceparentFromArgs([{ turn: { traceparent } }])).toEqual(expect.objectContaining({ traceId, parentId }));
      expect(traceparentFromArgs([{ item: { turn: { traceparent } } }])).toEqual(expect.objectContaining({ traceId, parentId }));
      expect(traceparentFromArgs([{ input: { traceparent } }])).toEqual(expect.objectContaining({ traceId, parentId }));
      expect(traceparentFromArgs([])).toBeNull();
      expect(traceparentFromArgs([{ other: 123 }])).toBeNull();
    });

    it("extracts traceparent from workflow memo", () => {
      expect(traceparentFromMemo({ traceparent })).toEqual(expect.objectContaining({ traceId, parentId }));
      expect(traceparentFromMemo(undefined)).toBeNull();
      expect(traceparentFromMemo({ other: "test" })).toBeNull();
    });
  });

  describe("backgroundContinuationFromArgs", () => {
    it("detects background continuation with sourceRunId and generation", () => {
      const continuation = backgroundContinuationFromArgs([
        {
          traceId: "trace:bg-12345",
          roomAgentContinuation: { sourceRunId: "agent_run:prev-123", generation: 2 }
        }
      ]);
      expect(continuation).toEqual({
        sourceRunId: "agent_run:prev-123",
        generation: 2,
        backgroundTraceId: "trace:bg-12345"
      });
    });

    it("returns null if no background continuation is present", () => {
      expect(backgroundContinuationFromArgs([{}])).toBeNull();
      expect(backgroundContinuationFromArgs([])).toBeNull();
    });
  });
});
