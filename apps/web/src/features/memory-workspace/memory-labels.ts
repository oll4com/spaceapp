import { projectInto, type Projection } from "./memory-camera.js";
import { FLAG_CORE, NODE_KIND, type MemoryScene } from "./memory-scene.js";

export const MAX_LABEL_CANDIDATES = 240; // nodes whose text is measured per frame, whatever the graph size
export const MAX_LABELS_DRAWN = 80;
const SCAN_BUDGET = 6000; // positions inspected (without measuring) while looking for on-screen candidates

export interface LabelPlacement { index: number; x: number; y: number; width: number; text: string }
export interface LabelSelection { labels: LabelPlacement[]; measured: number }

/**
 * Static priority of every node, computed once per scene: the core file, then source files, then everything
 * else by link count (hubs first). Counting sort over degree, so building it is linear.
 */
export function labelPriority(scene: MemoryScene): Int32Array {
  const degree = new Uint32Array(scene.count);
  for (let e = 0; e < scene.edgeCount; e++) { degree[scene.edgeSource[e]!]!++; degree[scene.edgeTarget[e]!]!++; }
  const tier = (i: number) => scene.flags[i]! & FLAG_CORE ? 0 : scene.kind[i] === NODE_KIND.SOURCE ? 1 : 2;
  let maxDegree = 0; for (let i = 0; i < scene.count; i++) if (degree[i]! > maxDegree) maxDegree = degree[i]!;
  // key = tier * (maxDegree + 1) + (maxDegree - degree): ascending key is the wanted order; ties keep index order.
  const span = maxDegree + 1, buckets = new Int32Array(3 * span + 1);
  const key = (i: number) => tier(i) * span + (maxDegree - degree[i]!);
  for (let i = 0; i < scene.count; i++) buckets[key(i) + 1]!++;
  for (let k = 0; k < 3 * span; k++) buckets[k + 1]! += buckets[k]!;
  const order = new Int32Array(scene.count);
  for (let i = 0; i < scene.count; i++) order[buckets[key(i)]!++] = i;
  return order;
}

/** Truncates like the Canvas 2D renderer did. */
export const labelText = (label: string) => label.length > 48 ? `${label.slice(0, 45)}…` : label;

export interface LabelInput {
  scene: MemoryScene; priority: Int32Array; projection: Projection;
  x: ArrayLike<number>; y: ArrayLike<number>; z: ArrayLike<number>;
  focus: number; showTitles: boolean;
  measure: (text: string) => number; // cached by the caller
  maxCandidates?: number; maxLabels?: number;
}

/**
 * Bounded label level of detail: the focused node, then the priority order. Non-source labels appear only from zoom 1.6,
 * as before. At most `maxCandidates` texts are measured and `maxLabels` placed, with the same collision rule as the
 * Canvas 2D renderer (16 px rows, 5 px gap).
 */
export function selectLabels(input: LabelInput): LabelSelection {
  const { scene, priority, projection: p, focus, showTitles, measure } = input;
  const maxCandidates = input.maxCandidates ?? MAX_LABEL_CANDIDATES, maxLabels = input.maxLabels ?? MAX_LABELS_DRAWN;
  if (!showTitles || scene.count === 0) return { labels: [], measured: 0 };
  const out = new Float64Array(4), boxes: Array<{ x: number; y: number; w: number }> = [], labels: LabelPlacement[] = [];
  let measured = 0, scanned = 0;
  const consider = (i: number) => {
    projectInto(p, input.x[i]!, input.y[i]!, input.z[i]!, out);
    const y = out[1]!, x = out[0]! + 9;
    if (x >= p.width || y < 14 || y > p.height - 5) return; // cheap rejection before measuring
    const text = labelText(scene.labels[i]!), width = measure(text);
    measured++;
    if (x + width > p.width || boxes.some(box => Math.abs(box.y - y) < 16 && x < box.x + box.w + 5 && x + width + 5 > box.x)) return;
    boxes.push({ x, y, w: width }); labels.push({ index: i, x, y, width, text });
  };
  if (focus >= 0) consider(focus);
  for (const i of priority) {
    if (labels.length >= maxLabels || measured >= maxCandidates || scanned++ >= SCAN_BUDGET) break;
    if (i === focus) continue;
    const major = scene.kind[i] === NODE_KIND.SOURCE;
    if (!major && p.zoom < 1.6) break; // priority order puts every source before any ordinary node
    consider(i);
  }
  return { labels, measured };
}

/** Width cache keyed by text so repeated frames never call measureText again. */
export function createTextMeasurer(measureText: (text: string) => number, limit = 4000) {
  const cache = new Map<string, number>();
  return (text: string) => {
    let width = cache.get(text);
    if (width === undefined) { if (cache.size >= limit) cache.clear(); cache.set(text, width = measureText(text)); }
    return width;
  };
}
