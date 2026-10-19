import { describe, expect, it, vi } from "vitest";
import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import type { MemoryPoint3D } from "../src/features/memory-workspace/memory-3d.js";
import {
  buildMemoryGpuScene, markMemoryNeighbors, memoryPickId, memoryVisibleLabels,
  updateMemoryCoordinates, prepareMemoryCoordinates, MEMORY_LABEL_CANDIDATES, MEMORY_LABEL_LIMIT
} from "../src/features/memory-workspace/memory-gpu-scene.js";

const node = (id: string, type: MemoryGraphNode["type"] = "MEMORY", label = id): MemoryGraphNode =>
  ({ id, type, label, sourcePath: null, recordId: type === "MEMORY" ? id : null });
const link = (source: string, target: string): MemoryGraphEdge =>
  ({ id: `${source}:${target}`, type: "CONTAINS", source, target });
const camera = { yaw: 0, pitch: 0, zoom: 2 };

describe("memory graph GPU scene data", () => {
  it("omits unknown endpoints and marks only real undirected neighbors", async () => {
    const nodes = [node("a"), node("b"), node("c"), node("isolated")];
    const scene = (await buildMemoryGpuScene(nodes,
      [link("a", "b"), link("b", "c"), link("a", "missing"), link("missing", "c")], new Map(), new Map()))!;
    expect(scene.edgeCount).toBe(2);
    expect([...scene.edges.subarray(0, scene.edgeCount * 3)]).toEqual([0, 1, 0, 1, 2, 0]);
    markMemoryNeighbors(scene, 1);
    expect([...scene.neighbors.subarray(0, nodes.length)]).toEqual([255, 0, 255, 0]);
    markMemoryNeighbors(scene, 0);
    expect([...scene.neighbors.subarray(0, nodes.length)]).toEqual([0, 255, 0, 0]);
    markMemoryNeighbors(scene, -1);
    expect(scene.neighbors.some(Boolean)).toBe(false);
    markMemoryNeighbors(scene, nodes.length);
    expect(scene.neighbors.some(Boolean)).toBe(false);
  });

  it("gives focused labels priority over core and source labels without overlapping text", async () => {
    // All points project to the same spot; exactly one label can occupy that screen space.
    const nodes = [node("ordinary"), node("source", "SOURCE"), node("core", "SOURCE", "space.md"), node("focused")];
    const scene = (await buildMemoryGpuScene(nodes, [], new Map(), new Map()))!;
    const labels = (focus: number) => memoryVisibleLabels(scene, camera, 800, 600, focus, () => 80);
    expect(labels(3).map((label) => label.index)).toEqual([3]);
    expect(labels(-1).map((label) => label.index)).toEqual([2]);
    const withoutCore = (await buildMemoryGpuScene(nodes.filter((item) => item.id !== "core"), [], new Map(), new Map()))!;
    expect(memoryVisibleLabels(withoutCore, camera, 800, 600, -1, () => 80).map((label) => label.index)).toEqual([1]);
  });

  it("bounds measurement work and reveals ordinary labels only at useful zoom or focus", async () => {
    const nodes = Array.from({ length: 500 }, (_, index) => node(`source-${index}`, "SOURCE"));
    const scene = (await buildMemoryGpuScene(nodes, [], new Map(), new Map()))!;
    const measure = vi.fn(() => 80);
    const labels = memoryVisibleLabels(scene, camera, 800, 600, 499, measure);
    expect(labels[0]?.index).toBe(499); // Focus is not lost outside the cached candidate set.
    expect(labels.length).toBeLessThanOrEqual(MEMORY_LABEL_LIMIT);
    expect(measure.mock.calls.length).toBeGreaterThan(0);
    expect(measure.mock.calls.length).toBeLessThanOrEqual(MEMORY_LABEL_CANDIDATES);
    const memories = (await buildMemoryGpuScene([node("memory")], [], new Map(), new Map()))!;
    expect(memoryVisibleLabels(memories, { ...camera, zoom: 1 }, 800, 600, -1, measure)).toEqual([]);
    expect(memoryVisibleLabels(memories, camera, 800, 600, -1, measure)).toHaveLength(1);
    expect(memoryVisibleLabels(memories, { ...camera, zoom: 1 }, 800, 600, 0, measure)).toHaveLength(1);
  });

  it("decodes every 50k RGB picking identifier and rejects background and out-of-range pixels", () => {
    // WebGL encodes index + 1 as little-endian RGB, reserving black for the background.
    const pixelFor = (index: number) => new Uint8Array([(index + 1) & 255, ((index + 1) >>> 8) & 255, ((index + 1) >>> 16) & 255, 255]);
    let roundTrips = true;
    for (let index = 0; index < 50000; index++) roundTrips &&= memoryPickId(pixelFor(index), 50000) === index;
    expect(roundTrips).toBe(true);
    expect(memoryPickId(new Uint8Array([0, 0, 0, 255]), 50000)).toBe(-1);
    expect(memoryPickId(pixelFor(50000), 50000)).toBe(-1);
    expect(memoryPickId(new Uint8Array([255, 255, 255, 255]), 50000)).toBe(-1);
    expect(memoryPickId(pixelFor(0), 0)).toBe(-1);
  });

  it("updates geometry without changing appearance, including extents after partial snapshots", async () => {
    const nodes = [node("core", "SOURCE", "space.md"), node("memory")];
    const points = new Map<string, MemoryPoint3D>([["core", { x: 1000, y: 0, z: 0 }], ["memory", { x: 0, y: 0, z: 0 }]]);
    const positions = new Map(nodes.map((item) => [item.id, { x: 0, y: 0, color: "#ff0000", hub: false, groupId: "test" }]));
    const scene = (await buildMemoryGpuScene(nodes, [], positions, points))!;
    const colors = scene.colors.slice();
    const radii = nodes.map((_, index) => scene.coordinates[index * 4 + 3]);
    updateMemoryCoordinates(scene, new Map([["memory", { x: 3, y: 4, z: 12 }]]));
    expect(scene.extent).toBe(1000); // The unchanged distant point still controls the camera framing.
    expect([...scene.coordinates.subarray(4, 7)]).toEqual([3, 4, 12]);
    updateMemoryCoordinates(scene, new Map([["core", { x: 0, y: 0, z: 300 }], ["memory", { x: 0, y: 400, z: 300 }]]));
    expect(scene.extent).toBe(500);
    expect(scene.colors).toEqual(colors);
    expect(nodes.map((_, index) => scene.coordinates[index * 4 + 3])).toEqual(radii);
  });

  it("prepares large coordinate snapshots across tasks without exposing partial geometry", async () => {
    const nodes = Array.from({ length: 4097 }, (_, index) => node(`n-${index}`, index === 0 ? "SOURCE" : "MEMORY", index === 0 ? "space.md" : `n-${index}`));
    const scene = (await buildMemoryGpuScene(nodes, [], new Map(), new Map([["n-0", { x: 1000, y: 0, z: 0 }]])))!;
    const before = scene.coordinates.slice(), colors = scene.colors;
    vi.useFakeTimers();
    try {
      const work = prepareMemoryCoordinates(scene, new Map([["n-4096", { x: 3, y: 4, z: 1200 }]]));
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      expect(scene.coordinates).toEqual(before);
      expect(scene.extent).toBe(1000);
      await vi.runAllTimersAsync();
      const prepared = (await work)!;
      expect(prepared.coordinates).not.toBe(scene.coordinates);
      expect([...prepared.coordinates.subarray(0, 4)]).toEqual([...before.subarray(0, 4)]);
      expect([...prepared.coordinates.subarray(4096 * 4, 4096 * 4 + 3)]).toEqual([3, 4, 1200]);
      expect(prepared.extent).toBeCloseTo(Math.hypot(3, 4, 1200));
      expect(nodes.every((_, index) => prepared.coordinates[index * 4 + 3] === before[index * 4 + 3])).toBe(true);
      expect(scene.coordinates).toEqual(before); // Caller alone decides when to publish.
      expect(scene.colors).toBe(colors);
    } finally { vi.useRealTimers(); }
  });

  it("cancels a prepared snapshot between batches without touching the displayed scene", async () => {
    const nodes = Array.from({ length: 4097 }, (_, index) => node(`n-${index}`));
    const scene = (await buildMemoryGpuScene(nodes, [], new Map(), new Map()))!;
    const before = scene.coordinates.slice();
    expect(await prepareMemoryCoordinates(scene, new Map(), () => true)).toBeNull();
    vi.useFakeTimers();
    try {
      let cancelled = false;
      const work = prepareMemoryCoordinates(scene, new Map([["n-0", { x: 999, y: 20, z: 30 }]]), () => cancelled);
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      cancelled = true;
      await vi.runAllTimersAsync();
      expect(await work).toBeNull();
      expect(scene.coordinates).toEqual(before);
      expect(scene.extent).toBe(60);
    } finally { vi.useRealTimers(); }
  });

  it("abandons canceled builds before work and between asynchronous batches", async () => {
    expect(await buildMemoryGpuScene([node("one")], [], new Map(), new Map(), () => true)).toBeNull();
    const nodes = Array.from({ length: 2049 }, (_, index) => node(`n-${index}`));
    let checks = 0;
    expect(await buildMemoryGpuScene(nodes, [], new Map(), new Map(), () => ++checks > 1)).toBeNull();
    expect(checks).toBeGreaterThan(1);
  });
});
