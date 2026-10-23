import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import type { MemoryCamera3D, MemoryPoint3D } from "./memory-3d.js";

/**
 * Dependency-free WebGL2 renderer for the 3D memory graph.
 *
 * Nodes are instanced quads with an SDF disc in the fragment shader; edges
 * are one batched line draw (plus a small overlay draw for the focused
 * node's incident edges). Depth is resolved by the GPU depth buffer — the
 * vertex shader reproduces `projectMemoryPoint` exactly (same rotation,
 * same perspective curve), so CPU picking/labels and GPU pixels agree.
 * No per-frame CPU sorting or buffer rebuilding: static buffers upload when
 * the graph or layout changes, per-node state (focus/neighbor/dim) is a
 * small dynamic attribute, and the camera is uniforms only.
 */

export const MEMORY_GRAPH_GL_NODE_STATE = { NORMAL: 0, FOCUS: 1, NEIGHBOR: 2, DIMMED: 3 } as const;

export interface MemoryGraphGLScene {
  nodeCount: number;
  nodePositions: Float32Array;
  nodeColors: Float32Array;
  nodeRadii: Float32Array;
  nodeGlow: Float32Array;
  nodeStates: Float32Array;
  edgeCount: number;
  edgePositions: Float32Array;
  edgeColors: Float32Array;
  focusEdgeCount: number;
  focusEdgePositions: Float32Array;
  focusEdgeColors: Float32Array;
  /** Depth normalization range: max distance of any point from the origin. */
  extent: number;
}

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  if (Number.isNaN(value)) return [0.45, 0.58, 0.68];
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

const EDGE_COLORS = {
  incident: hexToRgb("#98dafa"),
  derived: hexToRgb("#385068"),
  standard: hexToRgb("#203343")
};

/** Brightness applied to non-incident edges while a node is focused: the
 * Canvas look swaps them for the near-background #14202b, which is the
 * standard edge color scaled toward the surface background. */
export const MEMORY_GRAPH_GL_FOCUSED_EDGE_BRIGHTNESS = 0.32;

/** Node radius in the current Canvas 2D look, before perspective/zoom. */
export function memoryGraphNodeBaseRadius(node: MemoryGraphNode): number {
  if (node.type === "SOURCE" && isMemoryCoreLabel(node.label)) return 10;
  return node.type === "SOURCE" ? 4.6 : 2.1;
}

export function buildMemoryGraphNodeStates(count: number, focusIndex: number, neighborIndices: ReadonlySet<number>): Float32Array {
  const states = new Float32Array(count);
  if (focusIndex < 0) return states;
  states.fill(MEMORY_GRAPH_GL_NODE_STATE.DIMMED);
  for (const index of neighborIndices) states[index] = MEMORY_GRAPH_GL_NODE_STATE.NEIGHBOR;
  states[focusIndex] = MEMORY_GRAPH_GL_NODE_STATE.FOCUS;
  return states;
}

/**
 * Build the GPU scene buffers from the same inputs the Canvas renderer
 * uses. Pure and allocation-explicit so it can be unit-tested and reused by
 * the benchmark harness. Focus is deliberately NOT baked in: it changes on
 * every hover, so it is applied through `buildMemoryGraphNodeStates`,
 * `buildMemoryGraphFocusEdges` and the edge-brightness uniform instead of
 * a scene rebuild.
 */
export function buildMemoryGraphGLScene(input: {
  nodes: readonly MemoryGraphNode[];
  edges: readonly MemoryGraphEdge[];
  coordinates: ReadonlyMap<string, MemoryPoint3D>;
  atlasPositions: ReadonlyMap<string, MemoryAtlasPosition>;
}): MemoryGraphGLScene {
  const { nodes, edges, coordinates, atlasPositions } = input;
  const nodePositions = new Float32Array(nodes.length * 3);
  const nodeColors = new Float32Array(nodes.length * 3);
  const nodeRadii = new Float32Array(nodes.length);
  const nodeGlow = new Float32Array(nodes.length);
  let extent = 60;
  nodes.forEach((node, i) => {
    const point = coordinates.get(node.id) ?? { x: 0, y: 0, z: 0 };
    nodePositions[i * 3] = point.x; nodePositions[i * 3 + 1] = point.y; nodePositions[i * 3 + 2] = point.z;
    extent = Math.max(extent, Math.hypot(point.x, point.y, point.z));
    const [r, g, b] = hexToRgb(atlasPositions.get(node.id)?.color ?? "#7395ad");
    nodeColors[i * 3] = r; nodeColors[i * 3 + 1] = g; nodeColors[i * 3 + 2] = b;
    nodeRadii[i] = memoryGraphNodeBaseRadius(node);
    nodeGlow[i] = node.type === "SOURCE" && isMemoryCoreLabel(node.label) ? 1 : 0;
  });
  const edgePositions: number[] = [];
  const edgeColors: number[] = [];
  for (const edge of edges) {
    const a = coordinates.get(edge.source), b = coordinates.get(edge.target);
    if (!a || !b) continue;
    const color = edge.type === "DERIVED_FROM" ? EDGE_COLORS.derived : EDGE_COLORS.standard;
    edgePositions.push(a.x, a.y, a.z, b.x, b.y, b.z);
    edgeColors.push(color[0], color[1], color[2], 1, color[0], color[1], color[2], 1);
  }
  return {
    nodeCount: nodes.length,
    nodePositions, nodeColors, nodeRadii, nodeGlow,
    nodeStates: new Float32Array(nodes.length),
    edgeCount: edgePositions.length / 6,
    edgePositions: new Float32Array(edgePositions),
    edgeColors: new Float32Array(edgeColors),
    focusEdgeCount: 0,
    focusEdgePositions: new Float32Array(0),
    focusEdgeColors: new Float32Array(0),
    extent
  };
}

/** The focused node's incident edges, drawn bright over the base pass. */
export function buildMemoryGraphFocusEdges(input: {
  edges: readonly MemoryGraphEdge[];
  coordinates: ReadonlyMap<string, MemoryPoint3D>;
  focusId: string | null;
}): { positions: Float32Array; colors: Float32Array; count: number; neighborIds: Set<string> } {
  const { edges, coordinates, focusId } = input;
  const positions: number[] = [];
  const colors: number[] = [];
  const neighborIds = new Set<string>();
  if (focusId) {
    for (const edge of edges) {
      if (edge.source !== focusId && edge.target !== focusId) continue;
      neighborIds.add(edge.source === focusId ? edge.target : edge.source);
      const a = coordinates.get(edge.source), b = coordinates.get(edge.target);
      if (!a || !b) continue;
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
      const color = EDGE_COLORS.incident;
      colors.push(color[0], color[1], color[2], 1, color[0], color[1], color[2], 1);
    }
  }
  return { positions: new Float32Array(positions), colors: new Float32Array(colors), count: positions.length / 6, neighborIds };
}

const NODE_VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_color;
layout(location = 2) in float a_radius;
layout(location = 3) in float a_glow;
layout(location = 4) in float a_state;
layout(location = 5) in vec2 a_corner;
uniform vec4 u_rotation;
uniform vec4 u_projection;
uniform vec2 u_viewport;
out vec3 v_color;
out vec2 v_uv;
out float v_alpha;
out float v_glow;
void main() {
  float x1 = a_position.x * u_rotation.x + a_position.z * u_rotation.y;
  float depth = -a_position.x * u_rotation.y + a_position.z * u_rotation.x;
  float y1 = a_position.y * u_rotation.z - depth * u_rotation.w;
  float z1 = a_position.y * u_rotation.w + depth * u_rotation.z;
  float scale = u_projection.x;
  float zoom = u_projection.y;
  float pixelRatio = u_projection.w;
  float perspective = 650.0 / max(120.0, 650.0 + z1 * scale);
  vec2 center = vec2(x1, y1) * scale * zoom * perspective * pixelRatio;
  float highlighted = a_state == 1.0 ? 1.0 : 0.0;
  float radius = max(1.0, a_radius * perspective * sqrt(zoom)) * (1.0 + 0.5 * highlighted);
  vec2 point = center + a_corner * radius * 1.9 * pixelRatio;
  gl_Position = vec4(point / (u_viewport * 0.5), clamp(z1 / u_projection.z, -1.0, 1.0), 1.0);
  v_uv = a_corner * 1.9;
  v_color = highlighted > 0.5 ? vec3(1.0) : a_color;
  v_alpha = a_state == 3.0 ? 0.2 : clamp(perspective, 0.4, 1.0);
  v_glow = max(a_glow, highlighted);
}
`;

const NODE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec3 v_color;
in vec2 v_uv;
in float v_alpha;
in float v_glow;
out vec4 fragColor;
void main() {
  float d = length(v_uv);
  float disc = smoothstep(1.0, 0.82, d);
  float halo = v_glow * smoothstep(1.9, 0.95, d) * 0.5;
  float alpha = max(disc, halo) * v_alpha;
  if (alpha < 0.004) discard;
  fragColor = vec4(v_color, alpha);
}
`;

const EDGE_VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec4 a_color;
uniform vec4 u_rotation;
uniform vec4 u_projection;
uniform vec2 u_viewport;
uniform float u_brightness;
out vec4 v_color;
void main() {
  float x1 = a_position.x * u_rotation.x + a_position.z * u_rotation.y;
  float depth = -a_position.x * u_rotation.y + a_position.z * u_rotation.x;
  float y1 = a_position.y * u_rotation.z - depth * u_rotation.w;
  float z1 = a_position.y * u_rotation.w + depth * u_rotation.z;
  float scale = u_projection.x;
  float zoom = u_projection.y;
  float perspective = 650.0 / max(120.0, 650.0 + z1 * scale);
  vec2 point = vec2(x1, y1) * scale * zoom * perspective * u_projection.w;
  gl_Position = vec4(point / (u_viewport * 0.5), clamp(z1 / u_projection.z, -1.0, 1.0), 1.0);
  v_color = vec4(a_color.rgb * u_brightness, a_color.a);
}
`;

const EDGE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec4 v_color;
out vec4 fragColor;
void main() { fragColor = v_color; }
`;

function compileProgram(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram | null {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { gl.deleteShader(shader); return null; }
    return shader;
  };
  const vertex = compile(gl.VERTEX_SHADER, vertexSource);
  const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
  if (!vertex || !fragment) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { gl.deleteProgram(program); return null; }
  return program;
}

interface ProgramUniforms { rotation: WebGLUniformLocation | null; projection: WebGLUniformLocation | null; viewport: WebGLUniformLocation | null; brightness: WebGLUniformLocation | null }

export class MemoryGraphWebGLRenderer {
  private gl: WebGL2RenderingContext | null;
  private nodeProgram: WebGLProgram | null = null;
  private edgeProgram: WebGLProgram | null = null;
  private nodeUniforms: ProgramUniforms | null = null;
  private edgeUniforms: ProgramUniforms | null = null;
  private nodeVao: WebGLVertexArrayObject | null = null;
  private edgeVao: WebGLVertexArrayObject | null = null;
  private focusEdgeVao: WebGLVertexArrayObject | null = null;
  private stateBuffer: WebGLBuffer | null = null;
  private buffers = new Set<WebGLBuffer>();
  private vaos = new Set<WebGLVertexArrayObject>();
  private focusBuffers: WebGLBuffer[] = [];
  private scene: MemoryGraphGLScene | null = null;
  private lost = false;
  private readonly onLost: () => void;
  private readonly onRestored: () => void;
  private readonly handleLost = (event: Event) => {
    event.preventDefault();
    this.lost = true;
    this.onLost();
  };
  private readonly handleRestored = () => {
    this.lost = false;
    if (this.init()) {
      const scene = this.scene;
      this.scene = null;
      if (scene) this.setScene(scene);
    }
    this.onRestored();
  };

  private constructor(private readonly canvas: HTMLCanvasElement, gl: WebGL2RenderingContext, onLost: () => void, onRestored: () => void) {
    this.gl = gl;
    this.onLost = onLost;
    this.onRestored = onRestored;
    canvas.addEventListener("webglcontextlost", this.handleLost);
    canvas.addEventListener("webglcontextrestored", this.handleRestored);
  }

  /** Returns null when WebGL2 is unavailable — the caller falls back to Canvas 2D. */
  static create(canvas: HTMLCanvasElement, onLost: () => void, onRestored: () => void): MemoryGraphWebGLRenderer | null {
    const gl = canvas.getContext("webgl2", { alpha: true, antialias: true, powerPreference: "high-performance" });
    if (!gl) return null;
    const renderer = new MemoryGraphWebGLRenderer(canvas, gl, onLost, onRestored);
    if (!renderer.init()) return null;
    return renderer;
  }

  get contextLost(): boolean { return this.lost; }

  private init(): boolean {
    const gl = this.canvas.getContext("webgl2");
    if (!gl) return false;
    this.gl = gl;
    this.nodeProgram = compileProgram(gl, NODE_VERTEX_SHADER, NODE_FRAGMENT_SHADER);
    this.edgeProgram = compileProgram(gl, EDGE_VERTEX_SHADER, EDGE_FRAGMENT_SHADER);
    if (!this.nodeProgram || !this.edgeProgram) return false;
    const uniforms = (program: WebGLProgram): ProgramUniforms => ({
      rotation: gl.getUniformLocation(program, "u_rotation"),
      projection: gl.getUniformLocation(program, "u_projection"),
      viewport: gl.getUniformLocation(program, "u_viewport"),
      brightness: gl.getUniformLocation(program, "u_brightness")
    });
    this.nodeUniforms = uniforms(this.nodeProgram);
    this.edgeUniforms = uniforms(this.edgeProgram);
    return true;
  }

  /** Delete every GL object owned by the current scene before replacing it. */
  private releaseSceneObjects(): void {
    const gl = this.gl;
    if (!gl) return;
    for (const handle of this.buffers) gl.deleteBuffer(handle);
    for (const vao of this.vaos) gl.deleteVertexArray(vao);
    this.buffers.clear();
    this.vaos.clear();
    this.focusBuffers = [];
    this.stateBuffer = null;
  }

  setScene(scene: MemoryGraphGLScene): void {
    this.scene = scene;
    const gl = this.gl;
    if (!gl || this.lost) return;
    this.releaseSceneObjects();
    const buffer = (data: Float32Array, usage: number = gl.STATIC_DRAW) => {
      const handle = gl.createBuffer();
      if (handle) this.buffers.add(handle);
      gl.bindBuffer(gl.ARRAY_BUFFER, handle);
      gl.bufferData(gl.ARRAY_BUFFER, data, usage);
      return handle;
    };
    const attribute = (vao: WebGLVertexArrayObject | null, location: number, size: number, handle: WebGLBuffer | null, divisor = 0) => {
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, handle);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
      if (divisor) gl.vertexAttribDivisor(location, divisor);
    };
    // Node VAO: instanced quad corners + per-instance attributes.
    this.nodeVao = gl.createVertexArray();
    if (this.nodeVao) this.vaos.add(this.nodeVao);
    const corners = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    attribute(this.nodeVao, 5, 2, buffer(corners));
    attribute(this.nodeVao, 0, 3, buffer(scene.nodePositions), 1);
    attribute(this.nodeVao, 1, 3, buffer(scene.nodeColors), 1);
    attribute(this.nodeVao, 2, 1, buffer(scene.nodeRadii), 1);
    attribute(this.nodeVao, 3, 1, buffer(scene.nodeGlow), 1);
    this.stateBuffer = buffer(scene.nodeStates, gl.DYNAMIC_DRAW);
    attribute(this.nodeVao, 4, 1, this.stateBuffer, 1);
    // Edge VAOs: plain per-vertex streams.
    const edgeVao = (positions: Float32Array, colors: Float32Array) => {
      const vao = gl.createVertexArray();
      if (vao) this.vaos.add(vao);
      attribute(vao, 0, 3, buffer(positions));
      attribute(vao, 1, 4, buffer(colors));
      return vao;
    };
    this.edgeVao = edgeVao(scene.edgePositions, scene.edgeColors);
    this.focusEdgeVao = edgeVao(scene.focusEdgePositions, scene.focusEdgeColors);
    gl.bindVertexArray(null);
  }

  /** Focus/neighbor changes only rewrite the small state attribute. */
  updateNodeStates(states: Float32Array): void {
    const gl = this.gl;
    if (!gl || this.lost || !this.stateBuffer) return;
    if (this.scene) this.scene = { ...this.scene, nodeStates: states };
    gl.bindBuffer(gl.ARRAY_BUFFER, this.stateBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, states, gl.DYNAMIC_DRAW);
  }

  /** Replace the focused node's incident-edge overlay (a tiny buffer). */
  setFocusEdges(positions: Float32Array, colors: Float32Array, count: number): void {
    const gl = this.gl;
    if (!gl || this.lost || !this.focusEdgeVao || !this.scene) return;
    this.scene = { ...this.scene, focusEdgePositions: positions, focusEdgeColors: colors, focusEdgeCount: count };
    for (const old of this.focusBuffers) { gl.deleteBuffer(old); this.buffers.delete(old); }
    this.focusBuffers = [];
    const upload = (location: number, size: number, data: Float32Array) => {
      const handle = gl.createBuffer();
      if (handle) { this.buffers.add(handle); this.focusBuffers.push(handle); }
      gl.bindVertexArray(this.focusEdgeVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, handle);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    };
    upload(0, 3, positions);
    upload(1, 4, colors);
    gl.bindVertexArray(null);
  }

  draw(camera: MemoryCamera3D, scale: number, width: number, height: number, edgeBrightness = 1): void {
    const gl = this.gl, scene = this.scene;
    if (!gl || this.lost || !scene || !this.nodeProgram || !this.edgeProgram) return;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    const rotation: [number, number, number, number] = [Math.cos(camera.yaw), Math.sin(camera.yaw), Math.cos(camera.pitch), Math.sin(camera.pitch)];
    // Projection math mirrors projectMemoryPoint in CSS pixels; the shader
    // additionally receives the pixel ratio and the device-pixel viewport so
    // positions land on the same pixels the CPU picker computes.
    const ratio = width > 0 ? gl.drawingBufferWidth / width : 1;
    const applyUniforms = (uniforms: ProgramUniforms | null) => {
      if (!uniforms) return;
      gl.uniform4f(uniforms.rotation, ...rotation);
      gl.uniform4f(uniforms.projection, scale, camera.zoom, Math.max(1, scene.extent * 2), ratio);
      gl.uniform2f(uniforms.viewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
    };
    gl.useProgram(this.edgeProgram);
    applyUniforms(this.edgeUniforms);
    if (this.edgeUniforms?.brightness) gl.uniform1f(this.edgeUniforms.brightness, edgeBrightness);
    gl.bindVertexArray(this.edgeVao);
    gl.drawArrays(gl.LINES, 0, scene.edgeCount * 2);
    if (this.edgeUniforms?.brightness) gl.uniform1f(this.edgeUniforms.brightness, 1);
    gl.bindVertexArray(this.focusEdgeVao);
    gl.drawArrays(gl.LINES, 0, scene.focusEdgeCount * 2);
    gl.useProgram(this.nodeProgram);
    applyUniforms(this.nodeUniforms);
    gl.bindVertexArray(this.nodeVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, scene.nodeCount);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    this.canvas.removeEventListener("webglcontextlost", this.handleLost);
    this.canvas.removeEventListener("webglcontextrestored", this.handleRestored);
    this.releaseSceneObjects();
    this.gl?.getExtension("WEBGL_lose_context")?.loseContext();
    this.gl = null;
  }
}
