import { buildCodexAppServerTurnWorkflowId, formatTraceparent, parseTraceparent } from "@space/contracts";
import { describe, expect, it } from "vitest";
import { continuedRunTraceparent, prepareBackgroundContinuation } from "../src/room-background-continuation.js";
import { workflowRunSpanId } from "../src/workflow-trace-context.js";
import { continuationFixture } from "./room-continuation-fixture.js";

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const traceparent = `00-${traceId}-00f067aa0ba902b7-01`;

describe("background continuation trace link", () => {
  it("stays in the source trace and names the exact span of the run it continues", async () => {
    const c = continuationFixture("OPEN_TYPES", { traceparent });
    const source = c.initial.queueItem.turn;
    const prepared = await prepareBackgroundContinuation(c.input, c.store);
    if (prepared.state !== "READY") throw Error("Missing continuation");
    expect(prepared.item.turn.traceparent).toBe(traceparent);
    expect(prepared.item.turn.continuesTraceparent).toBe(formatTraceparent(traceId, workflowRunSpanId({ workflowId: buildCodexAppServerTurnWorkflowId(source) }), "01"));
    expect(parseTraceparent(prepared.item.turn.continuesTraceparent)?.traceId).toBe(traceId);
    expect(buildCodexAppServerTurnWorkflowId(prepared.item.turn)).not.toBe(buildCodexAppServerTurnWorkflowId(source));
  });

  it("links a continuation of a continuation to its own source, not the first run", async () => {
    const c = continuationFixture("OPEN_TYPES", { traceparent, continuesTraceparent: `00-${traceId}-${"1".repeat(16)}-01` });
    const prepared = await prepareBackgroundContinuation(c.input, c.store);
    if (prepared.state !== "READY") throw Error("Missing continuation");
    expect(prepared.item.turn.continuesTraceparent).toBe(continuedRunTraceparent(c.initial.queueItem.turn));
    expect(prepared.item.turn.continuesTraceparent).not.toContain("1".repeat(16));
  });

  it("adds no link when the source turn has no trace context", async () => {
    const c = continuationFixture();
    const prepared = await prepareBackgroundContinuation(c.input, c.store);
    if (prepared.state !== "READY") throw Error("Missing continuation");
    expect(prepared.item.turn).not.toHaveProperty("continuesTraceparent");
    expect(continuedRunTraceparent(c.initial.queueItem.turn)).toBeNull();
  });
});
