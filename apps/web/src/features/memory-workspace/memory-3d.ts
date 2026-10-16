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

/** Total force-simulation steps, as the fixed layout has always run. */
export const MEMORY_3D_LAYOUT_STEPS = 180;

/**
 * Above this many nodes the initial spread (and the per-step travel budget)
 * grows with the cube root of the count so the spatial grid keeps a bounded
 * occupancy — the same density the fixed layout has at 2,000 nodes. At or
 * below the threshold the factor is exactly 1 and the simulation is the
 * historical one, bit for bit. The physics (link lengths, strengths, cooling)
 * never changes, and every seed still comes from the node id, so the output
 * stays deterministic and independent of input ordering at any size.
 */
export function memory3DLayoutDensityScale(count: number): number {
  return Math.max(1, Math.cbrt(count / 2000));
}

export interface Memory3DLayoutStepper {
  readonly stepsCompleted: number;
  readonly totalSteps: number;
  readonly done: boolean;
  /** Advance the simulation by up to `steps` iterations (default 1). */
  step(steps?: number): void;
  /** Current positions as a fresh map; safe to hand to another thread/state. */
  positions(): Map<string, MemoryPoint3D>;
}

/** Incremental form of the 3D force layout: same math, resumable state. */
export function createMemory3DLayoutStepper(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[], totalSteps: number = MEMORY_3D_LAYOUT_STEPS): Memory3DLayoutStepper {
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const index = new Map(ordered.map((node, i) => [node.id, i]));
  const root = ordered.findIndex(node => node.type === "SOURCE" && isMemoryCoreLabel(node.label));
  const count = ordered.length;
  const densityScale = memory3DLayoutDensityScale(count);
  const spread = 260 * densityScale;
  const points = ordered.map(node => ({
    x: (unit(`${node.id}:x`) - 0.5) * spread,
    y: (unit(`${node.id}:y`) - 0.5) * spread,
    z: (unit(`${node.id}:z`) - 0.5) * spread
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
  const fx = new Float64Array(count), fy = new Float64Array(count), fz = new Float64Array(count);
  let stepIndex = 0;
  // The spatial grid is rebuilt every step. Cells are visited in the same
  // x/y/z order and members in ascending node order as the original
  // string-keyed grid, so force accumulation order — and therefore the
  // layout — is bit-for-bit identical; only the key encoding changed
  // (packed integers + flat typed arrays instead of string keys + array
  // churn, which is several times faster at 50,000 nodes). A step whose
  // cells ever leave the packable range falls back to the string grid.
  const CELL_OFFSET = 2048, CELL_SPAN = 4097;
  const cellX = new Int32Array(count), cellY = new Int32Array(count), cellZ = new Int32Array(count);
  const cellDense = new Int32Array(count);
  // Grid scratch buffers are allocated once and reused every step: at
  // 50,000 nodes a fresh Map + arrays per step is mostly garbage collection.
  const dense = new Map<number, number>();
  const cellCounts = new Int32Array(count);
  const cellStarts = new Int32Array(count + 1);
  const cellMembers = new Int32Array(count);
  const cellCursor = new Int32Array(count);
  const repulse = (i: number, j: number) => {
    const p = points[i]!, q = points[j]!;
    const dx = p.x - q.x, dy = p.y - q.y, dz = p.z - q.z;
    const distanceSquared = Math.max(1, dx * dx + dy * dy + dz * dz);
    const strength = (ordered[i]!.type === "SOURCE" || ordered[j]!.type === "SOURCE" ? 28 : 12) / distanceSquared;
    fx[i]! += dx * strength; fy[i]! += dy * strength; fz[i]! += dz * strength;
    fx[j]! -= dx * strength; fy[j]! -= dy * strength; fz[j]! -= dz * strength;
  };
  const runStep = () => {
    fx.fill(0); fy.fill(0); fz.fill(0);
    let packable = count > 0;
    for (let i = 0; i < count; i++) {
      const p = points[i]!;
      cellX[i] = Math.floor(p.x / 32); cellY[i] = Math.floor(p.y / 32); cellZ[i] = Math.floor(p.z / 32);
      if (Math.abs(cellX[i]!) > CELL_OFFSET - 1 || Math.abs(cellY[i]!) > CELL_OFFSET - 1 || Math.abs(cellZ[i]!) > CELL_OFFSET - 1) packable = false;
    }
    if (packable) {
      const pack = (x: number, y: number, z: number) => ((x + CELL_OFFSET) * CELL_SPAN + (y + CELL_OFFSET)) * CELL_SPAN + (z + CELL_OFFSET);
      dense.clear();
      let cellTotal = 0;
      for (let i = 0; i < count; i++) {
        const key = pack(cellX[i]!, cellY[i]!, cellZ[i]!);
        let cell = dense.get(key);
        if (cell === undefined) { cell = cellTotal++; dense.set(key, cell); cellCounts[cell] = 0; }
        cellDense[i] = cell;
        cellCounts[cell]!++;
      }
      cellStarts[0] = 0;
      for (let cell = 0; cell < cellTotal; cell++) cellStarts[cell + 1] = cellStarts[cell]! + cellCounts[cell]!;
      for (let cell = 0; cell < cellTotal; cell++) cellCursor[cell] = cellStarts[cell]!;
      for (let i = 0; i < count; i++) cellMembers[cellCursor[cellDense[i]!]!++] = i;
      for (let i = 0; i < count; i++) {
        const gx = cellX[i]!, gy = cellY[i]!, gz = cellZ[i]!;
        for (let x = gx - 1; x <= gx + 1; x++) for (let y = gy - 1; y <= gy + 1; y++) for (let z = gz - 1; z <= gz + 1; z++) {
          const cell = dense.get(pack(x, y, z));
          if (cell === undefined) continue;
          for (let k = cellStarts[cell]!; k < cellStarts[cell + 1]!; k++) {
            const j = cellMembers[k]!;
            if (j > i) repulse(i, j);
          }
        }
      }
    } else {
      const grid = new Map<string, number[]>();
      for (let i = 0; i < count; i++) {
        const key = `${cellX[i]},${cellY[i]},${cellZ[i]}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key)!.push(i);
      }
      for (let i = 0; i < count; i++) {
        const gx = cellX[i]!, gy = cellY[i]!, gz = cellZ[i]!;
        for (let x = gx - 1; x <= gx + 1; x++) for (let y = gy - 1; y <= gy + 1; y++) for (let z = gz - 1; z <= gz + 1; z++) {
          for (const j of grid.get(`${x},${y},${z}`) ?? []) if (j > i) repulse(i, j);
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
    const cooling = 1 - stepIndex / 230;
    for (let i = 0; i < count; i++) {
      if (i === root) continue;
      const p = points[i]!;
      const dx = fx[i]! - p.x * 0.0005, dy = fy[i]! - p.y * 0.0005, dz = fz[i]! - p.z * 0.0005;
      const stepScale = Math.min(1, (4 * densityScale) / Math.max(0.01, Math.hypot(dx, dy, dz))) * cooling;
      p.x += dx * stepScale; p.y += dy * stepScale; p.z += dz * stepScale;
    }
    stepIndex++;
  };
  return {
    get stepsCompleted() { return stepIndex; },
    get totalSteps() { return totalSteps; },
    get done() { return stepIndex >= totalSteps; },
    step(steps = 1) {
      const target = Math.min(totalSteps, stepIndex + Math.max(0, Math.floor(steps)));
      while (stepIndex < target) runStep();
    },
    positions() {
      return new Map(ordered.map((node, i) => [node.id, { ...points[i]! }]));
    }
  };
}

/** Independent XYZ force layout. No coordinates are inherited from the 2D map. */
export function layoutMemoryNetwork3D(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[]): Map<string, MemoryPoint3D> {
  const stepper = createMemory3DLayoutStepper(nodes, edges);
  while (!stepper.done) stepper.step();
  return stepper.positions();
}

export function projectMemoryPoint(point: MemoryPoint3D, camera: MemoryCamera3D, scale: number, width: number, height: number) {
  const x = point.x * Math.cos(camera.yaw) + point.z * Math.sin(camera.yaw);
  const depth = -point.x * Math.sin(camera.yaw) + point.z * Math.cos(camera.yaw);
  const y = point.y * Math.cos(camera.pitch) - depth * Math.sin(camera.pitch);
  const z = point.y * Math.sin(camera.pitch) + depth * Math.cos(camera.pitch);
  const perspective = 650 / Math.max(120, 650 + z * scale);
  return { x: width / 2 + x * scale * camera.zoom * perspective, y: height / 2 - y * scale * camera.zoom * perspective, z, perspective };
}

/**
 * Bulk form of projectMemoryPoint: identical math, but results land in
 * typed arrays instead of one object per point, so a 50,000-node frame
 * allocates nothing per node.
 */
export function projectMemoryPointsBulk(
  points: readonly MemoryPoint3D[],
  camera: MemoryCamera3D,
  scale: number,
  width: number,
  height: number
): { xs: Float64Array; ys: Float64Array; zs: Float64Array; perspectives: Float64Array } {
  const xs = new Float64Array(points.length);
  const ys = new Float64Array(points.length);
  const zs = new Float64Array(points.length);
  const perspectives = new Float64Array(points.length);
  const cosYaw = Math.cos(camera.yaw), sinYaw = Math.sin(camera.yaw);
  const cosPitch = Math.cos(camera.pitch), sinPitch = Math.sin(camera.pitch);
  for (let i = 0; i < points.length; i++) {
    const point = points[i]!;
    const x = point.x * cosYaw + point.z * sinYaw;
    const depth = -point.x * sinYaw + point.z * cosYaw;
    const y = point.y * cosPitch - depth * sinPitch;
    const z = point.y * sinPitch + depth * cosPitch;
    const perspective = 650 / Math.max(120, 650 + z * scale);
    xs[i] = width / 2 + x * scale * camera.zoom * perspective;
    ys[i] = height / 2 - y * scale * camera.zoom * perspective;
    zs[i] = z;
    perspectives[i] = perspective;
  }
  return { xs, ys, zs, perspectives };
}

/** A node after projection: screen position, camera depth and drawn radius. */
export interface MemoryProjectedPoint {
  id: string;
  x: number;
  y: number;
  /** Camera-space depth: smaller is nearer the viewer. */
  z: number;
  radius: number;
}

/**
 * Uniform-grid spatial index over projected points. Picking is a bounded
 * 3x3-cell lookup instead of a linear scan, so hover/click hit-testing stays
 * far below the 4 ms budget at 50,000 nodes. Among the points inside the
 * hit threshold the nearest (smallest z) wins — the same node the old
 * reverse-scan picked, since it drew far-to-near.
 */
export class MemorySpatialPicker3D {
  private ids: string[] = [];
  private xs: Float64Array = new Float64Array(0);
  private ys: Float64Array = new Float64Array(0);
  private zs: Float64Array = new Float64Array(0);
  private radii: Float64Array = new Float64Array(0);
  private head: Int32Array = new Int32Array(0);
  private next: Int32Array = new Int32Array(0);
  private cols = 1;
  private rows = 1;
  private cellSize = 32;

  constructor(points: readonly MemoryProjectedPoint[], width: number, height: number, cellSize?: number) {
    const ids: string[] = [];
    const xs = new Float64Array(points.length);
    const ys = new Float64Array(points.length);
    const zs = new Float64Array(points.length);
    const radii = new Float64Array(points.length);
    points.forEach((point, i) => {
      ids.push(point.id);
      xs[i] = point.x; ys[i] = point.y; zs[i] = point.z; radii[i] = point.radius;
    });
    this.build(ids, xs, ys, zs, radii, width, height, cellSize);
  }

  /** Array form: the renderer's per-frame path, with no per-point objects. */
  static fromArrays(ids: string[], xs: Float64Array, ys: Float64Array, zs: Float64Array, radii: Float64Array, width: number, height: number): MemorySpatialPicker3D {
    const picker = Object.create(MemorySpatialPicker3D.prototype) as MemorySpatialPicker3D;
    picker.build(ids, xs, ys, zs, radii, width, height, undefined);
    return picker;
  }

  private build(ids: string[], xs: Float64Array, ys: Float64Array, zs: Float64Array, radii: Float64Array, width: number, height: number, cellSize: number | undefined) {
    // The cell must be at least the largest hit threshold, or a big node
    // (a focused core can exceed 60 px) could hide two cells away.
    let maxThreshold = 7;
    for (let i = 0; i < radii.length; i++) maxThreshold = Math.max(maxThreshold, radii[i]! + 3);
    this.ids = ids;
    this.xs = xs; this.ys = ys; this.zs = zs; this.radii = radii;
    this.cellSize = Math.max(cellSize ?? 32, maxThreshold);
    this.cols = Math.max(1, Math.ceil(width / this.cellSize));
    this.rows = Math.max(1, Math.ceil(height / this.cellSize));
    this.head = new Int32Array(this.cols * this.rows).fill(-1);
    this.next = new Int32Array(ids.length).fill(-1);
    for (let i = 0; i < ids.length; i++) {
      const cell = this.cellIndex(xs[i]!, ys[i]!);
      this.next[i] = this.head[cell]!;
      this.head[cell] = i;
    }
  }

  private cellIndex(x: number, y: number): number {
    const cx = Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.cellSize)));
    const cy = Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.cellSize)));
    return cy * this.cols + cx;
  }

  get size(): number { return this.ids.length; }

  pick(x: number, y: number): string | null {
    const cx = Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.cellSize)));
    const cy = Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.cellSize)));
    let best = -1, bestZ = Infinity, bestDistance = Infinity;
    for (let gy = Math.max(0, cy - 1); gy <= Math.min(this.rows - 1, cy + 1); gy++) {
      for (let gx = Math.max(0, cx - 1); gx <= Math.min(this.cols - 1, cx + 1); gx++) {
        for (let i = this.head[gy * this.cols + gx]!; i !== -1; i = this.next[i]!) {
          const distance = Math.hypot(this.xs[i]! - x, this.ys[i]! - y);
          if (distance >= Math.max(7, this.radii[i]! + 3)) continue;
          if (this.zs[i]! < bestZ || (this.zs[i]! === bestZ && distance < bestDistance)) {
            best = i; bestZ = this.zs[i]!; bestDistance = distance;
          }
        }
      }
    }
    return best >= 0 ? this.ids[best]! : null;
  }
}

/** Hard per-frame label budgets, whatever the graph size. */
export const MAX_MEMORY_3D_LABELS_MEASURED = 160;
export const MAX_MEMORY_3D_LABELS_DRAWN = 64;

export interface Memory3DLabelCandidate {
  id: string;
  label: string;
  type: MemoryGraphNode["type"];
  /** Projected screen position of the node center. */
  x: number;
  y: number;
  isFocus: boolean;
}

export interface Memory3DLabelPlacement {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  isCore: boolean;
  isFocus: boolean;
}

/**
 * Level-of-detail label selection. The historical rules are unchanged —
 * focus first, then core labels, then sources; non-source labels need zoom
 * >= 1.6 unless focused; labels are truncated at 48 characters and placed
 * with the same collision boxes — but the work is bounded: at most
 * `maxMeasured` candidates are ever measured and at most `maxDrawn` labels
 * are placed, however large the graph is. Candidates should arrive in draw
 * order; the priority sort is stable.
 */
export function selectMemory3DLabels(
  candidates: readonly Memory3DLabelCandidate[],
  options: {
    width: number;
    height: number;
    zoom: number;
    measure: (text: string) => number;
    maxMeasured?: number;
    maxDrawn?: number;
  }
): Memory3DLabelPlacement[] {
  const maxMeasured = options.maxMeasured ?? MAX_MEMORY_3D_LABELS_MEASURED;
  const maxDrawn = options.maxDrawn ?? MAX_MEMORY_3D_LABELS_DRAWN;
  const byPriority = (a: Memory3DLabelCandidate, b: Memory3DLabelCandidate) =>
    Number(b.isFocus) - Number(a.isFocus) ||
    Number(isMemoryCoreLabel(b.label)) - Number(isMemoryCoreLabel(a.label)) ||
    Number(b.type === "SOURCE") - Number(a.type === "SOURCE");
  // The budgets mean only the first maxMeasured candidates in priority
  // order can ever be reached, and priority order is exactly: focus, core
  // and source candidates (sorted) followed by the rest in draw order. For
  // large graphs, partition instead of sorting every candidate.
  let prioritized: Memory3DLabelCandidate[];
  if (candidates.length > maxMeasured * 4) {
    const tier: Memory3DLabelCandidate[] = [];
    const rest: Memory3DLabelCandidate[] = [];
    for (const candidate of candidates) {
      if (candidate.isFocus || candidate.type === "SOURCE" || isMemoryCoreLabel(candidate.label)) tier.push(candidate);
      else rest.push(candidate);
    }
    tier.sort(byPriority);
    prioritized = [...tier, ...rest];
  } else {
    prioritized = [...candidates].sort(byPriority);
  }
  const placed: Memory3DLabelPlacement[] = [];
  const boxes: Array<{ x: number; y: number; w: number }> = [];
  let measured = 0;
  for (const candidate of prioritized) {
    if (placed.length >= maxDrawn || measured >= maxMeasured) break;
    if (candidate.type !== "SOURCE" && !candidate.isFocus && options.zoom < 1.6) continue;
    const text = candidate.label.length > 48 ? `${candidate.label.slice(0, 45)}…` : candidate.label;
    const w = options.measure(text);
    measured++;
    const x = candidate.x + 9, y = candidate.y;
    if (x + w > options.width || y < 14 || y > options.height - 5) continue;
    if (boxes.some(box => Math.abs(box.y - y) < 16 && x < box.x + box.w + 5 && x + w + 5 > box.x)) continue;
    boxes.push({ x, y, w });
    placed.push({ id: candidate.id, text, x, y, width: w, isCore: isMemoryCoreLabel(candidate.label), isFocus: candidate.isFocus });
  }
  return placed;
}

/** Normalized covariance determinant: 0 for a plane, 1 for equal spread in XYZ. */
export function memory3DVolumeRatio(points: MemoryPoint3D[]): number {
  if (points.length < 4) return 0;
  const center = points.reduce((sum, p) => ({ x: sum.x + p.x / points.length, y: sum.y + p.y / points.length, z: sum.z + p.z / points.length }), { x: 0, y: 0, z: 0 });
  let xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
  for (const p of points) {
    const x = p.x - center.x, y = p.y - center.y, z = p.z - center.z;
    xx += x * x; yy += y * y; zz += z * z; xy += x * y; xz += x * z; yz += y * z;
  }
  const determinant = xx * yy * zz + 2 * xy * xz * yz - xx * yz * yz - yy * xz * xz - zz * xy * xy;
  return Math.max(0, determinant / Math.max(1e-12, ((xx + yy + zz) / 3) ** 3));
}
