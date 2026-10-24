import { describe, expect, it } from "vitest";
import { createLayoutState, layoutMemoryNetwork3D, memory3DVolumeRatio, projectMemoryPoint, stepLayout, DEFAULT_MEMORY_CAMERA, type MemoryPoint3D } from "../src/features/memory-workspace/memory-3d.js";
import { isMemoryCoreLabel } from "../src/features/memory-workspace/memory-graph-visuals.js";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";

// Avalanche each seed so the three axes are independent even for similar file IDs.
const originalUnit = (seed: string) => {
  let hash = 2166136261;
  for (const character of seed) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d);
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967295;
};

/** Verbatim copy of the pre-grid implementation, kept to prove the typed-array layout is bit-identical. */
function originalLayoutMemoryNetwork3D(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[]): Map<string, MemoryPoint3D> {
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const index = new Map(ordered.map((node, i) => [node.id, i]));
  const root = ordered.findIndex(node => node.type === "SOURCE" && isMemoryCoreLabel(node.label));
  const count = ordered.length;
  const points = ordered.map(node => ({
    x: (originalUnit(`${node.id}:x`) - 0.5) * 260,
    y: (originalUnit(`${node.id}:y`) - 0.5) * 260,
    z: (originalUnit(`${node.id}:z`) - 0.5) * 260
  }));
  if (root >= 0) points[root] = { x: 0, y: 0, z: 0 };
  const links = [...edges].sort((a, b) => a.id.localeCompare(b.id)).flatMap(edge => {
    const a = index.get(edge.source), b = index.get(edge.target);
    if (a === undefined || b === undefined || a === b) return [];
    const fileLink = ordered[a]!.type === "SOURCE" && ordered[b]!.type === "SOURCE";
    return [{ a, b, length: fileLink ? 110 : edge.type === "CONTAINS" ? 34 : 55,
      strength: fileLink ? 0.035 : edge.type === "CONTAINS" ? 0.028 : 0.004 }];
  });
  // Initialize records around their actual file, in a volume rather than a plane.
  for (const edge of edges) {
    const a = index.get(edge.source), b = index.get(edge.target);
    if (edge.type !== "CONTAINS" || a === undefined || b === undefined || ordered[a]!.type !== "SOURCE" || ordered[b]!.type !== "MEMORY") continue;
    const parent = points[a]!, id = ordered[b]!.id;
    points[b] = { x: parent.x + (originalUnit(`${id}:dx`) - 0.5) * 70,
      y: parent.y + (originalUnit(`${id}:dy`) - 0.5) * 70, z: parent.z + (originalUnit(`${id}:dz`) - 0.5) * 70 };
  }
  const fx = new Float64Array(count), fy = new Float64Array(count), fz = new Float64Array(count);
  // Bounded spatial-grid repulsion and link springs act equally on all three axes.
  for (let step = 0; step < 180; step++) {
    fx.fill(0); fy.fill(0); fz.fill(0);
    const grid = new Map<string, number[]>();
    for (let i = 0; i < count; i++) {
      const p = points[i]!, key = `${Math.floor(p.x / 32)},${Math.floor(p.y / 32)},${Math.floor(p.z / 32)}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key)!.push(i);
    }
    for (let i = 0; i < count; i++) {
      const p = points[i]!, gx = Math.floor(p.x / 32), gy = Math.floor(p.y / 32), gz = Math.floor(p.z / 32);
      for (let x = gx - 1; x <= gx + 1; x++) for (let y = gy - 1; y <= gy + 1; y++) for (let z = gz - 1; z <= gz + 1; z++) {
        for (const j of grid.get(`${x},${y},${z}`) ?? []) {
          if (j <= i) continue;
          const q = points[j]!, dx = p.x - q.x, dy = p.y - q.y, dz = p.z - q.z;
          const distanceSquared = Math.max(1, dx * dx + dy * dy + dz * dz);
          const strength = (ordered[i]!.type === "SOURCE" || ordered[j]!.type === "SOURCE" ? 28 : 12) / distanceSquared;
          fx[i]! += dx * strength; fy[i]! += dy * strength; fz[i]! += dz * strength;
          fx[j]! -= dx * strength; fy[j]! -= dy * strength; fz[j]! -= dz * strength;
        }
      }
    }
    for (const link of links) {
      const a = points[link.a]!, b = points[link.b]!;
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, distance = Math.max(0.01, Math.hypot(dx, dy, dz));
      const spring = (distance - link.length) * link.strength / distance;
      fx[link.a]! += dx * spring; fy[link.a]! += dy * spring; fz[link.a]! += dz * spring;
      fx[link.b]! -= dx * spring; fy[link.b]! -= dy * spring; fz[link.b]! -= dz * spring;
    }
    const cooling = 1 - step / 230;
    for (let i = 0; i < count; i++) {
      if (i === root) continue;
      const p = points[i]!;
      const dx = fx[i]! - p.x * 0.0005, dy = fy[i]! - p.y * 0.0005, dz = fz[i]! - p.z * 0.0005;
      const stepScale = Math.min(1, 4 / Math.max(0.01, Math.hypot(dx, dy, dz))) * cooling;
      p.x += dx * stepScale; p.y += dy * stepScale; p.z += dz * stepScale;
    }
  }
  return new Map(ordered.map((node, i) => [node.id, points[i]!]));
}


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

const generatedGraph = (files: number, perFile: number) => {
  const nodes: MemoryGraphNode[] = [{ id: "root", label: "space.md", type: "SOURCE", sourcePath: "/docs/space.md", recordId: null }];
  const edges: MemoryGraphEdge[] = [];
  let seed = 12345;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let file = 0; file < files; file++) {
    const id = `src-${file}`;
    nodes.push({ id, label: `${id}.md`, type: "SOURCE", sourcePath: `/docs/${id}.md`, recordId: null });
    edges.push({ id: `df-${file}`, type: "DERIVED_FROM", source: "root", target: id });
    for (let item = 0; item < perFile; item++) {
      const memory = `${id}-m-${item}`;
      nodes.push({ id: memory, label: memory, type: "MEMORY", sourcePath: `/docs/${id}.md`, recordId: memory });
      edges.push({ id: `c-${memory}`, type: "CONTAINS", source: id, target: memory });
      if (item > 0 && random() < 0.5) edges.push({ id: `r-${memory}`, type: "SEMANTICALLY_RELATED", source: memory, target: `${id}-m-${Math.floor(random() * item)}` });
    }
  }
  return { nodes, edges };
};

describe("typed-array 3D layout", () => {
  it("is bit-identical to the original implementation on the fixture and a generated graph", () => {
    const small = fixture();
    expect(layoutMemoryNetwork3D(small.nodes, small.edges)).toEqual(originalLayoutMemoryNetwork3D(small.nodes, small.edges));
    const large = generatedGraph(40, 60);
    expect(large.nodes.length).toBeGreaterThan(2000);
    const expected = originalLayoutMemoryNetwork3D(large.nodes, large.edges);
    expect(layoutMemoryNetwork3D(large.nodes, large.edges)).toEqual(expected);
    expect(layoutMemoryNetwork3D([...large.nodes].reverse(), [...large.edges].reverse())).toEqual(expected);
    expect([...layoutMemoryNetwork3D([...large.nodes].reverse(), [...large.edges].reverse())]).toEqual([...expected]);
  }, 60_000);
  it("stepping in slices equals running all steps at once", () => {
    const { nodes, edges } = generatedGraph(10, 40);
    const state = createLayoutState(nodes, edges);
    let done = false, slices = 0;
    while (!done) { done = stepLayout(state, 7); slices++; }
    expect(slices).toBe(Math.ceil(180 / 7));
    expect(state.step).toBe(180);
    expect(stepLayout(state, 5)).toBe(true);
    const whole = layoutMemoryNetwork3D(nodes, edges);
    const sliced = new Map<string, MemoryPoint3D>(state.ids.map((id, i) => [id, { x: state.x[i]!, y: state.y[i]!, z: state.z[i]! }]));
    expect(sliced).toEqual(whole);
    expect(isMemoryCoreLabel("space.md")).toBe(true);
  });
  it("handles empty and single-node graphs", () => {
    expect(layoutMemoryNetwork3D([], []).size).toBe(0);
    const one = layoutMemoryNetwork3D([{ id: "a", label: "a", type: "MEMORY", sourcePath: null, recordId: "a" }], []);
    expect(one.size).toBe(1);
  });
  it("is independent of edge order for a record with two source parents, which the original was not", () => {
    // `shared` is CONTAINed by two sources. The original placed a record around the parent of the LAST CONTAINS edge
    // in input order; the new layout walks edges sorted by id, so the winner no longer depends on input order.
    const source = (id: string): MemoryGraphNode => ({ id, label: `${id}.md`, type: "SOURCE", sourcePath: `/docs/${id}.md`, recordId: null });
    const memory = (id: string): MemoryGraphNode => ({ id, label: id, type: "MEMORY", sourcePath: "/docs/source-a.md", recordId: id });
    const nodes = [{ ...source("root"), label: "space.md" }, source("source-a"), source("source-b"), memory("shared"), memory("only-a"), memory("only-b")];
    const edges: MemoryGraphEdge[] = [
      { id: "edge-1", type: "DERIVED_FROM", source: "root", target: "source-a" },
      { id: "edge-2", type: "DERIVED_FROM", source: "root", target: "source-b" },
      { id: "edge-3", type: "CONTAINS", source: "source-a", target: "shared" },
      { id: "edge-4", type: "CONTAINS", source: "source-b", target: "shared" },
      { id: "edge-5", type: "CONTAINS", source: "source-a", target: "only-a" },
      { id: "edge-6", type: "CONTAINS", source: "source-b", target: "only-b" }
    ];
    const reversed = [...edges].reverse();
    expect(layoutMemoryNetwork3D(nodes, reversed)).toEqual(layoutMemoryNetwork3D(nodes, edges));
    expect(originalLayoutMemoryNetwork3D(nodes, reversed)).not.toEqual(originalLayoutMemoryNetwork3D(nodes, edges));
  });
});
