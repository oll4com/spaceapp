import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { dummyTurnInputSchema, parseTraceparent } from "@space/contracts";
import { activityCorrelation, createActivityObservabilityInterceptors } from "../src/activity-observability.js";
import { getCodexAppServerTurnActivityConfig } from "../src/activities.js";
import { executeRoomActionBridge } from "../src/room-action-bridge.js";
import { freshRootTraceparent, prepareBackgroundContinuation } from "../src/room-background-continuation.js";
import { captureWorkerLogs } from "../src/worker-log.js";
import { continuationFixture } from "./room-continuation-fixture.js";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomBytes: vi.fn(actual.randomBytes) };
});

const originating = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("background continuation span link", () => {
  it("carries the originating turn's traceparent as continuationTraceparent and keeps the trace:bg id", async () => {
    const c = continuationFixture("OPEN_TYPES", originating);
    const prepared = await prepareBackgroundContinuation(c.input, c.store);
    if (prepared.state !== "READY") throw Error("Missing continuation");
    expect(prepared.item.turn.traceId).toBe("trace:bg-test-1");
    expect(prepared.item.turn.continuationTraceparent).toBe(originating);
    expect(prepared.item.turn.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    const root = parseTraceparent(prepared.item.turn.traceparent);
    expect(root).not.toBeNull();
    expect(root?.traceId).not.toMatch(/^0+$/);
    expect(root?.traceId).not.toBe(parseTraceparent(originating)!.traceId);
  });

  it("returns the identical fresh root traceparent when preparation is retried", async () => {
    const c = continuationFixture("OPEN_TYPES", originating);
    const first = await prepareBackgroundContinuation(c.input, c.store);
    const retry = await prepareBackgroundContinuation(c.input, c.store);
    if (first.state !== "READY" || retry.state !== "READY") throw Error("Missing continuation");
    expect(retry.item.turn.traceparent).toBe(first.item.turn.traceparent);
    expect(retry.item.turn.continuationTraceparent).toBe(originating);
  });

  it("never reuses the trace id it continues or an all-zero id", () => {
    const excluded = parseTraceparent(originating)!.traceId;
    const random = vi.mocked(randomBytes) as unknown as { mockReturnValueOnce(value: Buffer): unknown };
    // Forced collisions: an all-zero trace id, the source trace id, then an all-zero span id.
    random.mockReturnValueOnce(Buffer.alloc(16));
    random.mockReturnValueOnce(Buffer.from(excluded, "hex"));
    random.mockReturnValueOnce(Buffer.from("0af7651916cd43dd8448eb211c80319c", "hex"));
    random.mockReturnValueOnce(Buffer.alloc(8));
    random.mockReturnValueOnce(Buffer.from("b7ad6b7169203331", "hex"));
    expect(freshRootTraceparent(excluded)).toBe("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");
    const roots = new Set<string>();
    for (let index = 0; index < 200; index++) {
      const root = freshRootTraceparent(excluded);
      roots.add(root);
      const parsed = parseTraceparent(root)!;
      expect(root).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
      expect(parsed.traceId).not.toBe(excluded);
      expect(parsed.traceId).not.toMatch(/^0+$/);
      expect(parsed.parentId).not.toMatch(/^0+$/);
    }
    expect(roots.size).toBe(200);
  });

  it("adds no link field when the originating turn had no traceparent", async () => {
    const c = continuationFixture();
    const prepared = await prepareBackgroundContinuation(c.input, c.store);
    if (prepared.state !== "READY") throw Error("Missing continuation");
    expect(prepared.item.turn.continuationTraceparent).toBeUndefined();
    expect(parseTraceparent(prepared.item.turn.traceparent)).not.toBeNull();
  });

  it("still starts a fresh root when the originating traceparent is invalid", async () => {
    const c = continuationFixture("OPEN_TYPES", "00-00000000000000000000000000000000-00f067aa0ba902b7-01");
    const prepared = await prepareBackgroundContinuation(c.input, c.store);
    if (prepared.state !== "READY") throw Error("Missing continuation");
    expect(prepared.item.turn.continuationTraceparent).toBeUndefined();
    expect(prepared.item.turn.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it("keeps logs and internal API calls joinable by W3C trace id with OTLP export off", async () => {
    const c = continuationFixture("OPEN_TYPES", originating);
    const prepared = await prepareBackgroundContinuation(c.input, c.store);
    if (prepared.state !== "READY") throw Error("Missing continuation");
    const root = parseTraceparent(prepared.item.turn.traceparent)!;
    // No space-traceparent header exists: correlation comes from the activity input alone.
    expect(activityCorrelation([prepared.item.turn]).w3cTraceId).toBe(root.traceId);
    expect(activityCorrelation([prepared.item]).w3cTraceId).toBe(root.traceId);
    const sent: Array<Record<string, string>> = [];
    const actions = [{ toolId: "room:inspect", action: { type: "inspect" } }];
    await executeRoomActionBridge({
      turnInput: prepared.item.turn,
      assistantContent: "```space-room-actions\n" + JSON.stringify({ version: 1, actions }) + "\n```",
      config: { ...getCodexAppServerTurnActivityConfig({}), internalApiToken: "test-only" },
      fetchImpl: async (_url, init) => {
        sent.push(init!.headers as Record<string, string>);
        return Response.json({ id: "space-agent-room-action-bridge", results: actions.map(request => ({
          request, status: "EXECUTED", statusReason: "Recorded evidence", evidence: {} })) });
      }
    });
    expect(sent).toHaveLength(1);
    const child = parseTraceparent(sent[0]!.traceparent)!;
    expect(child.traceId).toBe(root.traceId);
    expect(child.parentId).not.toBe(root.parentId);
    expect(child.parentId).not.toMatch(/^0+$/);
  });

  it("stamps the fresh root trace id on worker log records with OTLP export off", async () => {
    const c = continuationFixture("OPEN_TYPES", originating);
    const prepared = await prepareBackgroundContinuation(c.input, c.store);
    if (prepared.state !== "READY") throw Error("Missing continuation");
    const root = parseTraceparent(prepared.item.turn.traceparent)!;
    const records: Array<Record<string, unknown>> = [];
    const restore = captureWorkerLogs(line => records.push(JSON.parse(line)));
    try {
      const hooks = createActivityObservabilityInterceptors({ spans: null })({
        info: { activityType: "runCodexAppServerTurn", activityId: "1", attempt: 1 },
        cancellationSignal: new AbortController().signal
      } as never);
      await hooks.inbound!.execute!({ args: [prepared.item.turn], headers: {} } as never, async () => "done");
      expect(records.map(record => record.event)).toEqual(["activity.started", "activity.finished"]);
      for (const record of records) expect(record.w3cTraceId).toBe(root.traceId);
    } finally { restore(); }
  });

  it("validates the field as a W3C traceparent", () => {
    const turn = { roomId: "room_otlp_link", paneId: "pane_otlp_link", prompt: "hi", traceId: "req:abcdefghijkl" };
    expect(dummyTurnInputSchema.parse({ ...turn, continuationTraceparent: originating }).continuationTraceparent).toBe(originating);
    expect(dummyTurnInputSchema.safeParse({ ...turn, continuationTraceparent: "https://example.test" }).success).toBe(false);
  });
});
