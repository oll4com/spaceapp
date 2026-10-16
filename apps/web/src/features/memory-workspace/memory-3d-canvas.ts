import { projectMemoryPoint, type MemoryCamera3D, type MemoryPoint3D } from "./memory-3d.js";
import { packedText, type PackedMemoryGraph } from "./memory-3d-buffers.js";
import { selectMemoryLabels } from "./memory-3d-labels.js";

const FALLBACK_COLOR = "#7395ad";

function rgb(colors: Uint8Array, index: number) {
  const cursor = index * 3;
  return `rgb(${colors[cursor] ?? 0}, ${colors[cursor + 1] ?? 0}, ${colors[cursor + 2] ?? 0})`;
}

/** Canvas 2D fallback. Callers pass at most the historical 2,000-node cap. */
export function paintMemoryGraphCanvas(
  context: CanvasRenderingContext2D,
  packed: PackedMemoryGraph,
  indexes: Uint32Array,
  camera: MemoryCamera3D,
  scale: number,
  width: number,
  height: number,
  focus: number,
  showTitles: boolean,
  neighbors: Uint8Array,
  edgeIndexes?: Uint32Array
) {
  context.clearRect(0, 0, width, height);
  const allowed = new Set<number>(indexes);
  const projected = new Map<number, ReturnType<typeof projectMemoryPoint> & { radius: number }>();
  for (const index of indexes) {
    const cursor = index * 3;
    const point: MemoryPoint3D = {
      x: packed.xyz[cursor] ?? 0,
      y: packed.xyz[cursor + 1] ?? 0,
      z: packed.xyz[cursor + 2] ?? 0
    };
    const screen = projectMemoryPoint(point, camera, scale, width, height);
    const highlighted = index === focus;
    const radius = Math.max(1, (packed.radii[index] ?? 2.1) * screen.perspective * Math.sqrt(camera.zoom)) * (highlighted ? 1.5 : 1);
    projected.set(index, { ...screen, radius });
  }
  context.lineWidth = 0.55;
  const edgeTotal = edgeIndexes ? edgeIndexes.length : Math.min(packed.edgeCount, 6_000);
  for (let cursor = 0; cursor < edgeTotal; cursor++) {
    const edge = edgeIndexes ? edgeIndexes[cursor] ?? 0 : cursor;
    const source = packed.edgePairs[edge * 2] ?? -1;
    const target = packed.edgePairs[edge * 2 + 1] ?? -1;
    if (!allowed.has(source) || !allowed.has(target)) continue;
    const start = projected.get(source);
    const end = projected.get(target);
    if (!start || !end) continue;
    const incident = source === focus || target === focus;
    context.strokeStyle = incident ? "#98dafa" : focus >= 0 ? "#14202b" : (packed.edgeTypes[edge] ?? 0) === 1 ? "#385068" : "#203343";
    context.lineWidth = incident ? 1.15 : 0.55;
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    context.stroke();
  }
  const ordered = [...indexes].sort((left, right) => (projected.get(right)?.z ?? 0) - (projected.get(left)?.z ?? 0));
  for (const index of ordered) {
    const point = projected.get(index);
    if (!point) continue;
    const highlighted = index === focus;
    const neighbor = (neighbors[index] ?? 0) > 0;
    context.globalAlpha = focus >= 0 && !highlighted && !neighbor ? 0.2 : Math.max(0.4, Math.min(1, point.perspective));
    context.fillStyle = highlighted ? "#ffffff" : rgb(packed.colors, index) || FALLBACK_COLOR;
    if ((packed.kinds[index] ?? 0) === 2 || highlighted) {
      context.shadowColor = context.fillStyle;
      context.shadowBlur = 13;
    }
    context.beginPath();
    context.arc(point.x, point.y, point.radius, 0, Math.PI * 2);
    context.fill();
    context.shadowBlur = 0;
  }
  context.globalAlpha = 1;
  if (!showTitles) return;
  const labels = selectMemoryLabels({
    showTitles,
    zoom: camera.zoom,
    focus,
    width,
    height,
    measure: text => context.measureText(text).width,
    candidates: [...indexes].map(index => {
      const point = projected.get(index);
      return {
        index,
        x: point?.x ?? Number.NaN,
        y: point?.y ?? Number.NaN,
        kind: packed.kinds[index] ?? 0,
        text: packedText(packed.labels, packed.labelOffsets, index)
      };
    })
  });
  context.font = "11px system-ui, sans-serif";
  for (const label of labels) {
    context.fillStyle = "#09111bea";
    context.fillRect(label.x - 3, label.y - 11, label.width + 6, 16);
    context.fillStyle = (packed.kinds[label.index] ?? 0) === 2 ? "#fff0b0" : "#c6dfed";
    context.fillText(label.text, label.x, label.y + 1);
  }
}
