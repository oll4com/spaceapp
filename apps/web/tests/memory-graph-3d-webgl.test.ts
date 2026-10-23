import { describe, expect, it } from "vitest";
import {
  MAX_LABELS_3D,
  buildEdgeBuffers,
  buildNodeStyleBuffer,
  decodePickColor,
  edgeColorHex,
  encodePickColor,
  hexToRgb,
  nodeBaseSize,
  nodeVisual,
  orderLabelCandidates,
  projectToNdc,
  truncateLabel,
  type LabelCandidate
} from "../src/features/memory-workspace/memory-graph-3d-webgl.js";
import { DEFAULT_MEMORY_CAMERA, projectMemoryPoint } from "../src/features/memory-workspace/memory-3d.js";
import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";

const node = (id: string, type: MemoryGraphNode["type"] = "MEMORY", label = id): MemoryGraphNode => ({
  id, type, label, sourcePath: null, recordId: null, clusterId: null
});

describe("GPU picking codec", () => {
  it("round-trips instance indices through 24-bit RGB", () => {
    for (const index of [0, 1, 255, 256, 1000, 49999, 16777214]) {
      const [r, g, b] = encodePickColor(index);
      expect(decodePickColor(r, g, b)).toBe(index);
    }
  });
  it("decodes black as background (no hit)", () => {
    expect(decodePickColor(0, 0, 0)).toBeNull();
  });
  it("encodes index 0 as non-black", () => {
    const [r, g, b] = encodePickColor(0);
    expect(r + g + b).toBeGreaterThan(0);
  });
});

describe("shader projection mirror", () => {
  it("projectToNdc matches the Canvas projectMemoryPoint math", () => {
    const points = [
      { x: 45, y: 20, z: 60 },
      { x: -300, y: 150, z: -80 },
      { x: 0, y: 0, z: 0 }
    ];
    for (const point of points) {
      for (const camera of [DEFAULT_MEMORY_CAMERA, { yaw: 1.2, pitch: 0.4, zoom: 2.5 }]) {
        const canvas = projectMemoryPoint(point, camera, 2, 1000, 700);
        const ndc = projectToNdc(point, camera, 2, 1000, 700);
        expect(ndc.ndcX * 500).toBeCloseTo(canvas.x - 500, 6);
        // NDC y is up-positive; canvas y is down-positive.
        expect(ndc.ndcY * 350).toBeCloseTo(350 - canvas.y, 6);
        expect(ndc.perspective).toBeCloseTo(canvas.perspective, 10);
      }
    }
  });
});

describe("node visuals mirror the Canvas 2D rules", () => {
  it("sizes: core root 10, SOURCE 4.6, others 2.1, 1.5x when highlighted", () => {
    expect(nodeBaseSize(node("a", "SOURCE", "space.md"))).toBe(10);
    expect(nodeBaseSize(node("b", "SOURCE", "notes.md"))).toBe(4.6);
    expect(nodeBaseSize(node("c", "MEMORY"))).toBe(2.1);
    const v = nodeVisual(node("c"), "#7395ad", { highlighted: true, dimmed: false, isCoreRoot: false });
    expect(v.size).toBeCloseTo(2.1 * 1.5);
    expect([v.r, v.g, v.b]).toEqual([1, 1, 1]);
  });
  it("dims non-neighbors under focus and glows roots", () => {
    const dimmed = nodeVisual(node("c"), "#7395ad", { highlighted: false, dimmed: true, isCoreRoot: false });
    expect(dimmed.dimmed).toBe(true);
    expect(dimmed.glow).toBe(0);
    const root = nodeVisual(node("a", "SOURCE", "space.md"), "#8796a8", { highlighted: false, dimmed: false, isCoreRoot: true });
    expect(root.glow).toBe(1);
    const [r, g, b] = hexToRgb("#7395ad");
    expect([dimmed.r, dimmed.g, dimmed.b]).toEqual([r, g, b]);
  });
  it("edge colors match the Canvas rules", () => {
    const edge = (type: MemoryGraphEdge["type"], source: string, target: string): MemoryGraphEdge =>
      ({ id: `${source}-${target}`, type, source, target });
    expect(edgeColorHex(edge("CONTAINS", "a", "b"), "a")).toBe("#98dafa");
    expect(edgeColorHex(edge("CONTAINS", "a", "b"), "zzz")).toBe("#14202b");
    expect(edgeColorHex(edge("DERIVED_FROM", "a", "b"), null)).toBe("#385068");
    expect(edgeColorHex(edge("CONTAINS", "a", "b"), null)).toBe("#203343");
  });
});

describe("instance buffers", () => {
  it("builds style and edge buffers with matching index order", () => {
    const nodes = [node("a", "SOURCE", "space.md"), node("b"), node("c")];
    const edges: MemoryGraphEdge[] = [
      { id: "e1", type: "CONTAINS", source: "a", target: "b" },
      { id: "e2", type: "TAGGED_WITH", source: "b", target: "missing" }
    ];
    const positions = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]);
    const indexOf = new Map([["a", 0], ["b", 1], ["c", 2]]);
    const style = buildNodeStyleBuffer(nodes, () => "#7395ad", "b", new Set(["a"]));
    expect(style.length).toBe(3 * 6);
    // node "b" is highlighted: size 2.1*1.5, white, not dimmed
    expect(style[6]).toBeCloseTo(3.15);
    expect(style[8]).toBe(1); expect(style[9]).toBe(1); expect(style[10]).toBe(1);
    expect(style[11]).toBe(0);
    // node "c" is dimmed under focus "b"
    expect(style[17]).toBe(1);
    const edgeBufs = buildEdgeBuffers(edges, indexOf, positions, "b");
    expect(edgeBufs.count).toBe(1); // the edge to "missing" is skipped
    expect(edgeBufs.positions.length).toBe(2 * 3);
    expect(edgeBufs.colors.length).toBe(2 * 3);
    expect(edgeBufs.positions[0]).toBe(0);
    expect(edgeBufs.positions[3]).toBe(10);
  });
});

describe("label LOD", () => {
  const candidate = (id: string, overrides: Partial<LabelCandidate> = {}): LabelCandidate => ({
    id, label: id, type: "MEMORY", isCore: false, degree: 1, x: 10, y: 10, ...overrides
  });
  it("keeps focus, core and source labels first and bounds the count", () => {
    const candidates = Array.from({ length: MAX_LABELS_3D + 100 }, (_, i) =>
      candidate(`n${i}`, { type: "MEMORY", degree: i }));
    candidates.push(candidate("focus", { type: "MEMORY", degree: 0 }));
    candidates.push(candidate("core", { type: "SOURCE", isCore: true, degree: 0 }));
    // zoom 2 so non-source labels are eligible, like the zoomed-in view.
    const ranked = orderLabelCandidates(candidates, { showTitles: true, focusId: "focus", zoom: 2 });
    expect(ranked.length).toBe(MAX_LABELS_3D);
    expect(ranked[0]!.id).toBe("focus");
    expect(ranked[1]!.id).toBe("core");
  });
  it("hides non-source labels below 1.6x zoom unless focused", () => {
    const candidates = [candidate("m1", { type: "MEMORY" }), candidate("s1", { type: "SOURCE" })];
    const ranked = orderLabelCandidates(candidates, { showTitles: true, focusId: null, zoom: 1 });
    expect(ranked.map(c => c.id)).toEqual(["s1"]);
    const rankedZoomed = orderLabelCandidates(candidates, { showTitles: true, focusId: null, zoom: 2 });
    expect(rankedZoomed.map(c => c.id)).toContain("m1");
  });
  it("returns nothing when titles are off", () => {
    expect(orderLabelCandidates([candidate("a")], { showTitles: false, focusId: null, zoom: 2 })).toEqual([]);
  });
  it("truncates long labels like the Canvas renderer", () => {
    expect(truncateLabel("x".repeat(60))).toBe(`${"x".repeat(45)}…`);
    expect(truncateLabel("short")).toBe("short");
  });
});
