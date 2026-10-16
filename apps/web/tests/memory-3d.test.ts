import { describe, expect, it } from "vitest";
import {
  layoutMemoryNetwork3D,
  memory3DVolumeRatio,
  projectMemoryPoint,
  DEFAULT_MEMORY_CAMERA,
  SpatialPickingIndex,
  selectVisibleLabels,
  type MemoryPoint3D
} from "../src/features/memory-workspace/memory-3d.js";
import { generateSyntheticMemoryGraph } from "../src/demo/synthetic-memory.js";
import { createMemoryAtlas } from "../src/features/memory-workspace/memory-atlas.js";
import { isMemoryCoreLabel } from "../src/features/memory-workspace/memory-graph-visuals.js";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";

describe("3D memory projection", () => {
  it("rotates all three axes through a full turn and returns to the same view", () => {
    const point = { x: 45, y: 20, z: 60 };
    const initial = projectMemoryPoint(point, DEFAULT_MEMORY_CAMERA, 2, 1000, 700);
    const rotated = projectMemoryPoint(point, { ...DEFAULT_MEMORY_CAMERA, yaw: DEFAULT_MEMORY_CAMERA.yaw + Math.PI / 2 }, 2, 1000, 700);
    const full = projectMemoryPoint(point, { ...DEFAULT_MEMORY_CAMERA, yaw: DEFAULT_MEMORY_CAMERA.yaw + Math.PI * 2, pitch: DEFAULT_MEMORY_CAMERA.pitch + Math.PI * 2 }, 2, 1000, 700);
    expect(rotated.x).not.toBeCloseTo(initial.x);
    expect(rotated.z).not.toBeCloseTo(initial.z);
    expect(full.x).toBeCloseTo(initial.x);
    expect(full.y).toBeCloseTo(initial.y);
    expect(full.z).toBeCloseTo(initial.z);
  });

  it("scales perspective correctly and avoids division by zero or NaN", () => {
    const near = projectMemoryPoint({ x: 0, y: 0, z: -200 }, DEFAULT_MEMORY_CAMERA, 1, 1000, 700);
    const far = projectMemoryPoint({ x: 0, y: 0, z: 200 }, DEFAULT_MEMORY_CAMERA, 1, 1000, 700);
    expect(near.perspective).toBeGreaterThan(far.perspective);

    // Deep negative z clamps safely at denominator >= 120
    const extreme = projectMemoryPoint({ x: 0, y: 0, z: -10000 }, DEFAULT_MEMORY_CAMERA, 1, 1000, 700);
    expect(Number.isFinite(extreme.x)).toBe(true);
    expect(Number.isFinite(extreme.y)).toBe(true);
    expect(extreme.perspective).toBeLessThanOrEqual(650 / 120);
  });

  const fixture = () => {
    const nodes: MemoryGraphNode[] = [{ id: "root", label: "gemini.md", type: "SOURCE", sourcePath: "/opt/spaceapp/docs/gemini.md", recordId: null }];
    const edges: MemoryGraphEdge[] = [];
    for (let file = 0; file < 12; file++) {
      const id = `source-${file}`;
      nodes.push({ id, label: `${id}.md`, type: "SOURCE", sourcePath: `/opt/spaceapp/docs/${id}.md`, recordId: null });
      edges.push({ id: `file-${file}`, type: "DERIVED_FROM", source: "root", target: id });
      for (let item = 0; item < 30; item++) {
        const memory = `${id}-memory-${item}`;
        nodes.push({ id: memory, label: memory, type: "MEMORY", sourcePath: `/opt/spaceapp/docs/${id}.md`, recordId: memory });
        edges.push({ id: memory, type: "CONTAINS", source: id, target: memory });
      }
    }
    return { nodes, edges };
  };

  it("occupies a volume, including at a side-on camera angle", () => {
    const { nodes, edges } = fixture();
    const layout = layoutMemoryNetwork3D(nodes, edges);
    expect(layout.size).toBe(nodes.length);
    expect(layout.get("root")).toEqual({ x: 0, y: 0, z: 0 });
    expect(memory3DVolumeRatio([...layout.values()])).toBeGreaterThan(0.35);
    for (const yaw of [0, Math.PI / 2, Math.PI]) {
      const points = [...layout.values()].map(p => projectMemoryPoint(p, { yaw, pitch: 0, zoom: 1 }, 1, 1000, 700));
      const width = Math.max(...points.map(p => p.x)) - Math.min(...points.map(p => p.x));
      const height = Math.max(...points.map(p => p.y)) - Math.min(...points.map(p => p.y));
      expect(width / height).toBeGreaterThan(0.5);
      expect(width / height).toBeLessThan(2);
    }
  });

  it("keeps real source links close and is deterministic under input reordering", () => {
    const { nodes, edges } = fixture();
    const layout = layoutMemoryNetwork3D(nodes, edges);
    const reversed = layoutMemoryNetwork3D([...nodes].reverse(), [...edges].reverse());
    expect([...reversed]).toEqual([...layout]);
    const distance = (a: string, b: string) => { const p = layout.get(a)!, q = layout.get(b)!; return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z); };
    const related = edges.filter(edge => edge.type === "CONTAINS");
    const meanLink = related.reduce((sum, edge) => sum + distance(edge.source, edge.target), 0) / related.length;
    const meanUnrelated = related.reduce((sum, edge) => sum + distance(edge.source === "source-0" ? "source-6" : "source-0", edge.target), 0) / related.length;
    expect(meanLink).toBeLessThan(meanUnrelated * 0.7);
  });

  it("detects flat geometry even if the plane is tilted", () => {
    const plane = Array.from({ length: 100 }, (_, i) => ({ x: i % 10, y: Math.floor(i / 10), z: i % 10 + Math.floor(i / 10) }));
    expect(memory3DVolumeRatio(plane)).toBeCloseTo(0);
    expect(layoutMemoryNetwork3D([], []).size).toBe(0);
  });

  it("streams incremental layout updates via progress callback and converges deterministically", () => {
    const { nodes, edges } = fixture();
    const stepsEmitted: number[] = [];
    const layoutWithProgress = layoutMemoryNetwork3D(nodes, edges, {
      streamInterval: 30,
      onProgress: ({ step, totalSteps, positions }) => {
        stepsEmitted.push(step);
        expect(totalSteps).toBe(180);
        expect(positions.size).toBe(nodes.length);
      }
    });

    const directLayout = layoutMemoryNetwork3D(nodes, edges);
    expect([...layoutWithProgress]).toEqual([...directLayout]);
    expect(stepsEmitted.length).toBeGreaterThanOrEqual(4);
    expect(stepsEmitted).toContain(180);
  });

  it("picks nodes in under 4ms at 50,000 nodes using spatial index", () => {
    const N = 50_000;
    const points: Array<{ id: string; x: number; y: number; z: number; radius: number }> = [];

    // Distribute 50,000 points across a 1000x800 viewport
    for (let i = 0; i < N; i++) {
      points.push({
        id: `node-${i}`,
        x: (i * 37) % 1000,
        y: (i * 71) % 800,
        z: (i % 200) - 100,
        radius: 2 + (i % 5)
      });
    }

    const index = new SpatialPickingIndex(points, 32);

    // Warm up
    index.findHit(500, 400);

    // Benchmark 100 picks
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      const hit = index.findHit((i * 13) % 1000, (i * 29) % 800);
      expect(hit !== undefined).toBe(true);
    }
    const elapsed = performance.now() - start;
    const perPickMs = elapsed / 100;

    // Requirement: picking takes at most 4 ms at 50k nodes
    expect(perPickMs).toBeLessThan(4);

    // Test front-most object preference (smaller z is closer)
    const overlappingIndex = new SpatialPickingIndex([
      { id: "back", x: 100, y: 100, z: 50, radius: 10 },
      { id: "front", x: 100, y: 100, z: -50, radius: 10 }
    ], 32);
    expect(overlappingIndex.findHit(100, 100)).toBe("front");
  });

  it("filters and bounds visible labels using LOD and collision avoidance", () => {
    const nodes: MemoryGraphNode[] = [
      { id: "core", label: "Workspace Core", type: "SOURCE", sourcePath: "/core.md", recordId: null },
      { id: "source-1", label: "Architecture.md", type: "SOURCE", sourcePath: "/arch.md", recordId: null }
    ];
    for (let i = 0; i < 500; i++) {
      nodes.push({ id: `mem-${i}`, label: `Memory ${i} title`, type: "MEMORY", sourcePath: "/doc.md", recordId: `rec-${i}` });
    }

    const coordinates = new Map<string, MemoryPoint3D>();
    for (let i = 0; i < nodes.length; i++) {
      coordinates.set(nodes[i]!.id, { x: (i % 20) * 200, y: Math.floor(i / 20) * 50, z: 0 });
    }

    // Low zoom (< 1.6): non-source nodes without focus are hidden
    const lowZoomLabels = selectVisibleLabels({
      nodes,
      coordinates,
      camera: { yaw: 0, pitch: 0, zoom: 1.0 },
      scale: 1,
      width: 1000,
      height: 800,
      focus: null,
      neighbors: new Set(),
      maxLabels: 50,
      measureText: t => t.length * 7
    });

    expect(lowZoomLabels.some(l => l.id === "core")).toBe(true);
    expect(lowZoomLabels.some(l => l.id === "source-1")).toBe(true);
    // Non-source nodes should not be present at low zoom without focus
    expect(lowZoomLabels.filter(l => l.id.startsWith("mem-")).length).toBe(0);

    // Focused node is always shown, even if non-source at low zoom
    coordinates.set("mem-42", { x: 50, y: 50, z: 0 });
    const focusedLabels = selectVisibleLabels({
      nodes,
      coordinates,
      camera: { yaw: 0, pitch: 0, zoom: 1.0 },
      scale: 1,
      width: 1000,
      height: 800,
      focus: "mem-42",
      neighbors: new Set(),
      maxLabels: 50,
      measureText: t => t.length * 7
    });
    expect(focusedLabels.some(l => l.id === "mem-42")).toBe(true);

    // Collision avoidance: two overlapping labels should not both be included
    const collidingCoordinates = new Map<string, MemoryPoint3D>([
      ["source-1", { x: 0, y: 0, z: 0 }],
      ["source-2", { x: 0.1, y: 0.1, z: 0 }]
    ]);
    const collidingNodes: MemoryGraphNode[] = [
      { id: "source-1", label: "First Doc.md", type: "SOURCE", sourcePath: "/1.md", recordId: null },
      { id: "source-2", label: "Second Doc.md", type: "SOURCE", sourcePath: "/2.md", recordId: null }
    ];
    const collidingResult = selectVisibleLabels({
      nodes: collidingNodes,
      coordinates: collidingCoordinates,
      camera: { yaw: 0, pitch: 0, zoom: 1.0 },
      scale: 1,
      width: 1000,
      height: 800,
      focus: null,
      neighbors: new Set(),
      maxLabels: 50,
      measureText: t => t.length * 7
    });
    expect(collidingResult.length).toBe(1);

    // Hard bounded limit
    const boundedResult = selectVisibleLabels({
      nodes,
      coordinates,
      camera: { yaw: 0, pitch: 0, zoom: 2.0 },
      scale: 1,
      width: 1000,
      height: 800,
      focus: null,
      neighbors: new Set(),
      maxLabels: 25,
      measureText: t => t.length * 7
    });
    expect(boundedResult.length).toBeLessThanOrEqual(25);
  });

  it("generates synthetic memory graphs of 2k, 10k, and 50k nodes with ~3x edges", () => {
    const graph2k = generateSyntheticMemoryGraph(2_000);
    expect(graph2k.nodes.length).toBe(2_000);
    expect(graph2k.edges.length).toBeGreaterThanOrEqual(5_900);
    expect(graph2k.edges.length).toBeLessThanOrEqual(6_100);
    expect(graph2k.nodes[0]!.label).toBe("space.md");

    const graph10k = generateSyntheticMemoryGraph(10_000);
    expect(graph10k.nodes.length).toBe(10_000);
    expect(graph10k.edges.length).toBeGreaterThanOrEqual(29_000);

    const graph50k = generateSyntheticMemoryGraph(50_000);
    expect(graph50k.nodes.length).toBe(50_000);
    expect(graph50k.edges.length).toBeGreaterThanOrEqual(148_000);

    // Deterministic check
    const repeat2k = generateSyntheticMemoryGraph(2_000);
    expect(repeat2k.nodes[10]!.id).toBe(graph2k.nodes[10]!.id);
    expect(repeat2k.edges[100]!.id).toBe(graph2k.edges[100]!.id);

    // Verify createMemoryAtlas preserves all nodes including topics and core
    const atlas2k = createMemoryAtlas(graph2k.nodes, graph2k.edges, false);
    expect(atlas2k.nodes.length).toBe(2_000);
    expect(atlas2k.nodes.some(n => isMemoryCoreLabel(n.label))).toBe(true);
  });
});
