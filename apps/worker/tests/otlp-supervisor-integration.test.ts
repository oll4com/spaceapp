// The production Room Agent supervisor in a real Temporal test server, driven
// through the production API coordinator (signalWithStart) and API trace hooks,
// with the production worker tracing composition. Only activities are stubbed.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { Context } from "@temporalio/activity";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, DefaultLogger, Runtime, Worker } from "@temporalio/worker";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRoomAgentSupervisorWorkflowId, type RoomAgentSupervisorQueueItem } from "@space/contracts";
import { createOtlpSpanExporter } from "@space/runtime";
import { createHttpObservability } from "../../api/src/observability.js";
import { TemporalRoomAgentWorkflowCoordinator } from "../../api/src/room-agent.js";
import { requestTraceContexts, traceContextForRawRequest } from "../../api/src/trace-context.js";
import { deterministicWorkflowSpanId } from "../src/temporal-trace-context.js";
import { createWorkerTracing } from "../src/worker-tracing.js";

const workflowInterceptorModule = fileURLToPath(new URL("../src/workflow-tracing.ts", import.meta.url));
const workflowsPath = fileURLToPath(new URL("../src/workflows.ts", import.meta.url));
const roomId = "room:otlp-supervisor";

interface OtlpSpan {
  traceId: string; spanId: string; parentSpanId?: string; name: string;
  attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string } }>;
}
const attrs = (span: OtlpSpan) => Object.fromEntries(span.attributes.map(({ key, value }) => [key, value.stringValue ?? value.intValue ?? ""]));

async function startCollector() {
  const bodies: Array<{ resourceSpans: Array<{ scopeSpans: Array<{ spans: OtlpSpan[] }> }> }> = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    bodies.push(JSON.parse(body));
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    spans: () => bodies.flatMap((b) => b.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans))),
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })
  };
}

function queueItem(missionId: string, traceId: string): RoomAgentSupervisorQueueItem {
  const key = missionId.split(":")[1];
  return {
    missionId,
    turn: {
      roomId, paneId: "pane:otlp-supervisor-agent", prompt: "synthetic prompt", artifactIds: [],
      agentSessionId: "agent_session:otlp", agentRunId: `agent_run:${key}`,
      roomAgentMissionId: missionId, roomAgentOperatorRequest: "synthetic request",
      agentUserMessageId: `agent_msg:u-${key}`, agentAssistantMessageId: `agent_msg:a-${key}`,
      permissionMode: "full_access", collaborationMode: "default", traceId
    }
  };
}

describe("OTLP through the production Room Agent supervisor", () => {
  let env: TestWorkflowEnvironment;
  beforeAll(async () => {
    Runtime.install({ logger: new DefaultLogger("ERROR") });
    env = await TestWorkflowEnvironment.createTimeSkipping();
  }, 120_000);
  afterAll(async () => { await env?.teardown(); });

  it("parents each mission to its own API span and keeps run-level polling out of the first request's trace", async () => {
    const collector = await startCollector();
    const apiSpans = createOtlpSpanExporter({ endpoint: collector.endpoint, serviceName: "space-api", flushIntervalMs: 60_000 });
    const spans = createOtlpSpanExporter({ endpoint: collector.endpoint, serviceName: "space-worker", flushIntervalMs: 60_000 });
    const taskQueue = `otlp-supervisor-${randomUUID()}`;
    const coordinator = new TemporalRoomAgentWorkflowCoordinator({
      address: "unused", namespace: env.namespace, taskQueue,
      clientFactory: async () => ({ client: env.client, close: async () => undefined })
    });
    const observability = createHttpObservability({ serviceName: "space-api", spanExporter: apiSpans });
    const app = Fastify({ genReqId: () => `req:${randomUUID()}` });
    // Same calls as apps/api/src/app.ts onRequest/onResponse.
    app.addHook("onRequest", async (request) => {
      observability.onRequest(request);
      requestTraceContexts.remember(request.id, traceContextForRawRequest(request.raw));
    });
    app.addHook("onResponse", async (request, reply) => observability.onResponse(request, reply));
    app.post<{ Params: { missionId: string } }>("/api/rooms/otlp/agent/:missionId", async (request) => {
      await coordinator.enqueue(queueItem(request.params.missionId, request.id));
      return { ok: true };
    });
    let polls = 0;
    const workflowBundle = await bundleWorkflowCode({ workflowsPath, workflowInterceptorModules: [workflowInterceptorModule], logger: new DefaultLogger("ERROR") });
    const tracing = createWorkerTracing(spans, { workflowInterceptorModule });
    const worker = await Worker.create({
      connection: env.nativeConnection, namespace: env.namespace, taskQueue, workflowBundle,
      ...tracing, interceptors: { ...tracing.interceptors, workflowModules: [] },
      activities: {
        checkRoomAgentSupervisorTurn: async () => "READY" as const,
        discardRoomAgentSupervisorTurn: async () => undefined,
        finishRoomAgentSupervisorTurn: async () => undefined,
        prepareRoomAgentBackgroundContinuation: async () => (++polls >= 3 ? { state: "DONE" } : { state: "WAITING" }),
        runCodexAppServerTurn: async (input: RoomAgentSupervisorQueueItem["turn"]) => ({
          workflowId: Context.current().info.workflowExecution.workflowId, roomId, paneId: input.paneId, traceId: input.traceId,
          status: "COMPLETED", message: "synthetic",
          // Mission C leaves background pane work, so the supervisor polls for it.
          roomAgentOutcome: input.roomAgentMissionId === "room_agent_mission:c"
            ? { status: "VERIFIED", statusReason: "ok", pendingActionIds: ["room_action:otlp-one"] }
            : { status: "VERIFIED", statusReason: "ok" }
        })
      }
    });
    const traceA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";
    const traceC = "ccccccccccccccccccccccccccccccc3";
    const caller = "1111111111111111";
    const flushed = async () => { await Promise.all([apiSpans.flush(), spans.flush()]); return collector.spans(); };
    const missionSpan = (all: OtlpSpan[], missionId: string) =>
      all.find((s) => s.name === "workflow roomAgentSupervisorWorkflow mission" && attrs(s)["space.mission_id"] === missionId);
    try {
      await worker.runUntil(async () => {
        // Requests A and B share ONE W3C trace but have different API spans.
        await app.inject({ method: "POST", url: "/api/rooms/otlp/agent/room_agent_mission:a", headers: { traceparent: `00-${traceA}-${caller}-01` } });
        await expect.poll(async () => missionSpan(await flushed(), "room_agent_mission:a"), { timeout: 30_000 }).toBeDefined();
        await app.inject({ method: "POST", url: "/api/rooms/otlp/agent/room_agent_mission:b", headers: { traceparent: `00-${traceA}-${caller}-01` } });
        await expect.poll(async () => missionSpan(await flushed(), "room_agent_mission:b"), { timeout: 30_000 }).toBeDefined();
        await app.inject({ method: "POST", url: "/api/rooms/otlp/agent/room_agent_mission:c", headers: { traceparent: `00-${traceC}-${caller}-01` } });
        await expect.poll(async () => (await flushed()).filter((s) => attrs(s)["space.activity_type"] === "prepareRoomAgentBackgroundContinuation").length,
          { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
      });
      const all = await flushed();
      const api = all.filter((s) => s.name === "POST /api/rooms/otlp/agent/:missionId");
      const apiFor = (missionId: string) => api.find((s) => attrs(s)["space.request_id"] === attrs(missionSpan(all, missionId)!)["space.trace_id"])!;
      const [missionA, missionB, missionC] = ["a", "b", "c"].map((m) => missionSpan(all, `room_agent_mission:${m}`)!);
      expect(apiFor("room_agent_mission:a").traceId).toBe(traceA);
      expect(apiFor("room_agent_mission:b").traceId).toBe(traceA);
      expect(apiFor("room_agent_mission:a").spanId).not.toBe(apiFor("room_agent_mission:b").spanId);
      expect(missionA).toMatchObject({ traceId: traceA, parentSpanId: apiFor("room_agent_mission:a").spanId });
      expect(missionB).toMatchObject({ traceId: traceA, parentSpanId: apiFor("room_agent_mission:b").spanId });
      expect(missionC).toMatchObject({ traceId: traceC, parentSpanId: apiFor("room_agent_mission:c").spanId });
      const childB = all.find((s) => s.name === "workflow codexAppServerTurnWorkflow" && s.parentSpanId === missionB!.spanId);
      expect(all.find((s) => attrs(s)["space.activity_type"] === "runCodexAppServerTurn" && s.parentSpanId === childB?.spanId)).toMatchObject({ traceId: traceA });

      // Polls for mission C belong to the supervisor's own trace, under its run span.
      const pollSpans = all.filter((s) => attrs(s)["space.activity_type"] === "prepareRoomAgentBackgroundContinuation");
      for (const poll of pollSpans) {
        expect(attrs(poll)["space.mission_id"]).toBe("room_agent_mission:c");
        expect([traceA, traceC]).not.toContain(poll.traceId);
        expect(poll.parentSpanId).toBe(deterministicWorkflowSpanId(attrs(poll)["space.temporal_run_id"]!));
      }
    } finally {
      await app.close();
      observability.close();
      await Promise.all([apiSpans.close(), spans.close()]);
      await collector.close();
      await env.client.workflow.getHandle(buildRoomAgentSupervisorWorkflowId(roomId)).terminate("test cleanup").catch(() => undefined);
    }
  }, 120_000);
});
