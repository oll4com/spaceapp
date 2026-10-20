import { expect, it } from "vitest";
import { otlpTraceRequest } from "../src/otlp-span-exporter.js";

it("serializes only valid bounded OTLP link identities, excluding link payloads", () => {
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
  const valid = { traceId, spanId: "00f067aa0ba902b7", privateContent: "Never export this" };
  const span = { traceId, spanId: "1111111111111111", parentSpanId: null, name: "workflow test",
    startTimeUnixNano: 1n, endTimeUnixNano: 2n, attributes: {}, error: false,
    links: [{ traceId: "private", spanId: "path" }, { traceId: "0".repeat(32), spanId: "0".repeat(16) }, ...Array.from({ length: 10 }, () => valid)] };
  const output = otlpTraceRequest([span], "synthetic");
  const exported = output.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
  expect(exported.links).toHaveLength(8);
  expect(exported.links).toEqual(Array.from({ length: 8 }, () => ({ traceId, spanId: valid.spanId })));
  expect(JSON.stringify(output)).not.toMatch(/private|Never export|privateContent/);
});
