import type { MemoryCamera3D } from "./memory-3d.js";

/**
 * WebGL2 renderer for the 3D memory graph.
 *
 * Replaces the per-frame Canvas 2D work (CPU projection of every node, a full
 * depth sort, one path per edge, `arc()` per node, linear-scan hit testing)
 * with GPU equivalents that keep the same projection math and look:
 *
 * - Nodes are instanced quads; positions live in a float texture that both
 *   shaders fetch by node index, so a layout update uploads positions once.
 * - Edges are one batched `LINES` draw fed from the same position texture.
 * - Depth is resolved by the depth buffer, not a CPU sort.
 * - Picking renders the node pass into an offscreen buffer with each node
 *   flat-colored by its encoded index; one `readPixels` returns the nearest
 *   node at the pointer.
 *
 * No rendering library is used; WebGL2 is enough for points and lines.
 */

export interface MemoryGraphGLNodeInput {
  /** CSS color, e.g. "#7395ad". */
  color: string;
  /** Base radius in CSS pixels before perspective/zoom (10 core, 4.6 source, 2.1 other). */
  radius: number;
  /** Core nodes get the soft halo the Canvas renderer drew with shadowBlur. */
  glow: boolean;
  /** Nodes without a 3D position yet are neither drawn nor pickable. */
  present: boolean;
}

export interface MemoryGraphGLEdgeInput {
  a: number;
  b: number;
  /** CSS color for the un-highlighted state. */
  color: string;
}

/** Parses "#rrggbb" into [r, g, b] floats in 0..1. */
export function parseHexColor(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  if (!Number.isFinite(value)) return [0, 0, 0];
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

/**
 * Picking encodes node index + 1 across the RGB bytes (0 means "no node"),
 * so up to 16,777,215 nodes are addressable.
 */
export function encodePickId(index: number): [number, number, number] {
  const value = index + 1;
  return [value & 255, (value >> 8) & 255, (value >> 16) & 255];
}

export function decodePickId(r: number, g: number, b: number): number {
  const value = r + g * 256 + b * 65536;
  return value - 1;
}

const PROJECTION_GLSL = /* glsl */ `
uniform sampler2D uPositions;
uniform vec2 uViewport;
uniform vec2 uCenter;
uniform float uScale;
uniform float uPixelRatio;
uniform float uZoom;
uniform float uExtent;
uniform vec4 uRotation;

vec3 nodePosition(int index) {
  int texWidth = textureSize(uPositions, 0).x;
  return texelFetch(uPositions, ivec2(index % texWidth, index / texWidth), 0).xyz;
}

// Mirrors projectMemoryPoint in memory-3d.ts exactly, in device pixels.
vec3 projectPoint(vec3 p, out float perspective, out float viewZ) {
  float x = p.x * uRotation.x + p.z * uRotation.y;
  float depth = -p.x * uRotation.y + p.z * uRotation.x;
  float y = p.y * uRotation.z - depth * uRotation.w;
  float z = p.y * uRotation.w + depth * uRotation.z;
  perspective = 650.0 / max(120.0, 650.0 + z * uScale);
  viewZ = z;
  return vec3(uCenter + vec2(x, -y) * (uScale * uZoom * perspective * uPixelRatio), z);
}

vec4 clipPosition(vec3 projected) {
  float clipZ = clamp(projected.z / max(uExtent, 1.0), -1.0, 1.0);
  return vec4(projected.x / uViewport.x * 2.0 - 1.0, 1.0 - projected.y / uViewport.y * 2.0, clipZ, 1.0);
}
`;

const NODE_VERTEX_GLSL = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
${PROJECTION_GLSL}
uniform float uPickMode;
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec3 aColor;
layout(location = 2) in float aRadius;
layout(location = 3) in float aGlow;
layout(location = 4) in float aState;
out vec3 vColor;
out vec2 vLocal;
out float vAlpha;
out float vGlow;
out float vPickId;

void main() {
  vPickId = float(gl_InstanceID);
  vColor = vec3(0.0);
  vLocal = vec2(0.0);
  vAlpha = 0.0;
  vGlow = 0.0;
  if (aRadius <= 0.0) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  float perspective;
  float viewZ;
  vec3 projected = projectPoint(nodePosition(gl_InstanceID), perspective, viewZ);
  bool focus = aState > 0.5 && aState < 1.5;
  float radius = max(1.0, aRadius * perspective * sqrt(uZoom)) * uPixelRatio;
  if (focus) radius *= 1.5;
  float glow = (aGlow > 0.5 || focus) ? 1.0 : 0.0;
  float quadRadius = radius * (glow > 0.5 ? 2.3 : 1.0);
  if (uPickMode > 0.5) quadRadius = max(radius, 7.0 * uPixelRatio) + 3.0 * uPixelRatio;
  vec3 device = vec3(projected.xy + aCorner * quadRadius, projected.z);
  gl_Position = clipPosition(device);
  vLocal = aCorner * (quadRadius / radius);
  vColor = focus ? vec3(1.0) : aColor;
  vAlpha = aState > 2.5 ? 0.2 : clamp(perspective, 0.4, 1.0);
  vGlow = glow;
}
`;

const NODE_FRAGMENT_GLSL = /* glsl */ `#version 300 es
precision highp float;
uniform float uPickMode;
in vec3 vColor;
in vec2 vLocal;
in float vAlpha;
in float vGlow;
in float vPickId;
out vec4 fragColor;

void main() {
  if (uPickMode > 0.5) {
    float value = vPickId + 1.0;
    fragColor = vec4(mod(value, 256.0) / 255.0, mod(floor(value / 256.0), 256.0) / 255.0, floor(value / 65536.0) / 255.0, 1.0);
    return;
  }
  float d = length(vLocal);
  float disc = 1.0 - smoothstep(0.88, 1.0, d);
  float halo = vGlow * 0.55 * pow(clamp(1.0 - d / 2.3, 0.0, 1.0), 2.0);
  float alpha = max(disc, halo) * vAlpha;
  if (alpha < 0.004) discard;
  fragColor = vec4(vColor, alpha);
}
`;

const EDGE_VERTEX_GLSL = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
${PROJECTION_GLSL}
layout(location = 0) in float aIndex;
layout(location = 1) in vec3 aColor;
layout(location = 2) in float aState;
out vec3 vColor;

void main() {
  float perspective;
  float viewZ;
  vec3 projected = projectPoint(nodePosition(int(aIndex + 0.5)), perspective, viewZ);
  gl_Position = clipPosition(projected);
  vColor = aState > 0.5 && aState < 1.5
    ? vec3(0.596, 0.855, 0.980)
    : aState > 1.5 ? vec3(0.078, 0.125, 0.169) : aColor;
}
`;

const EDGE_FRAGMENT_GLSL = /* glsl */ `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 fragColor;

void main() {
  fragColor = vec4(vColor, 1.0);
}
`;

interface ProgramInfo {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

const SHARED_UNIFORMS = ["uPositions", "uViewport", "uCenter", "uScale", "uPixelRatio", "uZoom", "uExtent", "uRotation"] as const;

export class MemoryGraphGLRenderer {
  private gl: WebGL2RenderingContext;
  private nodeProgram: ProgramInfo;
  private edgeProgram: ProgramInfo;
  private nodeVao: WebGLVertexArrayObject | null = null;
  private edgeVao: WebGLVertexArrayObject | null = null;
  private nodeBuffers: WebGLBuffer[] = [];
  private edgeBuffers: WebGLBuffer[] = [];
  private positionTexture: WebGLTexture | null = null;
  private positionData = new Float32Array(0);
  private positionTexWidth = 1;
  private nodeStateBuffer: WebGLBuffer | null = null;
  private edgeStateBuffer: WebGLBuffer | null = null;
  private nodeCount = 0;
  private edgeVertexCount = 0;
  private edgePairs = new Int32Array(0);
  private pickFramebuffer: WebGLFramebuffer | null = null;
  private pickColor: WebGLTexture | null = null;
  private pickDepth: WebGLRenderbuffer | null = null;
  private pickWidth = 0;
  private pickHeight = 0;
  private disposed = false;

  private constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { alpha: true, antialias: true, depth: true, premultipliedAlpha: false });
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
    this.nodeProgram = this.createProgram(NODE_VERTEX_GLSL, NODE_FRAGMENT_GLSL, [...SHARED_UNIFORMS, "uPickMode"]);
    this.edgeProgram = this.createProgram(EDGE_VERTEX_GLSL, EDGE_FRAGMENT_GLSL, [...SHARED_UNIFORMS]);
  }

  /** Creates a renderer, or returns null when WebGL2 is unavailable. */
  static tryCreate(canvas: HTMLCanvasElement): MemoryGraphGLRenderer | null {
    try {
      return new MemoryGraphGLRenderer(canvas);
    } catch {
      return null;
    }
  }

  private createProgram(vertexSource: string, fragmentSource: string, uniformNames: string[]): ProgramInfo {
    const gl = this.gl;
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(`Memory graph shader failed to compile: ${log ?? "unknown error"}`);
      }
      return shader;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Memory graph program failed to link: ${gl.getProgramInfoLog(program) ?? "unknown error"}`);
    }
    const uniforms: Record<string, WebGLUniformLocation | null> = {};
    for (const name of uniformNames) uniforms[name] = gl.getUniformLocation(program, name);
    return { program, uniforms };
  }

  private buffer(data: BufferSource, usage: number): WebGLBuffer {
    const gl = this.gl;
    const handle = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, handle);
    gl.bufferData(gl.ARRAY_BUFFER, data, usage);
    return handle;
  }

  /** Loads graph topology and styling; positions arrive via updatePositions. */
  setGraph(nodes: MemoryGraphGLNodeInput[], edges: MemoryGraphGLEdgeInput[]): void {
    const gl = this.gl;
    this.nodeCount = nodes.length;
    // Position texture: one RGBA float texel per node (xyz + unused w).
    this.positionTexWidth = Math.min(2048, Math.max(1, Math.ceil(Math.sqrt(Math.max(1, nodes.length)))));
    const texHeight = Math.max(1, Math.ceil(nodes.length / this.positionTexWidth));
    this.positionData = new Float32Array(this.positionTexWidth * texHeight * 4);
    if (this.positionTexture) gl.deleteTexture(this.positionTexture);
    this.positionTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.positionTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, this.positionTexWidth, texHeight, 0, gl.RGBA, gl.FLOAT, this.positionData);

    // Node VAO: static quad corners plus one instanced attribute set per node.
    // Deleting the VAO does not free its buffers, so drop the previous
    // generation explicitly before rebuilding.
    if (this.nodeVao) gl.deleteVertexArray(this.nodeVao);
    for (const handle of this.nodeBuffers) gl.deleteBuffer(handle);
    this.nodeBuffers = [];
    this.nodeVao = gl.createVertexArray();
    gl.bindVertexArray(this.nodeVao);
    const corners = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    const cornersBuffer = this.buffer(corners, gl.STATIC_DRAW);
    this.nodeBuffers.push(cornersBuffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, cornersBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const colors = new Float32Array(nodes.length * 3);
    const radii = new Float32Array(nodes.length);
    const glows = new Float32Array(nodes.length);
    nodes.forEach((node, i) => {
      const [r, g, b] = parseHexColor(node.color);
      colors[i * 3] = r; colors[i * 3 + 1] = g; colors[i * 3 + 2] = b;
      radii[i] = node.present ? node.radius : 0;
      glows[i] = node.glow ? 1 : 0;
    });
    const bindInstanced = (location: number, size: number, data: Float32Array<ArrayBuffer>, usage: number) => {
      const handle = this.buffer(data, usage);
      this.nodeBuffers.push(handle);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(location, 1);
      return handle;
    };
    bindInstanced(1, 3, colors, gl.STATIC_DRAW);
    bindInstanced(2, 1, radii, gl.STATIC_DRAW);
    bindInstanced(3, 1, glows, gl.STATIC_DRAW);
    this.nodeStateBuffer = bindInstanced(4, 1, new Float32Array(nodes.length), gl.DYNAMIC_DRAW);

    this.setEdges(edges);
    gl.bindVertexArray(null);
  }

  /** Rebuilds only the edge buffers (e.g. when the positioned set changes). */
  setEdges(edges: MemoryGraphGLEdgeInput[]): void {
    const gl = this.gl;
    // The edge VAO is reused across rebuilds, so its old buffers must be
    // deleted explicitly; deleting the VAO would not free them either.
    for (const handle of this.edgeBuffers) gl.deleteBuffer(handle);
    this.edgeBuffers = [];
    // Edge VAO: two vertices per edge, endpoint indices into the position texture.
    if (!this.edgeVao) this.edgeVao = gl.createVertexArray();
    gl.bindVertexArray(this.edgeVao);
    this.edgePairs = new Int32Array(edges.length * 2);
    const indices = new Float32Array(edges.length * 2);
    const edgeColors = new Float32Array(edges.length * 2 * 3);
    edges.forEach((edge, i) => {
      this.edgePairs[i * 2] = edge.a;
      this.edgePairs[i * 2 + 1] = edge.b;
      indices[i * 2] = edge.a;
      indices[i * 2 + 1] = edge.b;
      const [r, g, b] = parseHexColor(edge.color);
      for (const vertex of [i * 2, i * 2 + 1]) {
        edgeColors[vertex * 3] = r; edgeColors[vertex * 3 + 1] = g; edgeColors[vertex * 3 + 2] = b;
      }
    });
    this.edgeVertexCount = edges.length * 2;
    const bindEdge = (location: number, size: number, data: Float32Array<ArrayBuffer>, usage: number) => {
      const handle = this.buffer(data, usage);
      this.edgeBuffers.push(handle);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
      return handle;
    };
    bindEdge(0, 1, indices, gl.STATIC_DRAW);
    bindEdge(1, 3, edgeColors, gl.STATIC_DRAW);
    this.edgeStateBuffer = bindEdge(2, 1, new Float32Array(edges.length * 2), gl.DYNAMIC_DRAW);
    gl.bindVertexArray(null);
  }

  /** Uploads xyz triplets in node order (the layout order). */
  updatePositions(positions: Float32Array): void {
    const gl = this.gl;
    const count = Math.min(this.nodeCount, Math.floor(positions.length / 3));
    for (let i = 0; i < count; i++) {
      this.positionData[i * 4] = positions[i * 3]!;
      this.positionData[i * 4 + 1] = positions[i * 3 + 1]!;
      this.positionData[i * 4 + 2] = positions[i * 3 + 2]!;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.positionTexture);
    const texHeight = Math.max(1, Math.ceil(Math.max(1, this.nodeCount) / this.positionTexWidth));
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.positionTexWidth, texHeight, gl.RGBA, gl.FLOAT, this.positionData);
  }

  /**
   * Focus/neighbor highlighting, mirroring the Canvas renderer: the focus
   * node is white and enlarged, its incident edges light up, and unrelated
   * nodes and edges dim. Uploads only small state attributes.
   */
  setFocus(focusIndex: number, neighbors: ReadonlySet<number> | null): void {
    const gl = this.gl;
    const nodeStates = new Float32Array(this.nodeCount);
    const edgeStates = new Float32Array(this.edgeVertexCount);
    if (focusIndex >= 0) {
      for (let i = 0; i < this.nodeCount; i++) {
        nodeStates[i] = i === focusIndex ? 1 : neighbors?.has(i) ? 2 : 3;
      }
      for (let vertex = 0; vertex < this.edgeVertexCount; vertex += 2) {
        const incident = this.edgePairs[vertex] === focusIndex || this.edgePairs[vertex + 1] === focusIndex;
        edgeStates[vertex] = incident ? 1 : 2;
        edgeStates[vertex + 1] = edgeStates[vertex]!;
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeStateBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, nodeStates);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeStateBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, edgeStates);
  }

  private setSharedUniforms(info: ProgramInfo, camera: MemoryCamera3D, scale: number, extent: number, pixelRatio: number): void {
    const gl = this.gl;
    const u = info.uniforms;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.positionTexture);
    gl.uniform1i(u.uPositions!, 0);
    gl.uniform2f(u.uViewport!, this.canvas.width, this.canvas.height);
    gl.uniform2f(u.uCenter!, this.canvas.width / 2, this.canvas.height / 2);
    gl.uniform1f(u.uScale!, scale);
    gl.uniform1f(u.uPixelRatio!, pixelRatio);
    gl.uniform1f(u.uZoom!, camera.zoom);
    gl.uniform1f(u.uExtent!, extent);
    gl.uniform4f(u.uRotation!, Math.cos(camera.yaw), Math.sin(camera.yaw), Math.cos(camera.pitch), Math.sin(camera.pitch));
  }

  render(camera: MemoryCamera3D, scale: number, extent: number, pixelRatio: number): void {
    if (this.disposed || this.nodeCount === 0) return;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    // Batched edges first; they never write depth, so nodes always draw over them.
    gl.disable(gl.BLEND);
    gl.depthMask(false);
    gl.useProgram(this.edgeProgram.program);
    this.setSharedUniforms(this.edgeProgram, camera, scale, extent, pixelRatio);
    gl.bindVertexArray(this.edgeVao);
    gl.drawArrays(gl.LINES, 0, this.edgeVertexCount);
    // Instanced nodes with GPU depth ordering and alpha blending.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(true);
    gl.useProgram(this.nodeProgram.program);
    this.setSharedUniforms(this.nodeProgram, camera, scale, extent, pixelRatio);
    gl.uniform1f(this.nodeProgram.uniforms.uPickMode!, 0);
    gl.bindVertexArray(this.nodeVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.nodeCount);
    gl.bindVertexArray(null);
  }

  /**
   * GPU picking: renders the node pass with index-encoded colors into an
   * offscreen buffer and reads the single device pixel under the pointer.
   * The depth buffer makes the nearest node win, like the Canvas renderer's
   * draw order. Returns the node index, or -1.
   */
  pick(cssX: number, cssY: number, camera: MemoryCamera3D, scale: number, extent: number, pixelRatio: number): number {
    if (this.disposed || this.nodeCount === 0) return -1;
    const gl = this.gl;
    const width = this.canvas.width, height = this.canvas.height;
    if (this.pickWidth !== width || this.pickHeight !== height) {
      if (this.pickFramebuffer) gl.deleteFramebuffer(this.pickFramebuffer);
      if (this.pickColor) gl.deleteTexture(this.pickColor);
      if (this.pickDepth) gl.deleteRenderbuffer(this.pickDepth);
      this.pickColor = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.pickColor);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      this.pickDepth = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.pickDepth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
      this.pickFramebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFramebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.pickColor, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.pickDepth);
      this.pickWidth = width;
      this.pickHeight = height;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFramebuffer);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.useProgram(this.nodeProgram.program);
    this.setSharedUniforms(this.nodeProgram, camera, scale, extent, pixelRatio);
    gl.uniform1f(this.nodeProgram.uniforms.uPickMode!, 1);
    gl.bindVertexArray(this.nodeVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.nodeCount);
    const deviceX = Math.min(width - 1, Math.max(0, Math.round(cssX * pixelRatio)));
    const deviceY = Math.min(height - 1, Math.max(0, height - 1 - Math.round(cssY * pixelRatio)));
    const pixel = new Uint8Array(4);
    gl.readPixels(deviceX, deviceY, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return decodePickId(pixel[0]!, pixel[1]!, pixel[2]!);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    if (gl.isContextLost()) return;
    if (this.positionTexture) gl.deleteTexture(this.positionTexture);
    if (this.pickColor) gl.deleteTexture(this.pickColor);
    if (this.pickDepth) gl.deleteRenderbuffer(this.pickDepth);
    if (this.pickFramebuffer) gl.deleteFramebuffer(this.pickFramebuffer);
    if (this.nodeVao) gl.deleteVertexArray(this.nodeVao);
    if (this.edgeVao) gl.deleteVertexArray(this.edgeVao);
    for (const handle of this.nodeBuffers) gl.deleteBuffer(handle);
    this.nodeBuffers = [];
    for (const handle of this.edgeBuffers) gl.deleteBuffer(handle);
    this.edgeBuffers = [];
    gl.deleteProgram(this.nodeProgram.program);
    gl.deleteProgram(this.edgeProgram.program);
  }
}
