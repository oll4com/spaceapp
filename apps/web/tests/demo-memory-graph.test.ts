import { describe, expect, it, vi } from "vitest";
import { memoryGraphNodeDetailSchema, memoryGraphOverviewPayloadSchema, memoryGraphPayloadSchema } from "@space/contracts";
import { DemoMemoryGraph, demoMemoryGraphSizeFromLocation } from "../src/demo/demo-memory-graph.js";
import { DemoStore } from "../src/demo/DemoStore.js";
import { createDemoFixture } from "../src/demo/demo-fixture.js";
import { createDemoRuntime } from "../src/demo/demo-runtime.js";

describe("bounded local memory graph fixtures", () => {
  it.each([2000, 10000, 50000] as const)("generates %i nodes with exactly three valid outgoing relationships each", async (size) => {
    const yieldTask = vi.fn(async () => {});
    const graph = await new DemoMemoryGraph(size, yieldTask).overview({ limit: size });
    expect(graph.nodes).toHaveLength(size);
    expect(graph.edges).toHaveLength(size * 3);
    expect(graph.totalMatchingNodes).toBe(size);
    expect(graph.totalMatchingEdges).toBe(size * 3);
    expect(graph.truncated).toBe(false);
    expect(graph.nodes[0]).toMatchObject({ type: "SOURCE", label: "space.md", recordId: null });
    const sources = graph.nodes.filter((node) => node.type === "SOURCE");
    const sourcePaths = new Set(sources.map((node) => node.sourcePath));
    expect(sources).toHaveLength(24);
    expect(sourcePaths.size).toBe(24);
    expect(graph.nodes.every((node) => sourcePaths.has(node.sourcePath))).toBe(true);
    expect(graph.summary.recordCount).toBe(size - sources.length);
    expect(graph.summary.sourceCount).toBe(sourcePaths.size);
    expect(yieldTask.mock.calls.length).toBeGreaterThan(1);
    const ids = new Set(graph.nodes.map((node) => node.id));
    const outgoing = new Map<string, number>();
    const pairs = new Set<string>();
    for (const edge of graph.edges) {
      if (!ids.has(edge.source) || !ids.has(edge.target) || edge.source === edge.target) throw new Error("Invalid synthetic endpoint");
      pairs.add(`${edge.source}\0${edge.target}`);
      outgoing.set(edge.source, (outgoing.get(edge.source) ?? 0) + 1);
    }
    expect(pairs.size).toBe(size * 3);
    expect([...outgoing.values()].every((count) => count === 3)).toBe(true);
    const parsed = memoryGraphOverviewPayloadSchema.safeParse(graph);
    expect(parsed.success, parsed.success ? undefined : parsed.error.message).toBe(true);
  });

  it("is deterministic, yields to browser tasks, and returns details without a backend", async () => {
    let browserTaskRan = false;
    setTimeout(() => { browserTaskRan = true; }, 0);
    const fixture = new DemoMemoryGraph(2000);
    const first = await fixture.overview();
    expect(browserTaskRan).toBe(true);
    expect(await fixture.overview()).toEqual(first);
    const node = first.nodes[17]!;
    const detail = fixture.detail(node.id)!;
    expect(memoryGraphNodeDetailSchema.safeParse(detail).success).toBe(true);
    expect(detail.node).toEqual(node);
    expect(detail.record?.body).toContain("synthetic benchmark content");
    expect(detail.relatedEdges).toHaveLength(6);
    const source = fixture.detail(first.nodes[0]!.id)!;
    expect(memoryGraphNodeDetailSchema.safeParse(source).success).toBe(true);
    expect(source.record).toBeNull();
    expect(source.node.sourcePath).toBe(node.sourcePath);
    expect(fixture.detail("memory:demo-scale:99999")).toBeUndefined();
    expect(fixture.detail("memory:real-user-data")).toBeUndefined();
  });

  it("preserves matching counts when bounded and supports exact filtering and pagination", async () => {
    const store = new DemoStore(undefined, { memoryGraphNodes: 10000 });
    const bounded = (await store.api.memoryGraphOverview()).data;
    expect(bounded.nodes).toHaveLength(2000);
    expect(bounded.edges.length).toBeLessThanOrEqual(6000);
    expect(bounded.totalMatchingNodes).toBe(10000);
    expect(bounded.totalMatchingEdges).toBe(30000);
    expect(bounded.truncated).toBe(true);
    const filtered = (await store.api.memoryGraphOverview({ q: "Synthetic memory 00017", limit: 50000 })).data;
    expect(filtered.nodes.map((node) => node.id)).toEqual(["memory:demo-scale:00017"]);
    expect(filtered.edges).toEqual([]);
    expect(filtered.truncated).toBe(false);
    const page = await store.api.memoryGraph({ page: 2, pageSize: 25 });
    expect(page.data.nodes[0]?.id).toBe("memory:demo-scale:00025");
    expect(page.pagination).toEqual({ page: 2, pageSize: 25, totalItems: 10000, totalPages: 400 });
    const parsedPage = memoryGraphPayloadSchema.safeParse(page.data);
    expect(parsedPage.success, parsedPage.success ? undefined : parsedPage.error.message).toBe(true);
    const sources = (await store.api.memoryGraphOverview({ nodeType: "SOURCE" })).data;
    expect(sources.nodes).toHaveLength(24);
    expect(sources.summary.recordCount).toBe(0);
    expect((await store.api.memoryGraphOverview({ nodeType: "SOURCE", scope: "ROOM" })).data.nodes).toEqual([]);
    const firstSource = await store.api.memoryGraphNode("memory:demo-scale:00000");
    const fromSource = (await store.api.memoryGraphOverview({ sourcePath: firstSource.node.sourcePath! })).data;
    expect(fromSource.nodes).toEqual(bounded.nodes.filter((node) => node.sourcePath === firstSource.node.sourcePath));
    expect(fromSource.nodes.filter((node) => node.type === "SOURCE")).toHaveLength(1);
    expect(fromSource.summary).toMatchObject({ sourceCount: 1, recordCount: fromSource.nodes.length - 1 });
    expect((await store.api.memoryGraphOverview({ month: "2026-09" })).data.nodes).toEqual([]);
    await expect(store.api.memoryGraphOverview({ limit: 50001 })).rejects.toThrow("Graph limit");
    await expect(store.api.memoryGraphNode("memory:demo-scale:10000")).rejects.toThrow("not found");
  });

  it("keeps ordinary and public-mock fixtures unchanged unless the local demo explicitly opts in", async () => {
    expect((await new DemoStore().api.memoryGraphOverview()).data.nodes).toHaveLength(7);
    expect((await new DemoStore().api.memoryGraphOverview({ limit: 1 })).data.nodes).toHaveLength(1);
    const mock = new DemoStore(createDemoFixture(), { memoryGraphNodes: 50000 });
    expect((await mock.api.memoryGraphOverview()).data.nodes).toHaveLength(7);
    const { runtime } = createDemoRuntime({ memoryGraphNodes: 2000 });
    expect((await runtime.api.memoryGraphOverview()).data.nodes).toHaveLength(2000);
    await expect(runtime.platform.fetch("https://example.invalid")).rejects.toThrow("blocks network");
  });

  it("accepts only the three supported sizes on the demo route", () => {
    for (const size of [2000, 10000, 50000] as const) {
      expect(demoMemoryGraphSizeFromLocation({ pathname: "/demo-workspace", search: `?memoryGraphNodes=${size}` })).toBe(size);
    }
    for (const value of ["0", "1", "49999", "50001", "1000000000", "NaN", "-2000", "2000.5"]) {
      expect(demoMemoryGraphSizeFromLocation({ pathname: "/demo-workspace", search: `?memoryGraphNodes=${value}` })).toBeUndefined();
    }
    expect(demoMemoryGraphSizeFromLocation({ pathname: "/workspace", search: "?memoryGraphNodes=50000" })).toBeUndefined();
    expect(demoMemoryGraphSizeFromLocation({ pathname: "/mock", search: "?memoryGraphNodes=50000" })).toBeUndefined();
    expect(demoMemoryGraphSizeFromLocation({ pathname: "/demo-workspace", search: "" })).toBeUndefined();
  });
});
