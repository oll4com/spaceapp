import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import { MemoryGraphWebGLRenderer, baseScaleFor, isWebGL2Supported, shouldShowLabel } from "./memory-graph-webgl.js";
import type { MemoryCamera3D, MemoryPoint3D } from "./memory-3d.js";
import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";

export interface GlGraphState {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  positions: Map<string, MemoryAtlasPosition>;
  coordinates: Map<string, MemoryPoint3D>;
  showTitles: boolean;
  selectedNodeId: string | null;
}

export interface GlGraphAttach {
  render: () => void;
  rebuild: () => void;
  hit: (x: number, y: number) => string | null;
  setFocus: (id: string | null) => void;
  dispose: () => void;
}

const HIT_CELL = 48;
const HIT_KEY_STRIDE = 4096;

/** Bounded number of labels measured and drawn per frame (issue #62). */
export const MAX_GRAPH_LABELS_PER_FRAME = 96;

/** Pure helper: screen-space spatial hash for neighborhood picking (no linear scan). */
export function buildHitGrid(
  screenX: Float32Array,
  screenY: Float32Array,
  screenValid: Uint8Array
): Map<number, number[]> {
  const grid = new Map<number, number[]>();
  for (let index = 0; index < screenX.length; index += 1) {
    if (!screenValid[index]) continue;
    const key = Math.floor(screenX[index]! / HIT_CELL) * HIT_KEY_STRIDE + Math.floor(screenY[index]! / HIT_CELL);
    const bucket = grid.get(key);
    if (bucket) bucket.push(index);
    else grid.set(key, [index]);
  }
  return grid;
}

/** Pure helper: nearest node inside its pick radius in the 3x3 grid neighborhood. */
export function hitTest(
  grid: Map<number, number[]>,
  nodes: Array<{ id: string }>,
  screenX: Float32Array,
  screenY: Float32Array,
  screenRadius: Float32Array,
  screenValid: Uint8Array,
  x: number,
  y: number
): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  const cellX = Math.floor(x / HIT_CELL);
  const cellY = Math.floor(y / HIT_CELL);
  for (let cx = cellX - 1; cx <= cellX + 1; cx += 1) {
    for (let cy = cellY - 1; cy <= cellY + 1; cy += 1) {
      for (const index of grid.get(cx * HIT_KEY_STRIDE + cy) ?? []) {
        if (!screenValid[index]) continue;
        const distance = Math.hypot(screenX[index]! - x, screenY[index]! - y);
        if (distance < Math.max(7, screenRadius[index]! + 3) && distance < bestDistance) {
          bestDistance = distance;
          best = nodes[index]!.id;
        }
      }
    }
  }
  return best;
}

/** Pure helper: LOD-prioritized label candidates, bounded per frame (issue #62). */
export function selectLabelNodes(
  nodes: MemoryGraphNode[],
  screenValid: Uint8Array,
  focus: string | null,
  zoom: number,
  max = MAX_GRAPH_LABELS_PER_FRAME
): Array<{ node: MemoryGraphNode; index: number }> {
  const candidates: Array<{ node: MemoryGraphNode; index: number }> = [];
  for (let index = 0; index < nodes.length; index += 1) {
    if (!screenValid[index]) continue;
    const node = nodes[index]!;
    if (!shouldShowLabel(node.type, node.id === focus, isMemoryCoreLabel(node.label), zoom)) continue;
    candidates.push({ node, index });
  }
  return candidates
    .sort((a, b) =>
      Number(b.node.id === focus) - Number(a.node.id === focus) ||
      Number(isMemoryCoreLabel(b.node.label)) - Number(isMemoryCoreLabel(a.node.label)) ||
      Number(b.node.type === "SOURCE") - Number(a.node.type === "SOURCE")
    )
    .slice(0, max);
}

const HEX = (color: string): number => parseInt(color.replace("#", ""), 16) || 0x7395ad;

function unpackPointColor(color: number): [number, number, number] {
  return [((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255];
}

/**
 * Attaches the WebGL2 renderer to a canvas pair (main + label overlay).
 * The overlay carries text labels (LOD-selected); the main canvas carries
 * all points/edges through the GPU. Hit testing uses a spatial hash of
 * screen-space positions rebuilt on demand (not per frame).
 */
export function attachWebGLGraph(attach: {
  canvas: HTMLCanvasElement;
  overlay: HTMLCanvasElement;
  getState: () => GlGraphState;
  cameraRef: { current: MemoryCamera3D };
}): GlGraphAttach {
  const { canvas, overlay, getState, cameraRef } = attach;
  if (!isWebGL2Supported()) throw new Error("WebGL2 unsupported");
  const renderer = new MemoryGraphWebGLRenderer(canvas);
  const overlayContext = overlay.getContext("2d")!;
  const indexById = new Map<string, number>();
  let nodes: MemoryGraphNode[] = [];
  let screenX = new Float32Array(0);
  let screenY = new Float32Array(0);
  let screenRadius = new Float32Array(0);
  let screenValid = new Uint8Array(0);
  let grid = new Map<number, number[]>();
  // The spatial hash is rebuilt lazily: projection changes only on camera/data
  // moves, and hover queries keep the camera still, so one rebuild serves many
  // hits while rotation frames skip the O(nodes) build entirely (issue #62).
  let gridDirty = true;
  let width = 1;
  let height = 1;
  let hoverFocus: string | null = null;
  let baseNodeColors = new Float32Array(0);
  let baseEdgeColors = new Float32Array(0);
  let focusDirty = true;
  let lastCoordinates: Map<string, MemoryPoint3D> | null = null;
  let cachedValidIndexes: number[] = [];
  let cachedPoints: MemoryPoint3D[] = [];

  const effectiveFocus = () => hoverFocus ?? getState().selectedNodeId;

  const applyFocus = () => {
    const focusId = effectiveFocus();
    const focusIdx = focusId ? indexById.get(focusId) ?? -1 : -1;
    const neighbors = new Set<number>();
    if (focusIdx >= 0) {
      for (const edge of getState().edges) {
        if (edge.source === focusId) {
          const target = indexById.get(edge.target);
          if (target !== undefined) neighbors.add(target);
        }
        if (edge.target === focusId) {
          const source = indexById.get(edge.source);
          if (source !== undefined) neighbors.add(source);
        }
      }
    }
    const nodeColors = new Float32Array(nodes.length * 4);
    for (let i = 0; i < nodes.length; i++) {
      const focused = i === focusIdx;
      const neighbor = neighbors.has(i);
      const alpha = focusIdx < 0 || focused || neighbor ? 1 : 0.2;
      nodeColors[i * 4] = focused ? 1 : baseNodeColors[i * 4] ?? 0;
      nodeColors[i * 4 + 1] = focused ? 1 : baseNodeColors[i * 4 + 1] ?? 0;
      nodeColors[i * 4 + 2] = focused ? 1 : baseNodeColors[i * 4 + 2] ?? 0;
      nodeColors[i * 4 + 3] = (baseNodeColors[i * 4 + 3] ?? 1) * alpha;
    }
    renderer.updateNodeColors(nodeColors);
    const edges = getState().edges;
    const edgeColors = new Float32Array(edges.length * 8);
    edges.forEach((edge, index) => {
      const incident = focusIdx >= 0 && (edge.source === focusId || edge.target === focusId);
      const r = baseEdgeColors[index * 8] ?? 0;
      const g = baseEdgeColors[index * 8 + 1] ?? 0;
      const b = baseEdgeColors[index * 8 + 2] ?? 0;
      const alpha = focusIdx < 0 || incident ? 1 : 0.2;
      for (let corner = 0; corner < 2; corner++) {
        edgeColors[index * 8 + corner * 4] = incident ? 0.596 : r;
        edgeColors[index * 8 + corner * 4 + 1] = incident ? 0.855 : g;
        edgeColors[index * 8 + corner * 4 + 2] = incident ? 0.98 : b;
        edgeColors[index * 8 + corner * 4 + 3] = (baseEdgeColors[index * 8 + corner * 4 + 3] ?? 1) * alpha;
      }
    });
    renderer.updateEdgeColors(edgeColors);
    focusDirty = false;
  };

  const extentOf = () => {
    let max = 60;
    for (const p of getState().coordinates.values()) {
      const hypot = Math.hypot(p.x, p.y, p.z);
      if (hypot > max) max = hypot;
    }
    return max;
  };

  const rebuild = () => {
    const state = getState();
    nodes = state.nodes;
    indexById.clear();
    const points: Array<{ id: string; x: number; y: number; z: number; radius: number; color: number; alpha: number }> = [];
    nodes.forEach((node) => {
      const p = state.coordinates.get(node.id);
      if (!p) return;
      indexById.set(node.id, points.length);
      points.push({
        id: node.id,
        x: p.x, y: p.y, z: p.z,
        radius: node.type === "SOURCE" ? (isMemoryCoreLabel(node.label) ? 10 : 4.6) : 2.1,
        color: HEX(state.positions.get(node.id)?.color ?? "#7395ad"),
        alpha: 1
      });
    });
    const edges: Array<{ a: number; b: number; color: number; alpha: number }> = [];
    for (const edge of state.edges) {
      const a = indexById.get(edge.source), b = indexById.get(edge.target);
      if (a === undefined || b === undefined) continue;
      edges.push({ a, b, color: edge.type === "DERIVED_FROM" ? HEX("#385068") : HEX("#203343"), alpha: 1 });
    }
    renderer.setGeometry(points, edges);
    baseNodeColors = new Float32Array(points.length * 4);
    points.forEach((point, index) => {
      const [r, g, b] = unpackPointColor(point.color);
      baseNodeColors[index * 4] = r;
      baseNodeColors[index * 4 + 1] = g;
      baseNodeColors[index * 4 + 2] = b;
      baseNodeColors[index * 4 + 3] = point.alpha;
    });
    baseEdgeColors = new Float32Array(edges.length * 8);
    edges.forEach((edge, index) => {
      const [r, g, b] = unpackPointColor(edge.color);
      baseEdgeColors[index * 8] = r;
      baseEdgeColors[index * 8 + 1] = g;
      baseEdgeColors[index * 8 + 2] = b;
      baseEdgeColors[index * 8 + 3] = edge.alpha;
      baseEdgeColors[index * 8 + 4] = r;
      baseEdgeColors[index * 8 + 5] = g;
      baseEdgeColors[index * 8 + 6] = b;
      baseEdgeColors[index * 8 + 7] = edge.alpha;
    });
    screenX = new Float32Array(points.length);
    screenY = new Float32Array(points.length);
    screenRadius = new Float32Array(points.length);
    screenValid = new Uint8Array(points.length);
    focusDirty = true;
  };

  const projectScreen = () => {
    const coordinates = getState().coordinates;
    if (coordinates !== lastCoordinates) {
      // The node set is fixed per rebuild; extracting positions (one Map.get
      // per node) runs once per data change, never per frame (issue #62).
      lastCoordinates = coordinates;
      cachedValidIndexes = [];
      cachedPoints = [];
      for (let i = 0; i < nodes.length; i++) {
        const point = coordinates.get(nodes[i]!.id);
        if (!point) { screenValid[i] = 0; continue; }
        cachedValidIndexes.push(i);
        cachedPoints.push(point);
      }
    }
    const extent = extentOf();
    // baseScale stays unzoomed (the shader's uBaseScale); zoom applies exactly
    // once through zoomScale, so hover/click hit-testing aligns with the
    // drawn nodes (issue #62 review fix).
    const scale = baseScaleFor(Math.min(width, height), extent);
    // Camera trig and zoom factors are hoisted out of the loop: the per-frame
    // work is pure arithmetic with zero intermediate allocations, keeping the
    // CPU cost flat at 50k nodes (issue #62).
    const cosYaw = Math.cos(cameraRef.current.yaw), sinYaw = Math.sin(cameraRef.current.yaw);
    const cosPitch = Math.cos(cameraRef.current.pitch), sinPitch = Math.sin(cameraRef.current.pitch);
    const zoomScale = scale * cameraRef.current.zoom;

    for (let k = 0; k < cachedValidIndexes.length; k++) {
      const i = cachedValidIndexes[k]!;
      const point = cachedPoints[k]!;
      const x = point.x * cosYaw + point.z * sinYaw;
      const rotatedDepth = -point.x * sinYaw + point.z * cosYaw;
      const y = point.y * cosPitch - rotatedDepth * sinPitch;
      const z = point.y * sinPitch + rotatedDepth * cosPitch;
      const perspective = 650 / Math.max(120, 650 + z * zoomScale);
      const node = nodes[i]!;
      screenX[i] = width / 2 + x * zoomScale * perspective;
      screenY[i] = height / 2 - y * zoomScale * perspective;
      screenRadius[i] = Math.max(1, node.type === "SOURCE" ? (isMemoryCoreLabel(node.label) ? 10 : 4.6) : 2.1) * zoomScale * perspective;
      screenValid[i] = 1;
    }
    gridDirty = true;
  };

  const hit = (x: number, y: number): string | null => {
    if (gridDirty) {
      grid = buildHitGrid(screenX, screenY, screenValid);
      gridDirty = false;
    }
    return hitTest(grid, nodes, screenX, screenY, screenRadius, screenValid, x, y);
  };

  const drawLabels = () => {
    const state = getState();
    const context = overlayContext;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (overlay.width !== Math.round(width * dpr)) {
      overlay.width = Math.max(1, Math.round(width * dpr));
      overlay.height = Math.max(1, Math.round(height * dpr));
    }
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    if (!state.showTitles) return;
    const focus = effectiveFocus();
    const boxes: Array<{ x: number; y: number; w: number }> = [];
    context.font = "11px system-ui, sans-serif";
    // LOD + hard cap: at most MAX_GRAPH_LABELS_PER_FRAME labels are measured
    // and drawn per frame, whatever the graph size (issue #62).
    const ordered = selectLabelNodes(nodes, screenValid, focus, cameraRef.current.zoom);
    for (const { node, index } of ordered) {
      const label = node.label.length > 48 ? `${node.label.slice(0, 45)}…` : node.label;
      const x = screenX[index]! + 9, y = screenY[index]!;
      const w = context.measureText(label).width;
      if (x + w > width || y < 14 || y > height - 5) continue;
      if (boxes.some((box) => Math.abs(box.y - y) < 16 && x < box.x + box.w + 5 && x + w + 5 > box.x)) continue;
      boxes.push({ x, y, w });
      context.fillStyle = "#09111bea";
      context.fillRect(x - 3, y - 11, w + 6, 16);
      context.fillStyle = isMemoryCoreLabel(node.label) ? "#fff0b0" : "#c6dfed";
      context.fillText(label, x, y + 1);
    }
  };

  return {
    render: () => {
      const extent = extentOf();
      width = canvas.getBoundingClientRect().width || width;
      height = canvas.getBoundingClientRect().height || height;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      renderer.resize(width, height, dpr, extent);
      if (focusDirty) applyFocus();
      renderer.render(cameraRef.current);
      projectScreen();
      // Parity with the Canvas 2D fallback: keep data-rotation fresh for tests.
      canvas.dataset.rotation = `${cameraRef.current.yaw.toFixed(3)},${cameraRef.current.pitch.toFixed(3)}`;
      drawLabels();
    },
    rebuild,
    hit,
    setFocus: (id: string | null) => {
      hoverFocus = id;
      focusDirty = true;
    },
    dispose: () => renderer.dispose()
  };
}