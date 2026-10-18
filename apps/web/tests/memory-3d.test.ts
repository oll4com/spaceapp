import { describe, expect, it } from "vitest";
import { createMemoryNetwork3DSimulation, layoutMemoryNetwork3D, memory3DVolumeRatio, projectMemoryPoint, DEFAULT_MEMORY_CAMERA, MEMORY_3D_LAYOUT_STEPS } from "../src/features/memory-workspace/memory-3d.js";
import { createMemoryAtlas } from "../src/features/memory-workspace/memory-atlas.js";
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
  it("streams independent snapshots from the same deterministic force simulation", () => {
    const { nodes, edges } = fixture();
    const simulation = createMemoryNetwork3DSimulation(nodes, edges);
    const initial = simulation.snapshot();
    const initialRecord = { ...initial.get("source-0-memory-0")! };
    expect(simulation.progress).toBe(0);
    expect(simulation.done).toBe(false);
    simulation.advance(7);
    expect(simulation.progress).toBe(7 / MEMORY_3D_LAYOUT_STEPS);
    expect(simulation.snapshot().get("source-0-memory-0")).not.toEqual(initialRecord);
    expect(initial.get("source-0-memory-0")).toEqual(initialRecord);
    simulation.advance(MEMORY_3D_LAYOUT_STEPS);
    expect(simulation.done).toBe(true);
    expect(simulation.progress).toBe(1);
    expect(simulation.snapshot()).toEqual(layoutMemoryNetwork3D(nodes, edges));
  });
  it("preserves the full 3D topology without changing the 2D tag threshold", () => {
    const nodes: MemoryGraphNode[] = [
      { id: "memory", label: "memory", type: "MEMORY", recordId: "memory", sourcePath: null },
      { id: "rare", label: "rare tag", type: "TOPIC", recordId: null, sourcePath: null }
    ];
    const edges: MemoryGraphEdge[] = [{ id: "tag", source: "memory", target: "rare", type: "TAGGED_WITH", origin: "EXPLICIT_TAG" }];
    expect(createMemoryAtlas(nodes, edges, false).nodes).toHaveLength(1);
    const full = createMemoryAtlas(nodes, edges, false, undefined, true);
    expect(full.nodes).toEqual(nodes);
    expect(full.edges).toEqual(edges);
    expect(full.positions.size).toBe(2);
  });
  it("advances a dense 50k archive with real springs and finite XYZ coordinates", () => {
    const nodes: MemoryGraphNode[] = [{ id: "root", label: "space.md", type: "SOURCE", recordId: null, sourcePath: "space.md" }];
    const edges: MemoryGraphEdge[] = [];
    for (let i = 1; i < 50_000; i++) {
      const id = `memory:${i}`;
      nodes.push({ id, label: id, type: "MEMORY", recordId: id, sourcePath: "space.md" });
      edges.push({ id, source: "root", target: id, type: "CONTAINS" });
    }
    const simulation = createMemoryNetwork3DSimulation(nodes, edges);
    const before = simulation.snapshot().get("memory:1");
    simulation.advance(2);
    const snapshot = simulation.snapshot();
    expect(snapshot.size).toBe(50_000);
    expect(snapshot.get("root")).toEqual({ x: 0, y: 0, z: 0 });
    expect(snapshot.get("memory:1")).not.toEqual(before);
    expect([...snapshot.values()].every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))).toBe(true);
    expect(memory3DVolumeRatio([...snapshot.values()])).toBeGreaterThan(0.8);
  });
});
