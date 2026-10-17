import { describe, expect, it } from "vitest";
import { parentFromArgs, parseParent, readTraceHeader, writeTraceHeader, safeTraceAttributes, stableSpanId } from "../src/tracing-protocol.js";
const parent = { traceId: "a".repeat(32), spanId: "b".repeat(16) };
describe("trace wire protocol", () => {
  it("round trips bounded context and drops untrusted extra fields", () => {
    const headers = writeTraceHeader({}, { ...parent, links: [parent], prompt: "SECRET" } as typeof parent);
    expect(readTraceHeader(headers)).toEqual({ ...parent, links: [parent] });
    expect(JSON.stringify(headers)).not.toContain("SECRET");
    expect(readTraceHeader({ "space-otlp-v1": { data: new Uint8Array(2049) } })).toBeNull();
    expect(readTraceHeader({ "space-otlp-v1": { data: new TextEncoder().encode("invalid") } })).toBeNull();
  });
  it("rejects zero ids, invalid lengths, and never searches prompt contents", () => {
    expect(parseParent(`00-${"0".repeat(32)}-${parent.spanId}-01`)).toBeNull();
    expect(parseParent("invalid")).toBeNull();
    expect(parentFromArgs([{ prompt: { traceparent: `00-${parent.traceId}-${parent.spanId}-01` } }])).toBeNull();
    expect(parentFromArgs([{ turn: { traceparent: `00-${parent.traceId}-${parent.spanId}-01` } }])).toMatchObject(parent);
  });
  it("allows only bounded identifiers, outcome codes and numeric measurements", () => {
    expect(safeTraceAttributes({ "space.workflow_id": "wf:1", "space.attempt": 2,
      "space.category": "TIMEOUT", prompt: "SECRET", "space.outcome": "/private/path", "space.duration_ms": NaN }))
      .toEqual({ "space.workflow_id": "wf:1", "space.attempt": 2, "space.category": "TIMEOUT" });
    expect(stableSpanId("run:a")).toMatch(/^[a-f0-9]{16}$/);
    expect(stableSpanId("run:a")).toBe(stableSpanId("run:a"));
    expect(stableSpanId("run:a")).not.toBe(stableSpanId("run:b"));
  });
});
