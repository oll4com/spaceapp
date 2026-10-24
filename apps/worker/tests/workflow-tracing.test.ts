import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationFailure } from "@temporalio/workflow";
import { formatTraceparent } from "@space/contracts";
import type { SpanExporter } from "@space/runtime";
import type { WorkflowSpanRecord } from "../src/temporal-trace-context.js";

const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const laterTraceparent = "00-11111111111111111111111111111111-2222222222222222-01";
const privateText = "PRIVATE PROMPT /home/operator/project?token=secret";

const context = vi.hoisted(() => ({
  spans: [] as WorkflowSpanRecord[],
  info: {
    workflowId: "workflow:supervisor:room:one",
    workflowType: "supervisorWorkflow",
    runId: "8dfb046b-ec46-42bb-bc54-2df32b8b5c36",
    firstExecutionRunId: "8dfb046b-ec46-42bb-bc54-2df32b8b5c36",
    runStartTime: new Date(1_000),
    memo: {} as Record<string, unknown>,
    attempt: 1
  }
}));

vi.mock("@temporalio/workflow", async (importOriginal) => {
  const original = await importOriginal<typeof import("@temporalio/workflow")>();
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return {
    ...original,
    AsyncLocalStorage,
    workflowInfo: () => context.info,
    proxySinks: () => ({ spaceTracing: { record: (span: WorkflowSpanRecord) => context.spans.push(span) } })
  };
});

import {
  backgroundMissionTraceContext,
  decodeActivityTraceContext,
  decodeTraceLink,
  deterministicWorkflowSpanId,
  deterministicWorkflowTraceId,
  encodeTraceHeaders,
  sanitizeWorkflowTraceAttributes,
  traceparentFromArgs,
  workflowTraceAttributes
} from "../src/temporal-trace-context.js";
import { interceptors, withWorkflowTraceContext } from "../src/workflow-tracing.js";
import { createWorkerTracing } from "../src/worker-tracing.js";

const parsed = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", parentId: "00f067aa0ba902b7", flags: "01" };

beforeEach(() => {
  context.spans.length = 0;
  context.info.memo = {};
});

describe("pure Temporal trace context", () => {
  it("preserves unrelated headers and decodes binary and standard JSON traceparents", () => {
    const existing = { custom: { data: Uint8Array.of(3, 4) } };
    const headers = encodeTraceHeaders(existing, parsed, parsed);
    expect(headers.custom).toBe(existing.custom);
    expect(existing).toEqual({ custom: { data: Uint8Array.of(3, 4) } });
    expect(decodeActivityTraceContext(headers)).toEqual(parsed);
    expect(decodeTraceLink(headers)).toEqual(parsed);
    expect(decodeTraceLink(encodeTraceHeaders(headers, parsed))).toBeNull();
    expect(decodeActivityTraceContext({ traceparent: { data: new TextEncoder().encode(JSON.stringify(traceparent)) } })).toEqual(parsed);
  });

  it("ignores malformed, zero, oversized or non-ASCII payloads and can use a valid fallback", () => {
    for (const data of [Uint8Array.of(255), new Uint8Array(513), new TextEncoder().encode('"broken'), new TextEncoder().encode("00-00000000000000000000000000000000-00f067aa0ba902b7-01")]) {
      expect(decodeActivityTraceContext({ "space-traceparent": { data } })).toBeNull();
    }
    expect(decodeActivityTraceContext({
      "space-traceparent": { data: new Uint8Array(513) },
      traceparent: { data: new TextEncoder().encode(traceparent) }
    })).toEqual(parsed);
  });

  it("extracts only explicit context and allowlisted identifiers, never payload text", () => {
    const args = [{ item: { missionId: "mission:one", turn: { traceparent, traceId: "req:one", roomId: "room:one", prompt: privateText, paneId: privateText } } }];
    expect(traceparentFromArgs(args)).toEqual(parsed);
    expect(workflowTraceAttributes(args)).toEqual({ "space.mission_id": "mission:one", "space.trace_id": "req:one", "space.room_id": "room:one" });
    expect(traceparentFromArgs([{ content: { traceparent } }])).toBeNull();
    expect(sanitizeWorkflowTraceAttributes({
      "space.room_id": "room:one", "space.pane_id": privateText, "space.prompt": privateText, "space.url": "https://secret.example"
    })).toEqual({ "space.room_id": "room:one" });
  });

  it("derives replay-stable IDs without drawing from the application random stream", () => {
    const random = vi.spyOn(Math, "random").mockImplementation(() => { throw new Error("application RNG must stay untouched"); });
    try {
      const first = deterministicWorkflowSpanId(context.info.runId);
      expect(first).toMatch(/^[0-9a-f]{16}$/);
      expect(first).not.toBe("0000000000000000");
      expect(deterministicWorkflowSpanId(context.info.runId)).toBe(first);
      expect(deterministicWorkflowSpanId(`${context.info.runId}-next`)).not.toBe(first);
      expect(deterministicWorkflowTraceId(context.info.runId)).toMatch(/^[0-9a-f]{32}$/);
      expect(random).not.toHaveBeenCalled();
    } finally { random.mockRestore(); }
  });

  it("gives a background mission an exact reusable context across supervisor runs", () => {
    const turn = { traceId: "trace:bg-continuation:one", agentRunId: "agent_run:one", continuedTraceparent: traceparent };
    const first = backgroundMissionTraceContext(turn)!;
    expect(first.traceId).not.toBe(parsed.traceId);
    expect(backgroundMissionTraceContext({ ...turn, supervisorRunId: "a-different-run" })).toEqual(first);
    expect(backgroundMissionTraceContext({ ...turn, agentRunId: "agent_run:two" })).not.toEqual(first);
    expect(backgroundMissionTraceContext({ traceId: "req:one" })).toBeNull();
    expect(decodeActivityTraceContext(encodeTraceHeaders({}, first))).toEqual(first);
  });
});

describe("workflow tracing scopes", () => {
  it("isolates concurrent signal missions and restores the enclosing run context", async () => {
    const tracing = interceptors();
    const outbound = tracing.outbound![0]!;
    const parents: Record<string, ReturnType<typeof decodeActivityTraceContext>> = {};
    const activity = (key: string) => outbound.scheduleActivity!({ headers: {}, args: [], activityType: "noArgs", seq: 1, options: {} }, async (input) => {
      parents[key] = decodeActivityTraceContext(input.headers);
      return undefined;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await tracing.inbound![0]!.execute!({ args: [{ traceparent }], headers: {} }, async () => {
      const first = withWorkflowTraceContext({ traceparent, missionId: "mission:first" }, async () => { await gate; await activity("first"); });
      const later = withWorkflowTraceContext({ traceparent: laterTraceparent, missionId: "mission:later" }, async () => { await activity("later"); release(); });
      await Promise.all([first, later]);
      await activity("run");
    });
    const first = context.spans.find((span) => span.attributes["space.mission_id"] === "mission:first")!;
    const later = context.spans.find((span) => span.attributes["space.mission_id"] === "mission:later")!;
    const root = context.spans.find((span) => !span.operation)!;
    expect(parents.first).toMatchObject({ traceId: first.traceId, parentId: first.spanId });
    expect(parents.later).toMatchObject({ traceId: later.traceId, parentId: later.spanId });
    expect(parents.run).toMatchObject({ traceId: root.traceId, parentId: root.spanId });
    expect(first.parentSpanId).toBe(parsed.parentId);
    expect(later.traceId).toBe("11111111111111111111111111111111");
    expect(later.links).toContainEqual({ traceId: root.traceId, spanId: root.spanId });
    expect(root.traceId).toBe(parsed.traceId);
  });

  it("links consecutive background missions to the immediately preceding emitted span", async () => {
    const tracing = interceptors();
    const first = { traceId: "trace:bg-first", agentRunId: "agent_run:first", continuedTraceparent: traceparent };
    const firstContext = backgroundMissionTraceContext(first)!;
    const second = {
      traceId: "trace:bg-second", agentRunId: "agent_run:second",
      continuedTraceparent: formatTraceparent(firstContext.traceId, firstContext.parentId, firstContext.flags)
    };
    await tracing.inbound![0]!.execute!({ args: [{ traceparent }], headers: {} }, async () => {
      await withWorkflowTraceContext(first, async () => "done");
      await withWorkflowTraceContext(second, async () => "done");
    });
    const missions = context.spans.filter((span) => span.operation === "mission");
    expect(missions[0]).toMatchObject({ traceId: firstContext.traceId, spanId: firstContext.parentId, parentSpanId: null });
    expect(missions[1]!.links).toContainEqual({ traceId: missions[0]!.traceId, spanId: missions[0]!.spanId });
    expect(missions[1]!.traceId).not.toBe(missions[0]!.traceId);
  });

  it("exports a paused background mission once under its stable span, from its first pass to its finish", async () => {
    const tracing = interceptors();
    const background = { traceId: "trace:bg-paused", agentRunId: "agent_run:bg-paused", continuedTraceparent: traceparent };
    const stable = backgroundMissionTraceContext(background)!;
    const ordinary = { traceparent, missionId: "room_agent_mission:ordinary" };
    const now = vi.spyOn(Date, "now");
    try {
      await tracing.inbound![0]!.execute!({ args: [{ traceparent }], headers: {} }, async () => {
        now.mockReturnValue(5_000);
        await withWorkflowTraceContext(background, async () => ({ status: "PAUSED" as const }));
        await withWorkflowTraceContext(ordinary, async () => ({ status: "PAUSED" as const }));
        now.mockReturnValue(6_000);
        await withWorkflowTraceContext(background, async () => ({ status: "PAUSED" as const }));
        await withWorkflowTraceContext(ordinary, async () => ({ status: "PAUSED" as const }));
        now.mockReturnValue(7_000);
        await withWorkflowTraceContext(background, async () => ({ status: "COMPLETED" as const }));
      });
    } finally {
      now.mockRestore();
    }
    const missions = context.spans.filter((span) => span.operation === "mission");
    const stableSpans = missions.filter((span) => span.spanId === stable.parentId);
    expect(stableSpans).toHaveLength(1);
    expect(stableSpans[0]).toMatchObject({ traceId: stable.traceId, startTimeMs: 5_000, endTimeMs: 7_000, outcome: "COMPLETED" });
    // Ordinary missions keep one short span per pass, each with its own identity.
    const ordinarySpans = missions.filter((span) => span.spanId !== stable.parentId);
    expect(ordinarySpans).toHaveLength(2);
    expect(new Set(ordinarySpans.map((span) => span.spanId)).size).toBe(2);
  });

  it("keeps returned failures and thrown errors unchanged and never records their messages", async () => {
    const tracing = interceptors();
    // A workflow fails only with a Temporal failure; a plain Error fails (and retries) the task.
    const error = ApplicationFailure.create({ message: privateText, type: "TOOL_UNAVAILABLE" });
    await expect(tracing.inbound![0]!.execute!({ args: [], headers: {} }, async () => { throw error; })).rejects.toBe(error);
    expect(context.spans[0]).toMatchObject({ outcome: "FAILED", reasonCode: "TOOL_UNAVAILABLE" });
    const second = interceptors();
    const result = { status: "FAILED", message: privateText };
    await expect(second.inbound![0]!.execute!({ args: [], headers: {} }, async () => result)).resolves.toBe(result);
    expect(context.spans[1]).toMatchObject({ outcome: "FAILED_RESULT" });
    expect(JSON.stringify(context.spans)).not.toContain(privateText);
  });

  it("records cancellation caught and returned by a supervisor mission without changing the result", async () => {
    for (const status of ["INTERRUPTED", "CANCELLED"]) {
      const tracing = interceptors();
      const result = { status, reason: privateText };
      await expect(tracing.inbound![0]!.execute!({ args: [{ traceparent }], headers: {} }, async () =>
        withWorkflowTraceContext({ traceparent }, async () => result))).resolves.toBe(result);
      expect(context.spans.at(-2)).toMatchObject({ operation: "mission", outcome: "CANCELLED", reasonCode: "WORKFLOW_CANCELLED" });
    }
    expect(JSON.stringify(context.spans)).not.toContain(privateText);
  });

  it("passes through mission callbacks without exporting when no interceptor is active", async () => {
    interceptors();
    await expect(withWorkflowTraceContext({ traceparent }, async () => "untraced")).resolves.toBe("untraced");
    expect(context.spans).toEqual([]);
  });
});

describe("host workflow sink", () => {
  function exporter(record = vi.fn()): SpanExporter {
    return { record, flush: async () => {}, close: async () => {}, stats: () => ({ exported: 0, dropped: 0, failed: 0 }) };
  }

  it("does not register sandbox interceptors or sinks when disabled", () => {
    const options = createWorkerTracing(null);
    expect(options.sinks).toBeUndefined();
    expect(options.interceptors!.workflowModules).toBeUndefined();
    expect(options.interceptors!.activity).toHaveLength(1);
  });

  it("suppresses replay callbacks, sanitizes export attributes and contains exporter failures", () => {
    const capture = vi.fn();
    const options = createWorkerTracing(exporter(capture));
    const sink = options.sinks!.spaceTracing.record;
    expect(sink.callDuringReplay).toBe(false);
    const span: WorkflowSpanRecord = {
      traceId: parsed.traceId, spanId: "3333333333333333", parentSpanId: parsed.parentId,
      startTimeMs: 1_000, endTimeMs: 1_200, outcome: "FAILED", reasonCode: "TOOL_UNAVAILABLE",
      attributes: { "space.room_id": "room:one", "space.prompt": privateText, "space.pane_id": privateText },
      links: [{ traceId: "11111111111111111111111111111111", spanId: "4444444444444444" }]
    };
    sink.fn(context.info as never, span);
    expect(capture).toHaveBeenCalledOnce();
    expect(capture.mock.calls[0]![0]).toMatchObject({
      name: "workflow supervisorWorkflow", kind: 1, error: true,
      startTimeUnixNano: 1_000_000_000n, endTimeUnixNano: 1_200_000_000n,
      attributes: { "space.room_id": "room:one", "space.failure_category": "TOOL_UNAVAILABLE", "space.workflow_id": context.info.workflowId }
    });
    expect(capture.mock.calls[0]![0].attributes).not.toHaveProperty("space.prompt");
    expect(capture.mock.calls[0]![0].attributes).not.toHaveProperty("space.pane_id");
    const throwing = createWorkerTracing(exporter(() => { throw new Error(privateText); })).sinks!.spaceTracing.record;
    expect(() => throwing.fn(context.info as never, span)).not.toThrow();
    sink.fn(context.info as never, { ...span, outcome: privateText });
    sink.fn(context.info as never, { ...span, startTimeMs: Number.NaN });
    expect(capture).toHaveBeenCalledOnce();
  });
});

describe("Opus review: request-independent supervisor runs", () => {
  it("roots the production supervisor run in its own trace, links its starting request and keeps continued runs chained", async () => {
    const original = { workflowType: context.info.workflowType, runId: context.info.runId };
    context.info.workflowType = "roomAgentSupervisorWorkflow";
    context.info.memo = { traceparent, missionId: "mission:first", spaceTraceId: "req:first-request" };
    try {
      let tracing = interceptors();
      let pollParent: ReturnType<typeof decodeActivityTraceContext> = null;
      await tracing.inbound![0]!.execute!({ args: [{ roomId: "room:one" }], headers: {} }, async () => {
        await withWorkflowTraceContext({ missionId: "mission:first", turn: { traceparent, traceId: "req:first-request" } }, async () => "done");
        await tracing.outbound![0]!.scheduleActivity!({ headers: {}, args: [{ missionId: "mission:later" }], activityType: "poll", seq: 1, options: {} },
          async (input) => { pollParent = decodeActivityTraceContext(input.headers); return undefined; });
      });
      const root = context.spans.find((span) => !span.operation)!;
      const mission = context.spans.find((span) => span.operation === "mission")!;
      expect(root.traceId).not.toBe(parsed.traceId);
      expect(root.parentSpanId).toBeNull();
      expect(root.links).toContainEqual({ traceId: parsed.traceId, spanId: parsed.parentId });
      expect(root.attributes["space.mission_id"]).toBeUndefined();
      expect(mission).toMatchObject({ traceId: parsed.traceId, parentSpanId: parsed.parentId });
      expect(pollParent).toMatchObject({ traceId: root.traceId, parentId: root.spanId });

      // A continued run carries the link header and stays a child of the preceding run.
      const previous = { traceId: root.traceId, parentId: root.spanId, flags: "01" };
      context.spans.length = 0;
      context.info.runId = "9e0c157c-fd57-43c3-8d65-3e043c9c6d47";
      tracing = interceptors();
      await tracing.inbound![0]!.execute!({ args: [{ roomId: "room:one" }], headers: encodeTraceHeaders({}, previous, previous) }, async () => "next");
      expect(context.spans.find((span) => !span.operation)).toMatchObject({ traceId: root.traceId, parentSpanId: root.spanId });
    } finally {
      Object.assign(context.info, original);
    }
  });
});

describe("Opus reconciliation: legacy background items and workflow-task failures", () => {
  it("roots a legacy background item that still carries its source traceparent, keeping that context as a link", async () => {
    const tracing = interceptors();
    const legacy = { missionId: "mission:legacy", turn: { traceId: "trace:bg-legacy-one", agentRunId: "agent_run:bg-legacy-one", traceparent } };
    const background = backgroundMissionTraceContext(legacy.turn)!;
    await tracing.inbound![0]!.execute!({ args: [{ traceparent }], headers: {} }, async () => withWorkflowTraceContext(legacy, async () => "done"));
    const mission = context.spans.find((span) => span.operation === "mission")!;
    expect(mission).toMatchObject({ traceId: background.traceId, spanId: background.parentId, parentSpanId: null });
    expect(mission.links).toContainEqual({ traceId: parsed.traceId, spanId: parsed.parentId });
  });

  it("does not export a FAILED run span for a non-Temporal error, which only fails the retried workflow task", async () => {
    const tracing = interceptors();
    const error = new Error(privateText);
    await expect(tracing.inbound![0]!.execute!({ args: [], headers: {} }, async () => { throw error; })).rejects.toBe(error);
    expect(context.spans).toHaveLength(0);
  });
});

describe("workflow span export boundary", () => {
  function exporter(record = vi.fn()): SpanExporter {
    return { record, flush: async () => {}, close: async () => {}, stats: () => ({ exported: 0, dropped: 0, failed: 0 }) };
  }
  const record: WorkflowSpanRecord = {
    traceId: parsed.traceId, spanId: "3333333333333333", parentSpanId: null,
    startTimeMs: 1_000, endTimeMs: 1_200, outcome: "COMPLETED", attributes: {}
  };

  it("exports only generated <kind>:<token> correlation identifiers", () => {
    const capture = vi.fn();
    const sink = createWorkerTracing(exporter(capture)).sinks!.spaceTracing.record;
    const attributes = workflowTraceAttributes([{
      missionId: "PRIVATE-PROMPT-and-tool-output-must-stay-local", paneId: "private-notes.txt",
      roomId: "room:one", traceId: "trace:bg-continuation:one"
    }]);
    sink.fn(context.info as never, { ...record, attributes });
    const exported = capture.mock.calls[0]![0].attributes;
    expect(exported).toMatchObject({ "space.room_id": "room:one", "space.trace_id": "trace:bg-continuation:one" });
    expect(exported).not.toHaveProperty("space.mission_id");
    expect(exported).not.toHaveProperty("space.pane_id");
  });

  // The forms Space generates: makeSpaceId (`<kind>:<nanoid>`), API request ids,
  // background continuation ids, Dot and goal hex ids, and derived trace ids.
  const generated: Array<[string, string, string]> = [
    ["traceId", "space.trace_id", "trace:bg-6f1c2a4e-9b7d-4c1e-8a2f-3d5e7b9c1a20"],
    ["traceId", "space.trace_id", "trace:omp-native-model:V1StGXR8_Z5j"],
    ["traceId", "space.trace_id", "trace:memory-maintenance-2026-10-19"],
    ["spaceTraceId", "space.trace_id", "trace:V1StGXR8_Z5j"],
    ["requestId", "space.request_id", "req:V1StGXR8_Z5j"],
    ["parentSpaceTraceId", "space.request_id", "req:V1StGXR8_Z5j"],
    ["roomId", "space.room_id", "room:V1StGXR8_Z5j"],
    ["paneId", "space.pane_id", "pane:V1StGXR8_Z5j"],
    ["missionId", "space.mission_id", "room_agent_mission:V1StGXR8_Z5j"],
    ["roomAgentMissionId", "space.mission_id", "room_agent_mission:V1StGXR8_Z5j"],
    ["agentRunId", "space.agent_run_id", "agent_run:bg-6f1c2a4e-9b7d-4c1e-8a2f-3d5e7b9c1a20"],
    ["agentSessionId", "space.agent_session_id", "agent_session:V1StGXR8_Z5j"],
    ["actionId", "space.action_id", "room_agent_action:V1StGXR8_Z5j"],
    ["goalId", "space.goal_id", "dot_goal:0123456789abcdef0123456789abcdef"],
    ["dotId", "space.dot_id", "dot:0123456789abcdef0123456789abcdef"],
    ["turnId", "space.turn_id", "turn:V1StGXR8_Z5j"],
    ["cliTaskId", "space.cli_task_id", "cli_task:V1StGXR8_Z5j"],
    ["revisionId", "space.revision_id", "cli_revision:V1StGXR8_Z5j"]
  ];
  const notIdentifiers = [
    "PRIVATE PROMPT text", "private-notes.txt", "/home/operator/project", "https://example.test/a?token=secret",
    "room:has space", "Room:upper-case-kind", "room:", "room:a.b", `room:${"x".repeat(129)}`
  ];

  it.each(generated)("exports a generated %s as %s", (field, key, value) => {
    const capture = vi.fn();
    const sink = createWorkerTracing(exporter(capture)).sinks!.spaceTracing.record;
    sink.fn(context.info as never, { ...record, attributes: workflowTraceAttributes([{ [field]: value }]) });
    expect(capture.mock.calls[0]![0].attributes[key]).toBe(value);
  });

  // Each value is offered through the workflow-side reader and, as an older
  // sandbox could, directly under the exported key; the host drops it either way.
  it.each([...new Map(generated.map(([field, key]) => [field, key])).entries()])("drops a %s (%s) that is not a generated identifier", (field, key) => {
    const capture = vi.fn();
    const sink = createWorkerTracing(exporter(capture)).sinks!.spaceTracing.record;
    for (const value of notIdentifiers) {
      sink.fn(context.info as never, { ...record, attributes: workflowTraceAttributes([{ [field]: value }]) });
      sink.fn(context.info as never, { ...record, attributes: { [key]: value } });
    }
    expect(capture).toHaveBeenCalledTimes(notIdentifiers.length * 2);
    for (const [span] of capture.mock.calls) expect(span.attributes).not.toHaveProperty(key);
  });

  it("drops timestamps outside the OTLP fixed64 range and omits an invalid attempt", () => {
    const capture = vi.fn();
    const sink = createWorkerTracing(exporter(capture)).sinks!.spaceTracing.record;
    sink.fn({ ...context.info, attempt: -1 } as never, { ...record, startTimeMs: Number.MAX_SAFE_INTEGER, endTimeMs: Number.MAX_SAFE_INTEGER });
    expect(capture).not.toHaveBeenCalled();
    sink.fn({ ...context.info, attempt: -1 } as never, record);
    expect(capture).toHaveBeenCalledOnce();
    expect(capture.mock.calls[0]![0].attributes).not.toHaveProperty("space.attempt");
  });
});

describe("signal and update handler failures", () => {
  it("exports no span for a non-Temporal handler error, which fails the retried workflow task, but records a Temporal failure", async () => {
    const tracing = interceptors();
    const inbound = tracing.inbound![0]!;
    const taskError = new Error(privateText);
    const failure = ApplicationFailure.create({ message: privateText, type: "TOOL_UNAVAILABLE" });
    await inbound.execute!({ args: [{ traceparent }], headers: {} }, async () => {
      await expect(inbound.handleSignal!({ signalName: "plainError", args: [], headers: {} }, async () => { throw taskError; })).rejects.toBe(taskError);
      await expect(inbound.handleSignal!({ signalName: "temporalFailure", args: [], headers: {} }, async () => { throw failure; })).rejects.toBe(failure);
      return "done";
    });
    const signals = context.spans.filter((span) => span.operation === "signal");
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ outcome: "FAILED", reasonCode: "TOOL_UNAVAILABLE", attributes: { "space.signal_name": "temporalFailure" } });
    expect(JSON.stringify(context.spans)).not.toContain(privateText);
  });
});
