import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import type { MemoryCamera3D, MemoryPoint3D } from "./memory-3d.js";

/**
 * Pure WebGL2 building blocks for the 3D memory graph renderer.
 *
 * No DOM or WebGL context is touched here: shaders are strings, picking is
 * integer color coding, and label LOD is a pure ordering. The component in
 * MemoryGraph3D.tsx wires these to a real context.
 */

/** Upper bound on measured+drawn labels per frame, whatever the graph size. */
export const MAX_LABELS_3D = 160;

export const WEBGL_NODE_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;      // quad corner in [-1, 1]
layout(location = 1) in vec3 aPos;         // instance position (dynamic)
layout(location = 2) in vec2 aStyle;       // baseSize (highlight boost folded in), glow
layout(location = 3) in vec4 aColor;       // rgb, alpha
uniform float uYaw, uPitch, uZoom, uZoomSqrt, uScale, uWidth, uHeight, uDepthRange;
out vec2 vUv;
out vec4 vColor;
out float vGlow;
out float vPersp;
void main() {
  float cy = aPos.x * cos(uYaw) + aPos.z * sin(uYaw);
  float cdepth = -aPos.x * sin(uYaw) + aPos.z * cos(uYaw);
  float cyy = aPos.y * cos(uPitch) - cdepth * sin(uPitch);
  float cz = aPos.y * sin(uPitch) + cdepth * cos(uPitch);
  float persp = 650.0 / max(120.0, 650.0 + cz * uScale);
  vec2 centerPx = vec2(cy, cyy) * (uScale * uZoom * persp);
  vec2 ndc = centerPx / vec2(uWidth * 0.5, uHeight * 0.5);
  float radiusPx = max(1.0, aStyle.x * persp * uZoomSqrt);
  vec2 quadNdc = aCorner * vec2(radiusPx / (uWidth * 0.5), radiusPx / (uHeight * 0.5));
  gl_Position = vec4(ndc + quadNdc, clamp(cz / uDepthRange, -1.0, 1.0), 1.0);
  vUv = aCorner * 0.5 + 0.5;
  vColor = aColor;
  vGlow = aStyle.y;
  vPersp = persp;
}`;

export const WEBGL_NODE_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
in vec4 vColor;
in float vGlow;
in float vPersp;
out vec4 fragColor;
void main() {
  float d = length(vUv * 2.0 - 1.0);
  float disc = 1.0 - smoothstep(0.82, 1.0, d);
  float glow = (1.0 - smoothstep(0.55, 1.8, d)) * vGlow;
  vec3 col = vColor.rgb * disc + vColor.rgb * glow * 0.55;
  // vColor.a is the dim flag: 1 -> 0.2 alpha under focus, else perspective alpha.
  float alpha = vColor.a > 0.5 ? 0.2 : clamp(vPersp, 0.4, 1.0);
  float a = clamp(disc + glow * 0.6, 0.0, 1.0) * alpha;
  if (a < 0.012) discard;
  fragColor = vec4(col, a);
}`;

export const WEBGL_EDGE_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aColor;
uniform float uYaw, uPitch, uZoom, uScale, uWidth, uHeight, uDepthRange;
out vec3 vColor;
void main() {
  float cy = aPos.x * cos(uYaw) + aPos.z * sin(uYaw);
  float cdepth = -aPos.x * sin(uYaw) + aPos.z * cos(uYaw);
  float cyy = aPos.y * cos(uPitch) - cdepth * sin(uPitch);
  float cz = aPos.y * sin(uPitch) + cdepth * cos(uPitch);
  float persp = 650.0 / max(120.0, 650.0 + cz * uScale);
  vec2 centerPx = vec2(cy, cyy) * (uScale * uZoom * persp);
  vec2 ndc = centerPx / vec2(uWidth * 0.5, uHeight * 0.5);
  gl_Position = vec4(ndc, clamp(cz / uDepthRange, -1.0, 1.0), 1.0);
  vColor = aColor;
}`;

export const WEBGL_EDGE_FRAG = `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 fragColor;
void main() { fragColor = vec4(vColor, 1.0); }`;

export const WEBGL_PICK_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec3 aPos;
layout(location = 2) in vec2 aStyle;
uniform float uYaw, uPitch, uZoom, uZoomSqrt, uScale, uWidth, uHeight, uDepthRange;
out vec2 vUv;
out vec3 vId;
void main() {
  float cy = aPos.x * cos(uYaw) + aPos.z * sin(uYaw);
  float cdepth = -aPos.x * sin(uYaw) + aPos.z * cos(uYaw);
  float cyy = aPos.y * cos(uPitch) - cdepth * sin(uPitch);
  float cz = aPos.y * sin(uPitch) + cdepth * cos(uPitch);
  float persp = 650.0 / max(120.0, 650.0 + cz * uScale);
  vec2 centerPx = vec2(cy, cyy) * (uScale * uZoom * persp);
  vec2 ndc = centerPx / vec2(uWidth * 0.5, uHeight * 0.5);
  // Pick radius matches the Canvas hit test: max(7, radius + 3).
  float radiusPx = max(7.0, max(1.0, aStyle.x * persp * uZoomSqrt) + 3.0);
  vec2 quadNdc = aCorner * vec2(radiusPx / (uWidth * 0.5), radiusPx / (uHeight * 0.5));
  gl_Position = vec4(ndc + quadNdc, clamp(cz / uDepthRange, -1.0, 1.0), 1.0);
  float id = float(gl_InstanceID) + 1.0;
  vId = vec3(mod(id, 256.0), mod(floor(id / 256.0), 256.0), mod(floor(id / 65536.0), 256.0)) / 255.0;
  vUv = aCorner * 0.5 + 0.5;
}`;

export const WEBGL_PICK_FRAG = `#version 300 es
precision highp float;
in vec3 vId;
in vec2 vUv;
out vec4 fragColor;
void main() {
  float d = length(vUv * 2.0 - 1.0);
  if (d > 1.0) discard;
  fragColor = vec4(vId, 1.0);
}`;

/** Encode a 0-based instance index as 8-bit RGB (index+1, so 0 means background). */
export function encodePickColor(index: number): [number, number, number] {
  const id = index + 1;
  return [id & 0xff, (id >> 8) & 0xff, (id >> 16) & 0xff];
}

/** Decode a pick pixel back to a 0-based instance index, or null for background. */
export function decodePickColor(r: number, g: number, b: number): number | null {
  const id = r | (g << 8) | (b << 16);
  return id === 0 ? null : id - 1;
}

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex) ?? ["", "7395ad"];
  const v = parseInt(m[1]!, 16);
  return [((v >> 16) & 0xff) / 255, ((v >> 8) & 0xff) / 255, (v & 0xff) / 255];
}

/** Mirror of the Canvas 2D radius rule: root 10, SOURCE 4.6, else 2.1. */
export function nodeBaseSize(node: MemoryGraphNode): number {
  const root = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
  return root ? 10 : node.type === "SOURCE" ? 4.6 : 2.1;
}

export type NodeVisual = { size: number; r: number; g: number; b: number; dimmed: boolean; glow: number };

/**
 * Per-instance style for one frame. Mirrors the Canvas 2D look:
 * white + glow for the focused node, dim flag for non-neighbors under focus
 * (the shader turns it into 0.2 alpha), glow for core roots. The
 * perspective-driven alpha (0.4..1) is computed in-shader per frame.
 */
export function nodeVisual(
  node: MemoryGraphNode,
  colorHex: string,
  opts: { highlighted: boolean; dimmed: boolean; isCoreRoot: boolean }
): NodeVisual {
  const [r, g, b] = opts.highlighted ? [1, 1, 1] : hexToRgb(colorHex);
  return {
    size: nodeBaseSize(node) * (opts.highlighted ? 1.5 : 1),
    r, g, b,
    dimmed: opts.dimmed,
    glow: opts.highlighted || opts.isCoreRoot ? 1 : 0
  };
}

const EDGE_INCIDENT = "#98dafa";
const EDGE_DIMMED = "#14202b";
const EDGE_DERIVED = "#385068";
const EDGE_DEFAULT = "#203343";

/** Mirror of the Canvas 2D edge color rule. */
export function edgeColorHex(edge: MemoryGraphEdge, focus: string | null): string {
  const incident = focus !== null && (edge.source === focus || edge.target === focus);
  if (incident) return EDGE_INCIDENT;
  if (focus) return EDGE_DIMMED;
  return edge.type === "DERIVED_FROM" ? EDGE_DERIVED : EDGE_DEFAULT;
}

export type LabelCandidate = {
  id: string;
  label: string;
  type: MemoryGraphNode["type"];
  isCore: boolean;
  degree: number;
  x: number;
  y: number;
};

/**
 * Pure label LOD ordering. Keeps the current rules (focus and core labels
 * first, then sources; non-source labels hidden below 1.6x zoom unless
 * focused) and returns at most MAX_LABELS_3D candidates in draw priority.
 * The component measures text and applies collision avoidance.
 */
export function orderLabelCandidates(
  candidates: LabelCandidate[],
  opts: { showTitles: boolean; focusId: string | null; zoom: number }
): LabelCandidate[] {
  if (!opts.showTitles) return [];
  const filtered = candidates.filter(
    c => c.type === "SOURCE" || c.id === opts.focusId || opts.zoom >= 1.6
  );
  filtered.sort(
    (a, b) =>
      Number(b.id === opts.focusId) - Number(a.id === opts.focusId) ||
      Number(b.isCore) - Number(a.isCore) ||
      Number(b.type === "SOURCE") - Number(a.type === "SOURCE") ||
      b.degree - a.degree ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
  return filtered.slice(0, MAX_LABELS_3D);
}

export function truncateLabel(label: string): string {
  return label.length > 48 ? `${label.slice(0, 45)}…` : label;
}

/**
 * TypeScript mirror of the vertex-shader projection, for tests and for the
 * 2D label overlay. Must stay equivalent to WEBGL_NODE_VERT.
 */
export function projectToNdc(
  point: MemoryPoint3D,
  camera: MemoryCamera3D,
  scale: number,
  width: number,
  height: number
): { ndcX: number; ndcY: number; perspective: number; depthZ: number } {
  const cy = point.x * Math.cos(camera.yaw) + point.z * Math.sin(camera.yaw);
  const cdepth = -point.x * Math.sin(camera.yaw) + point.z * Math.cos(camera.yaw);
  const cyy = point.y * Math.cos(camera.pitch) - cdepth * Math.sin(camera.pitch);
  const cz = point.y * Math.sin(camera.pitch) + cdepth * Math.cos(camera.pitch);
  const perspective = 650 / Math.max(120, 650 + cz * scale);
  const s = scale * camera.zoom * perspective;
  return { ndcX: (cy * s) / (width / 2), ndcY: (cyy * s) / (height / 2), perspective, depthZ: cz };
}

/** Build the interleaved static instance buffer: [size, glow, r, g, b, dimFlag] per node. */
export function buildNodeStyleBuffer(
  nodes: MemoryGraphNode[],
  colorOf: (id: string) => string,
  focusId: string | null,
  neighbors: Set<string>
): Float32Array {
  const out = new Float32Array(nodes.length * 6);
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const highlighted = node.id === focusId;
    const visual = nodeVisual(node, colorOf(node.id), {
      highlighted,
      dimmed: focusId !== null && !highlighted && !neighbors.has(node.id),
      isCoreRoot: node.type === "SOURCE" && isMemoryCoreLabel(node.label)
    });
    out.set([visual.size, visual.glow, visual.r, visual.g, visual.b, visual.dimmed ? 1 : 0], i * 6);
  }
  return out;
}

/** Build edge line-segment buffers: positions (xyz xyz per edge) and rgb colors. */
export function buildEdgeBuffers(
  edges: MemoryGraphEdge[],
  indexOf: Map<string, number>,
  positions: Float32Array,
  focusId: string | null
): { positions: Float32Array; colors: Float32Array; count: number } {
  const pos: number[] = [];
  const col: number[] = [];
  let count = 0;
  for (const edge of edges) {
    const a = indexOf.get(edge.source);
    const b = indexOf.get(edge.target);
    if (a === undefined || b === undefined) continue;
    const [r, g, b2] = hexToRgb(edgeColorHex(edge, focusId));
    pos.push(positions[a * 3]!, positions[a * 3 + 1]!, positions[a * 3 + 2]!);
    pos.push(positions[b * 3]!, positions[b * 3 + 1]!, positions[b * 3 + 2]!);
    col.push(r, g, b2, r, g, b2);
    count++;
  }
  return { positions: new Float32Array(pos), colors: new Float32Array(col), count };
}
