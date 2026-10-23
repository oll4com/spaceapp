import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
export type MemoryPoint3D = { x: number; y: number; z: number };
export type MemoryCamera3D = { yaw: number; pitch: number; zoom: number };
export const DEFAULT_MEMORY_CAMERA: MemoryCamera3D = { yaw: 0.3, pitch: -0.15, zoom: 1 };

// Avalanche each seed so the three axes are independent even for similar file IDs.
const unit = (seed: string) => {
  let hash = 2166136261;
  for (const character of seed) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d);
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967295;
};

export const MEMORY_LAYOUT_3D_STEPS = 180;

/**
 * The 3D force layout as a steppable simulation. The worker advances it in
 * slices and streams snapshots to the main thread, so the view stays usable
 * while a large graph converges. Running it to completion produces exactly
 * the same positions as the original one-shot layout: the per-step math is
 * unchanged and the output stays deterministic for the same input.
 */
export class MemoryLayout3DSimulation {
  readonly totalSteps = MEMORY_LAYOUT_3D_STEPS;
  stepCount = 0;
  private readonly ordered: MemoryGraphNode[];
  private readonly points: MemoryPoint3D[];
  private readonly links: Array<{ a: number; b: number; length: number; strength: number }>;
  private readonly root: number;
  private readonly fx: Float64Array;
  private readonly fy: Float64Array;
  private readonly fz: Float64Array;

  /** Seed the simulation from deterministic per-node offsets so the same input always converges to the same layout. */
  constructor(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[]) {
    const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
    const index = new Map(ordered.map((node, i) => [node.id, i]));
    const root = ordered.findIndex(node => node.type === "SOURCE" && isMemoryCoreLabel(node.label));
    const count = ordered.length;
    const points = ordered.map(node => ({
      x: (unit(`${node.id}:x`) - 0.5) * 260,
      y: (unit(`${node.id}:y`) - 0.5) * 260,
      z: (unit(`${node.id}:z`) - 0.5) * 260
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
      points[b] = { x: parent.x + (unit(`${id}:dx`) - 0.5) * 70,
        y: parent.y + (unit(`${id}:dy`) - 0.5) * 70, z: parent.z + (unit(`${id}:dz`) - 0.5) * 70 };
    }
    this.ordered = ordered;
    this.points = points;
    this.links = links;
    this.root = root;
    this.fx = new Float64Array(count);
    this.fy = new Float64Array(count);
    this.fz = new Float64Array(count);
  }

  get done(): boolean {
    return this.stepCount >= this.totalSteps;
  }

  /** Node IDs in simulation order; snapshots and position arrays follow it. */
  get nodeIds(): string[] {
    return this.ordered.map(node => node.id);
  }

  /** Advance up to `steps` simulation steps. Returns true when converged. */
  step(steps = 1): boolean {
    for (let count = 0; count < steps && !this.done; count++) this.stepOnce();
    return this.done;
  }

  private stepOnce(): void {
    const { points, links, ordered, root, fx, fy, fz } = this;
    const count = points.length;
    const step = this.stepCount;
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
    this.stepCount++;
  }

  /** Positions as a flat XYZ array in `nodeIds` order, for transfer to the main thread. */
  positionsArray(): Float32Array {
    const out = new Float32Array(this.points.length * 3);
    this.points.forEach((point, i) => {
      out[i * 3] = point.x;
      out[i * 3 + 1] = point.y;
      out[i * 3 + 2] = point.z;
    });
    return out;
  }

  /** A defensive copy of the current simulation positions, keyed by node id. */
  snapshot(): Map<string, MemoryPoint3D> {
    return new Map(this.ordered.map((node, i) => [node.id, { ...this.points[i]! }]));
  }
}

/** Independent XYZ force layout. No coordinates are inherited from the 2D map. */
export function layoutMemoryNetwork3D(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[]): Map<string, MemoryPoint3D> {
  const simulation = new MemoryLayout3DSimulation(nodes, edges);
  simulation.step(Number.POSITIVE_INFINITY);
  return simulation.snapshot();
}

/**
 * Project one world point to screen space with the shared yaw/pitch camera.
 * Same math as the batch and WebGL paths, so all three renderers agree.
 * @param point World-space point to project.
 * @param camera Camera orientation (yaw/pitch) and zoom.
 * @param scale World-units to CSS pixels at zoom 1.
 * @param width Viewport width in CSS pixels.
 * @param height Viewport height in CSS pixels.
 * @returns Screen x/y, depth z, and the perspective divisor.
 */
export function projectMemoryPoint(point: MemoryPoint3D, camera: MemoryCamera3D, scale: number, width: number, height: number) {
  const x = point.x * Math.cos(camera.yaw) + point.z * Math.sin(camera.yaw);
  const depth = -point.x * Math.sin(camera.yaw) + point.z * Math.cos(camera.yaw);
  const y = point.y * Math.cos(camera.pitch) - depth * Math.sin(camera.pitch);
  const z = point.y * Math.sin(camera.pitch) + depth * Math.cos(camera.pitch);
  const perspective = 650 / Math.max(120, 650 + z * scale);
  return { x: width / 2 + x * scale * camera.zoom * perspective, y: height / 2 - y * scale * camera.zoom * perspective, z, perspective };
}

/**
 * Batch version of projectMemoryPoint: flat XYZ positions in, flat
 * [screenX, screenY, depth, perspective] quads out. Same math, no per-point
 * allocation, so a 50,000-node frame costs one pass over typed arrays.
 */
export function projectMemoryPoints(positions: Float32Array, camera: MemoryCamera3D, scale: number, width: number, height: number): Float32Array {
  const count = Math.floor(positions.length / 3);
  const out = new Float32Array(count * 4);
  const cosYaw = Math.cos(camera.yaw), sinYaw = Math.sin(camera.yaw);
  const cosPitch = Math.cos(camera.pitch), sinPitch = Math.sin(camera.pitch);
  for (let i = 0; i < count; i++) {
    const px = positions[i * 3]!, py = positions[i * 3 + 1]!, pz = positions[i * 3 + 2]!;
    const x = px * cosYaw + pz * sinYaw;
    const depth = -px * sinYaw + pz * cosYaw;
    const y = py * cosPitch - depth * sinPitch;
    const z = py * sinPitch + depth * cosPitch;
    const perspective = 650 / Math.max(120, 650 + z * scale);
    out[i * 4] = width / 2 + x * scale * camera.zoom * perspective;
    out[i * 4 + 1] = height / 2 - y * scale * camera.zoom * perspective;
    out[i * 4 + 2] = z;
    out[i * 4 + 3] = perspective;
  }
  return out;
}

/** On-screen node radius in CSS pixels, matching the Canvas 2D renderer's sizing. */
export function memoryNodeRadius(baseSize: number, perspective: number, zoom: number, highlighted: boolean): number {
  return Math.max(1, baseSize * perspective * Math.sqrt(zoom)) * (highlighted ? 1.5 : 1);
}

/**
 * Screen-space picking over the last projected frame. A uniform grid keeps
 * hover/click lookups at O(1)-ish instead of a linear scan over every node,
 * and the winner matches the Canvas 2D behavior: among the points whose hit
 * radius covers the pointer, the nearest one (smallest depth) wins.
 */
export class MemoryPickIndex {
  private cells = new Map<string, number[]>();
  private maxRadius = 0;
  constructor(private readonly cellSize = 64) {}

  /**
   * Fill the grid cells from one rendered frame.
   * @param projected [x, y, depth, perspective] quads from the last render.
   * @param radii On-screen node radii in CSS pixels.
   */
  rebuild(projected: Float32Array, radii: Float32Array): void {
    this.cells.clear();
    this.maxRadius = 0;
    const count = Math.floor(projected.length / 4);
    for (let i = 0; i < count; i++) {
      const x = projected[i * 4]!, y = projected[i * 4 + 1]!;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (radii[i]! > this.maxRadius) this.maxRadius = radii[i]!;
      const key = `${Math.floor(x / this.cellSize)},${Math.floor(y / this.cellSize)}`;
      const cell = this.cells.get(key);
      if (cell) cell.push(i);
      else this.cells.set(key, [i]);
    }
  }

  /** Index of the picked point, or -1. Depth ties break toward the closest center. */
  pick(x: number, y: number, projected: Float32Array, radii: Float32Array): number {
    const reach = Math.max(7, this.maxRadius + 3);
    const ring = Math.min(6, Math.ceil(reach / this.cellSize));
    const cx = Math.floor(x / this.cellSize), cy = Math.floor(y / this.cellSize);
    let best = -1, bestDepth = Number.POSITIVE_INFINITY, bestDistance = Number.POSITIVE_INFINITY;
    for (let gx = cx - ring; gx <= cx + ring; gx++) for (let gy = cy - ring; gy <= cy + ring; gy++) {
      for (const i of this.cells.get(`${gx},${gy}`) ?? []) {
        const px = projected[i * 4]!, py = projected[i * 4 + 1]!, depth = projected[i * 4 + 2]!;
        const distance = Math.hypot(px - x, py - y);
        if (distance >= Math.max(7, radii[i]! + 3)) continue;
        if (depth < bestDepth || (depth === bestDepth && distance < bestDistance)) {
          best = i; bestDepth = depth; bestDistance = distance;
        }
      }
    }
    return best;
  }
}

export interface MemoryLabelCandidate {
  id: string;
  label: string;
  type: MemoryGraphNode["type"];
  core: boolean;
  x: number;
  y: number;
}

export interface MemoryLabelPlacement {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  core: boolean;
}

export const MEMORY_LABEL_MAX_PER_FRAME = 48;
export const MEMORY_LABEL_MAX_MEASURED_PER_FRAME = 64;

/**
 * Level-of-detail label selection with the Canvas 2D rules preserved: focus
 * first, then core files, then sources; non-sources stay hidden below zoom
 * 1.6; collisions are avoided against already-placed boxes. Whatever the
 * graph size, at most maxMeasured labels are measured and maxLabels drawn
 * per frame, so label work is bounded.
 */
export function selectMemoryLabels(
  candidates: MemoryLabelCandidate[],
  options: {
    focusId?: string | null;
    zoom: number;
    width: number;
    height: number;
    maxLabels?: number;
    maxMeasured?: number;
    measure: (text: string) => number;
  }
): MemoryLabelPlacement[] {
  const maxLabels = options.maxLabels ?? MEMORY_LABEL_MAX_PER_FRAME;
  const maxMeasured = options.maxMeasured ?? MEMORY_LABEL_MAX_MEASURED_PER_FRAME;
  const focusId = options.focusId ?? null;
  const ordered = [...candidates].sort((a, b) =>
    Number(b.id === focusId) - Number(a.id === focusId) ||
    Number(b.core) - Number(a.core) ||
    Number(b.type === "SOURCE") - Number(a.type === "SOURCE"));
  const placements: MemoryLabelPlacement[] = [];
  const boxes: Array<{ x: number; y: number; w: number }> = [];
  let measured = 0;
  for (const candidate of ordered) {
    if (placements.length >= maxLabels || measured >= maxMeasured) break;
    if (candidate.type !== "SOURCE" && candidate.id !== focusId && options.zoom < 1.6) continue;
    const text = candidate.label.length > 48 ? `${candidate.label.slice(0, 45)}…` : candidate.label;
    const width = options.measure(text);
    measured++;
    const x = candidate.x + 9, y = candidate.y;
    if (x + width > options.width || y < 14 || y > options.height - 5) continue;
    if (boxes.some(box => Math.abs(box.y - y) < 16 && x < box.x + box.w + 5 && x + width + 5 > box.x)) continue;
    boxes.push({ x, y, w: width });
    placements.push({ id: candidate.id, text, x, y, width, core: candidate.core });
  }
  return placements;
}

export const MEMORY_LABEL_CANDIDATE_CAP = 512;

/**
 * Collect one frame's label candidates from the scene's nodes in projected
 * order, without allocating for nodes that cannot be labeled. The zoom gate
 * from selectMemoryLabels is applied before a candidate object exists, and
 * the survivors are grouped in selection priority (focus, core, sources,
 * rest) and capped. selectMemoryLabels measures at most
 * MEMORY_LABEL_MAX_MEASURED_PER_FRAME candidates before it stops, so a
 * working set of 512 in priority order cannot change which labels are
 * placed — but the per-frame cost stays bounded at any graph size instead
 * of an allocation and a sort over every node.
 */
export function collectMemoryLabelCandidates(
  nodes: MemoryGraphNode[],
  projected: Float32Array,
  options: { focusId?: string | null; zoom: number }
): MemoryLabelCandidate[] {
  const focusId = options.focusId ?? null;
  const focus: MemoryLabelCandidate[] = [];
  const core: MemoryLabelCandidate[] = [];
  const sources: MemoryLabelCandidate[] = [];
  const rest: MemoryLabelCandidate[] = [];
  const count = Math.min(nodes.length, Math.floor(projected.length / 4));
  for (let index = 0; index < count; index++) {
    const node = nodes[index]!;
    const isFocus = node.id === focusId;
    if (!isFocus && node.type !== "SOURCE" && options.zoom < 1.6) continue;
    const isCore = isMemoryCoreLabel(node.label);
    // Choose the priority group before allocating: the returned list keeps
    // the first MEMORY_LABEL_CANDIDATE_CAP candidates in group order, and a
    // node sits behind its own group plus every higher-priority group, so
    // once that lower bound reaches the cap the candidate would only be
    // sliced away below — don't allocate an object for it.
    let bucket: MemoryLabelCandidate[];
    let ahead: number;
    if (isFocus) { bucket = focus; ahead = 0; }
    else if (isCore) { bucket = core; ahead = focus.length; }
    else if (node.type === "SOURCE") { bucket = sources; ahead = focus.length + core.length; }
    else { bucket = rest; ahead = focus.length + core.length + sources.length; }
    if (ahead + bucket.length >= MEMORY_LABEL_CANDIDATE_CAP) continue;
    bucket.push({
      id: node.id,
      label: node.label,
      type: node.type,
      core: isCore,
      x: projected[index * 4]!,
      y: projected[index * 4 + 1]!
    });
  }
  return [...focus, ...core, ...sources, ...rest].slice(0, MEMORY_LABEL_CANDIDATE_CAP);
}

/**
 * Streaming fast path for scene sync: when only the layout coordinates
 * changed, rebuild just the flat position arrays from the previous scene's
 * node order and edge index table instead of repacking the whole scene
 * (colors, sizes, neighbor sets) on every snapshot. The derived edge
 * positions and the world extent are rebuilt alongside the node positions,
 * so nothing rendered from the old snapshot survives. Returns null when a
 * scene node has no coordinate yet — the caller then does a full rebuild,
 * which handles partial coordinates.
 * @param ids Node ids in scene order.
 * @param edgeNodeIndices Node index per edge vertex, two per edge.
 * @param coordinates The new layout coordinates keyed by node id.
 * @returns New position/edge-position arrays and the new extent, or null.
 */
export function buildStreamedMemoryPositions(
  ids: string[],
  edgeNodeIndices: Float32Array,
  coordinates: Map<string, MemoryPoint3D>
): { positions: Float32Array; edgePositions: Float32Array; extent: number } | null {
  const positions = new Float32Array(ids.length * 3);
  let extent = 60;
  for (let index = 0; index < ids.length; index++) {
    const point = coordinates.get(ids[index]!);
    if (!point) return null;
    positions[index * 3] = point.x;
    positions[index * 3 + 1] = point.y;
    positions[index * 3 + 2] = point.z;
    extent = Math.max(extent, Math.hypot(point.x, point.y, point.z));
  }
  const edgePositions = new Float32Array(edgeNodeIndices.length * 3);
  for (let vertex = 0; vertex < edgeNodeIndices.length; vertex++) {
    const nodeIndex = edgeNodeIndices[vertex]!;
    edgePositions[vertex * 3] = positions[nodeIndex * 3]!;
    edgePositions[vertex * 3 + 1] = positions[nodeIndex * 3 + 1]!;
    edgePositions[vertex * 3 + 2] = positions[nodeIndex * 3 + 2]!;
  }
  return { positions, edgePositions, extent };
}

/** Normalized covariance determinant: 0 for a plane, 1 for equal spread in XYZ. */
export function memory3DVolumeRatio(points: MemoryPoint3D[]): number {
  if (points.length < 4) return 0;
  // Scalar accumulation: a per-point object-building reduce allocates one
  // object per node on every call, and this runs per streamed snapshot.
  let sumX = 0, sumY = 0, sumZ = 0;
  for (const p of points) { sumX += p.x; sumY += p.y; sumZ += p.z; }
  const center = { x: sumX / points.length, y: sumY / points.length, z: sumZ / points.length };
  let xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
  for (const p of points) {
    const x = p.x - center.x, y = p.y - center.y, z = p.z - center.z;
    xx += x * x; yy += y * y; zz += z * z; xy += x * y; xz += x * z; yz += y * z;
  }
  const determinant = xx * yy * zz + 2 * xy * xz * yz - xx * yz * yz - yy * xz * xz - zz * xy * xy;
  return Math.max(0, determinant / Math.max(1e-12, ((xx + yy + zz) / 3) ** 3));
}
