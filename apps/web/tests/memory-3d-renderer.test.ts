import { describe, expect, it } from "vitest";
import { memoryGraphOverviewPayloadSchema } from "@space/contracts";
import { createSyntheticMemoryGraph, syntheticMemoryOverview } from "../src/demo/synthetic-memory-graph.js";
import { chooseMemoryGraphRenderer } from "../src/features/memory-workspace/memory-3d-gl-client.js";
import { selectMemoryLabels } from "../src/features/memory-workspace/memory-3d-labels.js";
import {
  canvasFallbackEdgeIndexes,
  canvasFallbackIndexes,
  createProjectedMemoryNodes,
  projectMemoryNodes,
  SpatialPickIndex
} from "../src/features/memory-workspace/memory-3d-pick.js";
import {
  createMemoryNetwork3DLayout,
  DEFAULT_MEMORY_CAMERA,
  layoutMemoryNetwork3D,
  projectMemoryPoint,
  projectMemoryPoints
} from "../src/features/memory-workspace/memory-3d.js";
import { publishMemoryLaunchShell, readMemoryGraphLaunch, resetMemoryLaunchShellStartup, snapMemoryGraphLaunchSize } from "../src/features/memory-workspace/memory-graph-launch.js";
import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";

function smallGraph(): { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] } {
  const nodes: MemoryGraphNode[] = [{ id: "root", label: "space.md", type: "SOURCE", sourcePath: "/demo/memory/space.md", recordId: null }];
  const edges: MemoryGraphEdge[] = [];
  for (let index = 0; index < 12; index++) {
    const id = `memory:000000${index}`;
    nodes.push({ id, label: `Memory ${index}`, type: "MEMORY", sourcePath: "/demo/memory/space.md", recordId: id });
    edges.push({ id: `edge:${index}`, type: "CONTAINS", source: "root", target: id });
  }
  return { nodes, edges };
}

describe("3D memory layout streaming", () => {
  it("matches a single batched run when positions are advanced in slices", () => {
    const { nodes, edges } = smallGraph();
    const streamed = createMemoryNetwork3DLayout(nodes, edges);
    expect(streamed.done).toBe(false);
    streamed.advance(10);
    expect(streamed.step).toBe(10);
    expect(streamed.done).toBe(false);
    streamed.advance(streamed.steps);
    expect(streamed.done).toBe(true);
    const positions = new Float32Array(streamed.ids.length * 3);
    streamed.writePositions(positions);
    const batched = createMemoryNetwork3DLayout(nodes, edges);
    batched.advance(batched.steps);
    const once = new Float32Array(batched.ids.length * 3);
    batched.writePositions(once);
    expect(Array.from(positions)).toEqual(Array.from(once));
    const layout = layoutMemoryNetwork3D(nodes, edges);
    streamed.ids.forEach((id, index) => {
      const point = layout.get(id)!;
      expect(positions[index * 3]).toBeCloseTo(point.x);
      expect(positions[index * 3 + 1]).toBeCloseTo(point.y);
      expect(positions[index * 3 + 2]).toBeCloseTo(point.z);
    });
    expect(layout.get("root")).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("keeps the fast approximation deterministic with the core pinned", () => {
    const { nodes, edges } = smallGraph();
    const first = createMemoryNetwork3DLayout(nodes, edges, { mode: "fast" });
    const second = createMemoryNetwork3DLayout([...nodes].reverse(), [...edges].reverse(), { mode: "fast" });
    first.advance(first.steps);
    second.advance(second.steps);
    const left = new Float32Array(first.ids.length * 3);
    const right = new Float32Array(second.ids.length * 3);
    first.writePositions(left);
    second.writePositions(right);
    expect(first.ids).toEqual(second.ids);
    expect(Array.from(left)).toEqual(Array.from(right));
    const root = first.ids.indexOf("root");
    expect([left[root * 3], left[root * 3 + 1], left[root * 3 + 2]]).toEqual([0, 0, 0]);
  });

  it("projects batches with the same camera math as a single point", () => {
    const xyz = new Float32Array([45, 20, 60, -10, 4, 8]);
    const outX = new Float32Array(2);
    const outY = new Float32Array(2);
    const outZ = new Float32Array(2);
    const outPerspective = new Float32Array(2);
    projectMemoryPoints(xyz, 2, DEFAULT_MEMORY_CAMERA, 2, 1000, 700, outX, outY, outZ, outPerspective);
    for (let index = 0; index < 2; index++) {
      const point = projectMemoryPoint({
        x: xyz[index * 3]!,
        y: xyz[index * 3 + 1]!,
        z: xyz[index * 3 + 2]!
      }, DEFAULT_MEMORY_CAMERA, 2, 1000, 700);
      expect(outX[index]).toBeCloseTo(point.x);
      expect(outY[index]).toBeCloseTo(point.y);
      expect(outZ[index]).toBeCloseTo(point.z);
      expect(outPerspective[index]).toBeCloseTo(point.perspective);
    }
  });
});

describe("3D memory picking and labels", () => {
  it("finds the closest node without scanning when the pointer misses", () => {
    const projected = createProjectedMemoryNodes(2);
    projected.x.set([100, 400]);
    projected.y.set([80, 90]);
    projected.z.set([5, 1]);
    projected.radius.set([8, 8]);
    const index = new SpatialPickIndex();
    index.rebuild(projected, new Uint8Array([2, 0]));
    expect(index.find(100, 80)).toBe(0);
    expect(index.find(400, 90)).toBe(1);
    expect(index.find(10, 10)).toBe(-1);
  });

  it("ignores nodes the canvas fallback did not draw", () => {
    const projected = createProjectedMemoryNodes(3);
    projected.x.set([100, 108, 400]);
    projected.y.set([80, 80, 90]);
    projected.z.set([5, 0, 1]);
    projected.radius.set([12, 12, 8]);
    const index = new SpatialPickIndex();
    index.rebuild(projected, new Uint8Array([0, 0, 2]));
    expect(index.find(104, 80)).toBe(1);
    index.rebuild(projected, new Uint8Array([0, 0, 2]), new Uint32Array([0, 2]));
    expect(index.find(104, 80)).toBe(0);
    expect(index.find(400, 90)).toBe(2);
    expect(index.labelCandidates(800, 600).includes(1)).toBe(false);
  });

  it("answers a 50,000 node pick in under 4 ms", () => {
    const count = 50_000;
    const projected = createProjectedMemoryNodes(count);
    const kinds = new Uint8Array(count);
    for (let index = 0; index < count; index++) {
      projected.x[index] = (index % 250) * 8;
      projected.y[index] = Math.floor(index / 250) * 8;
      projected.z[index] = index;
      projected.radius[index] = 4;
    }
    const index = new SpatialPickIndex();
    index.rebuild(projected, kinds);
    const queries = 30;
    const started = performance.now();
    let hits = 0;
    for (let query = 0; query < queries; query++) {
      const target = query * 1_000;
      if (index.find(projected.x[target]!, projected.y[target]!) === target) hits += 1;
    }
    const average = (performance.now() - started) / queries;
    expect(hits).toBe(queries);
    expect(average).toBeLessThan(4);
  });

  it("keeps label measurement and drawing bounded", () => {
    expect(selectMemoryLabels({
      showTitles: false, zoom: 3, focus: 0, width: 800, height: 600, measure: () => 10,
      candidates: [{ index: 0, x: 10, y: 20, kind: 2, text: "space.md" }]
    })).toEqual([]);
    const candidates = Array.from({ length: 200 }, (_, index) => ({
      index,
      x: 30 + (index % 8) * 90,
      y: 40 + Math.floor(index / 8) * 28,
      kind: index === 3 ? 2 : index < 6 ? 1 : 0,
      text: index === 4 ? "x".repeat(80) : `Node ${index}`
    }));
    let measured = 0;
    const zoomedOut = selectMemoryLabels({
      showTitles: true,
      zoom: 1,
      focus: 20,
      width: 900,
      height: 700,
      candidates,
      measure: text => { measured += 1; return text.length * 4; }
    });
    expect(measured).toBeLessThanOrEqual(48);
    expect(zoomedOut.length).toBeLessThanOrEqual(40);
    expect(zoomedOut[0]?.index).toBe(20);
    expect(zoomedOut.some(label => label.text.endsWith("…"))).toBe(true);
    const collided = selectMemoryLabels({
      showTitles: true,
      zoom: 2,
      focus: -1,
      width: 400,
      height: 200,
      candidates: [
        { index: 0, x: 20, y: 40, kind: 2, text: "space.md" },
        { index: 1, x: 22, y: 40, kind: 1, text: "archive.md" }
      ],
      measure: () => 80
    });
    expect(collided.map(label => label.index)).toEqual([0]);
  });

  it("caps the canvas fallback at 2,000 nodes and prefers the core", () => {
    const kinds = new Uint8Array(5_000);
    kinds[4_900] = 2;
    kinds[10] = 1;
    const indexes = canvasFallbackIndexes(kinds);
    expect(indexes.length).toBe(2_000);
    expect(indexes[0]).toBe(4_900);
    expect(indexes[1]).toBe(10);
    expect(chooseMemoryGraphRenderer({ webgl2: true, contextLost: false })).toBe("webgl2");
    expect(chooseMemoryGraphRenderer({ webgl2: false, contextLost: false })).toBe("canvas2d");
    expect(chooseMemoryGraphRenderer({ webgl2: true, contextLost: true })).toBe("canvas2d");
    const pairs = new Uint32Array([3_000, 3_001, 4_900, 10, 10, 4_900, 0, 1]);
    const edges = canvasFallbackEdgeIndexes(pairs, indexes, kinds.length, 2);
    expect(Array.from(edges)).toEqual([1, 2]);
  });

  it("projects node radii from the same camera used for picking", () => {
    const xyz = new Float32Array([0, 0, 0]);
    const radii = new Float32Array([10]);
    const projected = createProjectedMemoryNodes(1);
    projectMemoryNodes(xyz, radii, DEFAULT_MEMORY_CAMERA, 1, 800, 600, projected);
    const point = projectMemoryPoint({ x: 0, y: 0, z: 0 }, DEFAULT_MEMORY_CAMERA, 1, 800, 600);
    expect(projected.x[0]).toBeCloseTo(point.x);
    expect(projected.y[0]).toBeCloseTo(point.y);
    expect(projected.radius[0]).toBeGreaterThan(1);
  });
});

describe("synthetic memory graphs", () => {
  it("is deterministic and stays inside the overview contract", () => {
    const graph = createSyntheticMemoryGraph(80, 90);
    const again = createSyntheticMemoryGraph(80, 90);
    expect(graph.nodeCount).toBe(80);
    expect(graph.edgeCount).toBe(90);
    expect(graph.nodes.map(node => node.id)).toEqual(again.nodes.map(node => node.id));
    expect(graph.nodes[0]).toMatchObject({ label: "space.md", type: "SOURCE" });
    expect(graph.edges.some(edge => edge.type === "TAGGED_WITH" && edge.origin === "EXPLICIT_TAG")).toBe(true);
    const overview = syntheticMemoryOverview(40, 50);
    expect(memoryGraphOverviewPayloadSchema.parse(overview)).toEqual(overview);
    expect(overview.summary.sourceCount).toBeLessThanOrEqual(24);
  });
});

describe("memory graph launch query", () => {
  it("snaps requested sizes and reads the benchmark flag", () => {
    expect(snapMemoryGraphLaunchSize(2_000)).toBe(2_000);
    expect(snapMemoryGraphLaunchSize(12_000)).toBe(10_000);
    expect(snapMemoryGraphLaunchSize(50_000)).toBe(50_000);
    expect(readMemoryGraphLaunch("?memoryNodes=50000&memoryEdges=150000&benchmark=1")).toEqual({
      nodes: 50_000,
      edges: 150_000,
      benchmark: true
    });
    expect(readMemoryGraphLaunch("?memoryNodes=50000&benchmark=1")).toEqual({
      nodes: 50_000,
      edges: 150_000,
      benchmark: true
    });
    expect(readMemoryGraphLaunch("?memoryNodes=2000&memoryEdges=")).toEqual({
      nodes: 2_000,
      edges: 6_000,
      benchmark: false
    });
    expect(readMemoryGraphLaunch("?memoryNodes=2000&memoryEdges=0")).toEqual({
      nodes: 2_000,
      edges: 0,
      benchmark: false
    });
    expect(readMemoryGraphLaunch("")).toBeNull();
  });

  it("time-slices only the first shell publish of a direct graph launch", () => {
    resetMemoryLaunchShellStartup();
    let calls = 0;
    expect(publishMemoryLaunchShell(() => { calls += 1; }, "?memoryNodes=50000")).toBe(true);
    expect(publishMemoryLaunchShell(() => { calls += 1; }, "?memoryNodes=50000")).toBe(false);
    expect(publishMemoryLaunchShell(() => { calls += 1; }, "")).toBe(false);
    expect(calls).toBe(3);
    resetMemoryLaunchShellStartup();
    expect(publishMemoryLaunchShell(() => { calls += 1; }, "")).toBe(false);
    expect(publishMemoryLaunchShell(() => { calls += 1; }, "?memoryNodes=50000")).toBe(false);
    expect(calls).toBe(5);
  });
});
