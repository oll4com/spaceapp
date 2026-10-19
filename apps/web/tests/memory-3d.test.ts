import { describe, expect, it } from "vitest";
import { layoutMemoryNetwork3D, layoutMemoryNetwork3DStream, memory3DVolumeRatio, projectMemoryPoint, projectMemoryPointsBatch, DEFAULT_MEMORY_CAMERA } from "../src/features/memory-workspace/memory-3d.js";
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
});

describe("layout streaming (issue #62)", () => {
  const streamingFixture = () => {
    const nodes: MemoryGraphNode[] = [{ id: "root", label: "gemini.md", type: "SOURCE", sourcePath: "/opt/spaceapp/docs/gemini.md", recordId: null }];
    const edges: MemoryGraphEdge[] = [];
    for (let file = 0; file < 3; file += 1) {
      const id = `source-${file}`;
      nodes.push({ id, label: `${id}.md`, type: "SOURCE", sourcePath: `/opt/spaceapp/docs/${id}.md`, recordId: null });
      edges.push({ id: `derived-${file}`, type: "DERIVED_FROM", source: "root", target: id });
      for (let item = 0; item < 8; item += 1) {
        const memory = `${id}-memory-${item}`;
        nodes.push({ id: memory, label: memory, type: "MEMORY", sourcePath: `/opt/spaceapp/docs/${id}.md`, recordId: memory });
        edges.push({ id: memory, type: "CONTAINS", source: id, target: memory });
      }
    }
    return { nodes, edges };
  };
  it("yields bounded progress snapshots and lands on the synchronous layout", () => {
    const { nodes, edges } = streamingFixture();
    const iterator = layoutMemoryNetwork3DStream(nodes, edges, 48, 12);
    const yielded: Array<{ step: number; totalSteps: number; positions: Map<string, { x: number; y: number; z: number }> }> = [];
    let result = iterator.next();
    while (!result.done) {
      yielded.push(result.value);
      result = iterator.next();
    }
    expect(yielded.map((snapshot) => snapshot.step)).toEqual([12, 24, 36, 48]);
    for (const snapshot of yielded) {
      expect(snapshot.totalSteps).toBe(48);
      expect(snapshot.positions.size).toBe(nodes.length);
      expect([...snapshot.positions.values()].every(point => Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z))).toBe(true);
    }
    expect(yielded[0]!.positions.get("root")).toEqual({ x: 0, y: 0, z: 0 });
    // With default parameters the streamed result equals the synchronous layout.
    const defaultStream = layoutMemoryNetwork3DStream(nodes, edges);
    let defaultResult = defaultStream.next();
    while (!defaultResult.done) defaultResult = defaultStream.next();
    expect(defaultResult.value).toEqual(layoutMemoryNetwork3D(nodes, edges));
    // The view refines while converging: intermediate positions differ from the final ones.
    expect([...yielded[0]!.positions.values()]).not.toEqual([...defaultResult.value.values()]);
  });
  it("projects batches identically to the single-point projection", () => {
    const points = [{ x: 10, y: 20, z: 30 }, { x: -40, y: 5, z: -5 }];
    const camera = { ...DEFAULT_MEMORY_CAMERA, yaw: 0.7, pitch: 0.2, zoom: 1.4 };
    const batch = projectMemoryPointsBatch(points, camera, 2, 800, 600);
    points.forEach((point, index) => {
      const single = projectMemoryPoint(point, camera, 2, 800, 600);
      expect(batch[index]!.x).toBeCloseTo(single.x);
      expect(batch[index]!.y).toBeCloseTo(single.y);
      expect(batch[index]!.z).toBeCloseTo(single.z);
    });
  });
});
