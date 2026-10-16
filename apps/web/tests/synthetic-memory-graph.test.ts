import { describe, expect, it } from "vitest";
import { memoryGraphNodeDetailSchema, memoryGraphOverviewPayloadSchema } from "@space/contracts";
import { DemoStore } from "../src/demo/DemoStore.js";
import { generateSyntheticMemoryGraph, mulberry32, SYNTHETIC_MEMORY_SIZES, syntheticNodeDetail } from "../src/demo/synthetic-memory-graph.js";

describe("synthetic memory graph", () => {
  it("is deterministic and never uses Math.random", () => {
    const random = Math.random;
    Math.random = () => { throw new Error("Math.random must not be used"); };
    try {
      expect(generateSyntheticMemoryGraph(2000)).toEqual(generateSyntheticMemoryGraph(2000));
    } finally { Math.random = random; }
    const a = mulberry32(7), b = mulberry32(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it.each(SYNTHETIC_MEMORY_SIZES)("has exactly %i nodes, three edges per node, a core source and valid references", size => {
    const graph = generateSyntheticMemoryGraph(size);
    expect(graph.nodes).toHaveLength(size);
    expect(graph.edges).toHaveLength(size * 3);
    const ids = new Set(graph.nodes.map(node => node.id));
    expect(ids.size).toBe(size);
    expect(new Set(graph.edges.map(edge => edge.id)).size).toBe(graph.edges.length);
    for (const edge of graph.edges) { expect(ids.has(edge.source)).toBe(true); expect(ids.has(edge.target)).toBe(true); expect(edge.source).not.toBe(edge.target); }
    const sources = graph.nodes.filter(node => node.type === "SOURCE");
    expect(sources.filter(node => node.label === "space.md")).toHaveLength(1);
    expect(new Set(sources.map(node => node.sourcePath)).size).toBe(sources.length);
    expect(graph.summary.sourceCount).toBe(sources.length);
    expect(graph.summary.sourceCount).toBeLessThanOrEqual(24);
    expect(graph.nodes.every(node => node.id.includes(`synthetic-${size}-`))).toBe(true);
    expect(graph.nodes.filter(node => node.type === "MEMORY").length).toBe(graph.summary.recordCount);
  });

  it("serves schema-valid overviews at 2k, 10k and 50k through the demo store, with size-specific node details", async () => {
    const store = new DemoStore();
    const ids: string[] = [];
    for (const size of SYNTHETIC_MEMORY_SIZES) {
      const { data } = await store.api.memoryGraphOverview({ limit: size });
      expect(memoryGraphOverviewPayloadSchema.parse(data)).toEqual(data);
      expect(data.nodes).toHaveLength(size);
      expect(data.edges).toHaveLength(size * 3);
      const memory = data.nodes.find(node => node.type === "MEMORY")!;
      ids.push(memory.id);
      const detail = await store.api.memoryGraphNode(memory.id);
      expect(memoryGraphNodeDetailSchema.parse(detail).node.id).toBe(memory.id);
    }
    expect(new Set(ids).size).toBe(3);
    await expect(store.api.memoryGraphOverview({ limit: 99 })).rejects.toThrow();
    await expect(store.api.memoryGraphNode("memory:synthetic-2000-999999")).rejects.toThrow();
    expect(syntheticNodeDetail(generateSyntheticMemoryGraph(2000), "missing:node-id", "2026-07-18T12:00:00.000Z")).toBeNull();
  }, 120_000);

  it("keeps the default demo overview unchanged without a limit", async () => {
    const { data } = await new DemoStore().api.memoryGraphOverview();
    expect(data.nodes.length).toBeLessThan(20);
  });
});
