import type { MemoryCamera3D } from "./memory-3d.js";
import { projectMemoryPoint } from "./memory-3d.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";

/**
 * Batch projection buffers shared by the WebGL2 renderer, the picking index and the
 * label pass. `depth` is the rotated depth used by projectMemoryPoint (smaller = nearer),
 * `perspective` is the same perspective factor the Canvas 2D renderer uses.
 */
export interface ProjectionBuffers {
  x: Float32Array;
  y: Float32Array;
  depth: Float32Array;
  perspective: Float32Array;
}

export function createProjectionBuffers(count: number): ProjectionBuffers {
  return { x: new Float32Array(count), y: new Float32Array(count), depth: new Float32Array(count), perspective: new Float32Array(count) };
}

/**
 * Projects every point with the exact formula of projectMemoryPoint, so the GPU and
 * the fallback renderer produce identical screen positions. Writing into reusable
 * typed arrays keeps a 50,000-node frame free of per-node object allocation.
 */
export function projectMemoryPoints(positions: Float32Array, count: number, camera: MemoryCamera3D, scale: number, width: number, height: number, out: ProjectionBuffers): void {
  const cosYaw = Math.cos(camera.yaw), sinYaw = Math.sin(camera.yaw);
  const cosPitch = Math.cos(camera.pitch), sinPitch = Math.sin(camera.pitch);
  for (let i = 0; i < count; i++) {
    const px = positions[i * 3]!, py = positions[i * 3 + 1]!, pz = positions[i * 3 + 2]!;
    const x = px * cosYaw + pz * sinYaw;
    const depth = -px * sinYaw + pz * cosYaw;
    const y = py * cosPitch - depth * sinPitch;
    const z = py * sinPitch + depth * cosPitch;
    const perspective = 650 / Math.max(120, 650 + z * scale);
    out.x[i] = width / 2 + x * scale * camera.zoom * perspective;
    out.y[i] = height / 2 - y * scale * camera.zoom * perspective;
    out.depth[i] = z;
    out.perspective[i] = perspective;
  }
}

/** Screen extent helper: the largest |position| the view must fit, matching the Canvas 2D renderer. */
export function projectionExtent(positions: Float32Array, count: number): number {
  let extent = 60;
  for (let i = 0; i < count; i++) {
    const radius = Math.hypot(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!);
    if (radius > extent) extent = radius;
  }
  return extent;
}

export function projectionScale(positions: Float32Array, count: number, width: number, height: number): number {
  return Math.min(width, height) * 0.4 / projectionExtent(positions, count);
}

/** #rrggbb to linear 0..1 RGB for GPU attributes; the fallback palette on parse failure is the atlas default. */
export function parseColorHex(color: string | undefined): [number, number, number] {
  const fallback: [number, number, number] = [0x73 / 255, 0x95 / 255, 0xad / 255];
  if (!color || color.charCodeAt(0) !== 35 || color.length !== 7) return fallback;
  const value = parseInt(color.slice(1), 16);
  if (!Number.isFinite(value)) return fallback;
  return [(value >> 16 & 255) / 255, (value >> 8 & 255) / 255, (value & 255) / 255];
}

/**
 * Uniform-grid spatial index over projected screen positions. Rebuilt once per rendered
 * frame in O(count) and queried per pointer move in O(cell), so hover and click never
 * scan all nodes. Replaces the old linear scan.
 */
export class ProjectedPointIndex {
  private cellSize: number;
  private cells = new Map<number, number[]>();

  constructor(cellSize = 28) { this.cellSize = cellSize; }

  private static key(cx: number, cy: number): number { return (cx + 4096) * 8192 + (cy + 4096); }

  build(xs: Float32Array, ys: Float32Array, count: number, cellSize = this.cellSize): void {
    this.cellSize = cellSize;
    this.cells.clear();
    for (let i = 0; i < count; i++) {
      const key = ProjectedPointIndex.key(Math.floor(xs[i]! / cellSize), Math.floor(ys[i]! / cellSize));
      const bucket = this.cells.get(key);
      if (bucket) bucket.push(i); else this.cells.set(key, [i]);
    }
  }

  /** Candidates in the 3x3 cells around a query point, ascending index order. */
  query(x: number, y: number): number[] {
    const cx = Math.floor(x / this.cellSize), cy = Math.floor(y / this.cellSize);
    const result: number[] = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const bucket = this.cells.get(ProjectedPointIndex.key(cx + dx, cy + dy));
      if (bucket) result.push(...bucket);
    }
    return result;
  }
}

/**
 * Nearest-first picking, the same rule the old reverse-scan used: among the projected
 * circles that contain the pointer, the nearest node (smallest depth) wins, ties break
 * by index so the result is deterministic.
 */
export function pickProjectedNode(index: ProjectedPointIndex, xs: Float32Array, ys: Float32Array, depth: Float32Array, x: number, y: number, hitRadius: (nodeIndex: number) => number): number {
  let best = -1, bestDepth = Infinity;
  for (const candidate of index.query(x, y)) {
    if (Math.hypot(xs[candidate]! - x, ys[candidate]! - y) >= hitRadius(candidate)) continue;
    if (depth[candidate]! < bestDepth || (depth[candidate]! === bestDepth && candidate < best)) { best = candidate; bestDepth = depth[candidate]!; }
  }
  return best;
}

export interface GraphLabel {
  index: number;
  x: number;
  y: number;
  w: number;
  text: string;
}

export interface LabelSelectionOptions {
  xs: Float32Array;
  ys: Float32Array;
  depth: Float32Array;
  nodes: MemoryGraphNode[];
  focusIndex: number;
  showTitles: boolean;
  zoom: number;
  width: number;
  height: number;
  measure: (text: string) => number;
  /** Level-of-detail budgets: however large the graph is, at most this many labels are measured and drawn. */
  maxCandidates?: number;
  maxDrawn?: number;
}

/**
 * Level-of-detail label selection for any graph size. The current rules stay: focus,
 * core and source labels first, then everything else nearest-first, with collision
 * avoidance, off-screen rejection and the showTitles / zoom gates. Candidates are
 * bounded, so a 50,000-node frame still measures a bounded number of labels.
 */
export function selectGraphLabels(options: LabelSelectionOptions): GraphLabel[] {
  const { xs, ys, depth, nodes, focusIndex, showTitles, zoom, width, height, measure } = options;
  const maxCandidates = options.maxCandidates ?? 240;
  const maxDrawn = options.maxDrawn ?? 110;
  if (!showTitles) return [];
  const drawn: GraphLabel[] = [];
  const boxes: Array<{ x: number; y: number; w: number }> = [];
  // The zoom gate runs before any sorting, and each candidate's priority rank is
  // computed once, so no regex runs inside the comparator and low-zoom frames never
  // order the nodes they would discard anyway.
  const order: number[] = [];
  const rank = new Map<number, number>();
  for (let i = 0; i < nodes.length; i++) {
    const source = nodes[i]!.type === "SOURCE";
    if (!source && i !== focusIndex && zoom < 1.6) continue;
    order.push(i);
    rank.set(i, (i === focusIndex ? 4 : 0) | (isMemoryCoreLabel(nodes[i]!.label) ? 2 : 0) | (source ? 1 : 0));
  }
  // Priority first (focus, then core, then source), then nearest-first by depth; index
  // ties break deterministically.
  order.sort((a, b) => rank.get(b)! - rank.get(a)! || depth[b]! - depth[a]! || a - b);
  let measured = 0;
  for (const index of order) {
    if (measured >= maxCandidates || drawn.length >= maxDrawn) break;
    measured++;
    const label = nodes[index]!.label;
    const text = label.length > 48 ? label.slice(0, 45) + "\u2026" : label;
    const x = xs[index]! + 9, y = ys[index]!;
    const w = measure(text);
    if (x + w > width || y < 14 || y > height - 5) continue;
    if (boxes.some(box => Math.abs(box.y - y) < 16 && x < box.x + box.w + 5 && x + w + 5 > box.x)) continue;
    boxes.push({ x, y, w });
    drawn.push({ index, x, y, w, text });
  }
  return drawn;
}

/**
 * Deterministic subgraph for the Canvas 2D fallback, which keeps the current 2,000-node
 * cap. Core files and sources are always kept, then topics, then memories in id order,
 * so the same archive always falls back to the same sample.
 */
export function selectFallbackSubgraph(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[], cap = 2000): { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] } {
  if (nodes.length <= cap) return { nodes, edges };
  const selected = new Map<string, MemoryGraphNode>();
  for (const priority of ["core", "SOURCE", "TOPIC", "REST"] as const) {
    for (const node of nodes) {
      if (selected.size >= cap) break;
      if (selected.has(node.id)) continue;
      const rank = isMemoryCoreLabel(node.label) && node.type === "SOURCE" ? "core" : node.type === "SOURCE" ? "SOURCE" : node.type === "TOPIC" ? "TOPIC" : "REST";
      if (rank === priority) selected.set(node.id, node);
    }
    if (selected.size >= cap) break;
  }
  const ids = new Set(selected.keys());
  return { nodes: [...selected.values()], edges: edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)) };
}

/** Reference check used by tests: the batch projection must match projectMemoryPoint (Float32 storage allows a small relative error). */
export function projectionMatchesReference(positions: Float32Array, count: number, camera: MemoryCamera3D, scale: number, width: number, height: number, out: ProjectionBuffers, tolerance = 1e-5): boolean {
  for (let i = 0; i < count; i++) {
    const reference = projectMemoryPoint({ x: positions[i * 3]!, y: positions[i * 3 + 1]!, z: positions[i * 3 + 2]! }, camera, scale, width, height);
    const near = (a: number, b: number) => Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b));
    if (!near(reference.x, out.x[i]!) || !near(reference.y, out.y[i]!) || !near(reference.z, out.depth[i]!)) return false;
  }
  return true;
}
