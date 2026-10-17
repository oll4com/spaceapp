import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import { projectMemoryPoint, type MemoryCamera3D, type MemoryPoint3D } from "./memory-3d.js";

export const MAX_MEMORY_GRAPH_LABELS = 160;
export const MAX_MEMORY_GRAPH_LABEL_MEASUREMENTS = 256;
const PICK_CLUSTER_AXIS = 4;

export function memoryGraphP95(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
}

export type MemoryGraphPickIndex = {
  offsets: Uint32Array;
  bounds: Float32Array;
  maxSizes: Float32Array;
  nodeIndices: Uint32Array;
};

export function buildMemoryGraphPickIndex(
  nodePositions: Float32Array,
  nodeSizes: Float32Array,
  axis = PICK_CLUSTER_AXIS
): MemoryGraphPickIndex {
  const clusterCount = axis ** 3;
  const nodeCount = nodeSizes.length;
  const offsets = new Uint32Array(clusterCount + 1);
  const bounds = new Float32Array(clusterCount * 6);
  const maxSizes = new Float32Array(clusterCount);
  for (let cluster = 0; cluster < clusterCount; cluster++) {
    const offset = cluster * 6;
    bounds[offset] = bounds[offset + 1] = bounds[offset + 2] = Number.POSITIVE_INFINITY;
    bounds[offset + 3] = bounds[offset + 4] = bounds[offset + 5] = Number.NEGATIVE_INFINITY;
  }
  if (nodeCount === 0) return { offsets, bounds, maxSizes, nodeIndices: new Uint32Array() };

  let minX = Number.POSITIVE_INFINITY, minY = Number.POSITIVE_INFINITY, minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY, maxY = Number.NEGATIVE_INFINITY, maxZ = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < nodeCount; index++) {
    const positionOffset = index * 3;
    const x = nodePositions[positionOffset]!;
    const y = nodePositions[positionOffset + 1]!;
    const z = nodePositions[positionOffset + 2]!;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  const spanX = Math.max(1e-6, maxX - minX);
  const spanY = Math.max(1e-6, maxY - minY);
  const spanZ = Math.max(1e-6, maxZ - minZ);
  const counts = new Uint32Array(clusterCount);
  const clusterByNode = new Uint32Array(nodeCount);
  for (let index = 0; index < nodeCount; index++) {
    const positionOffset = index * 3;
    const x = nodePositions[positionOffset]!;
    const y = nodePositions[positionOffset + 1]!;
    const z = nodePositions[positionOffset + 2]!;
    const cellX = Math.min(axis - 1, Math.floor((x - minX) / spanX * axis));
    const cellY = Math.min(axis - 1, Math.floor((y - minY) / spanY * axis));
    const cellZ = Math.min(axis - 1, Math.floor((z - minZ) / spanZ * axis));
    const cluster = cellX + cellY * axis + cellZ * axis * axis;
    clusterByNode[index] = cluster;
    counts[cluster] = counts[cluster]! + 1;
    const boundOffset = cluster * 6;
    bounds[boundOffset] = Math.min(bounds[boundOffset]!, x);
    bounds[boundOffset + 1] = Math.min(bounds[boundOffset + 1]!, y);
    bounds[boundOffset + 2] = Math.min(bounds[boundOffset + 2]!, z);
    bounds[boundOffset + 3] = Math.max(bounds[boundOffset + 3]!, x);
    bounds[boundOffset + 4] = Math.max(bounds[boundOffset + 4]!, y);
    bounds[boundOffset + 5] = Math.max(bounds[boundOffset + 5]!, z);
    maxSizes[cluster] = Math.max(maxSizes[cluster]!, nodeSizes[index]!);
  }
  for (let cluster = 0; cluster < clusterCount; cluster++) offsets[cluster + 1] = offsets[cluster]! + counts[cluster]!;
  const cursors = offsets.slice(0, clusterCount);
  const nodeIndices = new Uint32Array(nodeCount);
  for (let index = 0; index < nodeCount; index++) {
    const cluster = clusterByNode[index]!;
    const destination = cursors[cluster]!;
    cursors[cluster] = destination + 1;
    nodeIndices[destination] = index;
  }
  return { offsets, bounds, maxSizes, nodeIndices };
}

export function pickMemoryGraphNodeIndex(
  pickIndex: MemoryGraphPickIndex,
  nodePositions: Float32Array,
  nodeSizes: Float32Array,
  x: number,
  y: number,
  camera: MemoryCamera3D,
  scale: number,
  width: number,
  height: number
): { nodeIndex: number; candidateClusters: number } {
  const cy = Math.cos(camera.yaw), sy = Math.sin(camera.yaw);
  const cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
  const sqrtZoom = Math.sqrt(camera.zoom);
  let candidateClusters = 0;
  let selectedIndex = -1;
  let selectedDepth = Number.POSITIVE_INFINITY;
  for (let cluster = 0; cluster < pickIndex.offsets.length - 1; cluster++) {
    const first = pickIndex.offsets[cluster]!;
    const last = pickIndex.offsets[cluster + 1]!;
    if (first === last) continue;
    const boundOffset = cluster * 6;
    let minScreenX = Number.POSITIVE_INFINITY, minScreenY = Number.POSITIVE_INFINITY;
    let maxScreenX = Number.NEGATIVE_INFINITY, maxScreenY = Number.NEGATIVE_INFINITY;
    let maxPerspective = 0;
    for (let corner = 0; corner < 8; corner++) {
      const px = pickIndex.bounds[boundOffset + ((corner & 1) === 0 ? 0 : 3)]!;
      const py = pickIndex.bounds[boundOffset + ((corner & 2) === 0 ? 1 : 4)]!;
      const pz = pickIndex.bounds[boundOffset + ((corner & 4) === 0 ? 2 : 5)]!;
      const rotatedX = px * cy + pz * sy;
      const depth = -px * sy + pz * cy;
      const rotatedY = py * cp - depth * sp;
      const projectedZ = py * sp + depth * cp;
      const perspective = 650 / Math.max(120, 650 + projectedZ * scale);
      const screenX = width * 0.5 + rotatedX * scale * camera.zoom * perspective;
      const screenY = height * 0.5 - rotatedY * scale * camera.zoom * perspective;
      minScreenX = Math.min(minScreenX, screenX); maxScreenX = Math.max(maxScreenX, screenX);
      minScreenY = Math.min(minScreenY, screenY); maxScreenY = Math.max(maxScreenY, screenY);
      maxPerspective = Math.max(maxPerspective, perspective);
    }
    const radius = Math.max(7, pickIndex.maxSizes[cluster]! * maxPerspective * sqrtZoom + 3);
    if (x < minScreenX - radius || x > maxScreenX + radius || y < minScreenY - radius || y > maxScreenY + radius) continue;
    candidateClusters++;
    for (let sortedIndex = first; sortedIndex < last; sortedIndex++) {
      const index = pickIndex.nodeIndices[sortedIndex]!;
      const positionOffset = index * 3;
      const px = nodePositions[positionOffset]!;
      const py = nodePositions[positionOffset + 1]!;
      const pz = nodePositions[positionOffset + 2]!;
      const rotatedX = px * cy + pz * sy;
      const depth = -px * sy + pz * cy;
      const rotatedY = py * cp - depth * sp;
      const projectedZ = py * sp + depth * cp;
      const perspective = 650 / Math.max(120, 650 + projectedZ * scale);
      const screenX = width * 0.5 + rotatedX * scale * camera.zoom * perspective;
      const screenY = height * 0.5 - rotatedY * scale * camera.zoom * perspective;
      const nodeRadius = Math.max(7, Math.max(1, nodeSizes[index]! * perspective * sqrtZoom) + 3);
      const deltaX = x - screenX;
      const deltaY = y - screenY;
      if (deltaX * deltaX + deltaY * deltaY > nodeRadius * nodeRadius) continue;
      const normalizedDepth = Math.max(-0.95, Math.min(0.95, projectedZ * scale / 1000));
      if (normalizedDepth < selectedDepth || (normalizedDepth === selectedDepth && index > selectedIndex)) {
        selectedIndex = index;
        selectedDepth = normalizedDepth;
      }
    }
  }
  return { nodeIndex: selectedIndex, candidateClusters };
}

export type MemoryGraphLabel = {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  core: boolean;
};

/** Selects and measures a fixed upper bound of labels, independent of graph size. */
export function selectMemoryGraphLabels(
  nodes: MemoryGraphNode[],
  coordinates: Map<string, MemoryPoint3D>,
  camera: MemoryCamera3D,
  scale: number,
  width: number,
  height: number,
  focus: string | null,
  measure: (label: string) => number
): MemoryGraphLabel[] {
  const candidates: MemoryGraphNode[] = [];
  const seen = new Set<string>();
  const append = (node: MemoryGraphNode | undefined) => {
    if (!node || seen.has(node.id) || !coordinates.has(node.id) || candidates.length >= MAX_MEMORY_GRAPH_LABEL_MEASUREMENTS) return;
    seen.add(node.id);
    candidates.push(node);
  };
  append(nodes.find(node => node.id === focus));
  for (const node of nodes) {
    if (node.type === "SOURCE" && isMemoryCoreLabel(node.label)) append(node);
    if (candidates.length >= MAX_MEMORY_GRAPH_LABEL_MEASUREMENTS) break;
  }
  for (const node of nodes) {
    if (node.type === "SOURCE") append(node);
    if (candidates.length >= MAX_MEMORY_GRAPH_LABEL_MEASUREMENTS) break;
  }
  if (camera.zoom >= 1.6) for (const node of nodes) {
    append(node);
    if (candidates.length >= MAX_MEMORY_GRAPH_LABEL_MEASUREMENTS) break;
  }

  const labels: MemoryGraphLabel[] = [];
  const boxes: Array<{ x: number; y: number; width: number }> = [];
  for (const node of candidates) {
    const point = projectMemoryPoint(coordinates.get(node.id)!, camera, scale, width, height);
    const label = node.label.length > 48 ? `${node.label.slice(0, 45)}…` : node.label;
    const x = point.x + 9;
    const y = point.y;
    const labelWidth = measure(label);
    if (x + labelWidth > width || x < 0 || y < 14 || y > height - 5) continue;
    if (boxes.some(box => Math.abs(box.y - y) < 16 && x < box.x + box.width + 5 && x + labelWidth + 5 > box.x)) continue;
    boxes.push({ x, y, width: labelWidth });
    labels.push({ id: node.id, label, x, y, width: labelWidth, core: isMemoryCoreLabel(node.label) });
    if (labels.length >= MAX_MEMORY_GRAPH_LABELS) break;
  }
  return labels;
}

const NODE_VERTEX = `#version 300 es
precision highp float;
layout(location=0) in vec2 aCorner;
layout(location=1) in vec3 aPosition;
layout(location=2) in vec4 aColor;
layout(location=3) in float aSize;
layout(location=4) in vec2 aState;
uniform vec2 uViewport;
uniform vec4 uCamera;
out vec2 vLocal;
out vec4 vColor;
vec4 projectPoint(vec3 point, out float perspective) {
  float cy = cos(uCamera.x), sy = sin(uCamera.x);
  float cp = cos(uCamera.y), sp = sin(uCamera.y);
  float rotatedX = point.x * cy + point.z * sy;
  float depth = -point.x * sy + point.z * cy;
  float rotatedY = point.y * cp - depth * sp;
  float z = point.y * sp + depth * cp;
  perspective = 650.0 / max(120.0, 650.0 + z * uCamera.w);
  vec2 screen = vec2(
    uViewport.x * 0.5 + rotatedX * uCamera.w * uCamera.z * perspective,
    uViewport.y * 0.5 - rotatedY * uCamera.w * uCamera.z * perspective
  );
  vec2 clip = vec2(screen.x / uViewport.x * 2.0 - 1.0, 1.0 - screen.y / uViewport.y * 2.0);
  return vec4(clip, clamp(z * uCamera.w / 1000.0, -0.95, 0.95), 1.0);
}
void main() {
  float perspective;
  vec4 projected = projectPoint(aPosition, perspective);
  float radius = max(1.0, aSize * perspective * sqrt(uCamera.z)) * aState.y;
  projected.xy += aCorner * radius * 2.0 / uViewport;
  gl_Position = projected;
  vLocal = aCorner;
  vColor = vec4(aColor.rgb, aColor.a * aState.x);
}`;

const NODE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vLocal;
in vec4 vColor;
out vec4 outColor;
void main() {
  float distanceFromCenter = length(vLocal);
  if (distanceFromCenter > 1.0) discard;
  float edge = 1.0 - smoothstep(0.78, 1.0, distanceFromCenter);
  outColor = vec4(vColor.rgb, vColor.a * edge);
}`;

const EDGE_VERTEX = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPosition;
layout(location=1) in vec2 aEndpoints;
uniform vec2 uViewport;
uniform vec4 uCamera;
uniform float uFocusIndex;
out vec4 vColor;
void main() {
  float cy = cos(uCamera.x), sy = sin(uCamera.x);
  float cp = cos(uCamera.y), sp = sin(uCamera.y);
  float rotatedX = aPosition.x * cy + aPosition.z * sy;
  float depth = -aPosition.x * sy + aPosition.z * cy;
  float rotatedY = aPosition.y * cp - depth * sp;
  float z = aPosition.y * sp + depth * cp;
  float perspective = 650.0 / max(120.0, 650.0 + z * uCamera.w);
  vec2 screen = vec2(
    uViewport.x * 0.5 + rotatedX * uCamera.w * uCamera.z * perspective,
    uViewport.y * 0.5 - rotatedY * uCamera.w * uCamera.z * perspective
  );
  gl_Position = vec4(screen.x / uViewport.x * 2.0 - 1.0, 1.0 - screen.y / uViewport.y * 2.0, clamp(z * uCamera.w / 1000.0, -0.95, 0.95), 1.0);
  bool focused = uFocusIndex >= 0.0;
  bool incident = abs(aEndpoints.x - uFocusIndex) < 0.5 || abs(aEndpoints.y - uFocusIndex) < 0.5;
  vColor = !focused ? vec4(0.125, 0.200, 0.263, 0.72) : incident ? vec4(0.596, 0.855, 0.980, 1.0) : vec4(0.078, 0.125, 0.169, 1.0);
}`;

const EDGE_FRAGMENT = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 outColor;
void main() { outColor = vColor; }`;

function compileProgram(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("WebGL shader allocation failed.");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader) ?? "unknown shader error";
      gl.deleteShader(shader);
      throw new Error(log);
    }
    return shader;
  };
  const vertex = compile(gl.VERTEX_SHADER, vertexSource);
  const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) throw new Error("WebGL program allocation failed.");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? "unknown link error";
    gl.deleteProgram(program);
    throw new Error(log);
  }
  return program;
}

function colorComponents(value: string): [number, number, number, number] {
  const hex = value.startsWith("#") ? value.slice(1) : value;
  const expanded = hex.length === 3 ? [...hex].map(character => `${character}${character}`).join("") : hex.slice(0, 6);
  const parsed = Number.parseInt(expanded, 16);
  if (!Number.isFinite(parsed)) return [0.45, 0.58, 0.68, 1];
  return [((parsed >> 16) & 255) / 255, ((parsed >> 8) & 255) / 255, (parsed & 255) / 255, 1];
}

export class MemoryGraphWebGLRenderer {
  readonly gl: WebGL2RenderingContext;
  private readonly nodeProgram: WebGLProgram;
  private readonly edgeProgram: WebGLProgram;
  private readonly nodeVao: WebGLVertexArrayObject;
  private readonly edgeChunks: Array<{ vao: WebGLVertexArrayObject; positionBuffer: WebGLBuffer; endpointBuffer: WebGLBuffer; vertexCount: number }>;
  private readonly buffers: WebGLBuffer[] = [];
  private readonly positionBuffer: WebGLBuffer;
  private readonly colorBuffer: WebGLBuffer;
  private readonly sizeBuffer: WebGLBuffer;
  private readonly stateBuffer: WebGLBuffer;
  private nodes: MemoryGraphNode[] = [];
  private edges: MemoryGraphEdge[] = [];
  private nodeIds: string[] = [];
  private nodeIndex = new Map<string, number>();
  private neighborOffsets = new Uint32Array();
  private neighborIndices = new Uint32Array();
  private nodeState = new Float32Array();
  private nodeSizes = new Float32Array();
  private nodePositions = new Float32Array();
  private edgePositions = new Float32Array();
  private edgeNodeIndices = new Uint32Array();
  private nodeCount = 0;
  private pickIndex = buildMemoryGraphPickIndex(new Float32Array(), new Float32Array());
  private focusIndex = -1;
  private cssWidth = 1;
  private cssHeight = 1;
  extent = 60;
  lastPickDurationMs = 0;
  lastGraphUploadDurationMs = 0;
  lastCoordinateUploadDurationMs = 0;
  lastAdjacencyBuildDurationMs = 0;
  lastPickIndexBuildDurationMs = 0;
  lastPickCandidateClusters = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { antialias: true, alpha: true, depth: true, powerPreference: "high-performance" });
    if (!gl) throw new Error("WebGL2 is unavailable.");
    this.gl = gl;
    const debugRenderer = gl.getExtension("WEBGL_debug_renderer_info");
    canvas.dataset.gpuRenderer = String(debugRenderer
      ? gl.getParameter(debugRenderer.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER));
    this.nodeProgram = compileProgram(gl, NODE_VERTEX, NODE_FRAGMENT);
    this.edgeProgram = compileProgram(gl, EDGE_VERTEX, EDGE_FRAGMENT);
    const buffer = () => {
      const value = gl.createBuffer();
      if (!value) throw new Error("WebGL buffer allocation failed.");
      this.buffers.push(value);
      return value;
    };
    this.positionBuffer = buffer();
    this.colorBuffer = buffer();
    this.sizeBuffer = buffer();
    this.stateBuffer = buffer();
    const cornerBuffer = buffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    const nodeVao = gl.createVertexArray();
    if (!nodeVao) throw new Error("WebGL vertex array allocation failed.");
    this.nodeVao = nodeVao;
    gl.bindVertexArray(nodeVao);
    this.attribute(cornerBuffer, 0, 2, 0);
    this.attribute(this.positionBuffer, 1, 3, 1);
    this.attribute(this.colorBuffer, 2, 4, 1);
    this.attribute(this.sizeBuffer, 3, 1, 1);
    this.attribute(this.stateBuffer, 4, 2, 1);
    this.edgeChunks = Array.from({ length: 4 }, () => {
      const positionBuffer = buffer();
      const endpointBuffer = buffer();
      const vao = gl.createVertexArray();
      if (!vao) throw new Error("WebGL edge vertex array allocation failed.");
      gl.bindVertexArray(vao);
      this.attribute(positionBuffer, 0, 3, 0);
      this.attribute(endpointBuffer, 1, 2, 0);
      return { vao, positionBuffer, endpointBuffer, vertexCount: 0 };
    });
    gl.bindVertexArray(null);
  }

  private attribute(buffer: WebGLBuffer, location: number, size: number, divisor: number) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(location, divisor);
  }

  resize(width: number, height: number, dpr: number) {
    this.cssWidth = Math.max(1, width);
    this.cssHeight = Math.max(1, height);
    const pixelWidth = Math.max(1, Math.round(width * Math.max(1, dpr)));
    const pixelHeight = Math.max(1, Math.round(height * Math.max(1, dpr)));
    if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth;
    if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight;
  }

  setGraph(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[], positions: Map<string, MemoryAtlasPosition>, coordinates: Map<string, MemoryPoint3D>) {
    const started = performance.now();
    const gl = this.gl;
    this.nodes = nodes.filter(node => coordinates.has(node.id));
    this.nodeIds = new Array<string>(this.nodes.length);
    this.nodeIndex = new Map<string, number>();
    this.nodes.forEach((node, index) => {
      this.nodeIds[index] = node.id;
      this.nodeIndex.set(node.id, index);
    });
    const edgeIndices = new Uint32Array(edges.length * 2);
    this.edges = [];
    for (const edge of edges) {
      const source = this.nodeIndex.get(edge.source);
      const target = this.nodeIndex.get(edge.target);
      if (source === undefined || target === undefined) continue;
      edgeIndices[this.edges.length * 2] = source;
      edgeIndices[this.edges.length * 2 + 1] = target;
      this.edges.push(edge);
    }
    this.edgeNodeIndices = edgeIndices.slice(0, this.edges.length * 2);
    this.nodeCount = this.nodes.length;
    this.neighborOffsets = new Uint32Array();
    this.neighborIndices = new Uint32Array();
    this.nodePositions = new Float32Array(this.nodeCount * 3);
    const nodeColors = new Float32Array(this.nodeCount * 4);
    this.nodeSizes = new Float32Array(this.nodeCount);
    this.nodeState = new Float32Array(this.nodeCount * 2);
    const colorCache = new Map<string, [number, number, number, number]>();
    this.nodes.forEach((node, index) => {
      const colorValue = positions.get(node.id)?.color ?? "#7395ad";
      let color = colorCache.get(colorValue);
      if (!color) {
        color = colorComponents(colorValue);
        colorCache.set(colorValue, color);
      }
      nodeColors.set(color, index * 4);
      const root = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
      this.nodeSizes[index] = root ? 10 : node.type === "SOURCE" ? 4.6 : 2.1;
      this.nodeState.set([1, 1], index * 2);
    });
    this.edgePositions = new Float32Array(this.edges.length * 6);
    const edgeEndpoints = new Float32Array(this.edges.length * 4);
    this.edges.forEach((_edge, index) => {
      const sourceIndex = this.edgeNodeIndices[index * 2]!;
      const targetIndex = this.edgeNodeIndices[index * 2 + 1]!;
      edgeEndpoints.set([sourceIndex, targetIndex, sourceIndex, targetIndex], index * 4);
    });
    const upload = (buffer: WebGLBuffer, data: BufferSource, usage: number) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, usage);
    };
    upload(this.colorBuffer, nodeColors, gl.STATIC_DRAW);
    upload(this.sizeBuffer, this.nodeSizes, gl.STATIC_DRAW);
    upload(this.stateBuffer, this.nodeState, gl.DYNAMIC_DRAW);
    this.edgeChunks.forEach((chunk, chunkIndex) => {
      const firstEdge = Math.floor(this.edges.length * chunkIndex / this.edgeChunks.length);
      const lastEdge = Math.floor(this.edges.length * (chunkIndex + 1) / this.edgeChunks.length);
      upload(chunk.endpointBuffer, edgeEndpoints.subarray(firstEdge * 4, lastEdge * 4), gl.STATIC_DRAW);
      chunk.vertexCount = (lastEdge - firstEdge) * 2;
    });
    this.updateCoordinates(coordinates);
    this.focusIndex = -1;
    this.lastGraphUploadDurationMs = performance.now() - started;
  }

  buildAdjacency() {
    const started = performance.now();
    const degrees = new Uint32Array(this.nodeCount);
    for (let index = 0; index < this.edges.length; index++) {
      const source = this.edgeNodeIndices[index * 2]!;
      const target = this.edgeNodeIndices[index * 2 + 1]!;
      degrees[source] = degrees[source]! + 1;
      degrees[target] = degrees[target]! + 1;
    }
    this.neighborOffsets = new Uint32Array(this.nodeCount + 1);
    for (let index = 0; index < this.nodeCount; index++) this.neighborOffsets[index + 1] = this.neighborOffsets[index]! + degrees[index]!;
    this.neighborIndices = new Uint32Array(this.neighborOffsets[this.nodeCount]!);
    const neighborCursors = this.neighborOffsets.slice(0, this.nodeCount);
    for (let index = 0; index < this.edges.length; index++) {
      const source = this.edgeNodeIndices[index * 2]!;
      const target = this.edgeNodeIndices[index * 2 + 1]!;
      const sourceCursor = neighborCursors[source]!;
      const targetCursor = neighborCursors[target]!;
      this.neighborIndices[sourceCursor] = target;
      this.neighborIndices[targetCursor] = source;
      neighborCursors[source] = sourceCursor + 1;
      neighborCursors[target] = targetCursor + 1;
    }
    this.lastAdjacencyBuildDurationMs = performance.now() - started;
  }

  updateCoordinates(coordinates: Map<string, MemoryPoint3D>) {
    const started = performance.now();
    const gl = this.gl;
    this.extent = 60;
    this.nodes.forEach((node, index) => {
      const point = coordinates.get(node.id);
      if (!point) return;
      const offset = index * 3;
      this.nodePositions[offset] = point.x;
      this.nodePositions[offset + 1] = point.y;
      this.nodePositions[offset + 2] = point.z;
      this.extent = Math.max(this.extent, Math.hypot(point.x, point.y, point.z));
    });
    this.edges.forEach((_edge, index) => {
      const sourceIndex = this.edgeNodeIndices[index * 2]! * 3;
      const targetIndex = this.edgeNodeIndices[index * 2 + 1]! * 3;
      const offset = index * 6;
      this.edgePositions[offset] = this.nodePositions[sourceIndex]!;
      this.edgePositions[offset + 1] = this.nodePositions[sourceIndex + 1]!;
      this.edgePositions[offset + 2] = this.nodePositions[sourceIndex + 2]!;
      this.edgePositions[offset + 3] = this.nodePositions[targetIndex]!;
      this.edgePositions[offset + 4] = this.nodePositions[targetIndex + 1]!;
      this.edgePositions[offset + 5] = this.nodePositions[targetIndex + 2]!;
    });
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.nodePositions, gl.DYNAMIC_DRAW);
    this.edgeChunks.forEach((chunk, chunkIndex) => {
      const firstEdge = Math.floor(this.edges.length * chunkIndex / this.edgeChunks.length);
      const lastEdge = Math.floor(this.edges.length * (chunkIndex + 1) / this.edgeChunks.length);
      gl.bindBuffer(gl.ARRAY_BUFFER, chunk.positionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.edgePositions.subarray(firstEdge * 6, lastEdge * 6), gl.DYNAMIC_DRAW);
    });
    this.rebuildPickClusters();
    this.lastCoordinateUploadDurationMs = performance.now() - started;
  }

  private rebuildPickClusters() {
    const started = performance.now();
    this.pickIndex = buildMemoryGraphPickIndex(this.nodePositions, this.nodeSizes);
    this.lastPickIndexBuildDurationMs = performance.now() - started;
  }

  setFocus(focus: string | null) {
    const gl = this.gl;
    this.focusIndex = focus ? this.nodeIndex.get(focus) ?? -1 : -1;
    for (let index = 0; index < this.nodeIds.length; index++) {
      this.nodeState[index * 2] = this.focusIndex >= 0 ? 0.2 : 1;
      this.nodeState[index * 2 + 1] = 1;
    }
    if (this.focusIndex >= 0) {
      this.nodeState[this.focusIndex * 2] = 1;
      this.nodeState[this.focusIndex * 2 + 1] = 1.5;
      for (let offset = this.neighborOffsets[this.focusIndex] ?? 0; offset < (this.neighborOffsets[this.focusIndex + 1] ?? 0); offset++) {
        this.nodeState[this.neighborIndices[offset]! * 2] = 1;
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.stateBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.nodeState);
  }

  private uniforms(program: WebGLProgram, camera: MemoryCamera3D, scale: number) {
    const gl = this.gl;
    gl.useProgram(program);
    gl.uniform2f(gl.getUniformLocation(program, "uViewport"), this.cssWidth, this.cssHeight);
    gl.uniform4f(gl.getUniformLocation(program, "uCamera"), camera.yaw, camera.pitch, camera.zoom, scale);
  }

  render(camera: MemoryCamera3D, scale: number, synchronize = false, layer: "all" | "edges" | "nodes" = "all") {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    if (layer !== "nodes") {
      this.uniforms(this.edgeProgram, camera, scale);
      gl.uniform1f(gl.getUniformLocation(this.edgeProgram, "uFocusIndex"), this.focusIndex);
      for (const chunk of this.edgeChunks) {
        gl.bindVertexArray(chunk.vao);
        gl.drawArrays(gl.LINES, 0, chunk.vertexCount);
      }
    }
    if (layer !== "edges") {
      this.uniforms(this.nodeProgram, camera, scale);
      gl.bindVertexArray(this.nodeVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.nodeCount);
    }
    gl.bindVertexArray(null);
    if (synchronize) gl.finish();
  }

  renderEdgeChunk(camera: MemoryCamera3D, scale: number, chunk: number, chunkCount: number) {
    const selected = this.edgeChunks[Math.floor(chunk * this.edgeChunks.length / chunkCount)];
    if (!selected) return;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.uniforms(this.edgeProgram, camera, scale);
    gl.uniform1f(gl.getUniformLocation(this.edgeProgram, "uFocusIndex"), this.focusIndex);
    gl.bindVertexArray(selected.vao);
    gl.drawArrays(gl.LINES, 0, selected.vertexCount);
    gl.bindVertexArray(null);
  }

  pick(x: number, y: number, camera: MemoryCamera3D, scale: number): string | null {
    const started = performance.now();
    const result = pickMemoryGraphNodeIndex(this.pickIndex, this.nodePositions, this.nodeSizes, x, y, camera, scale, this.cssWidth, this.cssHeight);
    this.lastPickCandidateClusters = result.candidateClusters;
    this.lastPickDurationMs = performance.now() - started;
    return result.nodeIndex < 0 ? null : this.nodeIds[result.nodeIndex] ?? null;
  }

  destroy() {
    const gl = this.gl;
    this.buffers.forEach(buffer => gl.deleteBuffer(buffer));
    gl.deleteVertexArray(this.nodeVao);
    this.edgeChunks.forEach(chunk => gl.deleteVertexArray(chunk.vao));
    gl.deleteProgram(this.nodeProgram);
    gl.deleteProgram(this.edgeProgram);
    delete this.canvas.dataset.gpuRenderer;
  }
}
