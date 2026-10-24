/**
 * Label planning for the 3D memory graph.
 *
 * The Canvas 2D renderer measured and drew labels while it walked every node,
 * which does not scale: at 50,000 nodes the measuring alone would blow the
 * frame budget. The planner keeps the historical label rules (priority order,
 * collision avoidance, on-canvas bounds) but works on a lazy candidate stream:
 * it measures at most `maxMeasured` labels and places at most `maxLabels`
 * per frame, whatever the graph size. The budget shrinks when zoomed out,
 * which is the level-of-detail: distant views show only the most important
 * labels.
 */

export interface MemoryGraphLabelCandidate {
  id: string;
  /** Label text, already truncated to the display form. */
  label: string;
  /** Projected screen position in CSS pixels. */
  x: number;
  y: number;
  /** Core labels (the space.md root) render in the highlight color. */
  core: boolean;
  /** Whether the type/zoom visibility rules allow this label at all. */
  eligible: boolean;
}

export interface MemoryGraphPlannedLabel {
  id: string;
  label: string;
  /** Text origin in CSS pixels (the historical +9 x offset is applied). */
  x: number;
  y: number;
  /** Measured text width in CSS pixels. */
  width: number;
  core: boolean;
}

/** Frame budget for labels, by camera zoom: fewer, more important labels when far away. */
export function memoryGraphLabelBudget(zoom: number): { maxLabels: number; maxMeasured: number } {
  const maxLabels = zoom < 1 ? 40 : zoom < 1.6 ? 80 : 140;
  return { maxLabels, maxMeasured: maxLabels * 3 };
}

/**
 * Walks candidates in priority order (the caller puts the focused node first,
 * then core labels, then sources) and greedily places labels that fit on the
 * canvas without colliding with an already placed one. Measuring stops once
 * `maxMeasured` labels have been measured, so the per-frame cost stays
 * bounded even when every candidate is eligible.
 */
export function planMemoryGraphLabels(
  candidates: Iterable<MemoryGraphLabelCandidate>,
  options: {
    width: number;
    height: number;
    maxLabels: number;
    maxMeasured: number;
    measure: (label: string) => number;
  }
): MemoryGraphPlannedLabel[] {
  const { width, height, maxLabels, maxMeasured, measure } = options;
  const placed: MemoryGraphPlannedLabel[] = [];
  const boxes: Array<{ x: number; y: number; w: number }> = [];
  let measured = 0;
  for (const candidate of candidates) {
    if (placed.length >= maxLabels || measured >= maxMeasured) break;
    if (!candidate.eligible) continue;
    const labelWidth = measure(candidate.label);
    measured += 1;
    const x = candidate.x + 9;
    const y = candidate.y;
    if (x + labelWidth > width || y < 14 || y > height - 5) continue;
    if (boxes.some(box => Math.abs(box.y - y) < 16 && x < box.x + box.w + 5 && x + labelWidth + 5 > box.x)) continue;
    boxes.push({ x, y, w: labelWidth });
    placed.push({ id: candidate.id, label: candidate.label, x, y, width: labelWidth, core: candidate.core });
  }
  return placed;
}
