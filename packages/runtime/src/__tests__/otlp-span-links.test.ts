import { describe, expect, it } from "vitest";
import { SPAN_ATTRIBUTE_ALLOWLIST, allowlistSpanAttributes, createOtlpSpanExporter, otlpTraceRequest, type ServerSpan } from "../index.js";

const base: ServerSpan = {
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "00f067aa0ba902b7",
  parentSpanId: null,
  name: "workflow probe",
  startTimeUnixNano: 1n,
  endTimeUnixNano: 2n,
  attributes: {},
  error: false
};

const encoded = (span: ServerSpan) => otlpTraceRequest([span], "space-worker").resourceSpans[0]!.scopeSpans[0]!.spans[0]! as Record<string, unknown>;

describe("OTLP span kind and links", () => {
  it("keeps the API encoding when kind and links are absent", () => {
    const span = encoded(base);
    expect(span.kind).toBe(2);
    expect(span).not.toHaveProperty("links");
    expect(encoded({ ...base, links: [] })).not.toHaveProperty("links");
  });

  it("encodes kind and valid links with allowlisted attributes, dropping invalid ids", () => {
    const span = encoded({
      ...base,
      kind: 1,
      links: [
        { traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331", attributes: { "space.link.kind": "continue_as_new", prompt: "secret" } },
        { traceId: "0".repeat(32), spanId: "b7ad6b7169203331" },
        { traceId: base.traceId, spanId: "0".repeat(16) },
        { traceId: "not-a-trace", spanId: "b7ad6b7169203331" },
        { traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "short" }
      ]
    });
    expect(span.kind).toBe(1);
    expect(span.links).toEqual([{
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      attributes: [{ key: "space.link.kind", value: { stringValue: "continue_as_new" } }]
    }]);
  });
});

describe("flush", () => {
  it("still exports after a flush found the queue empty", async () => {
    const posts: string[] = [];
    const exporter = createOtlpSpanExporter({
      endpoint: "http://127.0.0.1:4318",
      serviceName: "space-worker",
      flushIntervalMs: 60_000,
      fetch: async (_url, init) => { posts.push(init.body); return { ok: true }; }
    });
    await exporter.flush();
    exporter.record(base);
    await exporter.flush();
    expect(posts).toHaveLength(1);
    expect(exporter.stats()).toEqual({ exported: 1, dropped: 0, failed: 0 });
    await exporter.close();
  });
});

describe("allowlistSpanAttributes", () => {
  it("keeps allowlisted identifier-shaped values", () => {
    expect(allowlistSpanAttributes({
      "temporal.workflow.id": "workflow:codex-app-server:room_1:pane_1:req:abc",
      "temporal.activity.attempt": 2,
      "error.code": "CODEX_APP_SERVER_TURN_TIMEOUT",
      "space.error.category": "TIMEOUT",
      "space.duration_ms": 12
    })).toEqual({
      "temporal.workflow.id": "workflow:codex-app-server:room_1:pane_1:req:abc",
      "temporal.activity.attempt": 2,
      "error.code": "CODEX_APP_SERVER_TURN_TIMEOUT",
      "space.error.category": "TIMEOUT",
      "space.duration_ms": 12
    });
  });

  it("drops unknown keys, free text, paths, URLs, long strings, non-finite numbers and unsafe codes", () => {
    expect(allowlistSpanAttributes({
      prompt: "write me a poem",
      "error.message": "boom",
      "space.room_id": "/etc/passwd",
      "space.pane_id": "https://example.test/x",
      "space.mission_id": "has spaces",
      "space.trace_id": "x".repeat(201),
      "space.duration_ms": Number.POSITIVE_INFINITY,
      "space.queue_ms": Number.NaN,
      "error.code": "lower case message",
      "space.error.category": "MADE_UP",
      "temporal.activity.attempt": { nested: true },
      "space.outcome": null
    })).toEqual({});
  });

  it("only allows the documented keys", () => {
    expect([...SPAN_ATTRIBUTE_ALLOWLIST].sort()).toEqual([
      "space.duration_ms", "space.error.category", "error.code", "space.queue_ms",
      "space.link.kind", "space.mission_id", "space.outcome",
      "space.pane_id", "space.room_id", "space.trace_id",
      "temporal.activity.attempt", "temporal.activity.id", "temporal.activity.type",
      "temporal.workflow.run_id", "temporal.workflow.id", "temporal.workflow.type"
    ].sort());
  });
});

it("aborts a hanging collector and counts failed spans", async () => {
  let signal: AbortSignal | undefined;
  const exporter = createOtlpSpanExporter({
    endpoint: "http://127.0.0.1:4318", serviceName: "test", timeoutMs: 10,
    fetch: (_url, init) => new Promise((_resolve, reject) => {
      signal = init.signal;
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    })
  });
  exporter.record(base);
  await exporter.close();
  expect(signal?.aborted).toBe(true);
  expect(exporter.stats()).toEqual({ exported: 0, dropped: 0, failed: 1 });
});
