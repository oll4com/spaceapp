import { describe, expect, it } from "vitest";
import { createMemory3DPicker, createMemoryLayout3DStream, layoutMemoryNetwork3D, MAX_MEMORY_3D_LABELS_DRAWN, MAX_MEMORY_3D_LABELS_MEASURED, memory3DVolumeRatio, projectMemoryPoint, selectMemory3DLabels, DEFAULT_MEMORY_CAMERA } from "../src/features/memory-workspace/memory-3d.js";
import { cappedFallbackGraph } from "../src/features/memory-workspace/MemoryGraph3D.js";
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

describe("3D memory layout stream", () => {
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
  it("converges to the batch layout while streaming finite intermediate positions", () => {
    const { nodes, edges } = fixture();
    const stream = createMemoryLayout3DStream(nodes, edges);
    expect(stream.ids[0]).toBe("root");
    let progress = 0;
    for (;;) {
      const done = stream.step(7);
      progress++;
      expect(stream.coordinates.every(Number.isFinite)).toBe(true);
      if (done) break;
    }
    expect(progress).toBeGreaterThan(1);
    expect(stream.finish()).toEqual(layoutMemoryNetwork3D(nodes, edges));
    const batched = createMemoryLayout3DStream(nodes, edges);
    while (!batched.step(64)) continue;
    expect(batched.finish()).toEqual(stream.finish());
  });
  it("stays deterministic under input reordering while streaming in slices", () => {
    const { nodes, edges } = fixture();
    const stream = createMemoryLayout3DStream(nodes, edges);
    while (!stream.step(3)) continue;
    const reversed = createMemoryLayout3DStream([...nodes].reverse(), [...edges].reverse());
    while (!reversed.step(11)) continue;
    expect([...reversed.finish()]).toEqual([...stream.finish()]);
  });
});

describe("3D memory picking and labels", () => {
  const fixture = () => {
    const nodes: MemoryGraphNode[] = [];
    for (let index = 0; index < 40; index++) nodes.push({ id: `memory-${index}`, label: `memory ${index}`, type: index % 10 === 0 ? "SOURCE" : "MEMORY", sourcePath: null, recordId: null });
    const coordinates = new Map(nodes.map(node => [node.id, { x: Number(node.id.split("-")[1]) * 12, y: 0, z: 0 }]));
    return { nodes, coordinates };
  };
  it("picks the closest node under the pointer without a linear scan fallback", () => {
    const { nodes, coordinates } = fixture();
    const picker = createMemory3DPicker();
    picker.update(nodes, coordinates, DEFAULT_MEMORY_CAMERA, 2, 1000, 700);
    const hit = projectMemoryPoint(coordinates.get("memory-7")!, DEFAULT_MEMORY_CAMERA, 2, 1000, 700);
    const adjacent = projectMemoryPoint(coordinates.get("memory-8")!, DEFAULT_MEMORY_CAMERA, 2, 1000, 700);
    expect(picker.pick(hit.x, hit.y)).toBe("memory-7");
    expect(picker.pick(adjacent.x, adjacent.y)).toBe("memory-8");
    expect(picker.pick(adjacent.x + 100, adjacent.y)).toBe(null);
  });
  it("keeps label rules and bounds measured and drawn labels at the LOD caps", () => {
    const { nodes, coordinates } = fixture();
    const projected = new Map(nodes.map(node => {
      const p = projectMemoryPoint(coordinates.get(node.id)!, DEFAULT_MEMORY_CAMERA, 2, 1000, 700);
      return [node.id, { x: p.x, y: p.y }];
    }));
    const base = { focus: null, zoom: 3, width: 1000, height: 700, measure: (text: string) => text.length * 6, maxMeasured: 10, maxDrawn: 4 };
    const zoomed = selectMemory3DLabels({ ...base, nodes, project: id => projected.get(id) });
    expect(zoomed.length).toBeLessThanOrEqual(4);
    expect(zoomed.length).toBeGreaterThan(0);
    const overview = selectMemory3DLabels({ ...base, zoom: 1, nodes, project: id => projected.get(id) });
    expect(overview.every(label => label.id.startsWith("memory-") && Number(label.id.split("-")[1]) % 10 === 0)).toBe(true);
    const focused = selectMemory3DLabels({ ...base, zoom: 1, focus: "memory-1", nodes, project: id => projected.get(id) });
    expect(focused[0]!.id).toBe("memory-1");
    const capped = selectMemory3DLabels({ ...base, zoom: 3, nodes, project: id => projected.get(id), maxMeasured: MAX_MEMORY_3D_LABELS_MEASURED, maxDrawn: MAX_MEMORY_3D_LABELS_DRAWN });
    expect(capped.length).toBeLessThanOrEqual(MAX_MEMORY_3D_LABELS_DRAWN);
    const long: MemoryGraphNode = { id: "memory-long", label: "x".repeat(60), type: "SOURCE", sourcePath: null, recordId: null };
    const truncated = selectMemory3DLabels({ ...base, zoom: 1, nodes: [long], project: id => projected.get("memory-0"), measure: (text: string) => text.length * 6 });
    expect(truncated[0]!.label).toHaveLength(46);
  });
  it("caps the Canvas 2D fallback at the overview limits and keeps focused and source nodes", () => {
    const nodes: MemoryGraphNode[] = Array.from({ length: 2500 }, (_, index) => ({ id: `memory:${index}`, label: `Memory ${index}`, type: "MEMORY", sourcePath: null, recordId: null }));
    nodes.push({ id: "source:root", label: "gemini.md", type: "SOURCE", sourcePath: null, recordId: null });
    const edges: MemoryGraphEdge[] = Array.from({ length: 7000 }, (_, index) => ({ id: `edge:${index}`, type: "CONTAINS", source: "source:root", target: `memory:${index}` }));
    const capped = cappedFallbackGraph(nodes, edges, "memory:2499");
    expect(capped.nodes.length).toBeLessThanOrEqual(2000);
    expect(capped.edges.length).toBeLessThanOrEqual(6000);
    expect(capped.nodes.some(node => node.id === "source:root")).toBe(true);
    expect(capped.nodes.some(node => node.id === "memory:2499")).toBe(true);
    expect(capped.edges.every(edge => capped.nodes.some(node => node.id === edge.source || node.id === edge.target))).toBe(true);
  });
});
