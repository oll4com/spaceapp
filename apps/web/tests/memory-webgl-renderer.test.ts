import { describe, expect, it } from "vitest";
import type { MemoryGraphNode } from "@space/contracts";
import { DEFAULT_MEMORY_CAMERA, projectMemoryPoint, type MemoryCamera3D } from "../src/features/memory-workspace/memory-3d.js";
import { MEMORY_FALLBACK_NODE_LIMIT, MEMORY_LABEL_CANDIDATE_LIMIT, MEMORY_LABEL_LIMIT, memoryFallbackNodes, memoryLabelLayout, prepareMemoryRenderData, prepareMemoryRenderDataAsync } from "../src/features/memory-workspace/memory-webgl-renderer.js";
import { MemorySpatialIndex } from "../src/features/memory-workspace/memory-spatial-index.js";

function fixture(count: number) {
  const nodes: MemoryGraphNode[] = Array.from({ length: count }, (_, index) => ({ id: `node-${index}`, label: index === count - 1 ? "space.md" : index % 10 === 0 ? `source-${index}.md` : `Memory ${index}`, type: index % 10 === 0 || index === count - 1 ? "SOURCE" : "MEMORY", sourcePath: null, recordId: null }));
  const coordinates = new Map(nodes.map((node, index) => [node.id, { x: Math.sin(index * 2.399) * (40 + index % 600), y: Math.cos(index * 1.734) * (40 + index % 600), z: Math.sin(index * 0.738) * (40 + index % 600) }]));
  return prepareMemoryRenderData(nodes, [], new Map(), coordinates);
}

describe("memory GPU render preparation", () => {
  it("prepares the same buffers cooperatively and cancels stale snapshots", async () => {
    const fixtureData = fixture(2000), nodes = fixtureData.nodes.map(item => item.node), coordinates = new Map(fixtureData.nodes.map(item => [item.node.id, item.point]));
    const asyncData = await prepareMemoryRenderDataAsync(nodes, [], new Map(), coordinates, () => false);
    expect(asyncData?.nodeBuffer).toEqual(fixtureData.nodeBuffer);
    expect(await prepareMemoryRenderDataAsync(nodes, [], new Map(), coordinates, () => true)).toBeNull();
    expect(await MemorySpatialIndex.create(fixtureData, () => true)).toBeNull();
    const index = await MemorySpatialIndex.create(fixtureData, () => false);
    expect(index?.pick(500, 350, DEFAULT_MEMORY_CAMERA, 1000, 700, null)).toEqual(new MemorySpatialIndex(fixtureData).pick(500, 350, DEFAULT_MEMORY_CAMERA, 1000, 700, null));
  });
  it("rejects missing/nonfinite coordinates and dangling edges before upload", () => {
    const nodes = fixture(3).nodes.map(item => item.node);
    const data = prepareMemoryRenderData(nodes, [{ id: "missing", source: nodes[0]!.id, target: "absent", type: "CONTAINS" }], new Map(), new Map([[nodes[0]!.id, { x: 0, y: 0, z: 0 }], [nodes[1]!.id, { x: NaN, y: 0, z: 0 }]]));
    expect(data.nodes).toHaveLength(1); expect(data.edges).toHaveLength(0);
    expect([...data.nodeBuffer].every(Number.isFinite)).toBe(true);
  });
  it("keeps selected/core nodes while capping a fallback at 2k nodes", () => {
    const data = fixture(50_000), fallback = memoryFallbackNodes(data, "node-49001");
    expect(fallback).toHaveLength(MEMORY_FALLBACK_NODE_LIMIT);
    expect(fallback.some(item => item.node.id === "node-49001")).toBe(true);
    expect(fallback.some(item => item.node.label === "space.md")).toBe(true);
  });
});

describe("bounded label LOD", () => {
  it("prioritizes focus/core/source and bounds measurements and collision-free draws at 50k", () => {
    const data = fixture(50_000); let measurements = 0;
    const labels = memoryLabelLayout(data, { ...DEFAULT_MEMORY_CAMERA, zoom: 2 }, 1000, 700, "node-49001", () => { measurements++; return 70; });
    expect(labels.length).toBeLessThanOrEqual(MEMORY_LABEL_LIMIT); expect(measurements).toBeLessThanOrEqual(MEMORY_LABEL_CANDIDATE_LIMIT);
    expect(labels[0]?.node.node.id).toBe("node-49001");
    for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i]!, b = labels[j]!;
      expect(Math.abs(a.y - b.y) >= 16 || a.x >= b.x + b.width + 5 || a.x + a.width + 5 <= b.x).toBe(true);
    }
  });
  it("limits non-source labels at overview zoom while retaining a focused memory", () => {
    const data = fixture(200);
    const labels = memoryLabelLayout(data, DEFAULT_MEMORY_CAMERA, 1000, 700, "node-17", () => 40);
    expect(labels.every(label => label.node.node.type === "SOURCE" || label.node.node.id === "node-17")).toBe(true);
  });
});

describe("world-space BVH picking", () => {
  it("can cancel inside both the root bounds scan and its median partition", async () => {
    for (const threshold of [1000, 31_000]) {
      const data = fixture(10_000); let reads = 0;
      for (const item of data.nodes) for (const axis of ["x", "y", "z"] as const) {
        const value = item.point[axis];
        Object.defineProperty(item.point, axis, { get() { reads++; return value; } });
      }
      const result = await MemorySpatialIndex.create(data, () => reads > threshold);
      expect(result).toBeNull();
      // A whole 10k-node bounds pass alone reads 30k coordinates; the old
      // whole-branch partition could not observe cancellation this early.
      expect(reads).toBeLessThan(threshold + 3000);
    }
  });
  const brute = (data: ReturnType<typeof fixture>, x: number, y: number, camera: MemoryCamera3D, focus: string | null, width = 1000, height = 700) => {
    const scale = Math.min(width, height) * 0.4 / data.extent; let id: string | null = null, z = Infinity;
    for (const item of data.nodes) {
      const p = projectMemoryPoint(item.point, camera, scale, width, height);
      const radius = Math.max(1, item.radius * p.perspective * Math.sqrt(camera.zoom)) * (item.node.id === focus ? 1.5 : 1);
      if (p.z <= z && Math.hypot(p.x - x, p.y - y) <= Math.max(7, radius + 3)) { id = item.node.id; z = p.z; }
    }
    return id;
  };
  it("matches exact screen circles/depth across rotation and zoom, without rebuilding the index", () => {
    const data = fixture(1200), index = new MemorySpatialIndex(data);
    for (const camera of [DEFAULT_MEMORY_CAMERA, { yaw: Math.PI / 2, pitch: -1.3, zoom: 0.35 }, { yaw: 8.8, pitch: 3.7, zoom: 5 }]) {
      for (let n = 0; n < 30; n++) {
        const item = data.nodes[n * 37]!, point = projectMemoryPoint(item.point, camera, 700 * 0.4 / data.extent, 1000, 700);
        for (const offset of [0, 5, 12]) expect(index.pick(point.x + offset, point.y, camera, 1000, 700, item.node.id).id).toBe(brute(data, point.x + offset, point.y, camera, item.node.id));
      }
    }
  });
  it("returns empty for an empty graph and prunes a 50k volume query", () => {
    expect(new MemorySpatialIndex(fixture(0)).pick(500, 350, DEFAULT_MEMORY_CAMERA, 1000, 700, null).id).toBeNull();
    const data = fixture(50_000), result = new MemorySpatialIndex(data).pick(600, 350, DEFAULT_MEMORY_CAMERA, 1000, 700, null);
    expect(result.candidates).toBeLessThan(5000);
    expect(result.id).toBe(brute(data, 600, 350, DEFAULT_MEMORY_CAMERA, null));
  });
  it("matches the clamped near-plane projection on large surfaces", () => {
    const data = fixture(1000), index = new MemorySpatialIndex(data), camera = { yaw: 1.1, pitch: -0.2, zoom: 0.35 };
    for (let i = 0; i < 30; i++) {
      const point = projectMemoryPoint(data.nodes[i * 31]!.point, camera, 4000 * 0.4 / data.extent, 5000, 4000);
      expect(index.pick(point.x, point.y, camera, 5000, 4000, null).id).toBe(brute(data, point.x, point.y, camera, null, 5000, 4000));
    }
  });
  it("picks the last drawn instance when coincident nodes have equal depth", () => {
    const original = fixture(20), nodes = original.nodes.map(item => item.node);
    const data = prepareMemoryRenderData(nodes, [], new Map(), new Map(nodes.map(node => [node.id, { x: 0, y: 0, z: 0 }])));
    expect(new MemorySpatialIndex(data).pick(500, 350, DEFAULT_MEMORY_CAMERA, 1000, 700, null).id).toBe(nodes.at(-1)!.id);
  });
});
