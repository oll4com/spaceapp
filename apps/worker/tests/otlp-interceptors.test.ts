import { beforeEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  sink: vi.fn(),
  memo: {} as Record<string, string>,
  n: 0
}));
vi.mock("@temporalio/workflow", () => ({
  ContinueAsNew: class ContinueAsNew extends Error {},
  defaultPayloadConverter: { toPayload: (value: unknown) => value, fromPayload: (value: unknown) => value },
  isCancellation: (error: { name?: string }) => error?.name === "CancelledFailure",
  proxySinks: () => ({ spaceTracing: { workflowSpan: fixture.sink } }),
  workflowInfo: () => ({ runId: "run-test", runStartTime: new Date(0), memo: fixture.memo }),
  uuid4: () => (++fixture.n).toString(16).padStart(16, "0") + "123456789abcdef0"
}));
import { ContinueAsNew } from "@temporalio/workflow";
import { interceptors } from "../src/workflow-tracing-interceptors.js";
const trace = "4bf92f3577b34da6a3ce929d0e0e4736";
const carrier = (id: string) => `00-${trace}-${id}-01`;
beforeEach(() => { fixture.sink.mockReset(); fixture.memo = {}; fixture.n = 0; });
it("uses headers before arguments before memo and propagates the workflow span", async () => {
  for (const [headers, args, expected] of [
    [{ "space-traceparent": carrier("1111111111111111") }, [{ traceparent: carrier("2222222222222222") }], "1111111111111111"],
    [{}, [{ turn: { traceparent: carrier("2222222222222222") } }], "2222222222222222"],
    [{}, [], "3333333333333333"]
  ] as const) {
    fixture.memo = { traceparent: carrier("3333333333333333") };
    const hooks = interceptors();
    await hooks.inbound![0]!.execute!({ args, headers } as never, async () => {
      for (const method of ["scheduleActivity", "scheduleLocalActivity", "startChildWorkflowExecution"] as const) {
        await hooks.outbound![0]![method]!({ headers: {}, options: { args: [] } } as never, ((input: { headers: Record<string, string> }) => {
          expect(input.headers["space-traceparent"]).toMatch(new RegExp(`^00-${trace}-[0-9a-f]{16}-01$`));
          return Promise.resolve(undefined);
        }) as never);
      }
      return "ok";
    });
    expect(fixture.sink.mock.lastCall![0].parentSpanId).toBe(expected);
  }
});
it("preserves success and failure when the sink throws", async () => {
  fixture.sink.mockImplementation(() => { throw new Error("sink failure"); });
  const hooks = interceptors();
  const input = { args: [], headers: {} };
  await expect(hooks.inbound![0]!.execute!(input, async () => "ok")).resolves.toBe("ok");
  const failure = new Error("workflow failure");
  await expect(hooks.inbound![0]!.execute!(input, async () => { throw failure; })).rejects.toBe(failure);
});

it("puts validated background links in child memo without inheriting a parent", async () => {
  const hooks = interceptors();
  const old = carrier("1111111111111111");
  const fresh = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
  await hooks.inbound![0]!.execute!({ args: [{ traceparent: old }], headers: {} }, async () => {
    await hooks.outbound![0]!.startChildWorkflowExecution!({
      headers: {}, options: { args: [{ traceparent: fresh, continuationTraceparent: old }] }
    } as never, ((input: { headers: Record<string, string>; options: { memo: Record<string, string> } }) => {
      expect(input.options.memo.continuationTraceparent).toBe(old);
      expect(input.headers["space-traceparent"]).toBeUndefined();
      return Promise.resolve(undefined);
    }) as never);
  });
});

it("tolerates child starts without options or args", async () => {
  const hooks = interceptors();
  for (const input of [{ headers: {} }, { headers: {}, options: {} }]) {
    const next = vi.fn().mockResolvedValue("child");
    await expect(hooks.outbound![0]!.startChildWorkflowExecution!(input as never, next)).resolves.toBe("child");
    expect(next).toHaveBeenCalledOnce();
  }
});

it("falls through once when child tracing fails and preserves downstream errors", async () => {
  const hooks = interceptors();
  const input = { headers: {}, options: { get args(): never { throw Error("tracing failure"); } } };
  const next = vi.fn().mockResolvedValue("child");
  await expect(hooks.outbound![0]!.startChildWorkflowExecution!(input as never, next)).resolves.toBe("child");
  expect(next).toHaveBeenCalledOnce();
  expect(next.mock.calls[0]![0]).toBe(input);
  const failure = Error("child failure");
  next.mockReset().mockRejectedValue(failure);
  await expect(hooks.outbound![0]!.startChildWorkflowExecution!({ headers: {}, options: {} } as never, next)).rejects.toBe(failure);
  expect(next).toHaveBeenCalledOnce();
});

it("records WORKFLOW_FAILED for an unclassified failure", async () => {
  const hooks = interceptors();
  const failure = Error("private error message");
  await expect(hooks.inbound![0]!.execute!({ args: [], headers: {} }, async () => { throw failure; })).rejects.toBe(failure);
  expect(fixture.sink.mock.lastCall![0]).toMatchObject({ outcome: "FAILED", errorCode: "WORKFLOW_FAILED" });
});

it("starts background continuations as roots with a validated link", async () => {
  const old = carrier("1111111111111111");
  for (const traceparent of [undefined, "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"]) {
    const hooks = interceptors();
    await hooks.inbound![0]!.execute!({ args: [{ traceparent, continuationTraceparent: old }], headers: {} }, async () => "ok");
    const span = fixture.sink.mock.lastCall![0];
    expect(span.parentSpanId).toBeNull();
    expect(span.traceId).not.toBe(trace);
    expect(span.links).toEqual([{ traceId: trace, spanId: "1111111111111111", reason: "background_continuation" }]);
    if (traceparent) expect(span.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
  }
});

it("creates a fresh root for a background turn whose source had no W3C context", async () => {
  const hooks = interceptors();
  const turn = { roomAgentContinuation: { sourceRunId: "run-old", generation: 1 } };
  await hooks.inbound![0]!.execute!({ args: [{ traceparent: carrier("1111111111111111") }], headers: {} }, async () => {
    await hooks.outbound![0]!.startChildWorkflowExecution!({
      headers: { "space-traceparent": carrier("1111111111111111") }, options: { args: [turn] }
    } as never, (async (input: { headers: Record<string, unknown> }) => {
      expect(input.headers["space-traceparent"]).toBeUndefined();
      const child = interceptors();
      await child.inbound![0]!.execute!({ args: [turn], headers: input.headers } as never, async () => "ok");
      const span = fixture.sink.mock.lastCall![0];
      expect(span.parentSpanId).toBeNull();
      expect(span.traceId).not.toBe(trace);
      expect(span.links).toEqual([]);
    }) as never);
  });
});

it("records cancellation, continue-as-new and safe wrapped failure codes without swallowing errors", async () => {
  for (const [error, outcome, errorCode] of [
    [Object.assign(new Error("private"), { name: "CancelledFailure" }), "CANCELLED", null],
    [Object.create(ContinueAsNew.prototype), "CONTINUED_AS_NEW", null],
    [Object.assign(new Error("private"), { cause: { type: "TOOL_UNAVAILABLE" } }), "FAILED", "TOOL_UNAVAILABLE"]
  ] as const) {
    const hooks = interceptors();
    await expect(hooks.inbound![0]!.execute!({ args: [], headers: {} }, async () => { throw error; })).rejects.toBe(error);
    expect(fixture.sink.mock.lastCall![0]).toMatchObject({ outcome, errorCode });
  }
});
