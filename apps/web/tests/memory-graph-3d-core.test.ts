import { describe, expect, it } from "vitest";
import { DEFAULT_MEMORY_CAMERA, projectMemoryPoint, type MemoryCamera3D } from "../src/features/memory-workspace/memory-3d.js";
import { createProjectionBuffers, parseColorHex, pickProjectedNode, projectMemoryPoints, projectionMatchesReference, projectionScale, ProjectedPointIndex, selectFallbackSubgraph, selectGraphLabels } from "../src/features/memory-workspace/memory-graph-3d-core.js";
import { buildGraphGeometry, writeFocusAttributes } from "../src/features/memory-workspace/memory-graph-gl.js";
import { createSyntheticMemoryGraph } from "../src/demo/synthetic-memory-graph.js";
import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";

const node = (id: string, type: MemoryGraphNode["type"] = "MEMORY", label = id): MemoryGraphNode => ({ id, type, label, recordId: type === "MEMORY" ? id : null, sourcePath: null });
const edge = (id: string, source: string, target: string, type: MemoryGraphEdge["type"] = "SEMANTICALLY_RELATED"): MemoryGraphEdge => ({ id, source, target, type });

const fixture = (count: number) => {
  const nodes: MemoryGraphNode[] = [node("root", "SOURCE", "space.md")];
  const edges: MemoryGraphEdge[] = [];
  for (let i = 0; i < count; i++) {
    nodes.push(node(`memory-${String(i).padStart(5, "0")}`, "MEMORY", `Memory ${i}`));
    edges.push(edge(`contains-${i}`, "root", `memory-${String(i).padStart(5, "0")}`, "CONTAINS"));
  }
  return { nodes, edges };
};

describe("3D batch projection", () => {
  it("matches the reference projection for every node", () => {
    const camera: MemoryCamera3D = { yaw: 0.7, pitch: -0.3, zoom: 1.4 };
    const positions = new Float32Array([0, 0, 0, 45, 20, 60, -120, 8, 33]);
    const projection = createProjectionBuffers(3);
    const scale = 2.5, width = 1000, height = 700;
    projectMemoryPoints(positions, 3, camera, scale, width, height, projection);
    expect(projectionMatchesReference(positions, 3, camera, scale, width, height, projection)).toBe(true);
    for (let i = 0; i < 3; i++) {
      const reference = projectMemoryPoint({ x: positions[i * 3]!, y: positions[i * 3 + 1]!, z: positions[i * 3 + 2]! }, camera, scale, width, height);
      expect(projection.x[i]).toBeCloseTo(reference.x, 3);
      expect(projection.y[i]).toBeCloseTo(reference.y, 3);
      expect(projection.perspective[i]).toBeCloseTo(reference.perspective, 3);
    }
  });

  it("scales the view to fit the point extent like the Canvas 2D renderer", () => {
    const positions = new Float32Array([100, 0, 0, -100, 0, 0, 0, 50, 0, 0, -50, 0, 0, 0, 0]);
    expect(projectionScale(positions, 5, 800, 600)).toBeCloseTo(Math.min(800, 600) * 0.4 / 100, 6);
  });

  it("parses the palette and falls back to the atlas default", () => {
    expect(parseColorHex("#57ccff")).toEqual([0x57 / 255, 0xcc / 255, 0xff / 255]);
    expect(parseColorHex(undefined)).toEqual([0x73 / 255, 0x95 / 255, 0xad / 255]);
    expect(parseColorHex("nope")).toEqual([0x73 / 255, 0x95 / 255, 0xad / 255]);
  });
});

describe("3D picking index", () => {
  it("finds the nearest node under the pointer without scanning every node", () => {
    const projection = createProjectionBuffers(4);
    const positions = new Float32Array([0, 0, 0, 10, 0, 0, 0, 0, 0, 20, 0, 0]);
    projectMemoryPoints(positions, 4, DEFAULT_MEMORY_CAMERA, 2, 1000, 700, projection);
    const index = new ProjectedPointIndex(28);
    index.build(projection.x, projection.y, 4);
    // Node 3 is nearest (smallest depth): its circle wins even when node 2 overlaps.
    projection.depth[2] = 5; projection.depth[3] = -50;
    const picked = pickProjectedNode(index, projection.x, projection.y, projection.depth, projection.x[3]! + 1, projection.y[3]!, () => 20);
    expect(picked).toBe(3);
    const missed = pickProjectedNode(index, projection.x, projection.y, projection.depth, 999, 999, () => 3);
    expect(missed).toBe(-1);
  });

  it("uses the per-node hit radius, matching the old tolerance", () => {
    const projection = createProjectionBuffers(1);
    projectMemoryPoints(new Float32Array([0, 0, 0]), 1, DEFAULT_MEMORY_CAMERA, 2, 1000, 700, projection);
    const index = new ProjectedPointIndex(28);
    index.build(projection.x, projection.y, 1);
    const x = projection.x[0]!, y = projection.y[0]!;
    expect(pickProjectedNode(index, projection.x, projection.y, projection.depth, x + 8, y, () => 9)).toBe(0);
    expect(pickProjectedNode(index, projection.x, projection.y, projection.depth, x + 11, y, () => 9)).toBe(-1);
  });
});

describe("3D label level of detail", () => {
  const labelFixture = (count: number) => fixture(count);
  const measure = (text: string) => text.length * 6;

  it("keeps core and source labels first and bounds how many labels are drawn", () => {
    const { nodes, edges } = labelFixture(5000);
    const positions = new Float32Array(nodes.length * 3);
    for (let i = 0; i < nodes.length; i++) { positions[i * 3] = i * 2; positions[i * 3 + 1] = 0; positions[i * 3 + 2] = 0; }
    const projection = createProjectionBuffers(nodes.length);
    projectMemoryPoints(positions, nodes.length, DEFAULT_MEMORY_CAMERA, 0.5, 2000, 1200, projection);
    const labels = selectGraphLabels({ xs: projection.x, ys: projection.y, depth: projection.depth, nodes, focusIndex: -1, showTitles: true, zoom: 1, width: 2000, height: 1200, measure, maxCandidates: 240, maxDrawn: 60 });
    expect(labels.length).toBeLessThanOrEqual(60);
    expect(labels.length).toBeGreaterThan(0);
    // The core file leads every other node.
    expect(nodes[labels[0]!.index]!.label).toBe("space.md");
    // No two labels collide.
    for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i]!, b = labels[j]!;
      expect(Math.abs(a.y - b.y) < 16 && a.x < b.x + b.w + 5 && a.x + a.w + 5 > b.x).toBe(false);
    }
  });

  it("draws nothing when titles are off and gates non-source labels at low zoom", () => {
    const { nodes } = labelFixture(50);
    const positions = new Float32Array(nodes.length * 3);
    for (let i = 0; i < nodes.length; i++) { positions[i * 3] = (i % 10) * 18; positions[i * 3 + 1] = Math.floor(i / 10) * 18; }
    const projection = createProjectionBuffers(nodes.length);
    projectMemoryPoints(positions, nodes.length, DEFAULT_MEMORY_CAMERA, 1, 800, 600, projection);
    const options = { xs: projection.x, ys: projection.y, depth: projection.depth, nodes, focusIndex: -1, zoom: 1, width: 800, height: 600, measure };
    expect(selectGraphLabels({ ...options, showTitles: false })).toEqual([]);
    // At zoom 1 only SOURCE labels pass the gate; memories stay hidden until the user zooms in.
    const lowZoom = selectGraphLabels({ ...options, showTitles: true });
    expect(lowZoom.every(label => nodes[label.index]!.type === "SOURCE")).toBe(true);
    const highZoom = selectGraphLabels({ ...options, showTitles: true, zoom: 2 });
    expect(highZoom.some(label => nodes[label.index]!.type === "MEMORY")).toBe(true);
  });

  it("is deterministic under input reordering", () => {
    const { nodes } = labelFixture(100);
    const positions = new Float32Array(nodes.length * 3);
    for (let i = 0; i < nodes.length; i++) positions[i * 3] = (i * 7) % 90;
    const projection = createProjectionBuffers(nodes.length);
    projectMemoryPoints(positions, nodes.length, DEFAULT_MEMORY_CAMERA, 1, 800, 600, projection);
    const base = { xs: projection.x, ys: projection.y, depth: projection.depth, nodes, focusIndex: -1, showTitles: true, zoom: 1, width: 800, height: 600, measure };
    const first = selectGraphLabels(base).map(label => nodes[label.index]!.id);
    const reordered = [...nodes].reverse();
    const projection2 = createProjectionBuffers(reordered.length);
    projectMemoryPoints(positions, reordered.length, DEFAULT_MEMORY_CAMERA, 1, 800, 600, projection2);
    const second = selectGraphLabels({ ...base, nodes: reordered, xs: projection2.x, ys: projection2.y, depth: projection2.depth }).map(label => reordered[label.index]!.id);
    expect(second.sort()).toEqual(first.sort());
  });
});

describe("3D Canvas 2D fallback sample", () => {
  it("caps the fallback graph deterministically and keeps the core file", () => {
    const { nodes, edges } = fixture(5000);
    const sample = selectFallbackSubgraph(nodes, edges, 2000);
    expect(sample.nodes.length).toBeLessThanOrEqual(2000);
    expect(sample.nodes.some(n => n.label === "space.md")).toBe(true);
    expect(sample.edges.every(edge => sample.nodes.some(n => n.id === edge.source) && sample.nodes.some(n => n.id === edge.target))).toBe(true);
    expect(selectFallbackSubgraph(nodes, edges, 2000)).toEqual(sample);
  });

  it("returns the graph unchanged below the cap", () => {
    const { nodes, edges } = fixture(100);
    expect(selectFallbackSubgraph(nodes, edges, 2000)).toEqual({ nodes, edges });
  });
});

describe("50k benchmark budgets (issue #62)", () => {
  const graph = createSyntheticMemoryGraph(50000);
  const coordinates = new Map(graph.nodes.map((node, i) => [node.id, { x: (i % 37) * 4 - 74, y: (i % 23) * 6 - 66, z: (i % 19) * 8 - 76 }]));
  const positions = new Map(graph.nodes.map(node => [node.id, { x: 0, y: 0, color: "#7395ad", hub: false, groupId: "synthetic" }]));

  it("picks nodes through the spatial index in well under the 4ms budget at 50k nodes", () => {
    const count = graph.nodes.length;
    const packed = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const point = coordinates.get(graph.nodes[i]!.id)!;
      packed[i * 3] = point.x; packed[i * 3 + 1] = point.y; packed[i * 3 + 2] = point.z;
    }
    const projection = createProjectionBuffers(count);
    projectMemoryPoints(packed, count, DEFAULT_MEMORY_CAMERA, projectionScale(packed, count, 1280, 900), 1280, 900, projection);
    const index = new ProjectedPointIndex(28);
    index.build(projection.x, projection.y, count);
    pickProjectedNode(index, projection.x, projection.y, projection.depth, 640, 450, () => 9);
    const started = performance.now();
    for (let i = 0; i < 200; i++) pickProjectedNode(index, projection.x, projection.y, projection.depth, (i * 7) % 1280, (i * 13) % 900, () => 9);
    expect((performance.now() - started) / 200).toBeLessThan(4);
  });

  it("repacks the full 50k/150k geometry on the main thread in under 100ms", () => {
    // Best of three: the budget is about the code's own cost, so scheduler noise from
    // the rest of the suite must not count against it.
    let best = Infinity;
    for (let run = 0; run < 3; run++) {
      const started = performance.now();
      const geometry = buildGraphGeometry(graph.nodes, graph.edges, positions, coordinates, null);
      best = Math.min(best, performance.now() - started);
      if (run === 0) { expect(geometry.count).toBe(50000); expect(geometry.edgeCount).toBeGreaterThan(140000); }
    }
    expect(best).toBeLessThan(100);
  });
});


describe("3D focus attribute update", () => {
  it("rewrites the focus slices in place, matching a fresh repack while positions stay untouched", () => {
    const { nodes, edges } = fixture(300);
    const coordinates = new Map(nodes.map((node, i) => [node.id, { x: (i % 17) * 3 - 24, y: (i % 11) * 5 - 25, z: (i % 7) * 9 - 27 }]));
    const positions = new Map(nodes.map(node => [node.id, { x: 0, y: 0, color: "#57ccff", hub: false, groupId: "g" }]));
    const geometry = buildGraphGeometry(nodes, edges, positions, coordinates, null);
    const positionsBefore = new Float32Array(geometry.positions);
    const edgePositionsBefore = new Float32Array(geometry.edgePositions);
    const focusId = nodes[5]!.id;
    writeFocusAttributes(geometry, nodes, edges, positions, coordinates, focusId);
    const fresh = buildGraphGeometry(nodes, edges, positions, coordinates, focusId);
    // In-place rewrite must be byte-identical to a full repack for every focus-dependent slice.
    expect(Array.from(geometry.colors)).toEqual(Array.from(fresh.colors));
    expect(Array.from(geometry.sizes)).toEqual(Array.from(fresh.sizes));
    expect(Array.from(geometry.glows)).toEqual(Array.from(fresh.glows));
    expect(Array.from(geometry.dims)).toEqual(Array.from(fresh.dims));
    expect(Array.from(geometry.edgeColors)).toEqual(Array.from(fresh.edgeColors));
    // Positions and the edge layout are focus-independent and must never be touched.
    expect(Array.from(geometry.positions)).toEqual(Array.from(positionsBefore));
    expect(Array.from(geometry.edgePositions)).toEqual(Array.from(edgePositionsBefore));
  });
});
