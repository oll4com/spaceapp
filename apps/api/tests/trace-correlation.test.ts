import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { parseTraceparent, type RoomAgentSupervisorQueueItem } from "@space/contracts";
import { createApp } from "../src/app.js";
import { getApiConfig } from "../src/config.js";
import { apiDomainMetrics } from "../src/api-metrics.js";
import { TemporalCodexAppServerTurnStarter } from "../src/turns.js";
import { TemporalRoomAgentWorkflowCoordinator } from "../src/room-agent.js";
import type { TemporalClientFactory } from "../src/temporal-client.js";
import {
  TraceContextRegistry,
  childTraceparent,
  createRequestTraceContext,
  requestTraceContexts,
  withTurnTraceparent,
  workflowCorrelationMemo
} from "../src/trace-context.js";

const inboundTraceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const inboundParent = "00f067aa0ba902b7";
const inbound = `00-${inboundTraceId}-${inboundParent}-01`;

describe("request trace context", () => {
  it("continues a valid inbound trace with a new span and generates one otherwise", () => {
    const continued = createRequestTraceContext(inbound);
    expect(continued).toMatchObject({ w3cTraceId: inboundTraceId, parentSpanId: inboundParent, inbound: true });
    expect(continued.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(continued.spanId).not.toBe(inboundParent);
    expect(parseTraceparent(continued.traceparent)).toEqual({ traceId: inboundTraceId, parentId: continued.spanId, flags: "01" });

    for (const header of [undefined, "garbage", `00-${"0".repeat(32)}-${inboundParent}-01`]) {
      const generated = createRequestTraceContext(header);
      expect(generated.inbound).toBe(false);
      expect(generated.parentSpanId).toBeNull();
      expect(generated.w3cTraceId).toMatch(/^[0-9a-f]{32}$/);
      expect(generated.w3cTraceId).not.toBe(inboundTraceId);
    }
    expect(parseTraceparent(childTraceparent(inbound))?.traceId).toBe(inboundTraceId);
    expect(childTraceparent("not a traceparent")).toBeNull();
  });

  it("keeps a bounded request-id registry and fills turn inputs from it", () => {
    const registry = new TraceContextRegistry(2);
    registry.remember("req:aaaaaaaaaaaa", createRequestTraceContext(inbound));
    registry.remember("req:bbbbbbbbbbbb", createRequestTraceContext(undefined));
    registry.remember("req:cccccccccccc", createRequestTraceContext(undefined));
    expect(registry.size).toBe(2);
    expect(registry.lookup("req:aaaaaaaaaaaa")).toBeNull();

    registry.remember("req:dddddddddddd", createRequestTraceContext(inbound));
    const filled = withTurnTraceparent({ traceId: "req:dddddddddddd" }, registry);
    expect(parseTraceparent(filled.traceparent)?.traceId).toBe(inboundTraceId);
    const kept = withTurnTraceparent({ traceId: "req:dddddddddddd", traceparent: inbound }, registry);
    expect(kept.traceparent).toBe(inbound);
    expect(withTurnTraceparent({ traceId: "req:unknown00000" }, registry)).toEqual({ traceId: "req:unknown00000" });
  });

  it("builds a Temporal memo from identifiers only", () => {
    expect(workflowCorrelationMemo({ traceId: "req:abcdefghijkl", traceparent: inbound, parentTraceId: "req:parent000000", missionId: "mission:1" }))
      .toEqual({
        spaceTraceId: "req:abcdefghijkl",
        traceparent: inbound,
        w3cTraceId: inboundTraceId,
        parentSpaceTraceId: "req:parent000000",
        missionId: "mission:1"
      });
    expect(workflowCorrelationMemo({ traceId: "please summarize my secret plan", traceparent: "Bearer sk-live-123" })).toEqual({});
  });
});

describe("HTTP requests", () => {
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  afterEach(async () => { await app?.close(); app = undefined; });

  it("binds the W3C trace id to the request logger and keeps the server-owned request id", async () => {
    app = await createApp({
      store: new InMemorySpaceStore(),
      config: getApiConfig({ SPACE_STORE_MODE: "memory" }),
      auth: { sessionSecret: "trace-context-fixture-secret-1234", devLogin: false, secureCookies: false }
    });
    const observed: Array<{ reqId: unknown; w3cTraceId: unknown; context: unknown }> = [];
    app.addHook("onResponse", async (request) => {
      const bindings = request.log.bindings();
      observed.push({ reqId: bindings.reqId, w3cTraceId: bindings.w3cTraceId, context: request.traceContext });
    });

    const continued = await app.inject({ url: "/healthz", headers: { traceparent: inbound } });
    const generated = await app.inject({ url: "/healthz" });
    const requestId = continued.headers["x-request-id"] as string;
    expect(requestId).toMatch(/^req:[\w-]{12}$/);
    expect(observed[0]).toMatchObject({ reqId: requestId, w3cTraceId: inboundTraceId });
    expect(requestTraceContexts.lookup(requestId)?.w3cTraceId).toBe(inboundTraceId);
    expect(observed[1]?.w3cTraceId).toMatch(/^[0-9a-f]{32}$/);
    expect(observed[1]?.w3cTraceId).not.toBe(inboundTraceId);
    expect(requestTraceContexts.lookup(generated.headers["x-request-id"] as string)?.inbound).toBe(false);
  }, 30_000);
});

describe("trace lookup projection", () => {
  it("returns ids, codes and statuses and never messages, payload metadata or audit metadata", async () => {
    const { projectTraceRecords } = await import("../src/trace-routes.js");
    const secret = "sk-live-projection-secret PRIVATE PROMPT /home/operator/private";
    const projected = projectTraceRecords("req:projection01", {
      events: [{
        id: "event:projection1", roomId: "room:projection", paneId: "pane:projection", turnId: null, workflowId: null,
        traceId: "req:projection01", type: "TURN_FAILED", message: secret, createdAt: "2026-10-11T10:00:00.000Z",
        payload: { status: "FAILED", reasonCode: "OPENCODE_TURN_TIMEOUT", runId: "agent_run:1", metadata: { stderr: secret } }
      }],
      auditEvents: [{
        id: "audit:projection1", actorUserId: "user:operator", traceId: "req:projection01", action: "turn.queue",
        targetType: "workflow", targetId: "workflow:projection", createdAt: "2026-10-11T10:00:00.000Z",
        metadata: { prompt: secret, parentTraceId: "req:parenttrace1" }
      }],
      workflows: []
    });
    expect(projected.causalError).toMatchObject({ code: "OPENCODE_TURN_TIMEOUT", category: "TIMEOUT", source: "event:TURN_FAILED" });
    expect(projected.events[0]).toMatchObject({ runId: "agent_run:1", status: "FAILED" });
    expect(projected.auditEvents[0]?.parentTraceId).toBe("req:parenttrace1");
    expect(JSON.stringify(projected)).not.toMatch(/sk-live|PRIVATE PROMPT|private|user:operator/);
  });

  it("names a failed agent run's code as the cause when no event carries one", async () => {
    // Workflow-level faults that never became an event used to be absent from the lookup (observability.md).
    const { projectTraceRecords } = await import("../src/trace-routes.js");
    const projected = projectTraceRecords("req:agentrun0001", {
      events: [{ id: "event:agentrun1", roomId: "room:agentrun", paneId: null, turnId: null, workflowId: "workflow:agentrun",
        traceId: "req:agentrun0001", type: "TURN_QUEUED", message: "queued", createdAt: "2026-10-16T09:00:00.000Z", payload: {} }],
      auditEvents: [],
      workflows: [],
      agentRuns: [
        { runId: "agent_run:ok", workflowId: "workflow:agentrun", status: "COMPLETED", errorCode: null, createdAt: "2026-10-16T09:00:01.000Z", completedAt: "2026-10-16T09:00:02.000Z" },
        { runId: "agent_run:failed", workflowId: "workflow:agentrun", status: "FAILED", errorCode: "OPENCODE_TURN_TIMEOUT", createdAt: "2026-10-16T09:00:03.000Z", completedAt: "2026-10-16T09:00:09.000Z" }
      ]
    } as Parameters<typeof projectTraceRecords>[1]);
    expect(projected.agentRuns.map((run) => run.runId)).toEqual(["agent_run:ok", "agent_run:failed"]);
    expect(projected.causalError).toMatchObject({ code: "OPENCODE_TURN_TIMEOUT", category: "TIMEOUT", source: "agent-run",
      eventId: "agent_run:failed", workflowId: "workflow:agentrun", at: "2026-10-16T09:00:09.000Z" });
  });

  it("returns the trace's Room Agent missions, task runs and continuations, and a failed mission's code as the cause", async () => {
    const { projectTraceRecords } = await import("../src/trace-routes.js");
    const projected = projectTraceRecords("req:mission00001", {
      events: [], auditEvents: [], workflows: [],
      agentRuns: [
        { runId: "agent_run:first", workflowId: "workflow:first", status: "COMPLETED", errorCode: null, createdAt: "2026-10-16T09:00:01.000Z", completedAt: null },
        { runId: "agent_run:bg-next", workflowId: "workflow:bg-next", status: "COMPLETED", errorCode: null, createdAt: "2026-10-16T09:01:00.000Z",
          completedAt: null, continuationOf: "agent_run:first" }
      ],
      roomAgentMissions: [{ missionId: "room_agent_mission:one", roomId: "room:mission01", status: "FAILED", errorCode: "ROOM_AGENT_TOKEN_LIMIT",
        queuedAt: "2026-10-16T09:00:00.000Z", completedAt: "2026-10-16T09:05:00.000Z" }],
      roomAgentTaskRuns: [{ runId: "room_agent_task_run:one", missionId: "room_agent_mission:one", roomId: "room:mission01", status: "COMPLETED",
        errorCode: "not a safe code", queuedAt: "2026-10-16T09:00:00.000Z", completedAt: null }]
    } as Parameters<typeof projectTraceRecords>[1]);
    expect(projected.agentRuns.map((run) => run.continuationOf)).toEqual([null, "agent_run:first"]);
    expect(projected.roomAgentMissions).toEqual([expect.objectContaining({ missionId: "room_agent_mission:one", errorCode: "ROOM_AGENT_TOKEN_LIMIT" })]);
    expect(projected.roomAgentTaskRuns[0]?.errorCode).toBeNull();
    expect(projected.causalError).toMatchObject({ code: "ROOM_AGENT_TOKEN_LIMIT", source: "room-agent-mission",
      eventId: "room_agent_mission:one", workflowId: null, at: "2026-10-16T09:05:00.000Z" });
  });

  it("returns the CLI sessions a trace allocated with their task and revision ids", async () => {
    const { projectTraceRecords } = await import("../src/trace-routes.js");
    const projected = projectTraceRecords("req:clisession01", {
      events: [], auditEvents: [], workflows: [],
      cliSessions: [{ sessionId: "cli_session:one", paneId: "pane:cli", roomId: "room:cli", runtimeId: "cli:codex",
        cliTaskId: "cli_task:one", cliTaskRevisionId: "not an identifier", launchMode: "RESUME", status: "RUNNING",
        startedAt: "2026-10-27T16:00:00.000Z", endedAt: null }]
    } as Parameters<typeof projectTraceRecords>[1]);
    expect(projected.cliSessions).toEqual([{ sessionId: "cli_session:one", paneId: "pane:cli", roomId: "room:cli", runtimeId: "cli:codex",
      cliTaskId: "cli_task:one", cliTaskRevisionId: null, launchMode: "RESUME", status: "RUNNING",
      startedAt: "2026-10-27T16:00:00.000Z", endedAt: null }]);
    expect(projectTraceRecords("req:clisession02", { events: [], auditEvents: [], workflows: [] }).cliSessions).toEqual([]);
  });
});

function metricValue(pattern: RegExp): number {
  const line = apiDomainMetrics.render().split("\n").find((entry) => pattern.test(entry));
  return line ? Number(line.split(" ").at(-1)) : 0;
}

describe("workflow starters", () => {
  const turn = {
    roomId: "room:trace0001",
    paneId: "pane:trace0001",
    prompt: "PRIVATE PROMPT do not export sk-live-trace-secret",
    traceId: "req:startertrace",
    artifactIds: []
  };

  it("passes the request id and traceparent in workflow input and memo", async () => {
    requestTraceContexts.remember(turn.traceId, createRequestTraceContext(inbound));
    const start = vi.fn(async (_type: string, options: { workflowId: string }) => ({ workflowId: options.workflowId, firstExecutionRunId: "run-1" }));
    const close = vi.fn(async () => undefined);
    const clientFactory = vi.fn(async () => ({ client: { workflow: { start } }, close })) as unknown as TemporalClientFactory;
    const before = metricValue(/workflow_type="codexAppServerTurnWorkflow",outcome="STARTED",category="NONE"/);

    const result = await new TemporalCodexAppServerTurnStarter({ address: "unused", namespace: "default", taskQueue: "proof", clientFactory })
      .start(turn);

    expect(result).toMatchObject({ traceId: turn.traceId, runId: "run-1", status: "QUEUED" });
    const [workflowType, options] = start.mock.calls[0] as unknown as [string, { args: Array<{ traceId: string; traceparent: string }>; memo: Record<string, string>; workflowId: string }];
    expect(workflowType).toBe("codexAppServerTurnWorkflow");
    expect(options.workflowId).toContain(turn.traceId);
    expect(options.args[0]?.traceId).toBe(turn.traceId);
    expect(parseTraceparent(options.args[0]?.traceparent)?.traceId).toBe(inboundTraceId);
    expect(options.memo).toMatchObject({ spaceTraceId: turn.traceId, w3cTraceId: inboundTraceId });
    expect(JSON.stringify(options.memo)).not.toContain("PRIVATE PROMPT");
    expect(close).toHaveBeenCalledOnce();
    expect(metricValue(/workflow_type="codexAppServerTurnWorkflow",outcome="STARTED",category="NONE"/)).toBe(before + 1);
  });

  it("counts a failed start by category without exporting the error message", async () => {
    const error = Object.assign(new Error("14 UNAVAILABLE: connect ECONNREFUSED 10.0.0.9:7233 token=sk-live-start-secret"), { name: "ServiceError" });
    const clientFactory = vi.fn(async () => ({
      client: { workflow: { start: vi.fn(async () => { throw error; }) } },
      close: vi.fn(async () => undefined)
    })) as unknown as TemporalClientFactory;
    const pattern = /workflow_type="codexAppServerTurnWorkflow",outcome="FAILED",category="UPSTREAM_UNAVAILABLE"/;
    const before = metricValue(pattern);
    await expect(new TemporalCodexAppServerTurnStarter({ address: "unused", namespace: "default", taskQueue: "proof", clientFactory })
      .start({ ...turn, traceId: "req:failedstart1" })).rejects.toBe(error);
    expect(metricValue(pattern)).toBe(before + 1);
    expect(apiDomainMetrics.render()).not.toContain("sk-live-start-secret");
    expect(apiDomainMetrics.render()).not.toContain("10.0.0.9");
  });

  it("adds the traceparent to queued room-agent turns and links background actions to their origin", async () => {
    requestTraceContexts.remember("req:roomagent0001", createRequestTraceContext(inbound));
    const signalWithStart = vi.fn(async () => ({ signaledRunId: "run-2" }));
    const start = vi.fn(async () => ({}));
    const clientFactory = vi.fn(async () => ({ client: { workflow: { signalWithStart, start } }, close: vi.fn(async () => undefined) })) as unknown as TemporalClientFactory;
    const coordinator = new TemporalRoomAgentWorkflowCoordinator({ address: "unused", namespace: "default", taskQueue: "proof", clientFactory });
    const item: RoomAgentSupervisorQueueItem = {
      missionId: "room_agent_mission:trace",
      turn: { ...turn, traceId: "req:roomagent0001", permissionMode: null, collaborationMode: "default" }
    };

    await coordinator.enqueue(item);
    const signalOptions = (signalWithStart.mock.calls[0] as unknown as [string, { signalArgs: RoomAgentSupervisorQueueItem[] }])[1];
    expect(parseTraceparent(signalOptions.signalArgs[0]?.turn.traceparent)?.traceId).toBe(inboundTraceId);

    requestTraceContexts.remember("req:internal0001", createRequestTraceContext(inbound));
    await coordinator.enqueueAction("room_agent_action:1", {
      roomId: turn.roomId, missionId: "room_agent_mission:trace", agentPaneId: turn.paneId, agentSessionId: "agent_session:1",
      requestId: "req:roomagent0001", selectedToolIds: [], actions: []
    } as never, "req:internal0001");
    const actionOptions = (start.mock.calls[0] as unknown as [string, { memo: Record<string, string> }])[1];
    expect(actionOptions.memo).toMatchObject({
      spaceTraceId: "req:internal0001",
      parentSpaceTraceId: "req:roomagent0001",
      missionId: "room_agent_mission:trace",
      w3cTraceId: inboundTraceId
    });
  });
});
