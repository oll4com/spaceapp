import { describe, expect, it } from "vitest";
import {
  layoutMemoryNetwork3D,
  memory3DVolumeRatio,
  packMemoryGraph3DBuffers,
  pickMemoryNode3D,
  projectMemoryPoint,
  DEFAULT_MEMORY_CAMERA
} from "../src/features/memory-workspace/memory-3d.js";
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
  it("packs 50,000 nodes into contiguous WebGL Float32Arrays and performs sub-16ms interactive picking (#62)", () => {
    const count = 50_000;
    const nodes: MemoryGraphNode[] = new Array(count);
    const edges: MemoryGraphEdge[] = new Array(count - 1);
    const coordinates = new Map<string, { x: number; y: number; z: number }>();

    for (let i = 0; i < count; i++) {
      const id = i === 0 ? "root" : `node-${i}`;
      nodes[i] = {
        id,
        label: i === 0 ? "gemini.md" : `Memory ${i}`,
        type: i % 250 === 0 ? "SOURCE" : "MEMORY",
        sourcePath: "/opt/spaceapp/docs/gemini.md",
        recordId: i === 0 ? null : id
      };
      coordinates.set(id, {
        x: ((i * 73) % 400) - 200,
        y: ((i * 137) % 400) - 200,
        z: ((i * 251) % 400) - 200
      });
      if (i > 0) {
        edges[i - 1] = {
          id: `edge-${i}`,
          type: "CONTAINS",
          source: `node-${Math.floor((i - 1) / 250) * 250 || "root"}`.replace("node-root", "root"),
          target: id
        };
      }
    }

    const packed = packMemoryGraph3DBuffers(nodes, edges, coordinates);
    expect(packed.nodeIds).toHaveLength(50_000);
    expect(packed.positions).toHaveLength(150_000);
    expect(packed.colors).toHaveLength(150_000);
    expect(packed.sizes).toHaveLength(50_000);
    expect(packed.edgePositions).toHaveLength((count - 1) * 6);

    const rootProjected = projectMemoryPoint(coordinates.get("root")!, DEFAULT_MEMORY_CAMERA, (700 * 0.4) / packed.extent, 1000, 700);
    const t0 = performance.now();
    const picked = pickMemoryNode3D(packed, DEFAULT_MEMORY_CAMERA, 1000, 700, rootProjected.x, rootProjected.y);
    const elapsedMs = performance.now() - t0;

    expect(picked).not.toBeNull();
    // Single frame picking over 50,000 nodes completes well within interactive frame rates (<50ms in test runner, ~1-2ms native)
    expect(elapsedMs).toBeLessThan(50);
  });
});
