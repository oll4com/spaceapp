import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import { type MemoryCamera3D, type MemoryPoint3D } from "./memory-3d.js";

export const MAX_LABEL_BUDGET = 32;
export const CANVAS_FALLBACK_NODE_LIMIT = 2000;

export interface ProjectedPoint {
  id: string;
  x: number;
  y: number;
  z: number;
  perspective: number;
  radius: number;
}

/**
 * Screen-space spatial hash grid using flat typed arrays.
 * Zero-allocation during pointer queries; non-linear O(1) lookup.
 */
export class SpatialPickingIndex {
  private count = 0;
  private width = 1;
  private height = 1;
  private cellSize = 32;
  private cols = 1;
  private rows = 1;

  // Parallel typed arrays for projected nodes
  public screenX = new Float32Array(0);
  public screenY = new Float32Array(0);
  public screenZ = new Float32Array(0);
  public radii = new Float32Array(0);
  public nodeIds: string[] = [];

  // Flat spatial grid (linked list via head & next pointers)
  private head = new Int32Array(0);
  private next = new Int32Array(0);

  /**
   * Pre-allocates flat typed array capacity for n nodes.
   */
  public ensureCapacity(capacity: number) {
    if (this.screenX.length < capacity) {
      this.screenX = new Float32Array(capacity);
      this.screenY = new Float32Array(capacity);
      this.screenZ = new Float32Array(capacity);
      this.radii = new Float32Array(capacity);
      this.next = new Int32Array(capacity);
    }
  }

  /**
   * Rebuilds spatial hash index from current 3D node coordinates and camera.
   */
  public rebuild(
    nodes: MemoryGraphNode[],
    coordinates: Map<string, MemoryPoint3D>,
    camera: MemoryCamera3D,
    scale: number,
    width: number,
    height: number,
    focusId: string | null
  ) {
    this.count = nodes.length;
    this.width = width;
    this.height = height;
    this.ensureCapacity(this.count);

    const cols = Math.max(1, Math.ceil(width / this.cellSize) + 1);
    const rows = Math.max(1, Math.ceil(height / this.cellSize) + 1);
    const totalCells = cols * rows;

    if (this.head.length < totalCells) {
      this.head = new Int32Array(totalCells);
    }
    this.cols = cols;
    this.rows = rows;
    this.head.fill(-1, 0, totalCells);
    this.nodeIds = new Array(this.count);

    const cosYaw = Math.cos(camera.yaw);
    const sinYaw = Math.sin(camera.yaw);
    const cosPitch = Math.cos(camera.pitch);
    const sinPitch = Math.sin(camera.pitch);
    const halfW = width * 0.5;
    const halfH = height * 0.5;
    const zoomSqrt = Math.sqrt(camera.zoom);

    for (let i = 0; i < this.count; i++) {
      const node = nodes[i]!;
      this.nodeIds[i] = node.id;
      const coord = coordinates.get(node.id);
      if (!coord) {
        this.screenX[i] = -99999;
        this.screenY[i] = -99999;
        continue;
      }

      // Fast inlined projection
      const rx = coord.x * cosYaw + coord.z * sinYaw;
      const depth = -coord.x * sinYaw + coord.z * cosYaw;
      const ry = coord.y * cosPitch - depth * sinPitch;
      const rz = coord.y * sinPitch + depth * cosPitch;
      const perspective = 650 / Math.max(120, 650 + rz * scale);

      const sx = halfW + rx * scale * camera.zoom * perspective;
      const sy = halfH - ry * scale * camera.zoom * perspective;

      const root = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
      const highlighted = node.id === focusId;
      const baseRadius = root ? 10 : node.type === "SOURCE" ? 4.6 : 2.1;
      const radius = Math.max(1, baseRadius * perspective * zoomSqrt) * (highlighted ? 1.5 : 1);

      this.screenX[i] = sx;
      this.screenY[i] = sy;
      this.screenZ[i] = rz;
      this.radii[i] = radius;

      const cx = Math.floor(sx / this.cellSize);
      const cy = Math.floor(sy / this.cellSize);
      if (cx >= 0 && cx < cols && cy >= 0 && cy < rows) {
        const cell = cy * cols + cx;
        this.next[i] = this.head[cell]!;
        this.head[cell] = i;
      }
    }
  }

  /**
   * Queries screen-space (px, py) for the closest node under pointer within hit threshold.
   * Runs in O(1) time without allocations.
   */
  public query(px: number, py: number): string | null {
    if (this.count === 0) return null;
    const cols = this.cols;
    const rows = this.rows;
    const cx = Math.floor(px / this.cellSize);
    const cy = Math.floor(py / this.cellSize);

    let bestId: string | null = null;
    let bestDistSq = Infinity;
    let bestZ = Infinity; // Prefer closest node along view ray

    const minCx = Math.max(0, cx - 1);
    const maxCx = Math.min(cols - 1, cx + 1);
    const minCy = Math.max(0, cy - 1);
    const maxCy = Math.min(rows - 1, cy + 1);

    for (let y = minCy; y <= maxCy; y++) {
      for (let x = minCx; x <= maxCx; x++) {
        let idx = this.head[y * cols + x]!;
        while (idx !== -1) {
          const sx = this.screenX[idx]!;
          const sy = this.screenY[idx]!;
          const dx = sx - px;
          const dy = sy - py;
          const distSq = dx * dx + dy * dy;
          const hitRadius = Math.max(7, this.radii[idx]! + 3);

          if (distSq <= hitRadius * hitRadius) {
            const z = this.screenZ[idx]!;
            // If overlapping, pick the one closer to the camera (lower z)
            if (distSq < bestDistSq || (Math.abs(distSq - bestDistSq) < 4 && z < bestZ)) {
              bestDistSq = distSq;
              bestZ = z;
              bestId = this.nodeIds[idx]!;
            }
          }
          idx = this.next[idx]!;
        }
      }
    }
    return bestId;
  }
}

export interface SelectedLabel {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  isCore: boolean;
}

/**
 * Hard-budgeted label selector with spatial collision avoidance.
 * Upper-bounded to MAX_LABEL_BUDGET per frame.
 */
export function selectBoundedLabels(
  nodes: MemoryGraphNode[],
  spatial: SpatialPickingIndex,
  focusId: string | null,
  zoom: number,
  width: number,
  height: number,
  measureText: (text: string) => number,
  budget = MAX_LABEL_BUDGET
): SelectedLabel[] {
  if (nodes.length === 0 || spatial.nodeIds.length === 0) return [];

  // Gather priority candidates
  interface LabelCandidate {
    node: MemoryGraphNode;
    index: number;
    score: number;
    isCore: boolean;
    isFocused: boolean;
  }

  const candidates: LabelCandidate[] = [];
  const count = Math.min(nodes.length, spatial.nodeIds.length);

  for (let i = 0; i < count; i++) {
    const node = nodes[i]!;
    const sx = spatial.screenX[i]!;
    const sy = spatial.screenY[i]!;

    // Viewport frustum culling
    if (sx < -40 || sx > width + 40 || sy < -20 || sy > height + 20) continue;

    const isCore = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
    const isFocused = node.id === focusId;
    const isSource = node.type === "SOURCE";

    // Skip non-sources if not zoomed in and not focused
    if (!isCore && !isFocused && !isSource && zoom < 1.6) continue;

    // Priority scoring
    let score = 0;
    if (isFocused) score += 10000;
    if (isCore) score += 5000;
    if (isSource) score += 1000;
    score += (1000 - spatial.screenZ[i]!); // Closer to camera

    candidates.push({ node, index: i, score, isCore, isFocused });
  }

  // Sort descending by priority score
  candidates.sort((a, b) => b.score - a.score);

  const labelBoxes: SelectedLabel[] = [];

  for (let c = 0; c < candidates.length && labelBoxes.length < budget; c++) {
    const cand = candidates[c]!;
    const node = cand.node;
    const i = cand.index;
    const sx = spatial.screenX[i]!;
    const sy = spatial.screenY[i]!;

    const rawLabel = node.label.length > 48 ? `${node.label.slice(0, 45)}…` : node.label;
    const w = measureText(rawLabel);
    const x = sx + 9;
    const y = sy;

    // Boundary check
    if (x + w > width || y < 14 || y > height - 5) continue;

    // Collision detection against placed boxes
    let collides = false;
    for (let b = 0; b < labelBoxes.length; b++) {
      const box = labelBoxes[b]!;
      if (Math.abs(box.y - y) < 16 && x < box.x + box.w + 5 && x + w + 5 > box.x) {
        collides = true;
        break;
      }
    }
    if (collides && node.id !== focusId) continue;

    labelBoxes.push({
      id: node.id,
      label: rawLabel,
      x,
      y,
      w,
      isCore: isMemoryCoreLabel(node.label)
    });
  }

  return labelBoxes;
}

export function parseHexRgb(hex: string): [number, number, number] {
  let clean = hex.startsWith("#") ? hex.slice(1) : hex;
  if (clean.length === 3) {
    clean = clean[0]! + clean[0]! + clean[1]! + clean[1]! + clean[2]! + clean[2]!;
  }
  const val = parseInt(clean, 16);
  if (Number.isNaN(val)) return [0.45, 0.58, 0.68];
  return [((val >> 16) & 255) / 255, ((val >> 8) & 255) / 255, (val & 255) / 255];
}

const NODE_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec3 a_position;
layout(location = 2) in vec4 a_color;
layout(location = 3) in float a_radius;
layout(location = 4) in float a_flags;

uniform vec2 u_resolution;
uniform vec3 u_camera; // yaw, pitch, zoom
uniform float u_scale;
uniform float u_dim;

out vec4 v_color;
out vec2 v_uv;
out float v_flags;

void main() {
  float yaw = u_camera.x;
  float pitch = u_camera.y;
  float zoom = u_camera.z;

  float cosY = cos(yaw);
  float sinY = sin(yaw);
  float cosP = cos(pitch);
  float sinP = sin(pitch);

  float rx = a_position.x * cosY + a_position.z * sinY;
  float depth = -a_position.x * sinY + a_position.z * cosY;
  float ry = a_position.y * cosP - depth * sinP;
  float rz = a_position.y * sinP + depth * cosP;

  float perspective = 650.0 / max(120.0, 650.0 + rz * u_scale);
  float sx = rx * u_scale * zoom * perspective;
  float sy = ry * u_scale * zoom * perspective;

  float radius = max(1.0, a_radius * perspective * sqrt(zoom)) * (a_flags > 0.5 && a_flags < 1.5 ? 1.5 : 1.0);
  float quadPadding = (a_flags > 1.5) ? 6.0 : 2.5;
  float quadSize = radius + quadPadding;

  vec2 screenPos = vec2(u_resolution.x * 0.5 + sx, u_resolution.y * 0.5 - sy) + a_corner * quadSize;
  vec2 ndc = (screenPos / u_resolution) * 2.0 - 1.0;
  ndc.y = -ndc.y;

  // Linear depth mapped into [0.001, 0.999]
  float ndcZ = clamp((rz + 1500.0) / 3000.0, 0.001, 0.999);
  gl_Position = vec4(ndc, ndcZ, 1.0);

  v_color = vec4(a_color.rgb, a_color.a * u_dim);
  v_uv = a_corner * (quadSize / radius);
  v_flags = a_flags;
}
`;

const NODE_FS = `#version 300 es
precision highp float;
in vec4 v_color;
in vec2 v_uv;
in float v_flags;
out vec4 fragColor;

void main() {
  float dist = length(v_uv);
  if (dist > 1.4) discard;

  float delta = fwidth(dist);
  float circleAlpha = 1.0 - smoothstep(1.0 - delta, 1.0 + delta, dist);

  vec4 col = v_color;
  // Root or highlighted outer halo
  if (v_flags > 0.5) {
    float haloAlpha = smoothstep(1.4, 0.8, dist) * 0.45;
    col.rgb += vec3(haloAlpha);
    circleAlpha = max(circleAlpha, haloAlpha);
  }

  if (circleAlpha <= 0.01) discard;
  fragColor = vec4(col.rgb, col.a * circleAlpha);
}
`;

const EDGE_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec4 a_color;

uniform vec2 u_resolution;
uniform vec3 u_camera;
uniform float u_scale;
uniform float u_dim;

out vec4 v_color;

void main() {
  float yaw = u_camera.x;
  float pitch = u_camera.y;
  float zoom = u_camera.z;

  float cosY = cos(yaw);
  float sinY = sin(yaw);
  float cosP = cos(pitch);
  float sinP = sin(pitch);

  float rx = a_position.x * cosY + a_position.z * sinY;
  float depth = -a_position.x * sinY + a_position.z * cosY;
  float ry = a_position.y * cosP - depth * sinP;
  float rz = a_position.y * sinP + depth * cosP;

  float perspective = 650.0 / max(120.0, 650.0 + rz * u_scale);
  float sx = rx * u_scale * zoom * perspective;
  float sy = ry * u_scale * zoom * perspective;

  vec2 screenPos = vec2(u_resolution.x * 0.5 + sx, u_resolution.y * 0.5 - sy);
  vec2 ndc = (screenPos / u_resolution) * 2.0 - 1.0;
  ndc.y = -ndc.y;

  float ndcZ = clamp((rz + 1500.0) / 3000.0, 0.001, 0.999);
  gl_Position = vec4(ndc, ndcZ, 1.0);
  v_color = vec4(a_color.rgb, a_color.a * u_dim);
}
`;

const EDGE_FS = `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 fragColor;
void main() {
  fragColor = v_color;
}
`;

function createShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error(gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram | null {
  const vs = createShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = createShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  if (!vs || !fs) return null;

  const prog = gl.createProgram();
  if (!prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error(gl.getProgramInfoLog(prog));
    gl.deleteProgram(prog);
    return null;
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return prog;
}

/**
 * High-performance vanilla WebGL2 renderer for 50,000 nodes.
 * Features instanced billboard quads, batched line rendering, and GPU depth testing.
 * Separates immutable static geometry buffers from lightweight dynamic highlight passes.
 */
export class MemoryWebGL2Renderer {
  private gl: WebGL2RenderingContext;
  private nodeProgram: WebGLProgram | null = null;
  private edgeProgram: WebGLProgram | null = null;

  // Static geometry buffers
  private quadVao: WebGLVertexArrayObject | null = null;
  private quadVbo: WebGLBuffer | null = null;
  private nodeInstanceVbo: WebGLBuffer | null = null;

  private edgeVao: WebGLVertexArrayObject | null = null;
  private edgeVbo: WebGLBuffer | null = null;

  private nodeCount = 0;
  private edgeVertexCount = 0;

  // Dynamic highlight pass buffers (for instant hover without 50k buffer rebuild)
  private highlightQuadVao: WebGLVertexArrayObject | null = null;
  private highlightNodeVbo: WebGLBuffer | null = null;
  private highlightEdgeVao: WebGLVertexArrayObject | null = null;
  private highlightEdgeVbo: WebGLBuffer | null = null;

  private highlightNodeCount = 0;
  private highlightEdgeVertexCount = 0;

  private highlightNodeData = new Float32Array(0);
  private highlightEdgeData = new Float32Array(0);

  // Staged typed arrays for base node data: [x, y, z, r, g, b, a, radius, flags] (9 floats per node)
  private nodeData = new Float32Array(0);
  // Staged typed arrays for edge lines: [x, y, z, r, g, b, a] (7 floats per vertex, 2 vertices per edge)
  private edgeData = new Float32Array(0);

  // Topology and coordinate cache for microsecond focus queries
  private incidentEdges = new Map<string, MemoryGraphEdge[]>();
  private nodeById = new Map<string, MemoryGraphNode>();
  private coordsById: Map<string, MemoryPoint3D> = new Map();
  private colorsById = new Map<string, [number, number, number]>();
  private focusId: string | null = null;

  // Cached uniform locations
  private nodeUniforms = {
    resolution: null as WebGLUniformLocation | null,
    camera: null as WebGLUniformLocation | null,
    scale: null as WebGLUniformLocation | null,
    dim: null as WebGLUniformLocation | null
  };
  private edgeUniforms = {
    resolution: null as WebGLUniformLocation | null,
    camera: null as WebGLUniformLocation | null,
    scale: null as WebGLUniformLocation | null,
    dim: null as WebGLUniformLocation | null
  };

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.init();
  }

  private init() {
    const gl = this.gl;
    this.nodeProgram = createProgram(gl, NODE_VS, NODE_FS);
    this.edgeProgram = createProgram(gl, EDGE_VS, EDGE_FS);
    if (!this.nodeProgram || !this.edgeProgram) return;

    this.nodeUniforms.resolution = gl.getUniformLocation(this.nodeProgram, "u_resolution");
    this.nodeUniforms.camera = gl.getUniformLocation(this.nodeProgram, "u_camera");
    this.nodeUniforms.scale = gl.getUniformLocation(this.nodeProgram, "u_scale");
    this.nodeUniforms.dim = gl.getUniformLocation(this.nodeProgram, "u_dim");

    this.edgeUniforms.resolution = gl.getUniformLocation(this.edgeProgram, "u_resolution");
    this.edgeUniforms.camera = gl.getUniformLocation(this.edgeProgram, "u_camera");
    this.edgeUniforms.scale = gl.getUniformLocation(this.edgeProgram, "u_scale");
    this.edgeUniforms.dim = gl.getUniformLocation(this.edgeProgram, "u_dim");

    // Static unit quad for instanced billboards: 2 triangles (6 vertices)
    const quadVertices = new Float32Array([
      -1, -1,
       1, -1,
      -1,  1,
      -1,  1,
       1, -1,
       1,  1
    ]);

    this.quadVao = gl.createVertexArray();
    gl.bindVertexArray(this.quadVao);

    this.quadVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
    gl.bufferData(gl.ARRAY_BUFFER, quadVertices, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.nodeInstanceVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeInstanceVbo);
    const stride = 9 * 4; // 9 floats: vec3 pos (12), vec4 col (16), float radius (4), float flags (4)
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);

    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 12);
    gl.vertexAttribDivisor(2, 1);

    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 28);
    gl.vertexAttribDivisor(3, 1);

    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, 32);
    gl.vertexAttribDivisor(4, 1);

    // Edge lines VAO
    this.edgeVao = gl.createVertexArray();
    gl.bindVertexArray(this.edgeVao);
    this.edgeVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeVbo);
    const edgeStride = 7 * 4; // vec3 pos (12), vec4 col (16)
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, edgeStride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, edgeStride, 12);

    // Highlight Quad VAO (shares quadVbo corner coordinates)
    this.highlightQuadVao = gl.createVertexArray();
    gl.bindVertexArray(this.highlightQuadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.highlightNodeVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.highlightNodeVbo);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);

    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 12);
    gl.vertexAttribDivisor(2, 1);

    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 28);
    gl.vertexAttribDivisor(3, 1);

    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, 32);
    gl.vertexAttribDivisor(4, 1);

    // Highlight Edges VAO
    this.highlightEdgeVao = gl.createVertexArray();
    gl.bindVertexArray(this.highlightEdgeVao);
    this.highlightEdgeVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.highlightEdgeVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, edgeStride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, edgeStride, 12);

    gl.bindVertexArray(null);
  }

  /**
   * Uploads base static graph geometry (nodes, edges, positions, coordinates).
   * Called only when topology or layout coordinates change.
   */
  public updateGraph(
    nodes: MemoryGraphNode[],
    edges: MemoryGraphEdge[],
    coordinates: Map<string, MemoryPoint3D>,
    positions: Map<string, MemoryAtlasPosition>
  ) {
    const gl = this.gl;
    this.nodeCount = nodes.length;
    const nodeFloats = this.nodeCount * 9;
    if (this.nodeData.length < nodeFloats) {
      this.nodeData = new Float32Array(nodeFloats);
    }

    // Cache topology and coordinates
    this.nodeById.clear();
    this.coordsById = coordinates;
    this.colorsById.clear();
    this.incidentEdges.clear();

    for (let i = 0; i < this.nodeCount; i++) {
      const node = nodes[i]!;
      this.nodeById.set(node.id, node);
      const hex = positions.get(node.id)?.color ?? "#7395ad";
      this.colorsById.set(node.id, parseHexRgb(hex));
    }

    for (let i = 0; i < edges.length; i++) {
      const edge = edges[i]!;
      let s = this.incidentEdges.get(edge.source);
      if (!s) { s = []; this.incidentEdges.set(edge.source, s); }
      s.push(edge);

      let t = this.incidentEdges.get(edge.target);
      if (!t) { t = []; this.incidentEdges.set(edge.target, t); }
      t.push(edge);
    }

    let offset = 0;
    for (let i = 0; i < this.nodeCount; i++) {
      const node = nodes[i]!;
      const coord = coordinates.get(node.id) ?? { x: 0, y: 0, z: 0 };
      const isRoot = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
      const rgb = this.colorsById.get(node.id) ?? [0.45, 0.58, 0.68];
      const baseRadius = isRoot ? 10 : node.type === "SOURCE" ? 4.6 : 2.1;
      const flags = isRoot ? 2.0 : 0.0;

      this.nodeData[offset++] = coord.x;
      this.nodeData[offset++] = coord.y;
      this.nodeData[offset++] = coord.z;
      this.nodeData[offset++] = rgb[0];
      this.nodeData[offset++] = rgb[1];
      this.nodeData[offset++] = rgb[2];
      this.nodeData[offset++] = 1.0;
      this.nodeData[offset++] = baseRadius;
      this.nodeData[offset++] = flags;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeInstanceVbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.nodeData.subarray(0, nodeFloats), gl.STATIC_DRAW);

    // Static Edges
    const maxEdgeFloats = edges.length * 14;
    if (this.edgeData.length < maxEdgeFloats) {
      this.edgeData = new Float32Array(maxEdgeFloats);
    }

    let edgeOffset = 0;
    for (let i = 0; i < edges.length; i++) {
      const edge = edges[i]!;
      const a = coordinates.get(edge.source);
      const b = coordinates.get(edge.target);
      if (!a || !b) continue;

      let er = 0.125, eg = 0.20, eb = 0.26, ea = 0.6; // #203343
      if (edge.type === "DERIVED_FROM") {
        er = 0.220; eg = 0.314; eb = 0.408; ea = 0.7; // #385068
      }

      // Vertex A
      this.edgeData[edgeOffset++] = a.x;
      this.edgeData[edgeOffset++] = a.y;
      this.edgeData[edgeOffset++] = a.z;
      this.edgeData[edgeOffset++] = er;
      this.edgeData[edgeOffset++] = eg;
      this.edgeData[edgeOffset++] = eb;
      this.edgeData[edgeOffset++] = ea;

      // Vertex B
      this.edgeData[edgeOffset++] = b.x;
      this.edgeData[edgeOffset++] = b.y;
      this.edgeData[edgeOffset++] = b.z;
      this.edgeData[edgeOffset++] = er;
      this.edgeData[edgeOffset++] = eg;
      this.edgeData[edgeOffset++] = eb;
      this.edgeData[edgeOffset++] = ea;
    }

    // Phase 8 fix: derive vertex count strictly from vertices actually written
    this.edgeVertexCount = edgeOffset / 7;

    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeVbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.edgeData.subarray(0, edgeOffset), gl.STATIC_DRAW);
  }

  /**
   * Updates pointer hover/focus selection without rebuilding 50k static geometry.
   * Runs in microseconds by updating only incident edges and neighbors in dedicated highlight buffers.
   */
  public setFocus(focusId: string | null) {
    if (this.focusId === focusId) return;
    this.focusId = focusId;
    const gl = this.gl;

    if (!focusId) {
      this.highlightEdgeVertexCount = 0;
      this.highlightNodeCount = 0;
      return;
    }

    // 1. Collect incident edges and neighbor IDs
    const incEdges = this.incidentEdges.get(focusId) ?? [];
    const neighborIds = new Set<string>();
    for (const e of incEdges) {
      if (e.source !== focusId) neighborIds.add(e.source);
      if (e.target !== focusId) neighborIds.add(e.target);
    }

    // 2. Populate highlight edges (bright cyan #98dafa)
    const edgeFloats = incEdges.length * 14;
    if (this.highlightEdgeData.length < edgeFloats) {
      this.highlightEdgeData = new Float32Array(Math.max(edgeFloats, 256));
    }

    let edgeOffset = 0;
    for (const edge of incEdges) {
      const a = this.coordsById.get(edge.source);
      const b = this.coordsById.get(edge.target);
      if (!a || !b) continue;

      const er = 0.596, eg = 0.855, eb = 0.980, ea = 1.0; // #98dafa
      this.highlightEdgeData[edgeOffset++] = a.x;
      this.highlightEdgeData[edgeOffset++] = a.y;
      this.highlightEdgeData[edgeOffset++] = a.z;
      this.highlightEdgeData[edgeOffset++] = er;
      this.highlightEdgeData[edgeOffset++] = eg;
      this.highlightEdgeData[edgeOffset++] = eb;
      this.highlightEdgeData[edgeOffset++] = ea;

      this.highlightEdgeData[edgeOffset++] = b.x;
      this.highlightEdgeData[edgeOffset++] = b.y;
      this.highlightEdgeData[edgeOffset++] = b.z;
      this.highlightEdgeData[edgeOffset++] = er;
      this.highlightEdgeData[edgeOffset++] = eg;
      this.highlightEdgeData[edgeOffset++] = eb;
      this.highlightEdgeData[edgeOffset++] = ea;
    }
    this.highlightEdgeVertexCount = edgeOffset / 7;
    if (edgeOffset > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.highlightEdgeVbo);
      gl.bufferData(gl.ARRAY_BUFFER, this.highlightEdgeData.subarray(0, edgeOffset), gl.DYNAMIC_DRAW);
    }

    // 3. Populate highlight nodes (focused node + neighbors)
    const totalHighlightNodes = 1 + neighborIds.size;
    const nodeFloats = totalHighlightNodes * 9;
    if (this.highlightNodeData.length < nodeFloats) {
      this.highlightNodeData = new Float32Array(Math.max(nodeFloats, 256));
    }

    let nodeOffset = 0;
    // Add focused node (white, halo flag = 1.0, scaled)
    const focusedNode = this.nodeById.get(focusId);
    if (focusedNode) {
      const coord = this.coordsById.get(focusId) ?? { x: 0, y: 0, z: 0 };
      const isRoot = focusedNode.type === "SOURCE" && isMemoryCoreLabel(focusedNode.label);
      const baseRadius = isRoot ? 10 : focusedNode.type === "SOURCE" ? 4.6 : 2.1;

      this.highlightNodeData[nodeOffset++] = coord.x;
      this.highlightNodeData[nodeOffset++] = coord.y;
      this.highlightNodeData[nodeOffset++] = coord.z;
      this.highlightNodeData[nodeOffset++] = 1.0;
      this.highlightNodeData[nodeOffset++] = 1.0;
      this.highlightNodeData[nodeOffset++] = 1.0;
      this.highlightNodeData[nodeOffset++] = 1.0;
      this.highlightNodeData[nodeOffset++] = baseRadius;
      this.highlightNodeData[nodeOffset++] = 1.0; // flag 1.0 = focused halo
    }

    // Add neighbor nodes (full saturation/alpha)
    for (const nId of neighborIds) {
      const nNode = this.nodeById.get(nId);
      if (!nNode) continue;
      const coord = this.coordsById.get(nId) ?? { x: 0, y: 0, z: 0 };
      const isRoot = nNode.type === "SOURCE" && isMemoryCoreLabel(nNode.label);
      const rgb = this.colorsById.get(nId) ?? [0.45, 0.58, 0.68];
      const baseRadius = isRoot ? 10 : nNode.type === "SOURCE" ? 4.6 : 2.1;

      this.highlightNodeData[nodeOffset++] = coord.x;
      this.highlightNodeData[nodeOffset++] = coord.y;
      this.highlightNodeData[nodeOffset++] = coord.z;
      this.highlightNodeData[nodeOffset++] = rgb[0];
      this.highlightNodeData[nodeOffset++] = rgb[1];
      this.highlightNodeData[nodeOffset++] = rgb[2];
      this.highlightNodeData[nodeOffset++] = 1.0;
      this.highlightNodeData[nodeOffset++] = baseRadius;
      this.highlightNodeData[nodeOffset++] = isRoot ? 2.0 : 0.0;
    }

    this.highlightNodeCount = nodeOffset / 9;
    if (nodeOffset > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.highlightNodeVbo);
      gl.bufferData(gl.ARRAY_BUFFER, this.highlightNodeData.subarray(0, nodeOffset), gl.DYNAMIC_DRAW);
    }
  }

  /**
   * Compatibility method: updates both base graph geometry and focus state.
   */
  public updateBuffers(
    nodes: MemoryGraphNode[],
    edges: MemoryGraphEdge[],
    coordinates: Map<string, MemoryPoint3D>,
    positions: Map<string, MemoryAtlasPosition>,
    focusId: string | null
  ) {
    this.updateGraph(nodes, edges, coordinates, positions);
    this.setFocus(focusId);
  }

  /**
   * Executes the WebGL2 render pass with camera transformations and GPU depth testing.
   */
  public render(width: number, height: number, camera: MemoryCamera3D, scale: number) {
    const gl = this.gl;
    if (!this.nodeProgram || !this.edgeProgram) return;

    gl.viewport(0, 0, width, height);
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clearDepth(1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const hasFocus = Boolean(this.focusId);
    const baseDim = hasFocus ? 0.25 : 1.0;

    // 1. Draw Base Edges
    if (this.edgeVertexCount > 0) {
      gl.useProgram(this.edgeProgram);
      gl.uniform2f(this.edgeUniforms.resolution, width, height);
      gl.uniform3f(this.edgeUniforms.camera, camera.yaw, camera.pitch, camera.zoom);
      gl.uniform1f(this.edgeUniforms.scale, scale);
      gl.uniform1f(this.edgeUniforms.dim, baseDim);

      gl.bindVertexArray(this.edgeVao);
      gl.drawArrays(gl.LINES, 0, this.edgeVertexCount);
    }

    // 2. Draw Base Nodes (Instanced Quads)
    if (this.nodeCount > 0) {
      gl.useProgram(this.nodeProgram);
      gl.uniform2f(this.nodeUniforms.resolution, width, height);
      gl.uniform3f(this.nodeUniforms.camera, camera.yaw, camera.pitch, camera.zoom);
      gl.uniform1f(this.nodeUniforms.scale, scale);
      gl.uniform1f(this.nodeUniforms.dim, baseDim);

      gl.bindVertexArray(this.quadVao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.nodeCount);
    }

    // 3. Highlight Pass (Incident edges and focused node/neighbors)
    if (hasFocus) {
      if (this.highlightEdgeVertexCount > 0) {
        gl.useProgram(this.edgeProgram);
        gl.uniform2f(this.edgeUniforms.resolution, width, height);
        gl.uniform3f(this.edgeUniforms.camera, camera.yaw, camera.pitch, camera.zoom);
        gl.uniform1f(this.edgeUniforms.scale, scale);
        gl.uniform1f(this.edgeUniforms.dim, 1.0);

        gl.bindVertexArray(this.highlightEdgeVao);
        gl.drawArrays(gl.LINES, 0, this.highlightEdgeVertexCount);
      }

      if (this.highlightNodeCount > 0) {
        gl.useProgram(this.nodeProgram);
        gl.uniform2f(this.nodeUniforms.resolution, width, height);
        gl.uniform3f(this.nodeUniforms.camera, camera.yaw, camera.pitch, camera.zoom);
        gl.uniform1f(this.nodeUniforms.scale, scale);
        gl.uniform1f(this.nodeUniforms.dim, 1.0);

        gl.bindVertexArray(this.highlightQuadVao);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.highlightNodeCount);
      }
    }

    gl.bindVertexArray(null);
  }

  /**
   * Releases WebGL GPU resources (VAOs, buffers, and shader programs).
   */
  public destroy() {
    const gl = this.gl;
    if (this.quadVao) gl.deleteVertexArray(this.quadVao);
    if (this.quadVbo) gl.deleteBuffer(this.quadVbo);
    if (this.nodeInstanceVbo) gl.deleteBuffer(this.nodeInstanceVbo);
    if (this.edgeVao) gl.deleteVertexArray(this.edgeVao);
    if (this.edgeVbo) gl.deleteBuffer(this.edgeVbo);
    if (this.highlightQuadVao) gl.deleteVertexArray(this.highlightQuadVao);
    if (this.highlightNodeVbo) gl.deleteBuffer(this.highlightNodeVbo);
    if (this.highlightEdgeVao) gl.deleteVertexArray(this.highlightEdgeVao);
    if (this.highlightEdgeVbo) gl.deleteBuffer(this.highlightEdgeVbo);
    if (this.nodeProgram) gl.deleteProgram(this.nodeProgram);
    if (this.edgeProgram) gl.deleteProgram(this.edgeProgram);
  }
}
