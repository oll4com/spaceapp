import type { MemoryCameraUniforms } from "./memory-3d-view.js";

export type MemoryGLGraph = {
  count: number;
  /** RGBA per node. */
  colors: Uint8Array;
  /** 0 other, 1 source, 2 core source. */
  kinds: Uint8Array;
  /** Source and target node index per edge. */
  edgeEnds: Uint32Array;
  /** 1 for DERIVED_FROM edges (drawn lighter), else 0. */
  edgeKinds: Uint8Array;
};

const TEXTURE_WIDTH = 1024;

// Positions live in a float texture, so streaming a layout update is one texSubImage2D and the
// vertex shaders of nodes, edges and picking all read the same data. Projection mirrors
// `projectMemoryPoint`; depth is resolved by the GPU depth buffer.
const COMMON = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uPos;
uniform vec4 uRot;
uniform vec4 uView;
uniform float uDepthRange;
vec3 fetchPos(int i) { return texelFetch(uPos, ivec2(i & 1023, i >> 10), 0).xyz; }
vec4 project(vec3 p) {
  float x = p.x * uRot.x + p.z * uRot.y;
  float d = -p.x * uRot.y + p.z * uRot.x;
  float y = p.y * uRot.z - d * uRot.w;
  float z = p.y * uRot.w + d * uRot.z;
  float persp = 650.0 / max(120.0, 650.0 + z * uView.x);
  return vec4(x * uView.x * uView.y * persp / uView.z, y * uView.x * uView.y * persp / uView.w, clamp(z / uDepthRange, -1.0, 1.0), persp);
}
`;

const NODE_ATTRIBUTES = `
layout(location = 0) in vec4 aColor;
layout(location = 1) in float aKind;
layout(location = 2) in float aFlag;
uniform float uZoomSqrt;
uniform float uFocusActive;
uniform float uPickMode;
`;

const NODE_VS = COMMON + NODE_ATTRIBUTES + `
out vec4 vColor;
out vec2 vOffset;
out float vRadius;
out float vGlow;
void main() {
  vec4 c = project(fetchPos(gl_InstanceID));
  bool focused = aFlag > 1.5;
  float base = aKind > 1.5 ? 10.0 : (aKind > 0.5 ? 4.6 : 2.1);
  float radius = max(1.0, base * c.w * uZoomSqrt) * (focused ? 1.5 : 1.0);
  bool glow = uPickMode < 0.5 && (focused || aKind > 1.5);
  float alpha = (uFocusActive > 0.5 && !focused && aFlag < 0.5) ? 0.2 : max(0.4, min(1.0, c.w));
  // Same hit area as the Canvas 2D renderer: at least 7 px.
  if (uPickMode > 0.5) radius = max(7.0, radius + 3.0);
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0;
  float extent = (glow ? radius + 14.0 : radius) + 1.0;
  gl_Position = vec4(c.xy + corner * extent / uView.zw, c.z, 1.0);
  vOffset = corner * extent;
  vRadius = radius;
  vGlow = glow ? 1.0 : 0.0;
  // Pick mode carries the node id (index + 1) in the color.
  int id = gl_InstanceID + 1;
  vColor = uPickMode > 0.5
    ? vec4(float(id & 255) / 255.0, float((id >> 8) & 255) / 255.0, float((id >> 16) & 255) / 255.0, 1.0)
    : vec4(focused ? vec3(1.0) : aColor.rgb, alpha);
}
`;

const NODE_FS = `#version 300 es
precision highp float;
uniform float uPickMode;
in vec4 vColor;
in vec2 vOffset;
in float vRadius;
in float vGlow;
out vec4 outColor;
void main() {
  float d = length(vOffset);
  if (uPickMode > 0.5) {
    if (d > vRadius) discard;
    outColor = vColor;
    return;
  }
  float disc = 1.0 - smoothstep(vRadius - 0.75, vRadius + 0.5, d);
  float halo = vGlow * (1.0 - smoothstep(vRadius, vRadius + 13.0, d)) * 0.35;
  float a = max(disc, halo);
  if (a < 0.02) discard;
  outColor = vec4(vColor.rgb, vColor.a * a);
}
`;

const EDGE_VS = COMMON + `
layout(location = 0) in uvec2 aEdge;
layout(location = 1) in float aEdgeKind;
uniform int uFocus;
out vec4 vColor;
void main() {
  int node = int((gl_VertexID & 1) == 0 ? aEdge.x : aEdge.y);
  vec4 c = project(fetchPos(node));
  bool incident = uFocus >= 0 && (int(aEdge.x) == uFocus || int(aEdge.y) == uFocus);
  vColor = incident ? vec4(0.596, 0.855, 0.980, 1.0)
    : uFocus >= 0 ? vec4(0.078, 0.125, 0.169, 1.0)
    : aEdgeKind > 0.5 ? vec4(0.220, 0.314, 0.408, 1.0) : vec4(0.125, 0.200, 0.263, 1.0);
  gl_Position = vec4(c.xy, 0.0, 1.0);
}
`;

const EDGE_FS = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 outColor;
void main() { outColor = vColor; }
`;

type Program = { program: WebGLProgram; uniforms: Map<string, WebGLUniformLocation | null> };

/** WebGL2 renderer: instanced node quads, instanced line edges, GPU depth and GPU picking. */
export class MemoryWebGLRenderer {
  /** Called when the context is lost, and after it was restored and all resources rebuilt. */
  onContextLost: () => void = () => {};
  onContextRestored: () => void = () => {};
  private gl: WebGL2RenderingContext;
  private lost = false;
  /** True while no layout exists yet: the canvas is cleared and nothing is drawn or picked. */
  hidden = false;
  private graph: MemoryGLGraph | null = null;
  private positions = new Float32Array(0);
  private flags = new Uint8Array(0);
  private nodeProgram!: Program;
  private edgeProgram!: Program;
  private nodeVao!: WebGLVertexArrayObject;
  private edgeVao!: WebGLVertexArrayObject;
  private buffers: WebGLBuffer[] = [];
  private flagBuffer!: WebGLBuffer;
  private texture!: WebGLTexture;
  private textureRows = 0;
  private pickFramebuffer!: WebGLFramebuffer;
  private pickRenderbuffers: WebGLRenderbuffer[] = [];
  private readonly pixel = new Uint8Array(4);

  private constructor(private readonly canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.build();
    canvas.addEventListener("webglcontextlost", this.handleLost);
    canvas.addEventListener("webglcontextrestored", this.handleRestored);
  }

  /** Null when WebGL2 is unavailable or its shaders cannot be built. */
  static create(canvas: HTMLCanvasElement): MemoryWebGLRenderer | null {
    try {
      const gl = canvas.getContext("webgl2", { alpha: true, antialias: false, depth: true, premultipliedAlpha: true });
      return gl ? new MemoryWebGLRenderer(canvas, gl) : null;
    } catch {
      return null;
    }
  }

  get isLost() { return this.lost; }

  setGraph(graph: MemoryGLGraph) {
    this.graph = graph;
    this.flags = new Uint8Array(graph.count);
    this.positions = new Float32Array(graph.count * 3);
    if (!this.lost) this.uploadGraph();
  }

  /** x,y,z per node, in the order of the graph's nodes. */
  setPositions(positions: Float32Array) {
    this.positions = positions;
    if (!this.lost) this.uploadPositions();
  }

  /** 0 normal, 1 neighbor of the focus, 2 focus. */
  setFlags(flags: Uint8Array) {
    this.flags = flags;
    if (this.lost) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.flagBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, flags);
  }

  resize(width: number, height: number, dpr: number) {
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
  }

  draw(camera: MemoryCameraUniforms, focusIndex: number) {
    if (this.lost || !this.graph) return;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (this.hidden) return;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    // Edges first, without depth: they always sit under the nodes, as in the Canvas 2D look.
    gl.disable(gl.DEPTH_TEST);
    this.use(this.edgeProgram, camera);
    gl.uniform1i(this.edgeProgram.uniforms.get("uFocus")!, focusIndex);
    gl.bindVertexArray(this.edgeVao);
    if (this.graph.edgeKinds.length) gl.drawArraysInstanced(gl.LINES, 0, 2, this.graph.edgeKinds.length);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    this.use(this.nodeProgram, camera);
    this.nodeUniforms(camera, focusIndex >= 0, false);
    gl.bindVertexArray(this.nodeVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.graph.count);
    gl.bindVertexArray(null);
  }

  /**
   * Index of the front-most node under a CSS-pixel position, or -1. The scene is rendered with
   * node ids as colors into a 1x1 framebuffer whose viewport is shifted so that the pointer pixel
   * lands on it: one cheap draw and a single-pixel read, independent of the node count.
   */
  pick(camera: MemoryCameraUniforms, x: number, y: number, cssHeight: number): number {
    if (this.lost || this.hidden || !this.graph) return -1;
    const gl = this.gl;
    const scale = this.canvas.height / Math.max(1, cssHeight);
    const px = Math.floor(x * scale), py = Math.floor((cssHeight - y) * scale);
    if (px < 0 || py < 0 || px >= this.canvas.width || py >= this.canvas.height) return -1;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFramebuffer);
    gl.viewport(-px, -py, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    this.use(this.nodeProgram, camera);
    this.nodeUniforms(camera, false, true);
    gl.bindVertexArray(this.nodeVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.graph.count);
    gl.bindVertexArray(null);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.pixel);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const id = this.pixel[0]! | (this.pixel[1]! << 8) | (this.pixel[2]! << 16);
    return id - 1;
  }

  dispose() {
    this.canvas.removeEventListener("webglcontextlost", this.handleLost);
    this.canvas.removeEventListener("webglcontextrestored", this.handleRestored);
    this.release();
  }

  private handleLost = (event: Event) => {
    // Preventing the default is what allows the browser to restore the context later.
    event.preventDefault();
    this.lost = true;
    this.onContextLost();
  };

  private handleRestored = () => {
    this.lost = false;
    this.buffers = [];
    this.build();
    if (this.graph) { this.uploadGraph(); this.uploadPositions(); this.setFlags(this.flags); }
    this.onContextRestored();
  };

  private compile(vertex: string, fragment: string): Program {
    const gl = this.gl;
    const program = gl.createProgram()!;
    for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "shader failed");
      gl.attachShader(program, shader);
      gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "program failed");
    return { program, uniforms: new Map() };
  }

  private build() {
    const gl = this.gl;
    this.nodeProgram = this.compile(NODE_VS, NODE_FS);
    this.edgeProgram = this.compile(EDGE_VS, EDGE_FS);
    for (const p of [this.nodeProgram, this.edgeProgram]) {
      const count = gl.getProgramParameter(p.program, gl.ACTIVE_UNIFORMS) as number;
      for (let i = 0; i < count; i++) {
        const name = gl.getActiveUniform(p.program, i)!.name;
        p.uniforms.set(name, gl.getUniformLocation(p.program, name));
      }
    }
    this.nodeVao = gl.createVertexArray()!;
    this.edgeVao = gl.createVertexArray()!;
    this.texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.textureRows = 0;
    this.pickFramebuffer = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFramebuffer);
    const color = gl.createRenderbuffer()!, depth = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, color);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, 1, 1);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, 1, 1);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.pickRenderbuffers = [color, depth];
  }

  private release() {
    if (this.lost) return;
    const gl = this.gl;
    gl.deleteProgram(this.nodeProgram.program);
    gl.deleteProgram(this.edgeProgram.program);
    gl.deleteVertexArray(this.nodeVao);
    gl.deleteVertexArray(this.edgeVao);
    gl.deleteTexture(this.texture);
    gl.deleteFramebuffer(this.pickFramebuffer);
    for (const buffer of this.buffers) gl.deleteBuffer(buffer);
    for (const buffer of this.pickRenderbuffers) gl.deleteRenderbuffer(buffer);
    this.buffers = [];
  }

  private buffer(target: number, data: ArrayBufferView, usage: number) {
    const gl = this.gl;
    const buffer = gl.createBuffer()!;
    gl.bindBuffer(target, buffer);
    gl.bufferData(target, data, usage);
    this.buffers.push(buffer);
    return buffer;
  }

  private uploadGraph() {
    const gl = this.gl, graph = this.graph!;
    for (const buffer of this.buffers) gl.deleteBuffer(buffer);
    this.buffers = [];
    gl.bindVertexArray(this.nodeVao);
    this.buffer(gl.ARRAY_BUFFER, graph.colors, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.UNSIGNED_BYTE, true, 0, 0);
    gl.vertexAttribDivisor(0, 1);
    this.buffer(gl.ARRAY_BUFFER, graph.kinds, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.UNSIGNED_BYTE, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);
    this.flagBuffer = this.buffer(gl.ARRAY_BUFFER, this.flags, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.UNSIGNED_BYTE, false, 0, 0);
    gl.vertexAttribDivisor(2, 1);
    gl.bindVertexArray(this.edgeVao);
    this.buffer(gl.ARRAY_BUFFER, graph.edgeEnds, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribIPointer(0, 2, gl.UNSIGNED_INT, 0, 0);
    gl.vertexAttribDivisor(0, 1);
    this.buffer(gl.ARRAY_BUFFER, graph.edgeKinds, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.UNSIGNED_BYTE, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);
    this.textureRows = 0;
    this.uploadPositions();
  }

  private uploadPositions() {
    if (!this.graph) return;
    const gl = this.gl;
    const rows = Math.max(1, Math.ceil(this.graph.count / TEXTURE_WIDTH));
    const padded = new Float32Array(TEXTURE_WIDTH * rows * 3);
    padded.set(this.positions.subarray(0, Math.min(this.positions.length, padded.length)));
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    if (rows !== this.textureRows) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB32F, TEXTURE_WIDTH, rows, 0, gl.RGB, gl.FLOAT, padded);
      this.textureRows = rows;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TEXTURE_WIDTH, rows, gl.RGB, gl.FLOAT, padded);
    }
  }

  private use(program: Program, camera: MemoryCameraUniforms) {
    const gl = this.gl, u = program.uniforms;
    gl.useProgram(program.program);
    gl.uniform1i(u.get("uPos")!, 0);
    gl.uniform4f(u.get("uRot")!, camera.cosYaw, camera.sinYaw, camera.cosPitch, camera.sinPitch);
    gl.uniform4f(u.get("uView")!, camera.scale, camera.zoom, camera.halfWidth, camera.halfHeight);
    gl.uniform1f(u.get("uDepthRange")!, camera.depthRange);
  }

  private nodeUniforms(camera: MemoryCameraUniforms, focusActive: boolean, pickMode: boolean) {
    const gl = this.gl, u = this.nodeProgram.uniforms;
    gl.uniform1f(u.get("uZoomSqrt")!, Math.sqrt(camera.zoom));
    gl.uniform1f(u.get("uFocusActive")!, focusActive ? 1 : 0);
    gl.uniform1f(u.get("uPickMode")!, pickMode ? 1 : 0);
  }
}
