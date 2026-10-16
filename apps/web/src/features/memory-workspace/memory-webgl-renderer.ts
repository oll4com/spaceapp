import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import { projectMemoryPoint, type MemoryCamera3D, type MemoryPoint3D } from "./memory-3d.js";

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

  public ensureCapacity(capacity: number) {
    if (this.screenX.length < capacity) {
      this.screenX = new Float32Array(capacity);
      this.screenY = new Float32Array(capacity);
      this.screenZ = new Float32Array(capacity);
      this.radii = new Float32Array(capacity);
      this.next = new Int32Array(capacity);
    }
  }

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
      } else {
        this.next[i] = -1;
      }
    }
  }

  /**
   * Non-linear O(1) bounded spatial lookup around cursor.
   * Examines at most a 3x3 cell neighborhood.
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
  // Priority: 1. Focused node, 2. Root/Core nodes, 3. Source nodes, 4. Memory nodes (if zoomed)
  const candidateIndices: number[] = [];
  let focusIdx = -1;

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    if (node.id === focusId) {
      focusIdx = i;
      continue;
    }
    const isCore = isMemoryCoreLabel(node.label);
    const isSource = node.type === "SOURCE";
    if (isCore || isSource || (zoom >= 1.6 && candidateIndices.length < budget * 3)) {
      candidateIndices.push(i);
    }
  }

  // Sort candidate indices by priority: core first, then by depth (closer to camera)
  candidateIndices.sort((a, b) => {
    const coreA = Number(isMemoryCoreLabel(nodes[a]!.label));
    const coreB = Number(isMemoryCoreLabel(nodes[b]!.label));
    if (coreA !== coreB) return coreB - coreA;
    const srcA = Number(nodes[a]!.type === "SOURCE");
    const srcB = Number(nodes[b]!.type === "SOURCE");
    if (srcA !== srcB) return srcB - srcA;
    return spatial.screenZ[a]! - spatial.screenZ[b]!;
  });

  const orderedIndices = focusIdx >= 0 ? [focusIdx, ...candidateIndices] : candidateIndices;
  const labelBoxes: SelectedLabel[] = [];

  for (const idx of orderedIndices) {
    if (labelBoxes.length >= budget) break;

    const node = nodes[idx]!;
    const sx = spatial.screenX[idx]!;
    const sy = spatial.screenY[idx]!;
    if (sx < -50 || sx > width + 50 || sy < 10 || sy > height + 10) continue;

    const rawLabel = node.label.length > 48 ? `${node.label.slice(0, 45)}…` : node.label;
    const w = measureText(rawLabel);
    const x = sx + 9;
    const y = sy;

    // Bounds check
    if (x + w > width || y < 14 || y > height - 5) continue;

    // Collision check against placed boxes
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

  v_color = a_color;
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
  v_color = a_color;
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
 */
export class MemoryWebGL2Renderer {
  private gl: WebGL2RenderingContext;
  private nodeProgram: WebGLProgram | null = null;
  private edgeProgram: WebGLProgram | null = null;

  private quadVao: WebGLVertexArrayObject | null = null;
  private quadVbo: WebGLBuffer | null = null;
  private nodeInstanceVbo: WebGLBuffer | null = null;

  private edgeVao: WebGLVertexArrayObject | null = null;
  private edgeVbo: WebGLBuffer | null = null;

  private nodeCount = 0;
  private edgeVertexCount = 0;

  // Staged typed arrays for instanced node data: [x, y, z, r, g, b, a, radius, flags] (9 floats per node)
  private nodeData = new Float32Array(0);
  // Staged typed arrays for edge lines: [x, y, z, r, g, b, a] (7 floats per vertex, 2 vertices per edge)
  private edgeData = new Float32Array(0);

  // Cached uniform locations
  private nodeUniforms = { resolution: null as WebGLUniformLocation | null, camera: null as WebGLUniformLocation | null, scale: null as WebGLUniformLocation | null };
  private edgeUniforms = { resolution: null as WebGLUniformLocation | null, camera: null as WebGLUniformLocation | null, scale: null as WebGLUniformLocation | null };

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

    this.edgeUniforms.resolution = gl.getUniformLocation(this.edgeProgram, "u_resolution");
    this.edgeUniforms.camera = gl.getUniformLocation(this.edgeProgram, "u_camera");
    this.edgeUniforms.scale = gl.getUniformLocation(this.edgeProgram, "u_scale");

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

    gl.bindVertexArray(null);
  }

  public updateBuffers(
    nodes: MemoryGraphNode[],
    edges: MemoryGraphEdge[],
    coordinates: Map<string, MemoryPoint3D>,
    positions: Map<string, MemoryAtlasPosition>,
    focusId: string | null
  ) {
    const gl = this.gl;
    this.nodeCount = nodes.length;
    const nodeFloats = this.nodeCount * 9;
    if (this.nodeData.length < nodeFloats) {
      this.nodeData = new Float32Array(nodeFloats);
    }

    const neighbors = new Set<string>();
    if (focusId) {
      for (const edge of edges) {
        if (edge.source === focusId) neighbors.add(edge.target);
        if (edge.target === focusId) neighbors.add(edge.source);
      }
    }

    let offset = 0;
    for (let i = 0; i < this.nodeCount; i++) {
      const node = nodes[i]!;
      const coord = coordinates.get(node.id) ?? { x: 0, y: 0, z: 0 };
      const isFocused = node.id === focusId;
      const isRoot = node.type === "SOURCE" && isMemoryCoreLabel(node.label);

      let r = 0.45, g = 0.58, b = 0.68, a = 1.0;
      if (isFocused) {
        r = 1.0; g = 1.0; b = 1.0; a = 1.0;
      } else {
        const hex = positions.get(node.id)?.color ?? "#7395ad";
        const rgb = parseHexRgb(hex);
        r = rgb[0]; g = rgb[1]; b = rgb[2];
        if (focusId && !neighbors.has(node.id)) {
          a = 0.2;
        }
      }

      const baseRadius = isRoot ? 10 : node.type === "SOURCE" ? 4.6 : 2.1;
      const flags = isFocused ? 1.0 : isRoot ? 2.0 : 0.0;

      this.nodeData[offset++] = coord.x;
      this.nodeData[offset++] = coord.y;
      this.nodeData[offset++] = coord.z;
      this.nodeData[offset++] = r;
      this.nodeData[offset++] = g;
      this.nodeData[offset++] = b;
      this.nodeData[offset++] = a;
      this.nodeData[offset++] = baseRadius;
      this.nodeData[offset++] = flags;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeInstanceVbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.nodeData.subarray(0, nodeFloats), gl.DYNAMIC_DRAW);

    // Update Edges
    this.edgeVertexCount = edges.length * 2;
    const edgeFloats = this.edgeVertexCount * 7;
    if (this.edgeData.length < edgeFloats) {
      this.edgeData = new Float32Array(edgeFloats);
    }

    let edgeOffset = 0;
    for (let i = 0; i < edges.length; i++) {
      const edge = edges[i]!;
      const a = coordinates.get(edge.source);
      const b = coordinates.get(edge.target);
      if (!a || !b) continue;

      const incident = edge.source === focusId || edge.target === focusId;
      let er = 0.125, eg = 0.20, eb = 0.26, ea = 0.6; // #203343
      if (incident) {
        er = 0.596; eg = 0.855; eb = 0.980; ea = 1.0; // #98dafa
      } else if (focusId) {
        er = 0.078; eg = 0.125; eb = 0.169; ea = 0.18; // #14202b dimmed
      } else if (edge.type === "DERIVED_FROM") {
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

    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeVbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.edgeData.subarray(0, edgeOffset), gl.DYNAMIC_DRAW);
  }

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

    // 1. Draw Edges
    if (this.edgeVertexCount > 0) {
      gl.useProgram(this.edgeProgram);
      gl.uniform2f(this.edgeUniforms.resolution, width, height);
      gl.uniform3f(this.edgeUniforms.camera, camera.yaw, camera.pitch, camera.zoom);
      gl.uniform1f(this.edgeUniforms.scale, scale);

      gl.bindVertexArray(this.edgeVao);
      gl.drawArrays(gl.LINES, 0, this.edgeVertexCount);
    }

    // 2. Draw Nodes (Instanced Quads)
    if (this.nodeCount > 0) {
      gl.useProgram(this.nodeProgram);
      gl.uniform2f(this.nodeUniforms.resolution, width, height);
      gl.uniform3f(this.nodeUniforms.camera, camera.yaw, camera.pitch, camera.zoom);
      gl.uniform1f(this.nodeUniforms.scale, scale);

      gl.bindVertexArray(this.quadVao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.nodeCount);
    }

    gl.bindVertexArray(null);
  }

  public destroy() {
    const gl = this.gl;
    if (this.quadVao) gl.deleteVertexArray(this.quadVao);
    if (this.quadVbo) gl.deleteBuffer(this.quadVbo);
    if (this.nodeInstanceVbo) gl.deleteBuffer(this.nodeInstanceVbo);
    if (this.edgeVao) gl.deleteVertexArray(this.edgeVao);
    if (this.edgeVbo) gl.deleteBuffer(this.edgeVbo);
    if (this.nodeProgram) gl.deleteProgram(this.nodeProgram);
    if (this.edgeProgram) gl.deleteProgram(this.edgeProgram);
  }
}
