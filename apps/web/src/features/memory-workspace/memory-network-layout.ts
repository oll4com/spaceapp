import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { isMemoryCoreLabel, isMemoryIndexLabel } from "./memory-graph-visuals.js";

const unit = (value: string) => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return (hash >>> 0) / 4294967295;
};

/** Bounded force relaxation driven by actual edges; color never affects geometry. */
export function layoutMemoryNetwork(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[]) {
  const count = nodes.length;
  if (count === 0) return new Map<string, { x: number; y: number }>();
  const ordered = [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const index = new Map(ordered.map((node, i) => [node.id, i]));
  const sources = ordered.filter(node => node.type === "SOURCE");
  const root = sources.find(node => isMemoryCoreLabel(node.label)) ?? sources.find(node => isMemoryIndexLabel(node.label));
  const rootIndex = root ? index.get(root.id)! : -1;
  const sourceIndex = new Map<string | null, number>();
  for (const node of sources) sourceIndex.set(node.sourcePath, index.get(node.id)!);
  const spread = count > 2000 ? Math.sqrt(count / 2000) : 1;
  const px = new Float64Array(count);
  const py = new Float64Array(count);
  const isSource = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const node = ordered[i]!;
    px[i] = (unit(node.id) - 0.5) * 240 * spread;
    py[i] = (unit(`${node.id}:y`) - 0.5) * 200 * spread;
    if (node.type === "SOURCE") isSource[i] = 1;
  }
  // Start records close to their true source. The force simulation then resolves local relationships.
  for (let i = 0; i < count; i++) {
    const node = ordered[i]!;
    const parent = sourceIndex.get(node.sourcePath);
    if (node.type === "MEMORY" && parent !== undefined) {
      px[i] = px[parent]! + (unit(`${node.id}:dx`) - 0.5) * 45;
      py[i] = py[parent]! + (unit(`${node.id}:dy`) - 0.5) * 45;
    }
  }
  if (rootIndex >= 0) {
    px[rootIndex] = 0;
    py[rootIndex] = 0;
  }
  const linkCountMax = edges.length;
  const linkA = new Int32Array(linkCountMax);
  const linkB = new Int32Array(linkCountMax);
  const linkLength = new Float64Array(linkCountMax);
  const linkStrength = new Float64Array(linkCountMax);
  let linkCount = 0;
  for (const edge of edges) {
    const a = index.get(edge.source), b = index.get(edge.target);
    if (a === undefined || b === undefined || a === b) continue;
    const fileLink = isSource[a] === 1 && isSource[b] === 1;
    linkA[linkCount] = a;
    linkB[linkCount] = b;
    linkLength[linkCount] = fileLink ? 85 : edge.type === "CONTAINS" ? 28 : 45;
    linkStrength[linkCount] = fileLink ? 0.026 : edge.type === "CONTAINS" ? 0.017 : 0.0025;
    linkCount++;
  }
  const fx = new Float64Array(count), fy = new Float64Array(count);
  let bucketSize = 64;
  while (bucketSize < count * 2) bucketSize <<= 1;
  const bucketMask = bucketSize - 1;
  const bucketHead = new Int32Array(bucketSize);
  const cellX = new Int32Array(count);
  const cellY = new Int32Array(count);
  const cellNext = new Int32Array(count);
  const cellNodeHead = new Int32Array(count);
  const cellNodeTail = new Int32Array(count);
  const cellNodeCount = new Int32Array(count);
  const nodeNext = new Int32Array(count);
  const maxCellOccupants = count > 2000 ? 14 : 64;
  const totalSteps = count > 10000 ? 36 : count > 2000 ? 72 : 150;
  const coolingDenom = totalSteps === 150 ? 190 : totalSteps * 1.26;

  const hashCell2D = (gx: number, gy: number) => (Math.imul(gx, 73856093) ^ Math.imul(gy, 19349663)) & bucketMask;

  for (let step = 0; step < totalSteps; step++) {
    fx.fill(0);
    fy.fill(0);
    bucketHead.fill(-1);
    let numCells = 0;
    for (let i = 0; i < count; i++) {
      const gx = Math.floor(px[i]! / 25), gy = Math.floor(py[i]! / 25);
      const h = hashCell2D(gx, gy);
      let c = bucketHead[h]!;
      while (c !== -1 && (cellX[c] !== gx || cellY[c] !== gy)) c = cellNext[c]!;
      if (c === -1) {
        c = numCells++;
        cellX[c] = gx;
        cellY[c] = gy;
        cellNext[c] = bucketHead[h]!;
        bucketHead[h] = c;
        cellNodeHead[c] = i;
        cellNodeTail[c] = i;
        cellNodeCount[c] = 1;
        nodeNext[i] = -1;
      } else if (cellNodeCount[c]! < maxCellOccupants) {
        nodeNext[cellNodeTail[c]!] = i;
        cellNodeTail[c] = i;
        cellNodeCount[c]!++;
        nodeNext[i] = -1;
      }
    }
    for (let i = 0; i < count; i++) {
      const pxi = px[i]!, pyi = py[i]!, srcI = isSource[i] === 1;
      const gx = Math.floor(pxi / 25), gy = Math.floor(pyi / 25);
      for (let x = gx - 1; x <= gx + 1; x++) {
        for (let y = gy - 1; y <= gy + 1; y++) {
          const h = hashCell2D(x, y);
          let c = bucketHead[h]!;
          while (c !== -1 && (cellX[c] !== x || cellY[c] !== y)) c = cellNext[c]!;
          if (c === -1) continue;
          for (let j = cellNodeHead[c]!; j !== -1; j = nodeNext[j]!) {
            if (j <= i) continue;
            const dx = (pxi - px[j]!) || 0.01, dy = (pyi - py[j]!) || 0.01;
            const distanceSquared = Math.max(4, dx * dx + dy * dy);
            const repulsion = (srcI || isSource[j] === 1 ? 14 : 5) / distanceSquared;
            fx[i]! += dx * repulsion; fy[i]! += dy * repulsion;
            fx[j]! -= dx * repulsion; fy[j]! -= dy * repulsion;
          }
        }
      }
    }
    for (let l = 0; l < linkCount; l++) {
      const a = linkA[l]!, b = linkB[l]!;
      const dx = px[b]! - px[a]!, dy = py[b]! - py[a]!;
      const distance = Math.max(0.01, Math.hypot(dx, dy));
      const spring = (distance - linkLength[l]!) * linkStrength[l]! / distance;
      fx[a]! += dx * spring; fy[a]! += dy * spring;
      fx[b]! -= dx * spring; fy[b]! -= dy * spring;
    }
    const cooling = 1 - step / coolingDenom;
    for (let i = 0; i < count; i++) {
      if (i === rootIndex) continue;
      px[i]! += Math.max(-4, Math.min(4, fx[i]! - px[i]! * 0.0004)) * cooling;
      py[i]! += Math.max(-4, Math.min(4, fy[i]! - py[i]! * 0.0004)) * cooling;
    }
  }
  return new Map(ordered.map((node, i) => [node.id, { x: px[i]!, y: py[i]! }]));
}
