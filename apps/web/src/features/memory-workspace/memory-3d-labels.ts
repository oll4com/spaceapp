export const MAX_LABELS_MEASURED_PER_FRAME = 48;
export const MAX_LABELS_DRAWN_PER_FRAME = 40;
export const MAX_LABEL_CANDIDATES = 256;

export interface MemoryLabelCandidate {
  index: number;
  x: number;
  y: number;
  kind: number;
  text: string;
}

export interface MemoryLabelPlacement {
  index: number;
  x: number;
  y: number;
  text: string;
  width: number;
}

/**
 * Core and source labels win, focus wins over both, and measurement stops at a fixed budget
 * no matter how many candidates the caller collected.
 */
export function selectMemoryLabels(input: {
  showTitles: boolean;
  zoom: number;
  focus: number;
  candidates: readonly MemoryLabelCandidate[];
  measure: (text: string) => number;
  width: number;
  height: number;
  maxMeasured?: number;
  maxDrawn?: number;
}): MemoryLabelPlacement[] {
  if (!input.showTitles || input.width <= 0 || input.height <= 0) return [];
  const maxMeasured = input.maxMeasured ?? MAX_LABELS_MEASURED_PER_FRAME;
  const maxDrawn = input.maxDrawn ?? MAX_LABELS_DRAWN_PER_FRAME;
  const ranked = [...input.candidates].sort((left, right) =>
    Number(right.index === input.focus) - Number(left.index === input.focus)
    || right.kind - left.kind
    || left.index - right.index
  );
  const boxes: Array<{ x: number; y: number; w: number }> = [];
  const drawn: MemoryLabelPlacement[] = [];
  let measured = 0;
  for (const candidate of ranked) {
    if (measured >= maxMeasured || drawn.length >= maxDrawn) break;
    const focused = candidate.index === input.focus;
    if (!focused && candidate.kind < 1 && input.zoom < 1.6) continue;
    if (!Number.isFinite(candidate.x) || !Number.isFinite(candidate.y)) continue;
    const x = candidate.x + 9;
    const y = candidate.y;
    if (y < 14 || y > input.height - 5 || x > input.width) continue;
    const text = candidate.text.length > 48 ? `${candidate.text.slice(0, 45)}…` : candidate.text;
    measured += 1;
    const width = input.measure(text);
    if (x + width > input.width) continue;
    if (boxes.some(box => Math.abs(box.y - y) < 16 && x < box.x + box.w + 5 && x + width + 5 > box.x)) continue;
    boxes.push({ x, y, w: width });
    drawn.push({ index: candidate.index, x, y, text, width });
  }
  return drawn;
}

export function truncateMemoryLabel(text: string): string {
  return text.length > 48 ? `${text.slice(0, 45)}…` : text;
}
