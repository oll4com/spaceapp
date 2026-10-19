import { describe, expect, it } from "vitest";
import { memoryGraphOverviewPayloadSchema } from "@space/contracts";
import { createSyntheticMemoryGraph, syntheticMemoryNodeDetail } from "../src/demo/demo-memory-graph.js";

describe("reproducible memory graph benchmark data", () => {
  it.each([2000, 10000, 50000])("creates %i nodes and three real edges per node", count => {
    const graph = createSyntheticMemoryGraph(count);
    expect(graph.nodes).toHaveLength(count);
    expect(graph.edges).toHaveLength(count * 3);
    expect(graph.summary.nodeCount).toBe(count);
    const ids = new Set(graph.nodes.map(node => node.id));
    expect(graph.edges.every(edge => ids.has(edge.source) && ids.has(edge.target))).toBe(true);
    expect(graph.nodes[0]?.label).toBe("space.md");
    expect(graph.nodes.at(-1)).toEqual(createSyntheticMemoryGraph(count).nodes.at(-1));
  });
  it("caps malformed requests and allows real synthetic node detail navigation", () => {
    expect(createSyntheticMemoryGraph(Number.NaN).nodes).toHaveLength(2000);
    expect(createSyntheticMemoryGraph(-50).nodes).toHaveLength(1);
    expect(createSyntheticMemoryGraph(50001).nodes).toHaveLength(50000);
    expect(syntheticMemoryNodeDetail("demo:graph:0")?.node.label).toBe("space.md");
    expect(syntheticMemoryNodeDetail("demo:graph:49999")?.node.id).toBe("demo:graph:49999");
    expect(syntheticMemoryNodeDetail("demo:graph:50000")).toBeNull();
    expect(syntheticMemoryNodeDetail("not-a-demo-node")).toBeNull();
  });
  it("produces a complete payload accepted by the same contract as the live endpoint", () => {
    const graph = createSyntheticMemoryGraph(2000);
    expect(memoryGraphOverviewPayloadSchema.safeParse(graph).success).toBe(true);
  });
});
