import { describe, expect, it } from "vitest";
import { createSyntheticMemoryGraph } from "../src/demo/synthetic-memory-graph.js";

describe("demo synthetic memory graph", () => {
  it("generates a deterministic 50,000-node benchmark graph", () => {
    const graph = createSyntheticMemoryGraph(50000);
    expect(graph.nodes).toHaveLength(50000);
    expect(graph.edges.length).toBeGreaterThanOrEqual(100000);
    expect(graph.nodes[0]).toMatchObject({ id: "source:synthetic-space", type: "SOURCE", label: "space.md" });
    const ids = new Set(graph.nodes.map(node => node.id));
    expect(ids.size).toBe(graph.nodes.length);
    expect(graph.edges.every(edge => ids.has(edge.source) && ids.has(edge.target))).toBe(true);
    expect(graph.nodes.every(node => Number.isFinite(node.position?.relations.x) && Number.isFinite(node.position?.relations.y))).toBe(true);
    // Every memory hangs off a real source through a CONTAINS edge.
    const containsTargets = new Set(graph.edges.filter(edge => edge.type === "CONTAINS").map(edge => edge.target));
    expect(graph.nodes.filter(node => node.type === "MEMORY").every(node => containsTargets.has(node.id))).toBe(true);
    expect(graph.summary).toMatchObject({ nodeCount: 50000, issueCount: 0 });
    expect(graph.filters.relationMode).toBe("RELATIONS");
  });

  it("is deterministic for the same requested size", () => {
    expect(createSyntheticMemoryGraph(3000)).toEqual(createSyntheticMemoryGraph(3000));
  });

  it("clamps the requested size to the server's hard maximum", () => {
    expect(createSyntheticMemoryGraph(60000).nodes).toHaveLength(50000);
    expect(createSyntheticMemoryGraph(0).nodes.length).toBeGreaterThan(0);
    expect(createSyntheticMemoryGraph(-5).nodes.length).toBeGreaterThan(0);
  });

  it("keeps roughly three edges per node as the benchmark issue specifies", () => {
    for (const size of [2000, 10000, 50000]) {
      const graph = createSyntheticMemoryGraph(size);
      expect(graph.edges.length / graph.nodes.length).toBeGreaterThan(1.5);
      expect(graph.edges.length / graph.nodes.length).toBeLessThan(3.5);
    }
  });
});
