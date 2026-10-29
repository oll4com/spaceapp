import { beforeEach, describe, expect, it, vi } from "vitest";
import { evictRequestTraceContext } from "./support/trace-registry-eviction.js";
import { createRequestTraceContext, requestTraceContexts } from "../src/trace-context.js";
import { TemporalDotGoalWorkflowCoordinator } from "../src/dot-goals.js";
import { createMemoryConsolidationCoordinator } from "../src/memory-consolidation-coordinator.js";
import { createMemoryMutationCoordinator } from "../src/memory-mutation-coordinator.js";

const temporal = vi.hoisted(() => ({ memos: [] as Record<string, string>[], beforeConnect: () => {} }));
vi.mock("@temporalio/client", async importOriginal => {
  const actual = await importOriginal<typeof import("@temporalio/client")>();
  return { ...actual,
    Connection: { connect: async () => { temporal.beforeConnect(); return { close: async () => {} }; } },
    Client: class { workflow = { start: async (_type: string, options: { workflowId: string; memo: Record<string, string> }) => {
      temporal.memos.push(options.memo);
      return { workflowId: options.workflowId, firstExecutionRunId: "run:retained-trace" };
    } }; }
  };
});

const requestId = "req:retained0001";
const parent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const options = { enabled: true, address: "localhost:7233", namespace: "default", taskQueue: "space" };
const starters = [
  { name: "Dot goal", start: (traceparent?: string) => new TemporalDotGoalWorkflowCoordinator(options).start("dot_goal:retained01", requestId, traceparent) },
  { name: "memory consolidation", start: (traceparent?: string) => createMemoryConsolidationCoordinator(options).start({ runId: "memory_consolidation:retained", traceId: requestId }, "workflow:retained", traceparent) },
  { name: "memory mutation", start: (traceparent?: string) => createMemoryMutationCoordinator(options).start({ changeSetId: "memory_change:retained", traceId: requestId }, undefined, traceparent) }
];

beforeEach(() => { temporal.memos.length = 0; temporal.beforeConnect = () => {}; });
describe.each(starters)("$name request trace retention", ({ start }) => {
  it("keeps the retained API parent when connection setup evicts the registry entry", async () => {
    requestTraceContexts.remember(requestId, createRequestTraceContext(undefined));
    temporal.beforeConnect = () => evictRequestTraceContext(requestId);
    await start(parent);
    expect(requestTraceContexts.lookup(requestId)).toBeNull();
    expect(temporal.memos).toEqual([{ spaceTraceId: requestId, traceparent: parent, w3cTraceId: "4bf92f3577b34da6a3ce929d0e0e4736" }]);
  });

  it("keeps the registry fallback for callers without a retained parent", async () => {
    const context = createRequestTraceContext(parent);
    requestTraceContexts.remember(requestId, context);
    await start();
    expect(temporal.memos).toEqual([{ spaceTraceId: requestId, traceparent: context.traceparent, w3cTraceId: "4bf92f3577b34da6a3ce929d0e0e4736" }]);
  });
});
