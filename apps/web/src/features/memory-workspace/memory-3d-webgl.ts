import type { MemoryCamera3D } from "./memory-3d.js";
import { memoryExtent, type MemoryRenderModel } from "./memory-3d-model.js";
import { MemorySpatialIndex } from "./memory-3d-picking.js";

// Match projectMemoryPoint. Camera changes update uniforms, not 50k CPU projections.
const cameraShader = `
uniform vec2 u_view;
uniform mat3 u_rotation;
uniform float u_zoom;
uniform float u_extent;
vec4 projectPoint(vec3 p) {
  vec3 rotated = u_rotation * p;
  float scale = min(u_view.x, u_view.y) * 0.4 / u_extent;
  float perspective = 650.0 / max(120.0, 650.0 + rotated.z * scale);
  return vec4(rotated.xy * scale * u_zoom * perspective * 2.0 / u_view,
    clamp(rotated.z / u_extent * 0.8, -0.99, 0.99), perspective);
}`;

const nodeVertex = `#version 300 es
precision highp float;
layout(location=0) in vec3 a_position;
layout(location=1) in vec3 a_color;
layout(location=2) in float a_radius;
layout(location=3) in float a_neighbor;
uniform int u_focus;
out vec2 v_disc;
out vec4 v_color;
${cameraShader}
void main() {
  vec2 quad[4] = vec2[4](vec2(-1,-1), vec2(1,-1), vec2(-1,1), vec2(1,1));
  vec4 p = projectPoint(a_position);
  bool focused = gl_InstanceID == u_focus;
  float radius = max(1.0, a_radius * p.w * sqrt(u_zoom)) * (focused ? 1.5 : 1.0);
  v_disc = quad[gl_VertexID];
  gl_Position = vec4(p.xy + v_disc * radius * 2.0 / u_view, p.z, 1.0);
  float alpha = u_focus >= 0 && !focused && a_neighbor < 0.5 ? 0.2 : clamp(p.w, 0.4, 1.0);
  v_color = vec4(focused ? vec3(1) : a_color, alpha);
}`;
const nodeFragment = `#version 300 es
precision highp float;
precision highp int;
in vec2 v_disc;
in vec4 v_color;
out vec4 color;
void main() {
  float radius = length(v_disc);
  if (radius > 1.0) discard;
  color = vec4(v_color.rgb, v_color.a * (1.0 - smoothstep(0.85, 1.0, radius)));
}`;
const edgeVertex = `#version 300 es
precision highp float;
precision highp int;
layout(location=0) in ivec2 a_indices;
layout(location=1) in float a_kind;
uniform sampler2D u_positions;
uniform int u_focus;
out vec4 v_color;
${cameraShader}
void main() {
  int index = a_indices.x;
  vec3 position = texelFetch(u_positions, ivec2(index & 1023, index >> 10), 0).xyz;
  vec4 point = projectPoint(position);
  gl_Position = vec4(point.xyz, 1.0);
  bool incident = a_indices.x == u_focus || a_indices.y == u_focus;
  vec3 base = a_kind > 0.5 ? vec3(0.22,0.31,0.41) : vec3(0.125,0.2,0.263);
  v_color = vec4(incident ? vec3(0.596,0.855,0.98) : u_focus >= 0 ? vec3(0.078,0.125,0.169) : base, 1.0);
}`;
const edgeFragment = `#version 300 es
precision highp float;
in vec4 v_color;
out vec4 color;
void main() { color = v_color; }`;

/** A WebGL2 renderer owns every GPU resource it creates. No new render dependency. */
export class MemoryWebGLRenderer {
  private readonly nodeProgram: WebGLProgram;
  private readonly edgeProgram: WebGLProgram;
  private readonly nodeVao: WebGLVertexArrayObject;
  private readonly edgeVao: WebGLVertexArrayObject;
  private readonly buffers: WebGLBuffer[] = [];
  private readonly shaders: WebGLShader[] = [];
  private readonly uniforms = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  private readonly positions: WebGLBuffer;
  private readonly neighborBuffer: WebGLBuffer;
  private readonly positionTexture: WebGLTexture;
  private readonly picking = new MemorySpatialIndex();
  private readonly rotation = new Float32Array(9);
  private readonly textureWidth: number;
  private textureData = new Float32Array(0);
  private neighborData = new Float32Array(0);
  private focus = -1;
  private width = 1;
  private height = 1;
  private model: MemoryRenderModel | null = null;

  constructor(private readonly gl: WebGL2RenderingContext) {
    const object = <T,>(value: T | null): T => { if (!value) throw new Error("WebGL resource allocation failed"); return value; };
    this.nodeProgram = this.program(nodeVertex, nodeFragment);
    this.edgeProgram = this.program(edgeVertex, edgeFragment);
    this.nodeVao = object(gl.createVertexArray());
    this.edgeVao = object(gl.createVertexArray());
    this.positions = this.buffer();
    const styles = this.buffer();
    this.neighborBuffer = this.buffer();
    gl.bindVertexArray(this.nodeVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positions);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0); gl.vertexAttribDivisor(0, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, styles);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 16, 0); gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 16, 12); gl.vertexAttribDivisor(2, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.neighborBuffer);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 4, 0); gl.vertexAttribDivisor(3, 1);
    gl.bindVertexArray(this.edgeVao);
    const edgeIndices = this.buffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, edgeIndices);
    gl.enableVertexAttribArray(0); gl.vertexAttribIPointer(0, 2, gl.INT, 8, 0);
    const edgeKinds = this.buffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, edgeKinds);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 4, 0);
    gl.bindVertexArray(null);
    // WebGL2 guarantees at least 2048. A fixed power-of-two row lets the
    // vertex shader address 50k endpoints without integer division.
    this.textureWidth = 1024;
    this.positionTexture = object(gl.createTexture());
    for (const texture of [this.positionTexture]) {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
  }

  private buffer(): WebGLBuffer {
    const buffer = this.gl.createBuffer();
    if (!buffer) throw new Error("WebGL buffer allocation failed");
    this.buffers.push(buffer); return buffer;
  }
  private program(vertex: string, fragment: string): WebGLProgram {
    const gl = this.gl, program = gl.createProgram();
    if (!program) throw new Error("WebGL program allocation failed");
    for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("WebGL shader allocation failed");
      this.shaders.push(shader); gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "WebGL shader failed");
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "WebGL link failed");
    return program;
  }
  private uniform(program: WebGLProgram, name: string) {
    let cache = this.uniforms.get(program);
    if (!cache) { cache = new Map(); this.uniforms.set(program, cache); }
    if (!cache.has(name)) cache.set(name, this.gl.getUniformLocation(program, name));
    return cache.get(name)!;
  }
  setModel(model: MemoryRenderModel) {
    const gl = this.gl;
    this.model = model; this.focus = -1;
    // A single vertex batch avoids 150k two-vertex instances on integrated GPUs.
    // Both endpoints carry the pair so focus highlighting remains branch-free.
    const edgeVertices = new Int32Array(model.edgeIndices.length * 2);
    const edgeKinds = new Float32Array(model.edgeKinds.length * 2);
    for (let i = 0; i < model.edgeKinds.length; i++) {
      const a = model.edgeIndices[i * 2]!, b = model.edgeIndices[i * 2 + 1]!;
      edgeVertices.set([a, b, b, a], i * 4);
      edgeKinds[i * 2] = edgeKinds[i * 2 + 1] = model.edgeKinds[i]!;
    }
    for (const [buffer, data] of [[this.buffers[1]!, model.styles], [this.buffers[3]!, edgeVertices], [this.buffers[4]!, edgeKinds]] as const) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    }
    this.neighborData = new Float32Array(model.nodes.length);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.neighborBuffer); gl.bufferData(gl.ARRAY_BUFFER, this.neighborData, gl.DYNAMIC_DRAW);
    this.updatePositions(model.xyz);
  }
  updatePositions(xyz: Float32Array) {
    if (!this.model || xyz.length !== this.model.nodes.length * 3) return;
    const gl = this.gl;
    this.picking.invalidate();
    this.model.xyz = xyz; this.model.extent = memoryExtent(xyz);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positions); gl.bufferData(gl.ARRAY_BUFFER, xyz, gl.DYNAMIC_DRAW);
    const rows = Math.max(1, Math.ceil(this.model.nodes.length / this.textureWidth));
    if (this.textureData.length !== rows * this.textureWidth * 3) this.textureData = new Float32Array(rows * this.textureWidth * 3);
    this.textureData.set(xyz);
    gl.bindTexture(gl.TEXTURE_2D, this.positionTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB32F, this.textureWidth, rows, 0, gl.RGB, gl.FLOAT, this.textureData);
  }
  setFocus(focus: number) {
    if (focus === this.focus || !this.model) return;
    this.focus = focus; this.neighborData.fill(0);
    for (const i of this.model.neighbors.get(focus) ?? []) this.neighborData[i] = 1;
    if (focus >= 0 && this.model.neighborOffsets && this.model.neighborIndices) {
      const offsets = this.model.neighborOffsets, indices = this.model.neighborIndices;
      for (let i = offsets[focus]!; i < offsets[focus + 1]!; i++) this.neighborData[indices[i]!] = 1;
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.neighborBuffer); gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.neighborData);
  }
  resize(width: number, height: number) {
    this.width = Math.max(1, width); this.height = Math.max(1, height);
  }
  private camera(program: WebGLProgram, camera: MemoryCamera3D) {
    const gl = this.gl;
    gl.useProgram(program);
    gl.uniform2f(this.uniform(program, "u_view"), this.width, this.height);
    gl.uniformMatrix3fv(this.uniform(program, "u_rotation"), false, this.rotation);
    gl.uniform1f(this.uniform(program, "u_zoom"), camera.zoom);
    gl.uniform1f(this.uniform(program, "u_extent"), this.model!.extent);
    gl.uniform1i(this.uniform(program, "u_focus"), this.focus);
  }
  draw(camera: MemoryCamera3D) {
    if (!this.model || this.gl.isContextLost()) return;
    const gl = this.gl, count = this.model.nodes.length;
    const cy = Math.cos(camera.yaw), sy = Math.sin(camera.yaw), cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
    this.rotation.set([cy, sy * sp, -sy * cp, 0, cp, sp, sy, -cy * sp, cy * cp]);
    this.picking.rebuild(this.model, camera, this.width, this.height, this.focus);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.clearColor(0, 0, 0, 0); gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    // Seed depth with the node discs before rasterizing dense crossing lines.
    // This lets early depth rejection avoid shading edges hidden behind nodes.
    this.camera(this.nodeProgram, camera);
    gl.bindVertexArray(this.nodeVao); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    this.camera(this.edgeProgram, camera);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.positionTexture);
    gl.uniform1i(this.uniform(this.edgeProgram, "u_positions"), 0);
    gl.bindVertexArray(this.edgeVao); gl.drawArrays(gl.LINES, 0, this.model.edgeKinds.length * 2);
    gl.bindVertexArray(null);
  }
  pick(x: number, y: number): number {
    return this.model && !this.gl.isContextLost() ? this.picking.pick(x, y) : -1;
  }
  dispose() {
    const gl = this.gl;
    for (const buffer of this.buffers) gl.deleteBuffer(buffer);
    for (const shader of this.shaders) gl.deleteShader(shader);
    gl.deleteProgram(this.nodeProgram); gl.deleteProgram(this.edgeProgram);
    gl.deleteVertexArray(this.nodeVao); gl.deleteVertexArray(this.edgeVao);
    gl.deleteTexture(this.positionTexture);
  }
}
