import { describe, expect, it, vi } from "vitest";
import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import {
  createMemory3DLayoutStepper,
  layoutMemoryNetwork3D,
  memory3DLayoutDensityScale,
  MemorySpatialPicker3D,
  selectMemory3DLabels,
  MAX_MEMORY_3D_LABELS_DRAWN,
  MAX_MEMORY_3D_LABELS_MEASURED,
  type MemoryProjectedPoint
} from "../src/features/memory-workspace/memory-3d.js";
import {
  buildMemoryGraphFocusEdges,
  buildMemoryGraphGLScene,
  buildMemoryGraphNodeStates,
  memoryGraphNodeBaseRadius,
  MEMORY_GRAPH_GL_NODE_STATE
} from "../src/features/memory-workspace/memory-graph-webgl.js";
import { createSyntheticMemoryGraph } from "../src/demo/synthetic-memory-graph.js";

const node = (id: string, type: MemoryGraphNode["type"], label = id): MemoryGraphNode =>
  ({ id, type, label, sourcePath: type === "SOURCE" ? `/${label}` : null, recordId: null });
const edge = (id: string, type: MemoryGraphEdge["type"], source: string, target: string): MemoryGraphEdge =>
  ({ id, type, source, target });

function fixtureGraph(count: number) {
  const nodes: MemoryGraphNode[] = [node("source:space", "SOURCE", "space.md")];
  const edges: MemoryGraphEdge[] = [];
  for (let i = 0; i < count - 1; i++) {
    nodes.push(node(`memory:${i}`, "MEMORY", `Memory ${i}`));
    edges.push(edge(`edge:${i}`, "CONTAINS", "source:space", `memory:${i}`));
  }
  return { nodes, edges };
}

describe("streaming 3D layout", () => {
  it("density scale is exactly 1 at and below the historical size", () => {
    expect(memory3DLayoutDensityScale(0)).toBe(1);
    expect(memory3DLayoutDensityScale(373)).toBe(1);
    expect(memory3DLayoutDensityScale(2000)).toBe(1);
    expect(memory3DLayoutDensityScale(50000)).toBeCloseTo(Math.cbrt(25), 5);
  });

  it("stepper in chunks reproduces the one-shot layout exactly", () => {
    const { nodes, edges } = fixtureGraph(373);
    const expected = layoutMemoryNetwork3D(nodes, edges);
    const stepper = createMemory3DLayoutStepper(nodes, edges);
    expect(stepper.totalSteps).toBe(180);
    let guard = 0;
    while (!stepper.done && guard++ < 1000) stepper.step(7);
    expect(stepper.stepsCompleted).toBe(180);
    const actual = stepper.positions();
    expect(actual.size).toBe(expected.size);
    for (const [id, point] of expected) expect(actual.get(id)).toEqual(point);
  });

  it("partial positions are available and finite while streaming", () => {
    const { nodes, edges } = fixtureGraph(120);
    const stepper = createMemory3DLayoutStepper(nodes, edges);
    stepper.step(10);
    expect(stepper.done).toBe(false);
    const partial = stepper.positions();
    expect(partial.size).toBe(120);
    for (const point of partial.values()) {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
      expect(Number.isFinite(point.z)).toBe(true);
    }
    // The core stays pinned at the origin at every step.
    expect(partial.get("source:space")).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("stays deterministic and input-order independent above 2,000 nodes", () => {
    const { nodes, edges } = createSyntheticMemoryGraph(3000);
    const forward = layoutMemoryNetwork3D(nodes, edges);
    const reversed = layoutMemoryNetwork3D([...nodes].reverse(), [...edges].reverse());
    expect(reversed.size).toBe(forward.size);
    for (const [id, point] of forward) {
      const other = reversed.get(id)!;
      expect(other.x).toBeCloseTo(point.x, 10);
      expect(other.y).toBeCloseTo(point.y, 10);
      expect(other.z).toBeCloseTo(point.z, 10);
    }
  }, 60000);
});

describe("spatial picker", () => {
  const points: MemoryProjectedPoint[] = [
    { id: "near", x: 100, y: 100, z: -5, radius: 3 },
    { id: "far", x: 103, y: 100, z: 40, radius: 3 },
    { id: "edge", x: 300, y: 300, z: 0, radius: 1 }
  ];
  it("picks the front-most point inside the threshold", () => {
    const picker = new MemorySpatialPicker3D(points, 800, 600);
    expect(picker.pick(102, 100)).toBe("near");
    expect(picker.pick(300, 306)).toBe("edge");
  });
  it("misses outside the threshold and on empty space", () => {
    const picker = new MemorySpatialPicker3D(points, 800, 600);
    expect(picker.pick(300, 309)).toBeNull();
    expect(picker.pick(10, 10)).toBeNull();
    expect(new MemorySpatialPicker3D([], 800, 600).pick(0, 0)).toBeNull();
  });
  it("agrees with the old reverse linear scan on a random cloud", () => {
    let seed = 42;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const cloud: MemoryProjectedPoint[] = Array.from({ length: 4000 }, (_, i) => ({
      id: `n${i}`, x: random() * 1600, y: random() * 1200, z: random() * 200 - 100, radius: 2 + random() * 4
    }));
    // Draw order is z descending; the old scan reversed it (nearest first).
    const drawOrder = [...cloud].sort((a, b) => b.z - a.z);
    const legacy = (x: number, y: number) => [...drawOrder].reverse()
      .find(p => Math.hypot(p.x - x, p.y - y) < Math.max(7, p.radius + 3))?.id ?? null;
    const picker = new MemorySpatialPicker3D(cloud, 1600, 1200);
    for (let i = 0; i < 300; i++) {
      const x = random() * 1600, y = random() * 1200;
      expect(picker.pick(x, y)).toBe(legacy(x, y));
    }
  });
});

describe("label level of detail", () => {
  const measure = vi.fn((text: string) => text.length * 6);
  it("bounds measured and drawn labels whatever the graph size", () => {
    measure.mockClear();
    const candidates = Array.from({ length: 5000 }, (_, i) => ({
      id: `memory:${i}`, label: `Memory ${i}`, type: "SOURCE" as const,
      x: (i % 100) * 16, y: Math.floor(i / 100) * 18 + 20, isFocus: false
    }));
    const placed = selectMemory3DLabels(candidates, { width: 1600, height: 1000, zoom: 1, measure });
    expect(placed.length).toBeLessThanOrEqual(MAX_MEMORY_3D_LABELS_DRAWN);
    expect(placed.length).toBeGreaterThan(0);
    expect(measure.mock.calls.length).toBeLessThanOrEqual(MAX_MEMORY_3D_LABELS_MEASURED);
  });
  it("keeps the zoom gate, priority order, truncation and collision rules", () => {
    const gated = selectMemory3DLabels(
      [{ id: "m", label: "Plain memory", type: "MEMORY", x: 100, y: 100, isFocus: false }],
      { width: 800, height: 600, zoom: 1, measure }
    );
    expect(gated).toHaveLength(0);
    const zoomed = selectMemory3DLabels(
      [{ id: "m", label: "Plain memory", type: "MEMORY", x: 100, y: 100, isFocus: false }],
      { width: 800, height: 600, zoom: 1.6, measure }
    );
    expect(zoomed).toHaveLength(1);
    const long = "x".repeat(60);
    const [truncated] = selectMemory3DLabels(
      [{ id: "s", label: long, type: "SOURCE", x: 10, y: 100, isFocus: false }],
      { width: 800, height: 600, zoom: 1, measure }
    );
    expect(truncated!.text).toBe(`${"x".repeat(45)}…`);
    const collided = selectMemory3DLabels(
      [
        { id: "a", label: "First source label", type: "SOURCE", x: 100, y: 100, isFocus: false },
        { id: "b", label: "Second source label", type: "SOURCE", x: 104, y: 104, isFocus: false }
      ],
      { width: 800, height: 600, zoom: 1, measure: () => 120 }
    );
    expect(collided.map(label => label.id)).toEqual(["a"]);
    const focused = selectMemory3DLabels(
      [
        { id: "core", label: "space.md", type: "SOURCE", x: 100, y: 100, isFocus: false },
        { id: "focus", label: "Focused memory", type: "MEMORY", x: 300, y: 300, isFocus: true }
      ],
      { width: 800, height: 600, zoom: 1, measure }
    );
    expect(focused.map(label => label.id)).toEqual(["focus", "core"]);
    expect(focused[1]!.isCore).toBe(true);
  });
});

describe("WebGL scene building (pure)", () => {
  it("builds instanced buffers with the Canvas look's radii, glow and colors", () => {
    const { nodes, edges } = fixtureGraph(3);
    const coordinates = new Map([
      ["source:space", { x: 0, y: 0, z: 0 }],
      ["memory:0", { x: 30, y: 0, z: 0 }],
      ["memory:1", { x: 0, y: 40, z: 0 }]
    ]);
    const atlasPositions = new Map([
      ["source:space", { x: 0, y: 0, color: "#ffffff", hub: true, groupId: "g" }],
      ["memory:0", { x: 1, y: 1, color: "#7395ad", hub: false, groupId: "g" }],
      ["memory:1", { x: 2, y: 2, color: "#7395ad", hub: false, groupId: "g" }]
    ]);
    const scene = buildMemoryGraphGLScene({ nodes, edges, coordinates, atlasPositions });
    expect(scene.nodeCount).toBe(3);
    expect(scene.edgeCount).toBe(2);
    expect(memoryGraphNodeBaseRadius(nodes[0]!)).toBe(10);
    expect(scene.nodeRadii[0]).toBe(10);
    expect(scene.nodeRadii[1]).toBeCloseTo(2.1, 5);
    expect(scene.nodeRadii[2]).toBeCloseTo(2.1, 5);
    expect(scene.nodeGlow[0]).toBe(1);
    expect(scene.nodeGlow[1]).toBe(0);
    expect(scene.extent).toBeGreaterThanOrEqual(60);
    expect(scene.nodeStates.every(state => state === 0)).toBe(true);
  });
  it("derives focus states and the incident-edge overlay", () => {
    const { nodes, edges } = fixtureGraph(4);
    const coordinates = new Map(nodes.map((n, i) => [n.id, { x: i * 10, y: 0, z: 0 }]));
    const focusEdges = buildMemoryGraphFocusEdges({ edges, coordinates, focusId: "memory:1" });
    expect(focusEdges.count).toBe(1);
    expect([...focusEdges.neighborIds]).toEqual(["source:space"]);
    const states = buildMemoryGraphNodeStates(4, 2, new Set([0]));
    expect(states[2]).toBe(MEMORY_GRAPH_GL_NODE_STATE.FOCUS);
    expect(states[0]).toBe(MEMORY_GRAPH_GL_NODE_STATE.NEIGHBOR);
    expect(states[1]).toBe(MEMORY_GRAPH_GL_NODE_STATE.DIMMED);
    expect(buildMemoryGraphNodeStates(4, -1, new Set()).every(state => state === 0)).toBe(true);
  });
});

describe("synthetic demo graph", () => {
  it("generates a deterministic graph of exactly the requested size", () => {
    const first = createSyntheticMemoryGraph(50000);
    const second = createSyntheticMemoryGraph(50000);
    expect(first.nodes).toHaveLength(50000);
    expect(first.edges.length).toBeGreaterThan(140000);
    expect(first.edges.length).toBeLessThanOrEqual(150000);
    expect(second.nodes).toHaveLength(50000);
    expect(second.edges).toHaveLength(first.edges.length);
    expect(first.nodes[12345]).toEqual(second.nodes[12345]);
    expect(first.nodes[0]).toMatchObject({ type: "SOURCE", label: "space.md" });
    const ids = new Set(first.nodes.map(n => n.id));
    expect(first.edges.every(e => ids.has(e.source) && ids.has(e.target))).toBe(true);
  }, 60000);
  it("scales down cleanly", () => {
    const small = createSyntheticMemoryGraph(100);
    expect(small.nodes).toHaveLength(100);
    expect(small.edges.length).toBeGreaterThan(200);
  });
});
