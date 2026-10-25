import { describe, expect, it } from "vitest";
import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { layoutMemoryNetwork3D, memory3DVolumeRatio, memory3DVolumeRatioFlat, projectMemoryPoint, DEFAULT_MEMORY_CAMERA } from "../src/features/memory-workspace/memory-3d.js";
import { MEMORY_LAYOUT_STEPS, streamMemoryLayout3D, type MemoryLayoutProgress } from "../src/features/memory-workspace/memory-3d-layout.js";
import {
  MAX_LABELS_DRAWN, MAX_LABEL_CANDIDATES, buildMemoryScene, decodeMemoryPickId, encodeMemoryPickId, memoryCameraUniforms, memoryFocusFlags,
  memoryLabelOrder, memoryNodeRadius, memoryPercentile, memoryPickRadius, memoryViewExtent, pickMemoryCircle, projectMemoryClip, selectMemoryLabels
} from "../src/features/memory-workspace/memory-3d-view.js";
import { createSyntheticMemoryGraph, syntheticMemoryNodeCount } from "../src/demo/synthetic-memory-graph.js";

const graph = () => {
  const nodes: MemoryGraphNode[] = [{ id: "root", label: "gemini.md", type: "SOURCE", sourcePath: "/docs/gemini.md", recordId: null }];
  const edges: MemoryGraphEdge[] = [];
  for (let file = 0; file < 6; file++) {
    const id = `source-${file}`;
    nodes.push({ id, label: `${id}.md`, type: "SOURCE", sourcePath: `/docs/${id}.md`, recordId: null });
    edges.push({ id: `file-${file}`, type: "DERIVED_FROM", source: "root", target: id });
    for (let item = 0; item < 20; item++) {
      const memory = `${id}-memory-${item}`;
      nodes.push({ id: memory, label: memory, type: "MEMORY", sourcePath: `/docs/${id}.md`, recordId: memory });
      edges.push({ id: memory, type: "CONTAINS", source: id, target: memory });
    }
  }
  return { nodes, edges };
};

describe("3D camera math", () => {
  it("projects on the GPU path exactly where the Canvas 2D projection puts a point", () => {
    const width = 1000, height = 700, extent = 150, scale = Math.min(width, height) * 0.4 / extent;
    for (const camera of [DEFAULT_MEMORY_CAMERA, { yaw: 1.7, pitch: 0.6, zoom: 2.5 }, { yaw: -2.2, pitch: -1.1, zoom: 0.5 }]) {
      const uniforms = memoryCameraUniforms(camera, extent, width, height);
      for (const point of [{ x: 45, y: 20, z: 60 }, { x: -80, y: 33, z: -12 }, { x: 0, y: 0, z: 0 }]) {
        const cpu = projectMemoryPoint(point, camera, scale, width, height);
        const clip = projectMemoryClip(point, uniforms);
        expect(width / 2 + clip.x * width / 2).toBeCloseTo(cpu.x, 6);
        expect(height / 2 - clip.y * height / 2).toBeCloseTo(cpu.y, 6);
        expect(clip.perspective).toBeCloseTo(cpu.perspective, 9);
        // Larger camera depth is farther; the depth buffer must order the same way.
        expect(clip.depth).toBeCloseTo(cpu.z / (extent * 1.05), 9);
      }
    }
  });
  it("orders depth the same way the old CPU sort did", () => {
    const uniforms = memoryCameraUniforms(DEFAULT_MEMORY_CAMERA, 100, 800, 600);
    const near = projectMemoryClip({ x: 0, y: 0, z: -50 }, uniforms), far = projectMemoryClip({ x: 0, y: 0, z: 50 }, uniforms);
    expect(near.depth).toBeLessThan(far.depth);
  });
  it("uses a view extent of at least 60 and the farthest packed point", () => {
    expect(memoryViewExtent(new Float32Array([1, 2, 3]))).toBe(60);
    expect(memoryViewExtent(new Float32Array([0, 0, 0, 0, 300, 400]))).toBe(500);
  });
  it("computes the volume ratio the same way from packed coordinates", () => {
    const points = Array.from({ length: 60 }, (_, i) => ({ x: i % 7, y: (i * 3) % 11, z: (i * 5) % 13 }));
    const flat = Float32Array.from(points.flatMap(p => [p.x, p.y, p.z]));
    expect(memory3DVolumeRatioFlat(flat)).toBeCloseTo(memory3DVolumeRatio(points), 8);
    expect(memory3DVolumeRatioFlat(new Float32Array(6))).toBe(0);
  });
  it("sizes nodes like the Canvas 2D renderer", () => {
    expect(memoryNodeRadius("root", 1, 1, false)).toBe(10);
    expect(memoryNodeRadius("source", 1, 4, false)).toBeCloseTo(9.2);
    expect(memoryNodeRadius("other", 0.1, 1, false)).toBe(1);
    expect(memoryNodeRadius("other", 1, 1, true)).toBeCloseTo(3.15);
  });
});

describe("3D picking", () => {
  it("round-trips node indices through GPU pick colors and treats black as empty", () => {
    for (const index of [0, 1, 254, 255, 256, 65535, 65536, 49999, 16777214]) {
      const pixel = encodeMemoryPickId(index);
      expect(pixel[3]).toBe(255);
      expect(decodeMemoryPickId(pixel)).toBe(index);
    }
    expect(decodeMemoryPickId([0, 0, 0, 0])).toBe(-1);
  });
  it("picks the front-most circle within the hit radius, and nothing outside it", () => {
    const circles = [{ x: 100, y: 100, z: 30, radius: 2 }, { x: 103, y: 100, z: -10, radius: 2 }, { x: 300, y: 300, z: 0, radius: 2 }];
    expect(pickMemoryCircle(circles, 101, 100)).toBe(1);
    expect(pickMemoryCircle(circles, 100 - memoryPickRadius(2) + 0.5, 100)).toBe(0);
    expect(pickMemoryCircle(circles, 200, 200)).toBe(-1);
    expect(memoryPickRadius(1)).toBe(7);
    expect(memoryPickRadius(10)).toBe(13);
  });
  it("highlights the focus and its direct neighbors only", () => {
    const { nodes, edges } = graph();
    const scene = buildMemoryScene(nodes, edges, () => undefined);
    const focus = scene.index.get("source-0")!;
    const flags = memoryFocusFlags(scene, focus);
    expect(flags[focus]).toBe(2);
    expect(flags[scene.index.get("root")!]).toBe(1);
    expect(flags[scene.index.get("source-0-memory-3")!]).toBe(1);
    expect(flags[scene.index.get("source-1-memory-3")!]).toBe(0);
    expect([...memoryFocusFlags(scene, -1)].every(flag => flag === 0)).toBe(true);
  });
  it("builds typed scene arrays with colors, kinds and edge endpoints", () => {
    const { nodes, edges } = graph();
    const scene = buildMemoryScene(nodes, [...edges, { id: "dangling", type: "CONTAINS", source: "root", target: "missing" }], id => id === "root" ? "#fff0b0" : undefined);
    expect(scene.count).toBe(nodes.length);
    expect(scene.edgeEnds.length / 2).toBe(edges.length);
    expect([...scene.colors.slice(0, 4)]).toEqual([255, 240, 176, 255]);
    expect([...scene.colors.slice(4, 8)]).toEqual([0x73, 0x95, 0xad, 255]);
    expect(scene.kinds[0]).toBe(2);
    expect(scene.kinds[scene.index.get("source-1")!]).toBe(1);
    expect(scene.kinds[scene.index.get("source-1-memory-1")!]).toBe(0);
    expect(scene.edgeKinds[0]).toBe(1);
  });
  it("reports percentiles for frame-time samples", () => {
    expect(memoryPercentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.95)).toBe(100);
    expect(memoryPercentile([16, 16, 16, 40], 0.5)).toBe(16);
    expect(memoryPercentile([], 0.95)).toBe(0);
  });
});

describe("3D label level of detail", () => {
  const big = () => {
    const nodes: MemoryGraphNode[] = Array.from({ length: 20000 }, (_, i) => ({ id: `n${i}`, label: `label ${i}`, type: i < 500 ? "SOURCE" as const : "MEMORY" as const, sourcePath: null, recordId: null }));
    nodes[7] = { ...nodes[7]!, label: "gemini.md" };
    return nodes;
  };
  it("orders core files, then files, then the most connected records", () => {
    const nodes: MemoryGraphNode[] = [
      { id: "a", label: "memory-a", type: "MEMORY", sourcePath: null, recordId: null },
      { id: "b", label: "notes.md", type: "SOURCE", sourcePath: null, recordId: null },
      { id: "c", label: "memory-c", type: "MEMORY", sourcePath: null, recordId: null },
      { id: "d", label: "gemini.md", type: "SOURCE", sourcePath: null, recordId: null }
    ];
    const edges: MemoryGraphEdge[] = [{ id: "e1", type: "CONTAINS", source: "b", target: "c" }, { id: "e2", type: "CONTAINS", source: "b", target: "c" }];
    expect([...memoryLabelOrder(nodes, edges)]).toEqual([3, 1, 2, 0]);
  });
  it("projects and measures a bounded number of nodes whatever the graph size", () => {
    const nodes = big();
    const order = memoryLabelOrder(nodes, []);
    let projected = 0, measured = 0;
    const placements = selectMemoryLabels({
      order, focus: -1, zoom: 3, width: 4000, height: 4000,
      isSource: i => nodes[i]!.type === "SOURCE",
      project: i => { projected++; return { x: (i % 100) * 30, y: 20 + Math.floor(i / 100) * 18 }; },
      measure: () => { measured++; return 60; }
    });
    expect(projected).toBeLessThanOrEqual(MAX_LABEL_CANDIDATES);
    expect(measured).toBeLessThanOrEqual(MAX_LABEL_CANDIDATES);
    expect(placements.length).toBeLessThanOrEqual(MAX_LABELS_DRAWN);
    expect(placements[0]!.index).toBe(7);
  });
  it("shows only file labels when zoomed out, but always the focused node, first", () => {
    const nodes = big();
    const order = memoryLabelOrder(nodes, []);
    const run = (focus: number, zoom: number) => selectMemoryLabels({
      order, focus, zoom, width: 4000, height: 4000, maxCandidates: 5000, maxLabels: 5000,
      isSource: i => nodes[i]!.type === "SOURCE", project: i => ({ x: (i % 20) * 200, y: 20 + Math.floor(i / 20) * 20 }), measure: () => 60
    });
    const far = run(-1, 1);
    expect(far.length).toBe(500);
    expect(far.every(label => nodes[label.index]!.type === "SOURCE")).toBe(true);
    const focused = run(600, 1);
    expect(focused[0]!.index).toBe(600);
    expect(focused.length).toBe(501);
  });
  it("drops overlapping, off-screen and clipped labels", () => {
    const order = [0, 1, 2, 3];
    const spots = [{ x: 50, y: 100 }, { x: 60, y: 104 }, { x: 50, y: 5 }, { x: 395, y: 200 }];
    const placements = selectMemoryLabels({ order, focus: -1, zoom: 1, width: 400, height: 300, isSource: () => true, project: i => spots[i]!, measure: () => 80 });
    expect(placements.map(label => label.index)).toEqual([0]);
  });
});

describe("3D layout streaming", () => {
  it("streams the initial state first and the converged state last, in input order", () => {
    const { nodes, edges } = graph();
    const shuffled = [...nodes].reverse();
    let clock = 0;
    const messages: MemoryLayoutProgress[] = [];
    const simulation = streamMemoryLayout3D(shuffled, [...edges].reverse(), progress => messages.push(progress), { intervalMs: 120, now: () => (clock += 50) });
    expect(messages[0]).toMatchObject({ step: 0, steps: MEMORY_LAYOUT_STEPS, done: false });
    expect(messages.at(-1)).toMatchObject({ step: MEMORY_LAYOUT_STEPS, done: true });
    expect(messages.length).toBeGreaterThan(10);
    expect(messages.length).toBeLessThan(MEMORY_LAYOUT_STEPS);
    expect(messages.filter(message => message.done)).toHaveLength(1);
    expect(simulation.done).toBe(true);
    const reference = layoutMemoryNetwork3D(nodes, edges);
    const final = messages.at(-1)!.positions;
    expect(final.length).toBe(nodes.length * 3);
    shuffled.forEach((node, i) => {
      const expected = reference.get(node.id)!;
      expect(final[i * 3]).toBeCloseTo(expected.x, 3);
      expect(final[i * 3 + 1]).toBeCloseTo(expected.y, 3);
      expect(final[i * 3 + 2]).toBeCloseTo(expected.z, 3);
    });
    // Positions actually move between the first and the last message.
    expect(messages[0]!.positions).not.toEqual(final);
    expect(messages[0]!.positions).not.toBe(messages[1]!.positions);
  });
  it("is deterministic for the same input", () => {
    const { nodes, edges } = graph();
    expect([...layoutMemoryNetwork3D(nodes, edges)]).toEqual([...layoutMemoryNetwork3D(nodes, edges)]);
  });
  it("lays out an empty and a single-node graph", () => {
    expect(streamMemoryLayout3D([], [], () => {}).count).toBe(0);
    expect(layoutMemoryNetwork3D([{ id: "only", label: "only", type: "MEMORY", sourcePath: null, recordId: null }], []).size).toBe(1);
  });
  it("keeps a large synthetic graph spread out and finite", () => {
    const { nodes, edges } = createSyntheticMemoryGraph(3000);
    const simulation = streamMemoryLayout3D(nodes, edges, () => {}, { intervalMs: Infinity });
    const flat = simulation.snapshot();
    expect(flat.every(Number.isFinite)).toBe(true);
    expect(memory3DVolumeRatioFlat(flat)).toBeGreaterThan(0.05);
  });
});

describe("synthetic demo memory graph", () => {
  it("generates the requested number of nodes and about three edges per node, deterministically", () => {
    const first = createSyntheticMemoryGraph(2000), second = createSyntheticMemoryGraph(2000);
    expect(first.nodes).toHaveLength(2000);
    expect(first.edges.length).toBeGreaterThan(2000 * 2.8);
    expect(first.edges.length).toBeLessThanOrEqual(2000 * 3);
    expect(second).toEqual(first);
    const ids = new Set(first.nodes.map(node => node.id));
    expect(ids.size).toBe(2000);
    expect(new Set(first.edges.map(edge => edge.id)).size).toBe(first.edges.length);
    expect(first.edges.every(edge => ids.has(edge.source) && ids.has(edge.target))).toBe(true);
    expect(first.nodes.some(node => node.type === "SOURCE" && node.label === "gemini.md")).toBe(true);
    expect(first.edges.filter(edge => edge.type === "TAGGED_WITH").every(edge => edge.origin && edge.confidence !== undefined && edge.evidence)).toBe(true);
  });
  it("reaches 50,000 nodes and 150,000 edges and clamps larger requests", () => {
    const { nodes, edges } = createSyntheticMemoryGraph(50000);
    expect(nodes).toHaveLength(50000);
    expect(edges.length).toBeGreaterThan(145000);
    expect(createSyntheticMemoryGraph(80000).nodes).toHaveLength(50000);
    expect(createSyntheticMemoryGraph(0).nodes).toHaveLength(0);
  });
  it("reads the size from the page query", () => {
    expect(syntheticMemoryNodeCount("?memoryNodes=10000")).toBe(10000);
    expect(syntheticMemoryNodeCount("?memoryNodes=999999")).toBe(50000);
    expect(syntheticMemoryNodeCount("?memoryNodes=abc")).toBe(0);
    expect(syntheticMemoryNodeCount("")).toBe(0);
  });
});
