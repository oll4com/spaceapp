import { describe, expect, it } from "vitest";
import { createOtlpSpanExporter, otlpTraceRequest, type ServerSpan } from "../src/otlp-span-exporter.js";

const traceId = "0123456789abcdef0123456789abcdef";
const spanId = "0123456789abcdef";
const link = { traceId, spanId: "fedcba9876543210", attributes: { "space.link_type": "continue_as_new", "space.attempt": 1 } };

const span = (over: Partial<ServerSpan> = {}): ServerSpan => ({
  traceId,
  spanId,
  parentSpanId: null,
  name: "activity runCodexAppServerTurn",
  startTimeUnixNano: 1_000_000_000n,
  endTimeUnixNano: 2_000_000_000n,
  attributes: { "space.activity_type": "runCodexAppServerTurn" },
  error: false,
  kind: 1,
  ...over
});

describe("OTLP span links", () => {
  it("maps span links with attributes into the OTLP JSON request", () => {
    const request = otlpTraceRequest([span({ links: [link] })], "space-worker");
    const spans = request.resourceSpans[0].scopeSpans[0].spans;
    expect(spans).toHaveLength(1);
    expect(spans[0].links).toEqual([{
      traceId,
      spanId: link.spanId,
      attributes: [
        { key: "space.link_type", value: { stringValue: "continue_as_new" } },
        { key: "space.attempt", value: { intValue: "1" } }
      ]
    }]);
  });

  it("omits the links field when a span has no links or an empty list", () => {
    const bare = otlpTraceRequest([span()], "space-worker");
    expect(bare.resourceSpans[0].scopeSpans[0].spans[0]).not.toHaveProperty("links");
    const empty = otlpTraceRequest([span({ links: [] })], "space-worker");
    expect(empty.resourceSpans[0].scopeSpans[0].spans[0]).not.toHaveProperty("links");
  });

  it("exports links without attributes and multiple links from other traces", () => {
    const otherTrace = "ffffffffffffffffffffffffffffffff";
    const request = otlpTraceRequest([
      span({ links: [{ traceId: otherTrace, spanId: "aaaaaaaaaaaaaaaa" }, { traceId, spanId: "bbbbbbbbbbbbbbbb" } ] })
    ], "space-worker");
    const links = request.resourceSpans[0].scopeSpans[0].spans[0].links;
    expect(links).toHaveLength(2);
    expect(links[0]).toEqual({ traceId: otherTrace, spanId: "aaaaaaaaaaaaaaaa" });
    expect(links[1]).toEqual({ traceId, spanId: "bbbbbbbbbbbbbbbb" });
  });

  it("exports recorded links end to end through the exporter queue", async () => {
    const bodies: string[] = [];
    const exporter = createOtlpSpanExporter({
      endpoint: "http://127.0.0.1:4318",
      serviceName: "space-worker",
      fetch: async (_url, init) => {
        bodies.push(init.body);
        return { ok: true };
      }
    });
    exporter.record(span({ links: [link] }));
    await exporter.flush();
    await exporter.close();
    expect(bodies).toHaveLength(1);
    const parsed = JSON.parse(bodies[0]);
    const exported = parsed.resourceSpans[0].scopeSpans[0].spans[0];
    expect(exported.links[0].traceId).toBe(traceId);
    expect(exported.links[0].spanId).toBe("fedcba9876543210");
  });
});
