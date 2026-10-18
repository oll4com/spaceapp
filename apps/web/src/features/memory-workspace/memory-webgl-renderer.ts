import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import { projectMemoryPoint, type MemoryCamera3D, type MemoryPoint3D } from "./memory-3d.js";

export const MEMORY_FALLBACK_NODE_LIMIT = 2_000;
export const MEMORY_FALLBACK_EDGE_LIMIT = 6_000;
export const MEMORY_LABEL_CANDIDATE_LIMIT = 128;
export const MEMORY_LABEL_LIMIT = 48;
const LABEL_POOL_LIMIT = 512;
const profileEnabled = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("memoryProfile");
let profileSequence = 0;
const noProfile = () => {};

/** Opt-in User Timing spans for distinguishing CPU preparation from GL startup. */
export function memoryProfilePhase(phase: string): () => void {
  if (!profileEnabled || typeof performance.mark !== "function") return noProfile;
  const key = `memory-graph:${phase}:${++profileSequence}`, start = `${key}:start`, end = `${key}:end`;
  performance.mark(start);
  return () => { performance.mark(end); performance.measure(`memory-graph:${phase}`, start, end); performance.clearMarks(start); performance.clearMarks(end); };
}

export type RenderNode = { node: MemoryGraphNode; point: MemoryPoint3D; color: string; radius: number; index: number };
export type MemoryRenderData = {
  nodes: RenderNode[]; byId: Map<string, RenderNode>; edges: MemoryGraphEdge[];
  adjacency: Map<string, Set<string>>; extent: number; labels: RenderNode[];
  nodeBuffer: Float32Array; edgeBuffer: Float32Array;
};

/** Convert taxonomy hex colors to normalized GPU channels, with the standard fallback. */
function colorComponents(color: string): number[] {
  const hex = /^#[\da-f]{6}$/i.test(color) ? color.slice(1) : "7395ad";
  return [0, 2, 4].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
}

/** Build immutable GPU buffers once per graph/layout update, never per camera frame. */
function* prepareMemoryRenderSteps(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[], positions: Map<string, MemoryAtlasPosition>, coordinates: Map<string, MemoryPoint3D>): Generator<void, MemoryRenderData> {
  const prepared: RenderNode[] = [], byId = new Map<string, RenderNode>();
  const roots: RenderNode[] = [], sources: RenderNode[] = [], others: RenderNode[] = [];
  let extent = 60;
  let iteration = 0;
  for (const node of nodes) {
    if (++iteration % 256 === 0) yield;
    const point = coordinates.get(node.id);
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) continue;
    const root = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
    const entry = { node, point, color: positions.get(node.id)?.color ?? "#7395ad", radius: root ? 10 : node.type === "SOURCE" ? 4.6 : 2.1, index: prepared.length };
    prepared.push(entry); byId.set(node.id, entry);
    extent = Math.max(extent, Math.hypot(point.x, point.y, point.z));
    const pool = root ? roots : node.type === "SOURCE" ? sources : others;
    if (pool.length < LABEL_POOL_LIMIT) pool.push(entry);
  }
  const adjacency = new Map<string, Set<string>>();
  const links: MemoryGraphEdge[] = [];
  for (const edge of edges) { if (++iteration % 512 === 0) yield; if (byId.has(edge.source) && byId.has(edge.target)) links.push(edge); }
  const nodeBuffer = new Float32Array(prepared.length * 8), edgeBuffer = new Float32Array(links.length * 9);
  for (const item of prepared) {
    if (++iteration % 256 === 0) yield;
    nodeBuffer.set([item.point.x, item.point.y, item.point.z, item.radius, ...colorComponents(item.color), item.index + 1], item.index * 8);
  }
  let offset = 0;
  for (const edge of links) {
    if (++iteration % 256 === 0) yield;
    const a = byId.get(edge.source)!, b = byId.get(edge.target)!;
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, new Set());
    if (!adjacency.has(edge.target)) adjacency.set(edge.target, new Set());
    adjacency.get(edge.source)!.add(edge.target); adjacency.get(edge.target)!.add(edge.source);
    edgeBuffer.set([a.point.x, a.point.y, a.point.z, b.point.x, b.point.y, b.point.z, a.index + 1, b.index + 1, Number(edge.type === "DERIVED_FROM")], offset);
    offset += 9;
  }
  return { nodes: prepared, byId, edges: links, adjacency, extent, labels: [...roots, ...sources, ...others].slice(0, LABEL_POOL_LIMIT), nodeBuffer, edgeBuffer };
}

/** Exhaust the shared preparation steps synchronously for small fixtures and pure tests. */
export function prepareMemoryRenderData(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[], positions: Map<string, MemoryAtlasPosition>, coordinates: Map<string, MemoryPoint3D>): MemoryRenderData {
  const steps = prepareMemoryRenderSteps(nodes, edges, positions, coordinates);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/** Cooperatively prepare large snapshots without monopolizing the UI thread. */
export async function prepareMemoryRenderDataAsync(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[], positions: Map<string, MemoryAtlasPosition>, coordinates: Map<string, MemoryPoint3D>, cancelled: () => boolean): Promise<MemoryRenderData | null> {
  const steps = prepareMemoryRenderSteps(nodes, edges, positions, coordinates);
  let deadline = performance.now() + 6;
  for (;;) {
    if (cancelled()) return null;
    const step = steps.next(); if (step.done) return step.value;
    if (performance.now() >= deadline) { await new Promise<void>(resolve => setTimeout(resolve, 0)); deadline = performance.now() + 6; }
  }
}

/** Cap Canvas work while retaining the focused node and prioritizing source anchors. */
export function memoryFallbackNodes(data: MemoryRenderData, focus: string | null): RenderNode[] {
  if (data.nodes.length <= MEMORY_FALLBACK_NODE_LIMIT) return data.nodes;
  const entries = new Map<string, RenderNode>();
  const active = focus ? data.byId.get(focus) : undefined;
  if (active) entries.set(active.node.id, active);
  for (const item of data.labels) {
    if (item.node.type === "SOURCE") entries.set(item.node.id, item);
    if (entries.size >= MEMORY_FALLBACK_NODE_LIMIT) break;
  }
  for (const item of data.nodes) {
    if (entries.size >= MEMORY_FALLBACK_NODE_LIMIT) break;
    entries.set(item.node.id, item);
  }
  return [...entries.values()];
}

export type MemoryLabel = { node: RenderNode; text: string; x: number; y: number; width: number };
/** At most 128 projections/measurements and 48 text draws, regardless of graph size. */
export function memoryLabelLayout(data: MemoryRenderData, camera: MemoryCamera3D, width: number, height: number, focus: string | null, measure: (text: string) => number): MemoryLabel[] {
  const labels: MemoryLabel[] = [], visited = new Set<string>();
  const focused = focus ? data.byId.get(focus) : undefined;
  const candidates = focused ? [focused, ...data.labels] : data.labels;
  const scale = Math.min(width, height) * 0.4 / data.extent;
  let attempts = 0;
  for (const item of candidates) {
    if (attempts >= MEMORY_LABEL_CANDIDATE_LIMIT || labels.length >= MEMORY_LABEL_LIMIT) break;
    if (visited.has(item.node.id)) continue;
    visited.add(item.node.id);
    if (item.node.type !== "SOURCE" && item.node.id !== focus && camera.zoom < 1.6) continue;
    attempts++;
    const p = projectMemoryPoint(item.point, camera, scale, width, height);
    const text = item.node.label.length > 48 ? `${item.node.label.slice(0, 45)}…` : item.node.label;
    const x = p.x + 9, y = p.y;
    if (x < 0 || x > width - 10 || y < 14 || y > height - 5) continue;
    const labelWidth = measure(text);
    if (x + labelWidth > width || labels.some(box => Math.abs(box.y - y) < 16 && x < box.x + box.width + 5 && x + labelWidth + 5 > box.x)) continue;
    labels.push({ node: item, text, x, y, width: labelWidth });
  }
  return labels;
}

// Pixel-space projection deliberately matches projectMemoryPoint, including its
// near-camera clamp. The CPU only projects the bounded label/fallback sets.
const projection = `
uniform vec2 u_viewport;
uniform vec3 u_camera;
uniform float u_extent;
vec3 rotatePoint(vec3 p) {
  float cy = cos(u_camera.x), sy = sin(u_camera.x), cp = cos(u_camera.y), sp = sin(u_camera.y);
  float depth = -p.x * sy + p.z * cy;
  return vec3(p.x * cy + p.z * sy, p.y * cp - depth * sp, p.y * sp + depth * cp);
}
vec4 projectPoint(vec3 p, vec2 offset) {
  vec3 rotated = rotatePoint(p);
  float scale = min(u_viewport.x, u_viewport.y) * 0.4 / u_extent;
  float perspective = 650.0 / max(120.0, 650.0 + rotated.z * scale);
  vec2 screen = u_viewport * 0.5 + vec2(rotated.x, -rotated.y) * scale * u_camera.z * perspective + offset;
  vec2 clip = (screen / u_viewport * 2.0 - 1.0) * vec2(1.0, -1.0);
  return vec4(clip, clamp(rotated.z / (u_extent * 2.0), -0.99, 0.99), 1.0);
}
float perspectiveFor(vec3 p) {
  float scale = min(u_viewport.x, u_viewport.y) * 0.4 / u_extent;
  return 650.0 / max(120.0, 650.0 + rotatePoint(p).z * scale);
}`;

const nodeVertex = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_corner;
layout(location=1) in vec3 a_position;
layout(location=2) in float a_radius;
layout(location=3) in vec3 a_color;
layout(location=4) in float a_id;
uniform float u_focus;
uniform sampler2D u_neighbors;
uniform int u_textureWidth;
out vec2 v_corner;
out vec4 v_color;
${projection}
void main() {
  bool focused = a_id == u_focus;
  int index = int(a_id) - 1;
  bool neighbor = texelFetch(u_neighbors, ivec2(index % u_textureWidth, index / u_textureWidth), 0).r > 0.0;
  float perspective = perspectiveFor(a_position);
  float radius = max(1.0, a_radius * perspective * sqrt(u_camera.z)) * (focused ? 1.5 : 1.0);
  v_corner = a_corner;
  v_color = vec4(focused ? vec3(1.0) : a_color, u_focus > 0.0 && !focused && !neighbor ? 0.2 : clamp(perspective, 0.4, 1.0));
  gl_Position = projectPoint(a_position, a_corner * radius);
}`;
const nodeFragment = `#version 300 es
precision highp float;
in vec2 v_corner;
in vec4 v_color;
out vec4 color;
void main() {
  float radius = length(v_corner);
  if (radius > 1.0) discard;
  color = vec4(v_color.rgb, v_color.a * (1.0 - smoothstep(0.88, 1.0, radius)));
}`;
const edgeVertex = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_corner;
layout(location=1) in vec3 a_start;
layout(location=2) in vec3 a_end;
layout(location=3) in vec2 a_ids;
layout(location=4) in float a_derived;
uniform float u_focus;
out vec4 v_color;
${projection}
void main() {
  bool incident = u_focus > 0.0 && (a_ids.x == u_focus || a_ids.y == u_focus);
  vec3 base = a_derived > 0.5 ? vec3(0.220, 0.314, 0.408) : vec3(0.125, 0.200, 0.263);
  v_color = vec4(incident ? vec3(0.596, 0.855, 0.980) : u_focus > 0.0 ? vec3(0.078, 0.125, 0.169) : base, 1.0);
  vec4 a = projectPoint(a_start, vec2(0.0)), b = projectPoint(a_end, vec2(0.0));
  vec2 delta = (b.xy - a.xy) * u_viewport * vec2(0.5, -0.5);
  vec2 normal = vec2(-delta.y, delta.x) / max(0.001, length(delta));
  gl_Position = mix(a, b, (a_corner.x + 1.0) * 0.5);
  gl_Position.xy += normal * a_corner.y * (incident ? 1.15 : 0.55) / u_viewport * vec2(1.0, -1.0);
  gl_Position.z += 0.0001;
}`;
const edgeFragment = `#version 300 es
precision highp float;
in vec4 v_color;
out vec4 color;
void main() { color = v_color; }`;

type Program = { program: WebGLProgram; uniforms: Map<string, WebGLUniformLocation> };
type TimerExtension = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };

/** Native WebGL2: two draw calls for the graph; no scene graph or render dependency. */
export class MemoryWebGLRenderer {
  readonly gl: WebGL2RenderingContext;
  private programs: Program[] = [];
  private buffers: WebGLBuffer[] = [];
  private vaos: WebGLVertexArrayObject[] = [];
  private nodeProgram: Program;
  private edgeProgram: Program;
  private nodeVao: WebGLVertexArrayObject;
  private edgeVao: WebGLVertexArrayObject;
  private nodeBuffer: WebGLBuffer;
  private edgeBuffer: WebGLBuffer;
  private neighbors: WebGLTexture;
  private neighborPixels = new Uint8Array(1);
  private neighborWidth = 1;
  private focus: string | null = null;
  private data: MemoryRenderData | null = null;
  private destroyed = false;
  private timer: TimerExtension | null;
  private timerQuery: WebGLQuery | null = null;
  gpuMs: number | null = null;

  /** Allocate shaders and instanced geometry; release partial allocations if setup fails. */
  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.timer = gl.getExtension("EXT_disjoint_timer_query_webgl2") as TimerExtension | null;
    try {
      this.nodeProgram = this.createProgram(nodeVertex, nodeFragment);
      this.edgeProgram = this.createProgram(edgeVertex, edgeFragment);
      this.nodeVao = this.createVao(); gl.bindVertexArray(this.nodeVao);
      const corners = this.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, corners);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      this.nodeBuffer = this.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeBuffer);
      for (const [location, count, offset] of [[1, 3, 0], [2, 1, 12], [3, 3, 16], [4, 1, 28]]) {
        gl.enableVertexAttribArray(location!); gl.vertexAttribPointer(location!, count!, gl.FLOAT, false, 32, offset!); gl.vertexAttribDivisor(location!, 1);
      }
      this.edgeVao = this.createVao(); gl.bindVertexArray(this.edgeVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, corners);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      this.edgeBuffer = this.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeBuffer);
      for (const [location, count, offset] of [[1, 3, 0], [2, 3, 12], [3, 2, 24], [4, 1, 32]]) {
        gl.enableVertexAttribArray(location!); gl.vertexAttribPointer(location!, count!, gl.FLOAT, false, 36, offset!); gl.vertexAttribDivisor(location!, 1);
      }
      gl.bindVertexArray(null);
      this.neighbors = this.createTexture();
    } catch (error) { this.dispose(); throw error; }
  }

  /** Register allocated buffers so partial initialization can dispose them safely. */
  private createBuffer() {
    const buffer = this.gl.createBuffer();
    if (!buffer) throw new Error("Unable to allocate memory GPU buffer");
    this.buffers.push(buffer); return buffer;
  }
  /** Register vertex arrays for the same ownership lifetime as this renderer. */
  private createVao() {
    const vao = this.gl.createVertexArray();
    if (!vao) throw new Error("Unable to allocate memory vertex array");
    this.vaos.push(vao); return vao;
  }
  /** Create the unfiltered, clamped neighbor-membership lookup texture. */
  private createTexture() {
    const gl = this.gl, texture = gl.createTexture();
    if (!texture) throw new Error("Unable to allocate memory GPU texture");
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }
  /** Link one shader pair, deleting intermediate shaders on both success and failure. */
  private createProgram(vertex: string, fragment: string): Program {
    const gl = this.gl, shaders: WebGLShader[] = [];
    const program = gl.createProgram();
    if (!program) throw new Error("Unable to allocate memory shader program");
    try {
      for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
        const shader = gl.createShader(type);
        if (!shader) throw new Error("Unable to allocate memory shader");
        shaders.push(shader); gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "Memory shader compilation failed");
        gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "Memory shader linking failed");
      const result = { program, uniforms: new Map<string, WebGLUniformLocation>() }; this.programs.push(result); return result;
    } catch (error) { gl.deleteProgram(program); throw error; }
    finally { for (const shader of shaders) gl.deleteShader(shader); }
  }
  /** Cache active uniform locations while allowing uniforms optimized out by the driver. */
  private uniform(program: Program, name: string) {
    let location = program.uniforms.get(name);
    if (location === undefined) {
      const found = this.gl.getUniformLocation(program.program, name);
      if (found !== null) { location = found; program.uniforms.set(name, location); }
    }
    return location ?? null;
  }
  /** Upload a prepared snapshot once and reset neighbor state for its node indices. */
  setData(data: MemoryRenderData) {
    const gl = this.gl;
    if (this.destroyed || gl.isContextLost()) return;
    const finishProfile = memoryProfilePhase("gpu-upload");
    try {
      this.data = data; this.focus = null;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeBuffer); gl.bufferData(gl.ARRAY_BUFFER, data.nodeBuffer, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeBuffer); gl.bufferData(gl.ARRAY_BUFFER, data.edgeBuffer, gl.STATIC_DRAW);
      this.neighborWidth = Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number);
      const height = Math.max(1, Math.ceil(data.nodes.length / this.neighborWidth));
      this.neighborPixels = new Uint8Array(this.neighborWidth * height);
      gl.bindTexture(gl.TEXTURE_2D, this.neighbors); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, this.neighborWidth, height, 0, gl.RED, gl.UNSIGNED_BYTE, this.neighborPixels);
    } finally { finishProfile(); }
  }
  /** Change neighbor membership only when focus changes, without rebuilding geometry. */
  private setFocus(focus: string | null) {
    if (this.focus === focus) return;
    const data = this.data!, gl = this.gl;
    if (this.focus) for (const id of data.adjacency.get(this.focus) ?? []) this.neighborPixels[data.byId.get(id)!.index] = 0;
    if (focus) for (const id of data.adjacency.get(focus) ?? []) this.neighborPixels[data.byId.get(id)!.index] = 255;
    this.focus = focus;
    gl.bindTexture(gl.TEXTURE_2D, this.neighbors);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.neighborWidth, this.neighborPixels.length / this.neighborWidth, gl.RED, gl.UNSIGNED_BYTE, this.neighborPixels);
  }
  /** Bind camera and focus uniforms shared by node and edge draw calls. */
  private common(program: Program, camera: MemoryCamera3D, width: number, height: number, focus: string | null) {
    const gl = this.gl;
    gl.useProgram(program.program);
    gl.uniform2f(this.uniform(program, "u_viewport"), width, height);
    gl.uniform3f(this.uniform(program, "u_camera"), camera.yaw, camera.pitch, camera.zoom);
    gl.uniform1f(this.uniform(program, "u_extent"), this.data!.extent);
    gl.uniform1f(this.uniform(program, "u_focus"), focus ? (this.data!.byId.get(focus)?.index ?? -1) + 1 : 0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.neighbors);
    gl.uniform1i(this.uniform(program, "u_neighbors"), 0); gl.uniform1i(this.uniform(program, "u_textureWidth"), this.neighborWidth);
  }
  /** Submit one camera frame and read any completed GPU timer without waiting for the GPU. */
  render(camera: MemoryCamera3D, width: number, height: number, focus: string | null) {
    if (!this.data || this.destroyed || this.gl.isContextLost()) return;
    const gl = this.gl; this.setFocus(focus);
    if (this.timer && this.timerQuery && gl.getQueryParameter(this.timerQuery, gl.QUERY_RESULT_AVAILABLE)) {
      this.gpuMs = gl.getParameter(this.timer.GPU_DISJOINT_EXT) ? null : Number(gl.getQueryParameter(this.timerQuery, gl.QUERY_RESULT)) / 1_000_000;
      gl.deleteQuery(this.timerQuery); this.timerQuery = null;
    }
    let timing = false;
    if (this.timer && !this.timerQuery) {
      this.timerQuery = gl.createQuery();
      if (this.timerQuery) { gl.beginQuery(this.timer.TIME_ELAPSED_EXT, this.timerQuery); timing = true; }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.common(this.edgeProgram, camera, width, height, focus); gl.bindVertexArray(this.edgeVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.data.edges.length);
    this.common(this.nodeProgram, camera, width, height, focus); gl.bindVertexArray(this.nodeVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.data.nodes.length); gl.bindVertexArray(null);
    if (timing) gl.endQuery(this.timer!.TIME_ELAPSED_EXT);
  }
  /** Idempotently release GPU resources owned by this renderer, including timer queries. */
  dispose() {
    if (this.destroyed) return;
    this.destroyed = true;
    const gl = this.gl;
    for (const buffer of this.buffers) gl.deleteBuffer(buffer);
    for (const vao of this.vaos) gl.deleteVertexArray(vao);
    for (const entry of this.programs) gl.deleteProgram(entry.program);
    if (this.timerQuery) gl.deleteQuery(this.timerQuery);
    if (this.neighbors!) gl.deleteTexture(this.neighbors);
    this.data = null;
  }
}
