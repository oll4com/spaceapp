import { describe, expect, it } from "vitest";
import { createMemoryNetwork3DLayout, layoutMemoryNetwork3D, memory3DVolumeRatio, memoryNetwork3DLayoutSnapshot, projectMemoryPoint, stepMemoryNetwork3DLayout, DEFAULT_MEMORY_CAMERA } from "../src/features/memory-workspace/memory-3d.js";
import { buildMemoryGraphPickIndex, MAX_MEMORY_GRAPH_LABELS, MAX_MEMORY_GRAPH_LABEL_MEASUREMENTS, memoryGraphP95, pickMemoryGraphNodeIndex, selectMemoryGraphLabels } from "../src/features/memory-workspace/memory-webgl-renderer.js";
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
  it("streams deterministic layout snapshots before converging", () => {
    const { nodes, edges } = fixture();
    const state = createMemoryNetwork3DLayout(nodes, edges);
    const initial = memoryNetwork3DLayoutSnapshot(state);
    expect(stepMemoryNetwork3DLayout(state, 12)).toBe(false);
    expect(memoryNetwork3DLayoutSnapshot(state)).not.toEqual(initial);
    while (!stepMemoryNetwork3DLayout(state, 12)) { /* worker-sized chunks */ }
    expect(memoryNetwork3DLayoutSnapshot(state)).toEqual(layoutMemoryNetwork3D(nodes, edges));
  });
  it("bounds label measurement and drawing independently of graph size", () => {
    const nodes: MemoryGraphNode[] = Array.from({ length: 5000 }, (_, index) => ({
      id: `source:${index}`,
      label: index === 0 ? "gemini.md" : `Source ${index}`,
      type: "SOURCE",
      sourcePath: `/memory/${index}.md`,
      recordId: null
    }));
    const coordinates = new Map(nodes.map((node, index) => [node.id, { x: (index % 50) - 25, y: Math.floor(index / 50) - 50, z: index % 7 }]));
    let measurements = 0;
    const labels = selectMemoryGraphLabels(nodes, coordinates, DEFAULT_MEMORY_CAMERA, 3, 1200, 800, "source:4999", label => {
      measurements++;
      return label.length * 6;
    });
    expect(measurements).toBeLessThanOrEqual(MAX_MEMORY_GRAPH_LABEL_MEASUREMENTS);
    expect(labels.length).toBeLessThanOrEqual(MAX_MEMORY_GRAPH_LABELS);
    expect(labels.some(label => label.id === "source:4999")).toBe(true);
  });
  it("reports the nearest-rank p95", () => {
    expect(memoryGraphP95(Array.from({ length: 100 }, (_, index) => index + 1))).toBe(95);
    expect(memoryGraphP95([])).toBe(0);
  });
  it("matches brute-force depth picking while culling spatial clusters", () => {
    const width = 1000;
    const height = 700;
    const scale = 2.4;
    const count = 512;
    const positions = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    for (let index = 0; index < count; index++) {
      positions[index * 3] = (index % 16 - 7.5) * 18;
      positions[index * 3 + 1] = (Math.floor(index / 16) % 8 - 3.5) * 22;
      positions[index * 3 + 2] = (Math.floor(index / 128) - 1.5) * 30 + (index % 5);
      sizes[index] = index % 31 === 0 ? 10 : index % 7 === 0 ? 4.6 : 2.1;
    }
    const pickIndex = buildMemoryGraphPickIndex(positions, sizes);
    const bruteForce = (x: number, y: number, camera: typeof DEFAULT_MEMORY_CAMERA) => {
      let selectedIndex = -1;
      let selectedDepth = Number.POSITIVE_INFINITY;
      const sqrtZoom = Math.sqrt(camera.zoom);
      for (let index = 0; index < count; index++) {
        const point = { x: positions[index * 3]!, y: positions[index * 3 + 1]!, z: positions[index * 3 + 2]! };
        const projected = projectMemoryPoint(point, camera, scale, width, height);
        const perspective = 650 / Math.max(120, 650 + projected.z * scale);
        const radius = Math.max(7, Math.max(1, sizes[index]! * perspective * sqrtZoom) + 3);
        if ((x - projected.x) ** 2 + (y - projected.y) ** 2 > radius ** 2) continue;
        const depth = Math.max(-0.95, Math.min(0.95, projected.z * scale / 1000));
        if (depth < selectedDepth || (depth === selectedDepth && index > selectedIndex)) {
          selectedIndex = index;
          selectedDepth = depth;
        }
      }
      return selectedIndex;
    };
    const cameras = [
      DEFAULT_MEMORY_CAMERA,
      { yaw: 1.1, pitch: -0.35, zoom: 1.28 },
      { yaw: -2.2, pitch: 0.42, zoom: 0.78 }
    ];
    for (const camera of cameras) {
      for (let x = 50; x <= 950; x += 100) for (let y = 50; y <= 650; y += 100) {
        expect(pickMemoryGraphNodeIndex(pickIndex, positions, sizes, x, y, camera, scale, width, height).nodeIndex).toBe(bruteForce(x, y, camera));
      }
      for (let index = 0; index < count; index += 37) {
        const point = { x: positions[index * 3]!, y: positions[index * 3 + 1]!, z: positions[index * 3 + 2]! };
        const projected = projectMemoryPoint(point, camera, scale, width, height);
        expect(pickMemoryGraphNodeIndex(pickIndex, positions, sizes, projected.x, projected.y, camera, scale, width, height).nodeIndex).toBe(bruteForce(projected.x, projected.y, camera));
      }
    }
  });
});
