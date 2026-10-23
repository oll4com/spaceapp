import { describe, expect, it } from "vitest";
import {
  MemoryLayout3DSimulation,
  MemoryPickIndex,
  buildStreamedMemoryPositions,
  collectMemoryLabelCandidates,
  layoutMemoryNetwork3D,
  memoryNodeRadius,
  projectMemoryPoint,
  projectMemoryPoints,
  selectMemoryLabels,
  DEFAULT_MEMORY_CAMERA,
  MEMORY_LABEL_CANDIDATE_CAP,
  type MemoryLabelCandidate
} from "../src/features/memory-workspace/memory-3d.js";
import { generateSyntheticMemoryGraph } from "../src/demo/synthetic-memory-graph.js";
import { isMemoryCoreLabel } from "../src/features/memory-workspace/memory-graph-visuals.js";
import { memoryGraphEdgeSchema, memoryGraphNodeSchema, type MemoryGraphEdge, type MemoryGraphNode } from "@space/contracts";

/** Small deterministic fixture graph for the 3D layout and projection tests. */
function fixture(nodeCount = 127) {
  const nodes: MemoryGraphNode[] = [{ id: "root", label: "gemini.md", type: "SOURCE", sourcePath: "/opt/spaceapp/docs/gemini.md", recordId: null }];
  const edges: MemoryGraphEdge[] = [];
  const perSource = Math.ceil((nodeCount - 1) / 6);
  for (let file = 0; file < 6 && nodes.length < nodeCount; file++) {
    const id = `source-${file}`;
    nodes.push({ id, label: `${id}.md`, type: "SOURCE", sourcePath: `/opt/spaceapp/docs/${id}.md`, recordId: null });
    edges.push({ id: `file-${file}`, type: "DERIVED_FROM", source: "root", target: id });
    for (let item = 0; item < perSource && nodes.length < nodeCount; item++) {
      const memory = `${id}-memory-${item}`;
      nodes.push({ id: memory, label: memory, type: "MEMORY", sourcePath: `/opt/spaceapp/docs/${id}.md`, recordId: memory });
      edges.push({ id: memory, type: "CONTAINS", source: id, target: memory });
    }
  }
  return { nodes, edges };
}

// Deterministic pseudo-random values in [0, 1).
/** Deterministic pseudo-random generator (mulberry32) for repeatable fixtures. */
const rand = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967295;
  };
};

describe("streaming 3D layout simulation", () => {
  it("matches the one-shot layout exactly when run to completion", () => {
    const { nodes, edges } = fixture();
    const simulation = new MemoryLayout3DSimulation(nodes, edges);
    expect(simulation.done).toBe(false);
    simulation.step(Number.POSITIVE_INFINITY);
    expect(simulation.done).toBe(true);
    expect(simulation.stepCount).toBe(180);
    expect(simulation.snapshot()).toEqual(layoutMemoryNetwork3D(nodes, edges));
  });

  it("streams intermediate snapshots that converge to the final layout", () => {
    const { nodes, edges } = fixture();
    const simulation = new MemoryLayout3DSimulation(nodes, edges);
    simulation.step(10);
    const early = simulation.snapshot();
    expect(simulation.done).toBe(false);
    simulation.step(Number.POSITIVE_INFINITY);
    const final = simulation.snapshot();
    expect(final).toEqual(layoutMemoryNetwork3D(nodes, edges));
    expect(early.get("source-0-memory-0")).not.toEqual(final.get("source-0-memory-0"));
    // Position arrays follow nodeIds order and carry one XYZ triple per node.
    const positions = simulation.positionsArray();
    expect(positions).toHaveLength(nodes.length * 3);
    expect(simulation.nodeIds[0]).toBe("root");
    expect(positions[0]).toBe(0);
    expect(positions[1]).toBe(0);
    expect(positions[2]).toBe(0);
  });
});

describe("streamed scene position rebuild", () => {
  it("matches a full repack exactly, including derived edge positions and extent", () => {
    const { nodes, edges } = fixture(400);
    const simulation = new MemoryLayout3DSimulation(nodes, edges);
    const ids = simulation.nodeIds;
    const indexById = new Map(ids.map((id, index) => [id, index]));
    const visibleEdges = edges.filter(edge => indexById.has(edge.source) && indexById.has(edge.target));
    const edgeNodeIndices = new Float32Array(visibleEdges.flatMap(edge => [indexById.get(edge.source)!, indexById.get(edge.target)!]));
    simulation.step(12);
    const coordinates = simulation.snapshot();
    const streamed = buildStreamedMemoryPositions(ids, edgeNodeIndices, coordinates);
    expect(streamed).not.toBeNull();
    // Node positions are exactly the simulation's flat array for this snapshot.
    expect(streamed!.positions).toEqual(simulation.positionsArray());
    // Every derived edge endpoint equals its node's new position.
    for (let vertex = 0; vertex < edgeNodeIndices.length; vertex++) {
      const nodeIndex = edgeNodeIndices[vertex]!;
      expect(streamed!.edgePositions[vertex * 3]).toBe(streamed!.positions[nodeIndex * 3]);
      expect(streamed!.edgePositions[vertex * 3 + 1]).toBe(streamed!.positions[nodeIndex * 3 + 1]);
      expect(streamed!.edgePositions[vertex * 3 + 2]).toBe(streamed!.positions[nodeIndex * 3 + 2]);
    }
    // The extent follows the new snapshot (it grows as the layout expands),
    // never the first snapshot's.
    const expectedExtent = Math.max(60, ...ids.map(id => { const p = coordinates.get(id)!; return Math.hypot(p.x, p.y, p.z); }));
    expect(streamed!.extent).toBe(expectedExtent);
    // A scene node without a coordinate yet aborts to the full rebuild.
    const partial = new Map(coordinates);
    partial.delete(ids[0]!);
    expect(buildStreamedMemoryPositions(ids, edgeNodeIndices, partial)).toBeNull();
  });
});

describe("batch projection", () => {
  it("matches projectMemoryPoint component for component", () => {
    const random = rand(42);
    const count = 500;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count * 3; i++) positions[i] = (random() - 0.5) * 520;
    const camera = { yaw: 0.7, pitch: -0.3, zoom: 1.4 };
    const projected = projectMemoryPoints(positions, camera, 2.5, 1200, 800);
    for (let i = 0; i < count; i += 37) {
      const expected = projectMemoryPoint(
        { x: positions[i * 3]!, y: positions[i * 3 + 1]!, z: positions[i * 3 + 2]! },
        camera, 2.5, 1200, 800
      );
      // The batch path stores float32, so agreement is to sub-pixel precision.
      expect(Math.abs(projected[i * 4]! - expected.x)).toBeLessThan(1e-3);
      expect(Math.abs(projected[i * 4 + 1]! - expected.y)).toBeLessThan(1e-3);
      expect(Math.abs(projected[i * 4 + 2]! - expected.z)).toBeLessThan(1e-3);
      expect(Math.abs(projected[i * 4 + 3]! - expected.perspective)).toBeLessThan(1e-5);
    }
  });
});

describe("spatial pick index", () => {
  /** Build a pick index plus random projections for the probe tests. */
  const build = (count: number) => {
    const random = rand(7);
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count * 3; i++) positions[i] = (random() - 0.5) * 520;
    const projected = projectMemoryPoints(positions, DEFAULT_MEMORY_CAMERA, 2.2, 1200, 800);
    const radii = new Float32Array(count);
    for (let i = 0; i < count; i++) radii[i] = memoryNodeRadius(2.1, projected[i * 4 + 3]!, DEFAULT_MEMORY_CAMERA.zoom, false);
    const index = new MemoryPickIndex();
    index.rebuild(projected, radii);
    return { projected, radii, index };
  };
  /** O(n) reference implementation the spatial pick index is verified against. */
  const bruteForce = (x: number, y: number, projected: Float32Array, radii: Float32Array) => {
    let best = -1, bestDepth = Number.POSITIVE_INFINITY, bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < radii.length; i++) {
      const distance = Math.hypot(projected[i * 4]! - x, projected[i * 4 + 1]! - y);
      if (distance >= Math.max(7, radii[i]! + 3)) continue;
      const depth = projected[i * 4 + 2]!;
      if (depth < bestDepth || (depth === bestDepth && distance < bestDistance)) {
        best = i; bestDepth = depth; bestDistance = distance;
      }
    }
    return best;
  };

  it("agrees with a brute-force scan on every probe", () => {
    const { projected, radii, index } = build(3000);
    const random = rand(99);
    for (let probe = 0; probe < 300; probe++) {
      const x = random() * 1200, y = random() * 800;
      expect(index.pick(x, y, projected, radii)).toBe(bruteForce(x, y, projected, radii));
    }
  });

  it("picks 50,000 nodes far faster than the 4 ms budget", () => {
    const { projected, radii, index } = build(50_000);
    const random = rand(1234);
    const samples: number[] = [];
    for (let probe = 0; probe < 200; probe++) {
      const start = performance.now();
      index.pick(random() * 1200, random() * 800, projected, radii);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)]!;
    expect(p95).toBeLessThan(4);
  });
});

describe("label level-of-detail selection", () => {
  const candidates = (count: number): MemoryLabelCandidate[] => {
    const random = rand(5);
    return Array.from({ length: count }, (_, i) => ({
      id: `node-${i}`,
      label: `Label ${i}`,
      type: i % 10 === 0 ? "SOURCE" as const : "MEMORY" as const,
      core: i === 3,
      x: random() * 1100,
      y: 20 + random() * 700
    }));
  };

  it("bounds measured and drawn labels whatever the graph size", () => {
    let measured = 0;
    const placements = selectMemoryLabels(candidates(5000), {
      zoom: 2,
      width: 1200,
      height: 800,
      measure: text => { measured++; return text.length * 6; }
    });
    expect(placements.length).toBeLessThanOrEqual(48);
    expect(measured).toBeLessThanOrEqual(64);
  });

  it("keeps the priority and zoom rules of the 2D renderer", () => {
    const list: MemoryLabelCandidate[] = [
      { id: "memory-a", label: "Memory A", type: "MEMORY", core: false, x: 100, y: 100 },
      { id: "source-a", label: "Source A", type: "SOURCE", core: false, x: 400, y: 100 },
      { id: "core", label: "gemini.md", type: "SOURCE", core: true, x: 700, y: 100 },
      { id: "focused", label: "Focused memory", type: "MEMORY", core: false, x: 1000, y: 100 }
    ];
    const lowZoom = selectMemoryLabels(list, {
      focusId: "focused", zoom: 1, width: 1400, height: 800, measure: text => text.length * 6
    });
    // Below zoom 1.6 only sources and the focused node are labeled.
    expect(lowZoom.map(p => p.id).sort()).toEqual(["core", "focused", "source-a"]);
    expect(lowZoom[0]!.id).toBe("focused");
    const highZoom = selectMemoryLabels(list, {
      zoom: 2, width: 1400, height: 800, measure: text => text.length * 6
    });
    expect(highZoom.map(p => p.id)).toEqual(["core", "source-a", "memory-a", "focused"]);
  });

  it("never places colliding labels", () => {
    const list = candidates(800);
    const placements = selectMemoryLabels(list, {
      zoom: 2, width: 1200, height: 800, measure: text => text.length * 6
    });
    for (let i = 0; i < placements.length; i++) {
      for (let j = i + 1; j < placements.length; j++) {
        const a = placements[i]!, b = placements[j]!;
        const collides = Math.abs(a.y - b.y) < 16 && b.x < a.x + a.width + 5 && b.x + b.width + 5 > a.x;
        expect(collides).toBe(false);
      }
    }
  });

  it("collects a bounded candidate set that selects exactly the same labels", () => {
    const { nodes, edges } = fixture(4000);
    const simulation = new MemoryLayout3DSimulation(nodes, edges);
    simulation.step(Number.POSITIVE_INFINITY);
    const projected = projectMemoryPoints(simulation.positionsArray(), DEFAULT_MEMORY_CAMERA, 2, 1200, 800);
    const nodeById = new Map(nodes.map(node => [node.id, node]));
    const aligned = simulation.nodeIds.map(id => nodeById.get(id)!);
    const options = { focusId: aligned[10]!.id, zoom: 1, width: 1200, height: 800, measure: (text: string) => text.length * 6 };
    // The naive per-frame path: one candidate object for every node.
    const naive: MemoryLabelCandidate[] = aligned.map((node, index) => ({
      id: node.id,
      label: node.label,
      type: node.type,
      core: isMemoryCoreLabel(node.label),
      x: projected[index * 4]!,
      y: projected[index * 4 + 1]!
    }));
    const collected = collectMemoryLabelCandidates(aligned, projected, options);
    expect(collected.length).toBeLessThanOrEqual(MEMORY_LABEL_CANDIDATE_CAP);
    expect(collected[0]!.id).toBe(options.focusId);
    expect(selectMemoryLabels(collected, options)).toEqual(selectMemoryLabels(naive, options));
    const highZoom = { ...options, zoom: 2.5 };
    const collectedHigh = collectMemoryLabelCandidates(aligned, projected, highZoom);
    expect(collectedHigh.length).toBe(MEMORY_LABEL_CANDIDATE_CAP);
    expect(selectMemoryLabels(collectedHigh, highZoom)).toEqual(selectMemoryLabels(naive, highZoom));
  });
});

describe("synthetic demo graph", () => {
  it("generates the requested size deterministically at roughly 3 edges per node", () => {
    const first = generateSyntheticMemoryGraph(50_000);
    const second = generateSyntheticMemoryGraph(50_000);
    expect(first.nodes).toHaveLength(50_000);
    expect(first.edges.length).toBeGreaterThan(100_000);
    expect(first.edges.length).toBeLessThan(170_000);
    expect(first).toEqual(second);
    const ids = new Set(first.nodes.map(node => node.id));
    expect(first.nodes[0]).toMatchObject({ id: "source:space.md", type: "SOURCE", label: "space.md" });
    for (const edge of first.edges) {
      expect(ids.has(edge.source)).toBe(true);
      expect(ids.has(edge.target)).toBe(true);
    }
  });

  it("handles small sizes exactly", () => {
    expect(generateSyntheticMemoryGraph(10).nodes).toHaveLength(10);
    expect(generateSyntheticMemoryGraph(1).nodes).toHaveLength(1);
  });

  it("produces nodes and edges that satisfy the contracts schemas", () => {
    const { nodes, edges } = generateSyntheticMemoryGraph(500);
    for (const node of nodes) expect(memoryGraphNodeSchema.safeParse(node).success).toBe(true);
    for (const edge of edges) expect(memoryGraphEdgeSchema.safeParse(edge).success).toBe(true);
  });
});
