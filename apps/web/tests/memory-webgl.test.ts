import { IndexedMemoryCoordinates } from "../src/features/memory-workspace/memory-coordinates.js";
import { describe, expect, it } from "vitest";
import type { MemoryGraphNode } from "@space/contracts";
import { memoryLabelCandidates, memoryLabelsAtZoom, memoryFallbackGraph, MEMORY_LABEL_CANDIDATES, prepareMemoryGpuData } from "../src/features/memory-workspace/memory-webgl-data.js";
import { buildMemoryPickIndex, pickMemoryNode } from "../src/features/memory-workspace/memory-picking.js";
import { layoutMemoryNetwork3D, streamMemoryNetwork3D, projectMemoryPoint } from "../src/features/memory-workspace/memory-3d.js";
import { createSyntheticMemoryGraph } from "../src/demo/synthetic-memory-graph.js";

const node = (i: number, type: MemoryGraphNode["type"] = "MEMORY"): MemoryGraphNode => ({ id: `node:${i}`, type, label: i === 0 ? "gemini.md" : `Node ${i}`, recordId: null, sourcePath: null });
describe("memory WebGL data", () => {
  it("picks the nearest visible node and matches exhaustive projection across camera angles", () => {
    const count = 3000, points = new Float32Array(count * 3), radii = new Float32Array(count).fill(2.1);
    let state = 17;
    for (let i = 0; i < points.length; i++) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; points[i] = (state / 4294967296 - 0.5) * 300; }
    const index = buildMemoryPickIndex(points, radii);
    const scratch = new Int32Array(index.tree.length / 4);
    for (const camera of [{ yaw: 0, pitch: 0, zoom: 1 }, { yaw: 2.1, pitch: -0.6, zoom: 2 }, { yaw: -1, pitch: 1, zoom: 0.35 }]) {
      for (let sample = 0; sample < 40; sample++) {
        const x = 200 + sample * 11, y = 180 + sample % 11 * 12;
        let expected = -1, depth = Infinity;
        for (let i = 0; i < count; i++) {
          const p = projectMemoryPoint({ x: points[i * 3]!, y: points[i * 3 + 1]!, z: points[i * 3 + 2]! }, camera, 1.4, 900, 600);
          const radius = Math.max(7, Math.max(1, radii[i]! * p.perspective * Math.sqrt(camera.zoom)) + 3);
          if (Math.hypot(p.x - x, p.y - y) <= radius && p.z < depth) { expected = i; depth = p.z; }
        }
        expect(pickMemoryNode(index, camera, 1.4, 900, 600, x, y)).toBe(expected);
        expect(pickMemoryNode(index, camera, 1.4, 900, 600, x, y, -1, scratch)).toBe(expected);
      }
    }
    const overlapping = buildMemoryPickIndex(new Float32Array([0, 0, 10, 0, 0, -10]), new Float32Array([2, 2]));
    expect(pickMemoryNode(overlapping, { yaw: 0, pitch: 0, zoom: 1 }, 1, 900, 600, 450, 300)).toBe(1);
    expect(pickMemoryNode(overlapping, { yaw: 0, pitch: 0, zoom: 1 }, 1, 900, 600, 0, 0)).toBe(-1);
  });
  it("reuses picking storage across misses, depth ties and focused-node hits", () => {
    const points = new Float32Array(240 * 3), radii = new Float32Array(240).fill(2);
    for (let i = 2; i < 240; i++) { points[i * 3] = 100 + i; points[i * 3 + 2] = 20; }
    radii[0] = 10;
    const index = buildMemoryPickIndex(points, radii), scratch = new Int32Array(index.tree.length / 4);
    const camera = { yaw: 0, pitch: 0, zoom: 1 };
    expect(pickMemoryNode(index, camera, 1, 900, 600, 450, 300, -1, scratch)).toBe(0);
    expect(pickMemoryNode(index, camera, 1, 900, 600, 0, 0, -1, scratch)).toBe(-1);
    expect(pickMemoryNode(index, camera, 1, 900, 600, 466, 300, -1, scratch)).toBe(-1);
    expect(pickMemoryNode(index, camera, 1, 900, 600, 466, 300, 0, scratch)).toBe(0);
    expect(pickMemoryNode(index, camera, 1, 900, 600, 450, 300, -1, new Int32Array(1))).toBe(0);
  });
  it("bounds label work, keeps core/source priority and always includes selected nodes", () => {
    const nodes = Array.from({ length: 50000 }, (_, i) => node(i, i < 30 ? "SOURCE" : "MEMORY"));
    const candidates = memoryLabelCandidates(nodes);
    expect(candidates).toHaveLength(MEMORY_LABEL_CANDIDATES);
    expect(candidates.slice(0, 30)).toEqual(Array.from({ length: 30 }, (_, i) => i));
    expect(memoryLabelsAtZoom(nodes, candidates, 1, -1)).toHaveLength(30);
    expect(memoryLabelsAtZoom(nodes, candidates, 2, 49999)).toHaveLength(MEMORY_LABEL_CANDIDATES);
    expect(memoryLabelsAtZoom(nodes, candidates, 1, 49999)[0]).toBe(49999);
  });
  it("builds static adjacency and drops dangling edges, then caps Canvas fallback", () => {
    const nodes = Array.from({ length: 5000 }, (_, i) => node(i));
    const edges = [{ id: "a", source: "node:0", target: "node:1", type: "CONTAINS" as const }, { id: "b", source: "node:1", target: "node:4999", type: "CONTAINS" as const }, { id: "missing", source: "unknown", target: "node:1", type: "CONTAINS" as const }];
    const data = prepareMemoryGpuData(nodes, edges, new Map());
    expect([...data.endpoints]).toEqual([0, 1, 1, 4999]);
    expect([...data.neighbors.slice(data.offsets[1], data.offsets[2])]).toEqual([0, 4999]);
    const fallback = memoryFallbackGraph(nodes, edges);
    expect(fallback.nodes).toHaveLength(2000); expect(fallback.edges.map(edge => edge.id)).toEqual(["a"]);
  });
  it("streams usable independent positions before convergence and preserves deterministic final layout", () => {
    const nodes = Array.from({ length: 25 }, (_, i) => node(i, i === 0 ? "SOURCE" : "MEMORY"));
    const edges = nodes.slice(1).map(n => ({ id: n.id, source: nodes[0]!.id, target: n.id, type: "CONTAINS" as const }));
    const iterator = streamMemoryNetwork3D(nodes, edges, 30), initial = iterator.next().value!;
    const first = structuredClone(initial);
    const frames = [...iterator];
    expect(initial.iteration).toBe(0); expect(initial.done).toBe(false); expect(initial.positions.size).toBe(25);
    expect(frames.map(frame => frame.iteration)).toEqual([30, 60, 90, 120, 150, 180]);
    expect(initial).toEqual(first); expect(frames.at(-1)!.done).toBe(true);
    expect(frames.at(-1)!.positions).toEqual(layoutMemoryNetwork3D([...nodes].reverse(), [...edges].reverse()));
    expect(initial.positions).not.toEqual(frames.at(-1)!.positions);
  });
  it("generates reproducible provider-free graphs with exactly three edges per node", async () => {
    const first = await createSyntheticMemoryGraph(2000), second = await createSyntheticMemoryGraph(2000);
    expect(first).toEqual(second); expect(first.nodes).toHaveLength(2000); expect(first.edges).toHaveLength(6000);
    const ids = new Set(first.nodes.map(n => n.id));
    expect(first.edges.every(e => e.source !== e.target && ids.has(e.source) && ids.has(e.target))).toBe(true);
    expect((await createSyntheticMemoryGraph(2)).edges.every(e => e.source !== e.target)).toBe(true);
  });
});

it("reads transferred coordinates without rebuilding a graph-sized object map", () => {
  const points = new Float32Array([1, 2, 3, 4, 5, 6]);
  const coordinates = new IndexedMemoryCoordinates(new Map([["second", 1], ["first", 0]]), points);
  expect(coordinates.size).toBe(2);
  expect(coordinates.get("second")).toEqual({ x: 4, y: 5, z: 6 });
  expect(coordinates.get("missing")).toBeUndefined();
  const copy = coordinates.get("first")!; copy.x = 100;
  expect(points[0]).toBe(1);
  expect([...coordinates.values()]).toEqual([{ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }]);
});
