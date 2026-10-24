import { describe, expect, it } from "vitest";
import { layoutMemoryNetwork3D, memory3DVolumeRatio, projectMemoryPoint, DEFAULT_MEMORY_CAMERA } from "../src/features/memory-workspace/memory-3d.js";
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

import {
  buildProjectedSpatialIndex,
  MAX_VISIBLE_LABELS_3D,
  pickMemoryNodeAt,
  selectVisibleMemoryLabelsLOD,
  type ProjectedMemoryNode
} from "../src/features/memory-workspace/memory-3d.js";
import { listMemoryGraphOverviewQuerySchema } from "@space/contracts";
import { selectOverviewNodes } from "../../api/src/memory-graph-routes.js";

describe("50,000-node spatial picking, label LOD, incremental streaming, and overview limit (#62)", () => {
  it("picks the front-most node among 50,000 projected nodes in under 4 ms using spatial grid indexing", () => {
    const projected: ProjectedMemoryNode[] = Array.from({ length: 50_000 }, (_, i) => ({
      id: `node-${i}`,
      x: (i % 250) * 8,
      y: Math.floor(i / 250) * 8,
      z: 100 + (i % 50),
      perspective: 0.85,
      radius: 2.5
    }));
    // Add an overlapping closer node at the same screen coordinate as node-12550
    const targetX = (12550 % 250) * 8;
    const targetY = Math.floor(12550 / 250) * 8;
    projected.push({
      id: "node-frontmost",
      x: targetX + 1,
      y: targetY - 1,
      z: 10,
      perspective: 0.95,
      radius: 3.0
    });

    const index = buildProjectedSpatialIndex(projected);
    const t0 = performance.now();
    const hitId = pickMemoryNodeAt(index, targetX, targetY);
    const elapsedMs = performance.now() - t0;

    expect(hitId).toBe("node-frontmost");
    expect(elapsedMs).toBeLessThan(4);
  });

  it("bounds visible labels per frame and prioritizes focus, core, and source nodes", () => {
    const { nodes } = {
      nodes: [
        { id: "core-1", label: "gemini.md", type: "SOURCE" as const, sourcePath: "/gemini.md", recordId: null },
        { id: "src-1", label: "notes.md", type: "SOURCE" as const, sourcePath: "/notes.md", recordId: null },
        ...Array.from({ length: 500 }, (_, i) => ({
          id: `mem-${i}`,
          label: `Memory ${i}`,
          type: "MEMORY" as const,
          sourcePath: "/notes.md",
          recordId: `mem-${i}`
        }))
      ]
    };
    const lowZoom = selectVisibleMemoryLabelsLOD(nodes, "mem-42", 1.0);
    expect(lowZoom.map(n => n.id)).toEqual(["mem-42", "core-1", "src-1"]);

    const highZoom = selectVisibleMemoryLabelsLOD(nodes, "mem-42", 2.0);
    expect(highZoom.length).toBeLessThanOrEqual(MAX_VISIBLE_LABELS_3D);
    expect(highZoom[0]?.id).toBe("mem-42");
    expect(highZoom[1]?.id).toBe("core-1");
  });

  it("streams intermediate layout positions during layoutMemoryNetwork3D", () => {
    const nodes: MemoryGraphNode[] = Array.from({ length: 40 }, (_, i) => ({
      id: `n-${i}`,
      label: `n-${i}`,
      type: i === 0 ? "SOURCE" : "MEMORY",
      sourcePath: "/doc.md",
      recordId: `n-${i}`
    }));
    const stepsSeen: number[] = [];
    const finalMap = layoutMemoryNetwork3D(nodes, [], {
      steps: 24,
      streamIntervalSteps: 8,
      onProgress: (map, step) => {
        expect(map.size).toBe(40);
        stepsSeen.push(step);
      }
    });
    expect(stepsSeen).toEqual([8, 16, 24]);
    expect(finalMap.size).toBe(40);
  });

  it("allows overview query limit up to 50,000 nodes while defaulting to 2,000", () => {
    expect(listMemoryGraphOverviewQuerySchema.parse({}).limit).toBe(2000);
    expect(listMemoryGraphOverviewQuerySchema.parse({ limit: "50000" }).limit).toBe(50000);

    const manyNodes: MemoryGraphNode[] = Array.from({ length: 3500 }, (_, i) => ({
      id: `node-${i}`,
      label: `Node ${i}`,
      type: "MEMORY",
      sourcePath: "/a.md",
      recordId: `node-${i}`
    }));
    expect(selectOverviewNodes(manyNodes, []).length).toBe(2000);
    expect(selectOverviewNodes(manyNodes, [], 50000).length).toBe(3500);
  });
});
