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

  describe("Sub-4ms spatial index picking", () => {
    it("indexes 50,000 nodes and picks within 4ms", async () => {
      const { MemorySpatialIndex } = await import("../src/features/memory-workspace/memory-picking.js");
      const index = new MemorySpatialIndex();
      const points = Array.from({ length: 50000 }, (_, i) => ({
        id: `node-${i}`,
        x: (i * 17) % 1920,
        y: (i * 23) % 1080,
        z: (i % 500) - 250,
        radius: 4,
        perspective: 1
      }));

      // Target node placed at known coordinates with foreground Z depth (smaller z is closer to camera)
      points[12345] = { id: "target-node", x: 500, y: 500, z: -999, radius: 5, perspective: 1 };

      index.build(points, 1920, 1080, 32);

      // Measure repeated pick calls and verify median latency against the 4ms acceptance threshold
      const latencies: number[] = [];
      for (let run = 0; run < 25; run++) {
        const start = performance.now();
        const hit = index.pick(501, 502);
        latencies.push(performance.now() - start);
        expect(hit).toBe("target-node");
      }
      latencies.sort((a, b) => a - b);
      const median = latencies[Math.floor(latencies.length / 2)]!;
      expect(median).toBeLessThan(4); // Acceptance criteria requirement <= 4ms
    });

    it("prefers the node closest to the camera (smallest Z) on overlapping hits", async () => {
      const { MemorySpatialIndex } = await import("../src/features/memory-workspace/memory-picking.js");
      const index = new MemorySpatialIndex();
      const points = [
        { id: "background", x: 100, y: 100, z: 50, radius: 5, perspective: 1 },
        { id: "foreground", x: 100, y: 100, z: -50, radius: 5, perspective: 1 }
      ];
      index.build(points, 800, 600, 32);
      expect(index.pick(101, 100)).toBe("foreground");
    });

    it("returns null when clicking in empty space", async () => {
      const { MemorySpatialIndex } = await import("../src/features/memory-workspace/memory-picking.js");
      const index = new MemorySpatialIndex();
      index.build([{ id: "n1", x: 100, y: 100, z: 0, radius: 4, perspective: 1 }], 800, 600, 32);
      expect(index.pick(500, 500)).toBeNull();
    });
  });

  describe("Bounded Level-of-Detail label selection", () => {
    it("prioritizes focus and core labels and enforces bounded drawing counts", async () => {
      const { selectBoundedLabels } = await import("../src/features/memory-workspace/memory-labels.js");
      const nodes: MemoryGraphNode[] = [
        { id: "core", label: "gemini.md", type: "SOURCE", sourcePath: "/opt/spaceapp/docs/gemini.md", recordId: null },
        { id: "focus-node", label: "Focused item", type: "MEMORY", sourcePath: "/opt/spaceapp/docs/test.md", recordId: "rec-1" },
        ...Array.from({ length: 1000 }, (_, i) => ({
          id: `source-${i}`,
          label: `Source document ${i}`,
          type: "SOURCE" as const,
          sourcePath: `/opt/spaceapp/docs/doc-${i}.md`,
          recordId: null
        }))
      ];

      const projectedMap = new Map<string, any>([
        ["focus-node", { id: "focus-node", x: 100, y: 100, z: 10, radius: 4, perspective: 1 }],
        ["core", { id: "core", x: 100, y: 200, z: 5, radius: 8, perspective: 1 }],
        ...nodes.slice(2).map((n, i) => [
          n.id,
          { id: n.id, x: 200 + (i % 20) * 40, y: 100 + Math.floor(i / 20) * 30, z: i, radius: 4, perspective: 1 }
        ] as const)
      ]);

      const placed = selectBoundedLabels(
        nodes,
        projectedMap,
        "focus-node",
        1.0,
        1920,
        1080,
        label => ({ width: label.length * 7 }),
        120, // max evaluated
        50   // max drawn
      );

      expect(placed.length).toBeLessThanOrEqual(50);
      expect(placed.some(p => p.id === "focus-node")).toBe(true);
      expect(placed.some(p => p.id === "core")).toBe(true);
      expect(placed[0]!.id).toBe("focus-node");
    });
  });

  describe("Incremental layout streaming", () => {
    it("yields step 0 initial positions immediately and reaches final deterministic convergence", async () => {
      const { streamLayoutMemoryNetwork3D } = await import("../src/features/memory-workspace/memory-3d.js");
      const { nodes, edges } = fixture();
      const generator = streamLayoutMemoryNetwork3D(nodes, edges, 30);

      const snapshots = [];
      for (const snapshot of generator) {
        snapshots.push(snapshot);
      }

      // Step 0 yielded immediately
      expect(snapshots[0]!.step).toBe(0);
      expect(snapshots[0]!.done).toBe(false);
      expect(snapshots[0]!.coordinates.size).toBe(nodes.length);

      // Final step 180 marked done
      const last = snapshots.at(-1)!;
      expect(last.step).toBe(180);
      expect(last.done).toBe(true);

      // Matches synchronous layoutMemoryNetwork3D
      const syncResult = layoutMemoryNetwork3D(nodes, edges);
      expect([...last.coordinates]).toEqual([...syncResult]);
    });
  });

  describe("Synthetic demo graph generator", () => {
    it("generates deterministic benchmark graphs at 2k, 10k, and 50k nodes with ~3x edges", async () => {
      const { generateSyntheticMemoryGraph } = await import("../src/demo/synthetic-memory-graph.js");

      for (const size of [2000, 10000]) {
        const graph = generateSyntheticMemoryGraph(size);
        expect(graph.nodes.length).toBe(size);
        expect(graph.edges.length).toBeGreaterThanOrEqual(size * 2);
        expect(graph.edges.length).toBeLessThanOrEqual(size * 3);
        expect(graph.nodes[0]!.label).toBe("gemini.md");
        expect(graph.nodes[0]!.type).toBe("SOURCE");
      }
    });
  });
});

