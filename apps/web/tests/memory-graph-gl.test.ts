import { describe, expect, it, vi } from "vitest";
import { decodePickId, encodePickId, parseHexColor } from "../src/features/memory-workspace/memory-graph-gl.js";
import { memoryGraphLabelBudget, planMemoryGraphLabels, type MemoryGraphLabelCandidate } from "../src/features/memory-workspace/memory-graph-labels.js";
import { createSyntheticMemoryGraph, demoGraphSizeFromSearch } from "../src/demo/demo-synthetic-graph.js";

describe("memory graph picking ids", () => {
  it("round-trips node indices through the RGB encoding", () => {
    for (const index of [0, 1, 2, 254, 255, 256, 4096, 49_999, 65_535, 65_536, 1_000_000]) {
      const [r, g, b] = encodePickId(index);
      expect(decodePickId(r, g, b)).toBe(index);
    }
  });
  it("decodes the cleared background as no node", () => {
    expect(decodePickId(0, 0, 0)).toBe(-1);
  });
  it("parses hex colors and rejects invalid ones", () => {
    const [r, g, b] = parseHexColor("#98dafa");
    expect(r).toBeCloseTo(0.596, 2);
    expect(g).toBeCloseTo(0.855, 2);
    expect(b).toBeCloseTo(0.98, 2);
    expect(parseHexColor("not-a-color")).toEqual([0, 0, 0]);
  });
});

describe("memory graph label planning", () => {
  const candidate = (id: string, x: number, y: number, overrides: Partial<MemoryGraphLabelCandidate> = {}): MemoryGraphLabelCandidate => ({
    id, label: id, x, y, core: false, eligible: true, ...overrides
  });
  const plan = (candidates: MemoryGraphLabelCandidate[], options: Partial<{ width: number; height: number; maxLabels: number; maxMeasured: number }> = {}) =>
    planMemoryGraphLabels(candidates, { width: 800, height: 600, maxLabels: 10, maxMeasured: 30, measure: label => label.length * 6, ...options });

  it("caps the number of placed labels whatever the candidate count", () => {
    const candidates = Array.from({ length: 500 }, (_, i) => candidate(`n${i}`, (i % 20) * 40, Math.floor(i / 20) * 24 + 20));
    expect(plan(candidates, { maxLabels: 7 })).toHaveLength(7);
  });
  it("measures at most the bounded number of labels per frame", () => {
    const measure = vi.fn((label: string) => label.length * 6);
    const candidates = Array.from({ length: 500 }, (_, i) => candidate(`n${i}`, 10, 20 + i));
    planMemoryGraphLabels(candidates, { width: 800, height: 600, maxLabels: 100, maxMeasured: 5, measure });
    expect(measure.mock.calls.length).toBeLessThanOrEqual(5);
  });
  it("never measures ineligible candidates", () => {
    const measure = vi.fn((label: string) => label.length * 6);
    planMemoryGraphLabels([candidate("a", 10, 20, { eligible: false }), candidate("b", 10, 40)], { width: 800, height: 600, maxLabels: 10, maxMeasured: 30, measure });
    expect(measure.mock.calls.map(call => call[0])).toEqual(["b"]);
  });
  it("avoids collisions and off-canvas labels with the historical rules", () => {
    const placed = plan([
      candidate("first", 100, 100),
      candidate("overlapping", 104, 104),
      candidate("off-right", 790, 100),
      candidate("too-high", 100, 10),
      candidate("second-row", 100, 140)
    ]);
    expect(placed.map(item => item.id)).toEqual(["first", "second-row"]);
    expect(placed[0]).toMatchObject({ x: 109, y: 100, width: 30 });
  });
  it("keeps priority order: earlier candidates win contested space", () => {
    const placed = plan([candidate("focus", 100, 100), candidate("core", 102, 102)]);
    expect(placed.map(item => item.id)).toEqual(["focus"]);
  });
  it("shrinks the label budget as the camera zooms out (level of detail)", () => {
    expect(memoryGraphLabelBudget(0.5).maxLabels).toBeLessThan(memoryGraphLabelBudget(1.2).maxLabels);
    expect(memoryGraphLabelBudget(1.2).maxLabels).toBeLessThan(memoryGraphLabelBudget(2.5).maxLabels);
    expect(memoryGraphLabelBudget(2.5).maxMeasured).toBe(memoryGraphLabelBudget(2.5).maxLabels * 3);
  });
});

describe("synthetic demo graph", () => {
  it("generates a deterministic graph of the requested size with valid edges", () => {
    const first = createSyntheticMemoryGraph(2000);
    const second = createSyntheticMemoryGraph(2000);
    expect(first.nodes).toHaveLength(2000);
    expect(first).toEqual(second);
    const ids = new Set(first.nodes.map(node => node.id));
    expect(first.nodes.some(node => node.type === "SOURCE" && node.label === "space.md")).toBe(true);
    expect(first.edges.every(edge => ids.has(edge.source) && ids.has(edge.target))).toBe(true);
    // Roughly three edges per node, like the 50k/150k benchmark shape.
    expect(first.edges.length).toBeGreaterThan(2000 * 2.5);
    expect(first.edges.length).toBeLessThan(2000 * 3.2);
  });
  it("reads the demo graph size from the URL query", () => {
    expect(demoGraphSizeFromSearch("?demoGraphSize=50000")).toBe(50000);
    expect(demoGraphSizeFromSearch("?demoGraphSize=2000")).toBe(2000);
    expect(demoGraphSizeFromSearch("")).toBeNull();
    expect(demoGraphSizeFromSearch("?demoGraphSize=abc")).toBeNull();
    expect(demoGraphSizeFromSearch("?demoGraphSize=50")).toBeNull();
    expect(demoGraphSizeFromSearch("?demoGraphSize=999999")).toBeNull();
  });
});
