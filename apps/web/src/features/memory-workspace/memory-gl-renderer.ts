import type { MemoryCamera3D } from "./memory-3d.js";
import { layoutExtent } from "./memory-camera.js";
import { renderKindsOf } from "./memory-picking.js";
import { buildAdjacency, EDGE_DERIVED, fillFocusStates, type MemoryAdjacency, type MemoryScene } from "./memory-scene.js";

export class ShaderError extends Error { constructor(message: string) { super(message); this.name = "ShaderError"; } }

// The projection below is line-for-line memory-camera.ts projectInto(); zoom is applied once, here.
const PROJECT = `
uniform vec4 uRot;   // cos(yaw), sin(yaw), cos(pitch), sin(pitch)
uniform vec4 uView;  // scale (extent normalized once), zoom, width, height in CSS px
uniform float uExtent;
vec4 project(vec3 m, out float persp) {
  float px = m.x * uRot.x + m.z * uRot.y;
  float depth = -m.x * uRot.y + m.z * uRot.x;
  float py = m.y * uRot.z - depth * uRot.w;
  float pz = m.y * uRot.w + depth * uRot.z;
  persp = 650.0 / max(120.0, 650.0 + pz * uView.x);
  vec2 screen = vec2(uView.z * 0.5 + px * uView.x * uView.y * persp, uView.w * 0.5 - py * uView.x * uView.y * persp);
  return vec4(screen, clamp(pz / uExtent, -1.0, 1.0) * 0.98, 1.0);
}
vec4 toClip(vec2 screen, float z) { return vec4(screen.x / uView.z * 2.0 - 1.0, 1.0 - screen.y / uView.w * 2.0, z, 1.0); }
`;
const NODE_VERT = `#version 300 es
precision highp float;
layout(location=0) in vec2 aCorner;
layout(location=1) in vec3 aPos;
layout(location=2) in vec4 aColorKind;
layout(location=3) in float aState;
uniform float uHasFocus;
${PROJECT}
out vec2 vOffset; out vec3 vColor; out float vAlpha; out float vRadius; out float vGlow;
void main() {
  float persp; vec4 p = project(aPos, persp);
  float kind = floor(aColorKind.a * 255.0 + 0.5);
  float base = kind > 1.5 ? 10.0 : (kind > 0.5 ? 4.6 : 2.1);
  bool focused = aState > 1.5 && aState < 2.5;
  float radius = max(1.0, base * persp * sqrt(uView.y)) * (focused ? 1.5 : 1.0);
  float glow = (kind > 1.5 || focused) ? 1.0 : 0.0;
  float reach = radius * (1.0 + glow * 1.6) + 2.0;
  gl_Position = toClip(p.xy + aCorner * reach, p.z);
  vOffset = aCorner * reach; vRadius = radius; vGlow = glow;
  vColor = focused ? vec3(1.0) : aColorKind.rgb;
  vAlpha = (uHasFocus > 0.5 && aState > 0.5 && aState < 1.5) ? 0.2 : clamp(persp, 0.4, 1.0);
}`;
const NODE_FRAG = `#version 300 es
precision highp float;
in vec2 vOffset; in vec3 vColor; in float vAlpha; in float vRadius; in float vGlow;
out vec4 outColor;
void main() {
  float d = length(vOffset);
  float aa = max(fwidth(d), 0.75);
  float body = 1.0 - smoothstep(vRadius - aa, vRadius + aa, d);
  float halo = vGlow * 0.45 * exp(-max(d - vRadius, 0.0) / (vRadius * 0.7 + 1.0)) * (1.0 - smoothstep(vRadius * 2.4, vRadius * 2.6, d));
  float a = body + (1.0 - body) * halo;
  if (a < 0.02) discard;
  float alpha = a * vAlpha;
  outColor = vec4(vColor * alpha, alpha);
}`;
const EDGE_VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
${PROJECT}
void main() { float persp; vec4 p = project(aPos, persp); gl_Position = toClip(p.xy, p.z); }`;
const EDGE_FRAG = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 outColor;
void main() { outColor = vec4(uColor.rgb * uColor.a, uColor.a); }`;

const EDGE_COLORS = { other: [0x20, 0x33, 0x43], derived: [0x38, 0x50, 0x68], dim: [0x14, 0x20, 0x2b], incident: [0x98, 0xda, 0xfa] } as const;
const rgba = (c: readonly number[], a: number): [number, number, number, number] => [c[0]! / 255, c[1]! / 255, c[2]! / 255, a];

function compile(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source); gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new ShaderError(gl.getShaderInfoLog(shader) ?? "shader compile failed");
  return shader;
}
function link(gl: WebGL2RenderingContext, vertex: string, fragment: string) {
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertex)); gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new ShaderError(gl.getProgramInfoLog(program) ?? "program link failed");
  return program;
}

/** Instanced nodes plus batched edges. Camera changes touch uniforms only; focus changes re-upload a node-state byte array and one small index list. */
export class MemoryGLRenderer {
  private gl: WebGL2RenderingContext;
  private nodeProgram: WebGLProgram; private edgeProgram: WebGLProgram;
  private nodeVao: WebGLVertexArrayObject; private edgeVaos: WebGLVertexArrayObject[] = [];
  private cornerBuffer: WebGLBuffer; private positionBuffer: WebGLBuffer; private colorBuffer: WebGLBuffer; private stateBuffer: WebGLBuffer;
  private indexBuffers: WebGLBuffer[] = []; // other, derived, incident
  private indexCounts = [0, 0, 0];
  private scene: MemoryScene | null = null; private adjacency: MemoryAdjacency | null = null;
  private states = new Uint8Array(0); private interleaved = new Float32Array(0);
  private focus = -1;
  extent = 60;
  private disposed = false;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: true, depth: true, premultipliedAlpha: true });
    if (!gl) throw new Error("WebGL2 is unavailable.");
    this.gl = gl;
    this.loseContextExtension = gl.getExtension("WEBGL_lose_context");
    this.nodeProgram = link(gl, NODE_VERT, NODE_FRAG); this.edgeProgram = link(gl, EDGE_VERT, EDGE_FRAG);
    const buffer = () => gl.createBuffer()!;
    this.cornerBuffer = buffer(); this.positionBuffer = buffer(); this.colorBuffer = buffer(); this.stateBuffer = buffer();
    this.indexBuffers = [buffer(), buffer(), buffer()];
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.nodeVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.nodeVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuffer); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0); gl.vertexAttribDivisor(1, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer); gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 0, 0); gl.vertexAttribDivisor(2, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.stateBuffer); gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.UNSIGNED_BYTE, false, 0, 0); gl.vertexAttribDivisor(3, 1);
    for (const index of this.indexBuffers) {
      const vao = gl.createVertexArray()!; gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index);
      this.edgeVaos.push(vao);
    }
    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  get contextLost() { return this.gl.isContextLost(); }
  /** Held from creation: a lost context no longer hands out extensions, and restoring needs this object. */
  readonly loseContextExtension: WEBGL_lose_context | null;

  /** Uploads everything that does not change while the layout streams: colors, kinds and edge index lists. */
  setScene(scene: MemoryScene) {
    const gl = this.gl;
    this.scene = scene; this.adjacency = buildAdjacency(scene); this.focus = -1;
    const kinds = renderKindsOf(scene), colorKind = new Uint8Array(scene.count * 4);
    for (let i = 0; i < scene.count; i++) { colorKind[i * 4] = scene.rgb[i * 3]!; colorKind[i * 4 + 1] = scene.rgb[i * 3 + 1]!; colorKind[i * 4 + 2] = scene.rgb[i * 3 + 2]!; colorKind[i * 4 + 3] = kinds[i]!; }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer); gl.bufferData(gl.ARRAY_BUFFER, colorKind, gl.STATIC_DRAW);
    this.states = new Uint8Array(scene.count);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.stateBuffer); gl.bufferData(gl.ARRAY_BUFFER, this.states, gl.DYNAMIC_DRAW);
    this.interleaved = new Float32Array(scene.count * 3);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer); gl.bufferData(gl.ARRAY_BUFFER, this.interleaved, gl.DYNAMIC_DRAW);
    let derived = 0; for (let e = 0; e < scene.edgeCount; e++) if (scene.edgeKind[e] === EDGE_DERIVED) derived++;
    const other = new Uint32Array((scene.edgeCount - derived) * 2), derivedIdx = new Uint32Array(derived * 2);
    let o = 0, d = 0;
    for (let e = 0; e < scene.edgeCount; e++) {
      if (scene.edgeKind[e] === EDGE_DERIVED) { derivedIdx[d++] = scene.edgeSource[e]!; derivedIdx[d++] = scene.edgeTarget[e]!; }
      else { other[o++] = scene.edgeSource[e]!; other[o++] = scene.edgeTarget[e]!; }
    }
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffers[0]!); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, other, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffers[1]!); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, derivedIdx, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffers[2]!); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(0), gl.DYNAMIC_DRAW);
    this.indexCounts = [other.length, derivedIdx.length, 0];
  }

  /** One layout snapshot: converts to float32, uploads once, and refreshes the single extent used for normalization. */
  setPositions(x: Float64Array, y: Float64Array, z: Float64Array) {
    const count = Math.min(this.scene?.count ?? 0, x.length), out = this.interleaved;
    for (let i = 0; i < count; i++) { out[i * 3] = x[i]!; out[i * 3 + 1] = y[i]!; out[i * 3 + 2] = z[i]!; }
    this.extent = layoutExtent(x, y, z, count);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.positionBuffer);
    this.gl.bufferSubData(this.gl.ARRAY_BUFFER, 0, out);
  }

  /** Re-uploads node states and the focused node's edge list only when the focus actually changed. */
  setFocus(index: number) {
    if (index === this.focus || !this.scene || !this.adjacency) return;
    const gl = this.gl;
    this.focus = index;
    fillFocusStates(this.states, this.adjacency, index);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.stateBuffer); gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.states);
    const incident = index < 0 ? new Uint32Array(0) : new Uint32Array((this.adjacency.offsets[index + 1]! - this.adjacency.offsets[index]!) * 2);
    if (index >= 0) for (let k = this.adjacency.offsets[index]!, i = 0; k < this.adjacency.offsets[index + 1]!; k++) {
      const e = this.adjacency.edges[k]!; incident[i++] = this.scene.edgeSource[e]!; incident[i++] = this.scene.edgeTarget[e]!;
    }
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffers[2]!); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, incident, gl.DYNAMIC_DRAW);
    this.indexCounts[2] = incident.length;
  }

  render(camera: MemoryCamera3D, width: number, height: number, dpr: number) {
    const gl = this.gl;
    if (this.disposed || gl.isContextLost() || !this.scene) return;
    const pixelWidth = Math.max(1, Math.round(width * dpr)), pixelHeight = Math.max(1, Math.round(height * dpr));
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) { this.canvas.width = pixelWidth; this.canvas.height = pixelHeight; }
    gl.viewport(0, 0, pixelWidth, pixelHeight);
    gl.clearColor(0, 0, 0, 0); gl.clearDepth(1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const scale = Math.min(width, height) * 0.4 / this.extent, hasFocus = this.focus >= 0 ? 1 : 0;
    const setUniforms = (program: WebGLProgram) => {
      gl.useProgram(program);
      gl.uniform4f(gl.getUniformLocation(program, "uRot"), Math.cos(camera.yaw), Math.sin(camera.yaw), Math.cos(camera.pitch), Math.sin(camera.pitch));
      gl.uniform4f(gl.getUniformLocation(program, "uView"), scale, camera.zoom, width, height);
      gl.uniform1f(gl.getUniformLocation(program, "uExtent"), this.extent);
    };
    setUniforms(this.edgeProgram);
    const color = gl.getUniformLocation(this.edgeProgram, "uColor");
    const draw = (slot: number, c: [number, number, number, number]) => {
      if (!this.indexCounts[slot]) return;
      gl.uniform4f(color, ...c); gl.bindVertexArray(this.edgeVaos[slot]!);
      gl.drawElements(gl.LINES, this.indexCounts[slot]!, gl.UNSIGNED_INT, 0);
    };
    draw(0, rgba(hasFocus ? EDGE_COLORS.dim : EDGE_COLORS.other, 0.8));
    draw(1, rgba(hasFocus ? EDGE_COLORS.dim : EDGE_COLORS.derived, 0.8));
    draw(2, rgba(EDGE_COLORS.incident, 1));
    setUniforms(this.nodeProgram);
    gl.uniform1f(gl.getUniformLocation(this.nodeProgram, "uHasFocus"), hasFocus);
    gl.bindVertexArray(this.nodeVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.scene.count);
    gl.bindVertexArray(null);
  }

  /** Blocks until the GPU finished the submitted frame (1-pixel readback). Benchmarks only: it defeats pipelining. */
  finish() { const gl = this.gl; gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.syncPixel); }
  private syncPixel = new Uint8Array(4);

  /** Releases every GPU object; safe to call on a lost context and more than once. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    for (const buffer of [this.cornerBuffer, this.positionBuffer, this.colorBuffer, this.stateBuffer, ...this.indexBuffers]) gl.deleteBuffer(buffer);
    gl.deleteVertexArray(this.nodeVao); for (const vao of this.edgeVaos) gl.deleteVertexArray(vao);
    gl.deleteProgram(this.nodeProgram); gl.deleteProgram(this.edgeProgram);
  }
}
