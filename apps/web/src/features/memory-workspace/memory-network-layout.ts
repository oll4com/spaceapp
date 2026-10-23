import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { isMemoryCoreLabel, isMemoryIndexLabel } from "./memory-graph-visuals.js";

const unit = (value: string) => {
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0) / 4294967295;
};

/** Bounded force relaxation driven by actual edges; color never affects geometry. */
export function layoutMemoryNetwork(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[]) {
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const index = new Map(ordered.map((node, i) => [node.id, i]));
  const sources = ordered.filter(node => node.type === "SOURCE");
  const root = sources.find(node => isMemoryCoreLabel(node.label)) ?? sources.find(node => isMemoryIndexLabel(node.label));
  const rootIndex = root ? index.get(root.id)! : -1;
  const sourceIndex = new Map(sources.map(node => [node.sourcePath, index.get(node.id)!]));
  // Above 2,000 nodes the seed spread (and travel budget) grows with the
  // square root of the count so the spatial grid keeps a bounded occupancy;
  // at or below 2,000 the factor is exactly 1 and the layout is unchanged.
  const densityScale = Math.max(1, Math.sqrt(ordered.length / 2000));
  const points = ordered.map(node => ({ x: (unit(node.id) - 0.5) * 240 * densityScale, y: (unit(`${node.id}:y`) - 0.5) * 200 * densityScale }));
  // Start records close to their true source. The force simulation then resolves local relationships.
  ordered.forEach((node, i) => {
    const parent = sourceIndex.get(node.sourcePath);
    if (node.type === "MEMORY" && parent !== undefined) {
      points[i] = { x: points[parent]!.x + (unit(`${node.id}:dx`) - 0.5) * 45, y: points[parent]!.y + (unit(`${node.id}:dy`) - 0.5) * 45 };
    }
  });
  if (rootIndex >= 0) points[rootIndex] = { x: 0, y: 0 };
  const links = edges.flatMap(edge => {
    const a = index.get(edge.source), b = index.get(edge.target);
    if (a === undefined || b === undefined || a === b) return [];
    const fileLink = ordered[a]!.type === "SOURCE" && ordered[b]!.type === "SOURCE";
    return [{ a, b, length: fileLink ? 85 : edge.type === "CONTAINS" ? 28 : 45, strength: fileLink ? 0.026 : edge.type === "CONTAINS" ? 0.017 : 0.0025 }];
  });
  const count = points.length;
  const fx = new Float64Array(count), fy = new Float64Array(count);
  // Cells are visited in the same order and members in ascending node order
  // as the original string-keyed grid, so force accumulation order — and the
  // layout — is bit-for-bit identical; only the key encoding changed
  // (packed integers + flat typed arrays), which is several times faster at
  // 50,000 nodes. Out-of-range steps fall back to the string grid.
  const CELL_OFFSET = 2048, CELL_SPAN = 4097;
  const cellX = new Int32Array(count), cellY = new Int32Array(count), cellDense = new Int32Array(count);
  // Grid scratch buffers are allocated once and reused every step.
  const dense = new Map<number, number>();
  const cellCounts = new Int32Array(count);
  const cellStarts = new Int32Array(count + 1);
  const cellMembers = new Int32Array(count);
  const cellCursor = new Int32Array(count);
  const repulse = (i: number, j: number) => {
    const p = points[i]!, q = points[j]!;
    const dx = p.x - q.x || 0.01, dy = p.y - q.y || 0.01;
    const distanceSquared = Math.max(4, dx * dx + dy * dy);
    const repulsion = (ordered[i]!.type === "SOURCE" || ordered[j]!.type === "SOURCE" ? 14 : 5) / distanceSquared;
    fx[i]! += dx * repulsion; fy[i]! += dy * repulsion;
    fx[j]! -= dx * repulsion; fy[j]! -= dy * repulsion;
  };
  for (let step = 0; step < 150; step++) {
    fx.fill(0); fy.fill(0);
    let packable = count > 0;
    for (let i = 0; i < count; i++) {
      const p = points[i]!;
      cellX[i] = Math.floor(p.x / 25); cellY[i] = Math.floor(p.y / 25);
      if (Math.abs(cellX[i]!) > CELL_OFFSET - 1 || Math.abs(cellY[i]!) > CELL_OFFSET - 1) packable = false;
    }
    if (packable) {
      const pack = (x: number, y: number) => (x + CELL_OFFSET) * CELL_SPAN + (y + CELL_OFFSET);
      dense.clear();
      let cellTotal = 0;
      for (let i = 0; i < count; i++) {
        const key = pack(cellX[i]!, cellY[i]!);
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
        const gx = cellX[i]!, gy = cellY[i]!;
        for (let x = gx - 1; x <= gx + 1; x++) for (let y = gy - 1; y <= gy + 1; y++) {
          const cell = dense.get(pack(x, y));
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
        const key = `${cellX[i]},${cellY[i]}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key)!.push(i);
      }
      for (let i = 0; i < count; i++) {
        const gx = cellX[i]!, gy = cellY[i]!;
        for (let x = gx - 1; x <= gx + 1; x++) for (let y = gy - 1; y <= gy + 1; y++) {
          for (const j of grid.get(`${x},${y}`) ?? []) if (j > i) repulse(i, j);
        }
      }
    }
    for (const link of links) {
      const a = points[link.a]!, b = points[link.b]!;
      const dx = b.x - a.x, dy = b.y - a.y, distance = Math.max(0.01, Math.hypot(dx, dy));
      const spring = (distance - link.length) * link.strength / distance;
      fx[link.a]! += dx * spring; fy[link.a]! += dy * spring;
      fx[link.b]! -= dx * spring; fy[link.b]! -= dy * spring;
    }
    const cooling = 1 - step / 190;
    const travel = 4 * densityScale;
    for (let i = 0; i < count; i++) {
      if (i === rootIndex) continue;
      const p = points[i]!;
      p.x += Math.max(-travel, Math.min(travel, fx[i]! - p.x * 0.0004)) * cooling;
      p.y += Math.max(-travel, Math.min(travel, fy[i]! - p.y * 0.0004)) * cooling;
    }
  }
  return new Map(ordered.map((node, i) => [node.id, points[i]!]));
}
