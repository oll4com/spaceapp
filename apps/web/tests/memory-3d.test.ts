import { describe, expect, it } from "vitest";
import { layoutMemoryNetwork3D, layoutMemoryNetwork3DIncremental, memory3DVolumeRatio, projectMemoryPoint, DEFAULT_MEMORY_CAMERA } from "../src/features/memory-workspace/memory-3d.js";
import { generateSyntheticMemoryGraph } from "../src/demo/synthetic-memory.js";
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
  it("streams incremental progress during layout and produces identical deterministic final result", async () => {
    const { nodes, edges } = fixture();
    const progressSteps: number[] = [];
    const incrementalResult = await new Promise<Map<string, any>>((resolve) => {
      layoutMemoryNetwork3DIncremental(nodes, edges, (intermediate: any, step: number, done: boolean) => {
        progressSteps.push(step);
        if (done) resolve(intermediate);
      }, 30);
    });
    const standardResult = layoutMemoryNetwork3D(nodes, edges);
    expect(progressSteps.length).toBeGreaterThanOrEqual(5);
    expect(progressSteps).toContain(180);
    expect([...incrementalResult]).toEqual([...standardResult]);
  });
  it("generates deterministic synthetic graphs across small and large scales", () => {
    const graph2k = generateSyntheticMemoryGraph(2000, 3);
    expect(graph2k.nodes.length).toBe(2000);
    expect(graph2k.edges.length).toBe(6000);
    expect(graph2k.summary.nodeCount).toBe(2000);
    expect(graph2k.summary.edgeCount).toBe(6000);

    const graph10k = generateSyntheticMemoryGraph(10000, 3);
    expect(graph10k.nodes.length).toBe(10000);
    expect(graph10k.edges.length).toBe(30000);

    const graph50k = generateSyntheticMemoryGraph(50000, 3);
    expect(graph50k.nodes.length).toBe(50000);
    expect(graph50k.edges.length).toBe(150000);
    expect(graph50k.summary.nodeCount).toBe(50000);
    expect(graph50k.summary.edgeCount).toBe(150000);

    // Verify first source links to root (no dangling source:file-0)
    const firstSourceEdge = graph50k.edges.find(e => e.id === "edge:source-link-1");
    expect(firstSourceEdge?.source).toBe("source:core-root");
  });

  it("roundtrips picking color encoding and decoding with boundary indices", async () => {
    const { encodePickingColor, decodePickingColor } = await import("../src/features/memory-workspace/memory-graph-webgl.js");
    const testIndices = [0, 1, 254, 255, 256, 1000, 49999];
    for (const index of testIndices) {
      const [r, g, b] = encodePickingColor(index);
      const decoded = decodePickingColor(r, g, b, 255);
      expect(decoded).toBe(index);
    }
    // Transparent pixel must decode to -1 (miss)
    expect(decodePickingColor(0, 0, 0, 0)).toBe(-1);
    expect(decodePickingColor(255, 255, 255, 0)).toBe(-1);
  });
});
