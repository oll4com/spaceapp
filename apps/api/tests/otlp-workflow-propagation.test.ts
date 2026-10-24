import Fastify from "fastify";
import { expect, it } from "vitest";
import { formatTraceparent } from "@space/contracts";
import type { ServerSpan, SpanExporter } from "@space/runtime";
import { createHttpObservability } from "../src/observability.js";
import { requestTraceContexts, traceContextForRawRequest, withTurnTraceparent } from "../src/trace-context.js";
import { scheduleMemoryConsolidation } from "../src/memory-consolidation-coordinator.js";
import { scheduleMemoryMutation } from "../src/memory-mutation-coordinator.js";

it("parents turn and direct memory workflow starts to the actual exported HTTP SERVER span", async () => {
  const recorded: ServerSpan[] = [];
  const exporter: SpanExporter = {
    record: span => { recorded.push(span); }, flush: async () => {}, close: async () => {},
    stats: () => ({ exported: recorded.length, dropped: 0, failed: 0 })
  };
  const observability = createHttpObservability({ serviceName: "space-api", spanExporter: exporter });
  const app = Fastify({ genReqId: () => "req:otlp-propagation-proof" });
  const memos: Array<Record<string, string>> = [];
  let turnTraceparent: string | undefined;
  app.addHook("onRequest", async request => {
    observability.onRequest(request);
    requestTraceContexts.remember(request.id, traceContextForRawRequest(request.raw));
  });
  app.addHook("onResponse", async (request, reply) => observability.onResponse(request, reply));
  app.post("/run", async request => {
    turnTraceparent = withTurnTraceparent({ traceId: request.id }).traceparent;
    await scheduleMemoryConsolidation({ runId: "memory_consolidation:trace-test", traceId: request.id }, "workflow:trace-test", async (_type, options) => {
      memos.push(options.memo); return { workflowId: options.workflowId };
    });
    await scheduleMemoryMutation({ changeSetId: "memory_change:trace-test", traceId: request.id }, async (_type, options) => {
      memos.push(options.memo); return { workflowId: options.workflowId };
    });
    return { ok: true };
  });
  try {
    const response = await app.inject({ method: "POST", url: "/run" });
    expect(response.statusCode, response.body).toBe(200);
    expect(recorded).toHaveLength(1);
    const server = recorded[0]!;
    const expected = formatTraceparent(server.traceId, server.spanId);
    expect(turnTraceparent).toBe(expected);
    expect(memos).toHaveLength(2);
    for (const memo of memos) expect(memo).toMatchObject({ traceparent: expected, w3cTraceId: server.traceId });
  } finally { await app.close(); observability.close(); }
});
