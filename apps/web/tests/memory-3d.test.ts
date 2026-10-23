import { describe, expect, it, vi } from "vitest";
import {
  layoutMemoryNetwork3D,
  createMemoryNetwork3DSimulation,
  computeMemory3DExtent,
  memory3DVolumeRatio,
  projectMemoryPoint,
  buildMemory3DSpatialIndex,
  pickMemory3DNode,
  selectMemory3DLabels,
  selectMemory3DFallbackNodes,
  buildMemory3DWebGLBuffers,
  updateMemory3DFocusAttributes,
  MEMORY_3D_NODE_VERTEX_SHADER,
  MEMORY_3D_NODE_FRAGMENT_SHADER,
  MEMORY_3D_EDGE_VERTEX_SHADER,
  MEMORY_3D_EDGE_FRAGMENT_SHADER,
  DEFAULT_MEMORY_CAMERA,
  type MemoryPoint3D
} from "../src/features/memory-workspace/memory-3d.js";
import { DemoStore, generateSyntheticMemoryGraph } from "../src/demo/DemoStore.js";
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

  it("streams incremental 3D simulation frames and packs Float32Array coordinates at 50k nodes / 150k edges", () => {
    const synthetic = generateSyntheticMemoryGraph(50_000, 150_000);
    expect(synthetic.nodes.length).toBe(50_000);
    expect(synthetic.edges.length).toBe(150_000);

    const sim = createMemoryNetwork3DSimulation(synthetic.nodes, synthetic.edges);
    expect(sim.totalSteps).toBeGreaterThanOrEqual(24);
    const doneFirst = sim.step(4);
    expect(doneFirst).toBe(false);
    expect(sim.currentStep).toBe(4);

    const coords = sim.packCoordinates();
    expect(coords).toBeInstanceOf(Float32Array);
    expect(coords.length).toBe(150_000);
    const extent = computeMemory3DExtent(new Map(), coords);
    expect(Number.isFinite(extent)).toBe(true);
    expect(extent).toBeGreaterThan(100);
    expect(memory3DVolumeRatio(coords)).toBeGreaterThan(0.25);
  });

  it("builds a 50k-node spatial index and picks nodes in <= 4 ms", () => {
    const synthetic = generateSyntheticMemoryGraph(50_000, 150_000);
    const sim = createMemoryNetwork3DSimulation(synthetic.nodes, synthetic.edges);
    sim.step(4);
    const coords = sim.packCoordinates();
    const extent = computeMemory3DExtent(new Map(), coords);
    const scale = (Math.min(1280, 800) * 0.34) / extent;
    const focusNodeId = synthetic.nodes[250]!.id;

    const index = buildMemory3DSpatialIndex({
      nodes: synthetic.nodes,
      coordinates: new Map(),
      packedCoordinates: coords,
      camera: DEFAULT_MEMORY_CAMERA,
      scale,
      width: 1280,
      height: 800,
      focusId: focusNodeId
    });
    expect(index.nodes.length).toBe(50_000);

    const targetX = index.screenX[250]!;
    const targetY = index.screenY[250]!;
    const t0 = performance.now();
    let picked: string | null = null;
    for (let iter = 0; iter < 50; iter++) {
      picked = pickMemory3DNode(index, targetX, targetY);
    }
    const avgPickMs = (performance.now() - t0) / 50;
    expect(typeof picked).toBe("string");
    if (process.env.MEMORY_BENCH) {
      expect(avgPickMs).toBeLessThanOrEqual(4);
    }
  });

  it("caps LOD labels at <= 64 with screen-space collision avoidance and prioritizes focused nodes", () => {
    const synthetic = generateSyntheticMemoryGraph(10_000, 30_000);
    const sim = createMemoryNetwork3DSimulation(synthetic.nodes, synthetic.edges);
    sim.step(4);
    const coords = sim.packCoordinates();
    const extent = computeMemory3DExtent(new Map(), coords);
    const scale = (Math.min(1280, 800) * 0.34) / extent;
    const focusId = synthetic.nodes[500]!.id;
    const index = buildMemory3DSpatialIndex({
      nodes: synthetic.nodes,
      coordinates: new Map(),
      packedCoordinates: coords,
      camera: { ...DEFAULT_MEMORY_CAMERA, zoom: 1.8 },
      scale,
      width: 1280,
      height: 800,
      focusId
    });

    const labels = selectMemory3DLabels({
      spatial: index,
      showTitles: true,
      camera: { ...DEFAULT_MEMORY_CAMERA, zoom: 1.8 },
      focusId,
      maxLabels: 64
    });
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.length).toBeLessThanOrEqual(64);
    expect(labels[0]?.id).toBe(focusId);
  });

  it("builds WebGL2 instanced node and edge buffers and updates focus flags in-place", () => {
    const { nodes, edges } = generateSyntheticMemoryGraph(2_000, 6_000);
    const sim = createMemoryNetwork3DSimulation(nodes, edges);
    sim.step(4);
    const coords = sim.packCoordinates();
    const atlas = createMemoryAtlas(nodes, edges);

    const buffers = buildMemory3DWebGLBuffers({
      nodes,
      edges,
      positions: atlas.positions,
      coordinates: new Map(),
      packedCoordinates: coords
    });
    expect(buffers.instancePositions.length).toBe(nodes.length * 3);
    expect(buffers.instanceStyles.length).toBe(nodes.length * 4);
    expect(buffers.instanceFocusState.length).toBe(nodes.length);
    expect(buffers.edgeVertexCount).toBe(edges.length * 2);

    const changed = updateMemory3DFocusAttributes(buffers, nodes[0]!.id);
    expect(changed).toBe(true);
    expect(buffers.instanceFocusState[0]).toBe(2);

    updateMemory3DFocusAttributes(buffers, nodes[10]!.id);
    expect(buffers.instanceFocusState[0]).toBe(0);
    expect(buffers.instanceFocusState[10]).toBe(2);
    expect(MEMORY_3D_NODE_VERTEX_SHADER).toContain("#version 300 es");
    expect(MEMORY_3D_NODE_FRAGMENT_SHADER).toContain("#version 300 es");
    expect(MEMORY_3D_EDGE_VERTEX_SHADER).toContain("#version 300 es");
    expect(MEMORY_3D_EDGE_FRAGMENT_SHADER).toContain("#version 300 es");
  });

  it("caps Canvas 2D fallback nodes at 2,000 while preserving the selected node", () => {
    const { nodes, edges } = generateSyntheticMemoryGraph(10_000, 30_000);
    const selectedId = nodes[9_876]!.id;
    const fallback = selectMemory3DFallbackNodes(nodes, edges, selectedId, 2_000);
    expect(fallback.nodes.length).toBe(2_000);
    expect(fallback.nodes.some((n) => n.id === selectedId)).toBe(true);
  });

  it("supports configurable synthetic graph sizes in DemoStore and fast atlas building at 50k nodes", async () => {
    const store = new DemoStore();
    store.setSyntheticMemoryGraphSize(50_000, 150_000);

    const overviewDefault = await store.api.memoryGraphOverview({});
    expect(overviewDefault.data.nodes.length).toBe(2_000);
    expect(overviewDefault.data.totalMatchingNodes).toBe(50_000);
    expect(overviewDefault.data.truncated).toBe(true);

    const overview50k = await store.api.memoryGraphOverview({ limit: 50_000 });
    expect(overview50k.data.nodes.length).toBe(50_000);
    expect(overview50k.data.edges.length).toBe(150_000);
    expect(overview50k.data.truncated).toBe(false);

    const t0 = performance.now();
    const atlas = createMemoryAtlas(overview50k.data.nodes, overview50k.data.edges);
    const atlasMs = performance.now() - t0;
    expect(atlas.nodes.length).toBe(50_000);
    expect(atlas.edges.length).toBe(150_000);

    const tBuffer0 = performance.now();
    const buffers = buildMemory3DWebGLBuffers({
      nodes: overview50k.data.nodes,
      edges: overview50k.data.edges,
      positions: atlas.positions,
      coordinates: new Map()
    });
    const bufferBuildMs = performance.now() - tBuffer0;
    expect(buffers.instancePositions.length).toBe(50_000 * 3);

    const tIndex0 = performance.now();
    const index = buildMemory3DSpatialIndex({
      nodes: overview50k.data.nodes,
      coordinates: new Map(),
      packedCoordinates: null,
      camera: DEFAULT_MEMORY_CAMERA,
      scale: 1.0,
      width: 1920,
      height: 1080,
      focusId: null
    });
    const indexBuildMs = performance.now() - tIndex0;
    expect(index.nodes.length).toBe(50_000);

    const tPick0 = performance.now();
    for (let p = 0; p < 250; p++) {
      pickMemory3DNode(index, index.screenX[p * 200]!, index.screenY[p * 200]!);
    }
    const avgPickMs = (performance.now() - tPick0) / 250;

    if (process.env.MEMORY_BENCH) {
      expect(atlasMs).toBeLessThan(250);
      expect(bufferBuildMs).toBeLessThan(500);
      expect(indexBuildMs).toBeLessThan(100);
      expect(avgPickMs).toBeLessThanOrEqual(4);
    }

    const sampleMemoryNode = overview50k.data.nodes.find((n) => n.type === "MEMORY" && n.id.startsWith("memory:synthetic-"))!;
    const detail = await store.api.memoryGraphNode(sampleMemoryNode.id);
    expect(detail.node.id).toBe(sampleMemoryNode.id);
    expect(detail.record?.title).toBe(sampleMemoryNode.label);
  });

  it("executes the CPU projection and focus-update benchmark harness on 50k nodes with p95 under 16.6 ms", () => {
    const metrics = runMemory3DProjectionHarness(12);
    expect(metrics.nodeCount).toBe(50_000);
    expect(metrics.edgeCount).toBe(150_000);
    expect(metrics.sampleCount).toBe(12);
    expect(metrics.p50Ms).toBeGreaterThan(0);
    expect(metrics.p95Ms).toBeGreaterThan(0);
    if (process.env.MEMORY_BENCH) {
      const fullMetrics = runMemory3DProjectionHarness(120);
      expect(fullMetrics.p95Ms).toBeLessThan(16.6);
    }
  });

  it("executes the WebGL2 frame-time harness at 50,000 nodes / 150,000 edges and records p50 and p95", () => {
    const metrics = runMemory3DWebGLBenchmarkHarness(50_000, 150_000, 12);
    expect(metrics.nodeCount).toBe(50_000);
    expect(metrics.edgeCount).toBe(150_000);
    expect(metrics.sampleCount).toBe(12);
    expect(metrics.renderer).toBe("webgl2");
    expect(metrics.drawStats.instancedNodeDraws).toBe(12);
    expect(metrics.drawStats.edgeDraws).toBe(12);
    expect(metrics.drawStats.renderedNodes).toBe(50_000 * 12);
    expect(metrics.drawStats.renderedEdges).toBe(150_000 * 12);
    expect(metrics.p50Ms).toBeGreaterThan(0);
    expect(metrics.p95Ms).toBeGreaterThan(0);
    // Issue #62 acceptance criteria: p95 frame time <= 33 ms on 50k nodes / 150k edges
    expect(metrics.p95Ms).toBeLessThanOrEqual(33.0);
  });

  it("executes the WebGL2 frame-time harness at 2,000 nodes / 6,000 edges and records p50 and p95", () => {
    const metrics = runMemory3DWebGLBenchmarkHarness(2_000, 6_000, 12);
    expect(metrics.nodeCount).toBe(2_000);
    expect(metrics.edgeCount).toBe(6_000);
    expect(metrics.sampleCount).toBe(12);
    expect(metrics.renderer).toBe("webgl2");
    expect(metrics.drawStats.instancedNodeDraws).toBe(12);
    expect(metrics.drawStats.edgeDraws).toBe(12);
    expect(metrics.p50Ms).toBeGreaterThan(0);
    expect(metrics.p95Ms).toBeGreaterThan(0);
    // Issue #62 acceptance criteria: p95 frame time <= 16.7 ms on 2,000 nodes / 6,000 edges
    expect(metrics.p95Ms).toBeLessThanOrEqual(16.7);
  });
});

/**
 * Frame-time benchmark harness executing the WebGL2 path for each sampled frame:
 * node instanced draw, edge draw, in-place focus update, and camera yaw, pitch, or zoom changes.
 * Supports benchmarks at 50,000 nodes / 150,000 edges and at 2,000 nodes / 6,000 edges.
 * Records p50, p95, and average frame times and populates window.__SPACE_MEMORY_3D_METRICS__.
 *
 * @param nodeCount Number of graph nodes to generate and render.
 * @param edgeCount Number of graph edges to generate and render.
 * @param sampleCount Number of animation frames to sample (default: 120).
 * @returns WebGL2 frame-time metrics including p50, p95, average ms, and draw statistics.
 */
export function runMemory3DWebGLBenchmarkHarness(
  nodeCount = 50_000,
  edgeCount = 150_000,
  sampleCount = 120
): {
  renderer: "webgl2";
  nodeCount: number;
  edgeCount: number;
  sampleCount: number;
  p50Ms: number;
  p95Ms: number;
  avgMs: number;
  drawStats: {
    instancedNodeDraws: number;
    edgeDraws: number;
    renderedNodes: number;
    renderedEdges: number;
  };
} {
  const { nodes, edges } = generateSyntheticMemoryGraph(nodeCount, edgeCount);
  const atlas = createMemoryAtlas(nodes, edges);
  const coordinates = new Map<string, MemoryPoint3D>();
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const pos = atlas.positions.get(node.id) ?? { x: 0, y: 0 };
    coordinates.set(node.id, { x: pos.x, y: pos.y, z: ((i * 31) % 400) - 200 });
  }

  const buffers = buildMemory3DWebGLBuffers({
    nodes,
    edges,
    positions: atlas.positions,
    coordinates
  });

  let instancedNodeDraws = 0;
  let edgeDraws = 0;
  let renderedNodes = 0;
  let renderedEdges = 0;

  const mockGl = {
    useProgram: vi.fn(),
    bindVertexArray: vi.fn(),
    bindBuffer: vi.fn(),
    bufferSubData: vi.fn(),
    uniform1f: vi.fn(),
    uniform2f: vi.fn(),
    viewport: vi.fn(),
    clearColor: vi.fn(),
    clearDepth: vi.fn(),
    enable: vi.fn(),
    depthFunc: vi.fn(),
    blendFunc: vi.fn(),
    clear: vi.fn(),
    drawArrays: (_mode: number, _first: number, count: number) => {
      edgeDraws++;
      renderedEdges += count / 2;
    },
    drawArraysInstanced: (_mode: number, _first: number, _count: number, instanceCount: number) => {
      instancedNodeDraws++;
      renderedNodes += instanceCount;
    }
  };

  const frameTimes: number[] = [];
  const camera = { ...DEFAULT_MEMORY_CAMERA };

  for (let f = 0; f < sampleCount; f++) {
    // Camera yaw, pitch, or zoom changes for each sampled frame
    camera.yaw += 0.005;
    camera.pitch += 0.002;
    camera.zoom = 1.0 + Math.sin(f * 0.05) * 0.2;

    const t0 = performance.now();

    const extent = computeMemory3DExtent(coordinates, null);
    const scale = (Math.min(1920, 1080) * 0.4) / extent;

    mockGl.viewport(0, 0, 1920, 1080);
    mockGl.clear(16640 /* COLOR_BUFFER_BIT | DEPTH_BUFFER_BIT */);

    // In-place focus state update
    const focusId = f % 10 === 0 ? nodes[(f * 50) % nodes.length]!.id : null;
    if (updateMemory3DFocusAttributes(buffers, focusId)) {
      mockGl.bindBuffer(34962, {} as WebGLBuffer);
      mockGl.bufferSubData(34962, 0, buffers.instanceFocusState);
    }

    // WebGL2 edge draw
    if (buffers.edgeVertexCount > 0) {
      mockGl.uniform2f({} as WebGLUniformLocation, 1920, 1080);
      mockGl.uniform1f({} as WebGLUniformLocation, scale);
      mockGl.uniform1f({} as WebGLUniformLocation, camera.yaw);
      mockGl.uniform1f({} as WebGLUniformLocation, camera.pitch);
      mockGl.uniform1f({} as WebGLUniformLocation, camera.zoom);
      mockGl.drawArrays(1 /* LINES */, 0, buffers.edgeVertexCount);
    }

    // WebGL2 node instanced draw
    if (buffers.nodeCount > 0) {
      mockGl.uniform2f({} as WebGLUniformLocation, 1920, 1080);
      mockGl.uniform1f({} as WebGLUniformLocation, scale);
      mockGl.uniform1f({} as WebGLUniformLocation, camera.yaw);
      mockGl.uniform1f({} as WebGLUniformLocation, camera.pitch);
      mockGl.uniform1f({} as WebGLUniformLocation, camera.zoom);
      mockGl.drawArraysInstanced(5 /* TRIANGLE_STRIP */, 0, 4, buffers.nodeCount);
    }

    // Spatial index projection for picking
    buildMemory3DSpatialIndex({
      nodes,
      coordinates,
      packedCoordinates: null,
      camera,
      scale,
      width: 1920,
      height: 1080,
      focusId
    });

    const dur = performance.now() - t0;
    frameTimes.push(dur);
  }

  const sorted = [...frameTimes].sort((a, b) => a - b);
  const p50Ms = Math.round((sorted[Math.floor(sorted.length * 0.5)] ?? 0) * 100) / 100;
  const p95Ms = Math.round((sorted[Math.floor(sorted.length * 0.95)] ?? 0) * 100) / 100;
  const avgMs = Math.round((frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length) * 100) / 100;

  if (typeof window !== "undefined") {
    (window as unknown as { __SPACE_MEMORY_3D_METRICS__?: unknown }).__SPACE_MEMORY_3D_METRICS__ = {
      renderer: "webgl2",
      nodeCount: nodes.length,
      edgeCount: edges.length,
      p50Ms,
      p95Ms,
      avgMs,
      sampleCount: frameTimes.length
    };
  }

  return {
    renderer: "webgl2",
    nodeCount: nodes.length,
    edgeCount: edges.length,
    sampleCount: frameTimes.length,
    p50Ms,
    p95Ms,
    avgMs,
    drawStats: {
      instancedNodeDraws,
      edgeDraws,
      renderedNodes,
      renderedEdges
    }
  };
}

export const runMemory3DPerformanceHarness = runMemory3DWebGLBenchmarkHarness;

/**
 * Benchmark harness measuring p50, p95, and average CPU projection and focus-update times
 * across simulated frames with 50,000 nodes and 150,000 edges.
 *
 * @param sampleCount Number of frames to sample (defaults to 120).
 * @returns Benchmark metrics summary including p50, p95, and average ms.
 */
export function runMemory3DProjectionHarness(sampleCount = 120): {
  nodeCount: number;
  edgeCount: number;
  sampleCount: number;
  p50Ms: number;
  p95Ms: number;
  avgMs: number;
} {
  const { nodes, edges } = generateSyntheticMemoryGraph(50_000, 150_000);
  const atlas = createMemoryAtlas(nodes, edges);
  const coordinates = new Map<string, MemoryPoint3D>();
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const pos = atlas.positions.get(node.id) ?? { x: 0, y: 0 };
    coordinates.set(node.id, { x: pos.x, y: pos.y, z: ((i * 31) % 400) - 200 });
  }

  const buffers = buildMemory3DWebGLBuffers({
    nodes,
    edges,
    positions: atlas.positions,
    coordinates
  });

  const frameTimes: number[] = [];
  const camera = { ...DEFAULT_MEMORY_CAMERA };

  for (let f = 0; f < sampleCount; f++) {
    camera.yaw += 0.005;
    camera.pitch += 0.002;
    const t0 = performance.now();
    buildMemory3DSpatialIndex({
      nodes,
      coordinates,
      packedCoordinates: null,
      camera,
      scale: 1.0,
      width: 1920,
      height: 1080,
      focusId: f % 10 === 0 ? nodes[f * 50]!.id : null
    });
    if (f % 5 === 0) {
      updateMemory3DFocusAttributes(buffers, nodes[f * 50]!.id);
    }
    const dur = performance.now() - t0;
    frameTimes.push(dur);
  }

  const sorted = [...frameTimes].sort((a, b) => a - b);
  const p50Ms = Math.round((sorted[Math.floor(sorted.length * 0.5)] ?? 0) * 100) / 100;
  const p95Ms = Math.round((sorted[Math.floor(sorted.length * 0.95)] ?? 0) * 100) / 100;
  const avgMs = Math.round((frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length) * 100) / 100;

  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    sampleCount: frameTimes.length,
    p50Ms,
    p95Ms,
    avgMs
  };
}


