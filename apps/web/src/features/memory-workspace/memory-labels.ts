import type { MemoryGraphNode } from "@space/contracts";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import type { ProjectedNodePoint } from "./memory-picking.js";

export interface LabelCandidate {
  node: MemoryGraphNode;
  point: ProjectedNodePoint;
}

export interface PlacedLabel {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  isCore: boolean;
}

/**
 * Level-of-Detail label selector and culler.
 * Strictly bounds both string measurements and drawn boxes to constant limits
 * (max 120 evaluated, max 50 drawn), keeping frame time well below 1ms at 50,000 nodes.
 */
export function selectBoundedLabels(
  nodes: MemoryGraphNode[],
  projectedMap: Map<string, ProjectedNodePoint>,
  focusId: string | null,
  zoom: number,
  width: number,
  height: number,
  measureText: (text: string) => { width: number },
  maxCandidates: number = 120,
  maxDrawn: number = 50
): PlacedLabel[] {
  const byId = new Map(nodes.map(n => [n.id, n]));

  // 1. Gather candidates according to LOD priority:
  const focusNode = focusId ? byId.get(focusId) : undefined;
  const focusPoint = focusId ? projectedMap.get(focusId) : undefined;

  const coreNodes: LabelCandidate[] = [];
  const sourceNodes: LabelCandidate[] = [];
  const otherNodes: LabelCandidate[] = [];

  for (const node of nodes) {
    if (node.id === focusId) continue;
    const p = projectedMap.get(node.id);
    if (!p) continue;
    // Cull nodes outside screen bounds with margin
    if (p.x < -50 || p.x > width + 50 || p.y < -50 || p.y > height + 50) continue;

    if (isMemoryCoreLabel(node.label)) {
      coreNodes.push({ node, point: p });
    } else if (node.type === "SOURCE") {
      sourceNodes.push({ node, point: p });
    } else if (zoom >= 1.6) {
      otherNodes.push({ node, point: p });
    }
  }

  // Sort sources and others by closeness to camera (smaller z is closer)
  sourceNodes.sort((a, b) => a.point.z - b.point.z);
  otherNodes.sort((a, b) => a.point.z - b.point.z);

  const candidates: LabelCandidate[] = [];
  if (focusNode && focusPoint) {
    candidates.push({ node: focusNode, point: focusPoint });
  }
  candidates.push(...coreNodes);
  candidates.push(...sourceNodes);
  if (candidates.length < maxCandidates) {
    candidates.push(...otherNodes.slice(0, maxCandidates - candidates.length));
  }

  const boundedCandidates = candidates.slice(0, maxCandidates);
  const placed: PlacedLabel[] = [];
  const labelBoxes: Array<{ x: number; y: number; w: number }> = [];

  for (const { node, point: p } of boundedCandidates) {
    if (placed.length >= maxDrawn) break;
    const rawLabel = node.label;
    const label = rawLabel.length > 48 ? `${rawLabel.slice(0, 45)}…` : rawLabel;
    const x = p.x + 9;
    const y = p.y;
    const w = measureText(label).width;

    // Viewport bounds
    if (x + w > width || y < 14 || y > height - 5) continue;

    // Collision avoidance: minimum 16px vertical, 5px horizontal buffer
    const collides = labelBoxes.some(
      box => Math.abs(box.y - y) < 16 && x < box.x + box.w + 5 && x + w + 5 > box.x
    );
    if (collides) continue;

    labelBoxes.push({ x, y, w });
    placed.push({
      id: node.id,
      label,
      x,
      y,
      w,
      isCore: isMemoryCoreLabel(node.label)
    });
  }

  return placed;
}
