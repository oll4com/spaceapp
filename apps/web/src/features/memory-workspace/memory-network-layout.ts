import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";

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
  const root = sources.find(node => node.label === "gemini.md") ?? sources.find(node => node.label === "gemini_history.md");
  const rootIndex = root ? index.get(root.id)! : -1;
  const sourceIndex = new Map(sources.map(node => [node.sourcePath, index.get(node.id)!]));
  const points = ordered.map(node => ({ x: (unit(node.id) - 0.5) * 240, y: (unit(`${node.id}:y`) - 0.5) * 200 }));
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
  for (let step = 0; step < 150; step++) {
    fx.fill(0); fy.fill(0);
    const grid = new Map<string, number[]>();
    for (let i = 0; i < count; i++) {
      const p = points[i]!;
      const key = `${Math.floor(p.x / 25)},${Math.floor(p.y / 25)}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key)!.push(i);
    }
    for (let i = 0; i < count; i++) {
      const p = points[i]!, gx = Math.floor(p.x / 25), gy = Math.floor(p.y / 25);
      for (let x = gx - 1; x <= gx + 1; x++) for (let y = gy - 1; y <= gy + 1; y++) {
        for (const j of grid.get(`${x},${y}`) ?? []) {
          if (j <= i) continue;
          const q = points[j]!;
          const dx = p.x - q.x || 0.01, dy = p.y - q.y || 0.01;
          const distanceSquared = Math.max(4, dx * dx + dy * dy);
          const repulsion = (ordered[i]!.type === "SOURCE" || ordered[j]!.type === "SOURCE" ? 14 : 5) / distanceSquared;
          fx[i]! += dx * repulsion; fy[i]! += dy * repulsion;
          fx[j]! -= dx * repulsion; fy[j]! -= dy * repulsion;
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
    for (let i = 0; i < count; i++) {
      if (i === rootIndex) continue;
      const p = points[i]!;
      p.x += Math.max(-4, Math.min(4, fx[i]! - p.x * 0.0004)) * cooling;
      p.y += Math.max(-4, Math.min(4, fy[i]! - p.y * 0.0004)) * cooling;
    }
  }
  return new Map(ordered.map((node, i) => [node.id, points[i]!]));
}
