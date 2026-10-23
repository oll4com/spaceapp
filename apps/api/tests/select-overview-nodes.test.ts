import { describe, expect, it } from "vitest";
import { selectOverviewNodes } from "../src/memory-graph-routes.js";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";

describe("selectOverviewNodes limit budgeting", () => {
  const generateNodes = (count: number): MemoryGraphNode[] =>
    Array.from({ length: count }, (_, i) => ({
      id: `node-${i}`,
      type: i < 5 ? "SOURCE" : "MEMORY",
      label: i === 0 ? "gemini.md" : `Node ${i}`,
      sourcePath: `/opt/spaceapp/docs/doc-${i}.md`,
      recordId: i < 5 ? null : `rec-${i}`
    }));

  it("defaults to 2000-node cap when limit is unspecified", () => {
    const nodes = generateNodes(3000);
    const edges: MemoryGraphEdge[] = [];
    const selected = selectOverviewNodes(nodes, edges);
    expect(selected).toHaveLength(2000);
  });

  it("scales up to the requested limit (e.g. 50,000 nodes)", () => {
    const nodes = generateNodes(5000);
    const edges: MemoryGraphEdge[] = [];
    const selected = selectOverviewNodes(nodes, edges, 5000);
    expect(selected).toHaveLength(5000);
  });

  it("returns all nodes when total count is below limit", () => {
    const nodes = generateNodes(100);
    const edges: MemoryGraphEdge[] = [];
    const selected = selectOverviewNodes(nodes, edges, 2000);
    expect(selected).toHaveLength(100);
  });

  it("prioritizes core sources and tagged topics before generic memories", () => {
    const nodes = generateNodes(100);
    const edges: MemoryGraphEdge[] = [];
    const selected = selectOverviewNodes(nodes, edges, 2);
    expect(selected).toHaveLength(2);
    expect(selected.some(n => n.label === "gemini.md")).toBe(true);
  });
});
