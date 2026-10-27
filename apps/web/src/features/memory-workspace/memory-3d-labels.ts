import type { MemoryGraphNode } from "@space/contracts";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import {
  projectMemoryPoint,
  type MemoryCamera3D,
  type MemoryPoint3D,
} from "./memory-3d.js";
export const LABEL_CANDIDATES = 96;
export const LABEL_LIMIT = 40;
/** Bound per-frame projection, measurement and collision work independently of graph size. */
export function memoryLabelCandidates(nodes: MemoryGraphNode[]) {
  const core: MemoryGraphNode[] = [],
    source: MemoryGraphNode[] = [],
    rest: MemoryGraphNode[] = [];
  for (const node of nodes) {
    const bucket = isMemoryCoreLabel(node.label)
      ? core
      : node.type === "SOURCE"
        ? source
        : rest;
    if (bucket.length < LABEL_CANDIDATES) bucket.push(node);
  }
  return [...core, ...source, ...rest].slice(0, LABEL_CANDIDATES);
}
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
    if (node.type !== "SOURCE" && node !== focus && camera.zoom < 1.6) continue;
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
