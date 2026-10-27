import type { MemoryGraphNode } from "@space/contracts";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import {
  projectMemoryPoint,
  type MemoryCamera3D,
  type MemoryPoint3D,
} from "./memory-3d.js";
export const LABEL_CANDIDATES = 96;
export const LABEL_LIMIT = 40;
export const LABEL_PROJECTIONS = 2048;
/** Index complete priority groups once per scene for bounded viewport sampling. */
export function createMemoryLabelIndex(nodes: MemoryGraphNode[]) {
  const core: MemoryGraphNode[] = [],
    source: MemoryGraphNode[] = [],
    rest: MemoryGraphNode[] = [];
  for (const node of nodes) {
    const bucket = isMemoryCoreLabel(node.label)
      ? core
      : node.type === "SOURCE"
        ? source
        : rest;
    bucket.push(node);
  }
  return { groups: [core, source, rest], count: nodes.length };
}
/** Sample the current viewport with bounded projection work, then rank visible candidates. */
export function memoryLabelCandidates(
  index: ReturnType<typeof createMemoryLabelIndex>,
  coordinates: Map<string, MemoryPoint3D>,
  camera: MemoryCamera3D,
  scale: number,
  width: number,
  height: number,
) {
  const groups = camera.zoom >= 1.6 ? index.groups : index.groups.slice(0, 2);
  const budgets = index.count <= LABEL_PROJECTIONS
    ? groups.map(group => group.length)
    : groups.map((group, i) => Math.min(group.length, [64, 512, 1472][i]!));
  let spare = LABEL_PROJECTIONS - budgets.reduce((sum, count) => sum + count, 0);
  for (let i = 0; i < groups.length; i++) {
    const extra = Math.min(spare, groups[i]!.length - budgets[i]!);
    budgets[i]! += extra;
    spare -= extra;
  }
  const visible = groups.map((group, bucket) => {
    const count = budgets[bucket]!;
    const projected: Array<{ node: MemoryGraphNode; distance: number }> = [];
    for (let i = 0; i < count; i++) {
      // Include both ends; large groups are sampled evenly, not truncated by insertion order.
      const node = group[count === 1 ? 0 : Math.floor(i * (group.length - 1) / (count - 1))]!;
      const point = coordinates.get(node.id);
      if (!point) continue;
      const p = projectMemoryPoint(point, camera, scale, width, height);
      if (p.x < 0 || p.x > width - 9 || p.y < 14 || p.y > height - 5) continue;
      projected.push({ node, distance: (p.x - width / 2) ** 2 + (p.y - height / 2) ** 2 });
    }
    return projected.sort((a, b) => a.distance - b.distance).slice(0, LABEL_CANDIDATES).map(p => p.node);
  });
  // Reserve room for nearby memories when zoomed in, even in source-heavy graphs.
  const memories = visible[2] ?? [];
  const reserved = Math.min(24, memories.length);
  const priorities = [...visible[0]!, ...visible[1]!].slice(0, LABEL_CANDIDATES - reserved);
  return [...priorities, ...memories].slice(0, LABEL_CANDIDATES);
}
/** Measure only bounded viewport candidates and reject overlapping label rectangles. */
export function selectMemoryLabels(
  candidates: MemoryGraphNode[],
  focus: MemoryGraphNode | undefined,
  coordinates: Map<string, MemoryPoint3D>,
  camera: MemoryCamera3D,
  scale: number,
  width: number,
  height: number,
  measure: (label: string) => number,
) {
  const result: Array<{
    id: string;
    label: string;
    x: number;
    y: number;
    width: number;
    core: boolean;
  }> = [];
  const seen = new Set<string>();
  for (const node of (focus ? [focus, ...candidates] : candidates).slice(
    0,
    LABEL_CANDIDATES,
  )) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    if (node.type !== "SOURCE" && !isMemoryCoreLabel(node.label) && node !== focus && camera.zoom < 1.6) continue;
    const point = coordinates.get(node.id);
    if (!point) continue;
    const p = projectMemoryPoint(point, camera, scale, width, height),
      x = p.x + 9,
      y = p.y;
    if (x < 0 || x > width || y < 14 || y > height - 5) continue;
    const label =
        node.label.length > 48 ? `${node.label.slice(0, 45)}…` : node.label,
      w = measure(label);
    if (
      x + w > width ||
      result.some(
        (box) =>
          Math.abs(box.y - y) < 16 &&
          x < box.x + box.width + 5 &&
          x + w + 5 > box.x,
      )
    )
      continue;
    result.push({
      id: node.id,
      label,
      x,
      y,
      width: w,
      core: isMemoryCoreLabel(node.label),
    });
    if (result.length === LABEL_LIMIT) break;
  }
  return result;
}
