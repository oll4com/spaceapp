import type { MemoryCamera3D } from "./memory-3d.js";
import { markMemoryNeighbors, MEMORY_TEXTURE_WIDTH, type MemoryGpuScene } from "./memory-gpu-scene.js";
import { MemoryPickIndex } from "./memory-pick-index.js";

const projection = `
uniform sampler2D u_positions;
uniform vec2 u_viewport;
uniform vec3 u_camera;
uniform float u_scale;
vec4 positionAt(int index) { return texelFetch(u_positions, ivec2(index % 256, index / 256), 0); }
vec4 project(vec3 point) {
  float cy = cos(u_camera.x), sy = sin(u_camera.x), cp = cos(u_camera.y), sp = sin(u_camera.y);
  float x = point.x * cy + point.z * sy;
  float d = -point.x * sy + point.z * cy;
  float y = point.y * cp - d * sp, z = point.y * sp + d * cp;
  float perspective = 650.0 / max(120.0, 650.0 + z * u_scale);
  return vec4(u_viewport * 0.5 + vec2(x, -y) * u_scale * u_camera.z * perspective,
    clamp(z * u_scale / (650.0 + max(u_viewport.x, u_viewport.y)), -0.99, 0.99), perspective);
}
vec2 clip(vec2 pixel) { return pixel / u_viewport * vec2(2.0, -2.0) + vec2(-1.0, 1.0); }
`;
const nodeVertex = `#version 300 es
precision highp float;
precision highp int;
${projection}
uniform sampler2D u_colors;
uniform sampler2D u_neighbors;
uniform int u_focus;
out vec2 v_local;
out vec4 v_color;
out float v_radius;
out float v_extent;
void main() {
  int index = gl_InstanceID;
  ivec2 address = ivec2(index % 256, index / 256);
  vec4 point = positionAt(index), color = texelFetch(u_colors, address, 0);
  vec4 p = project(point.xyz);
  bool focused = index == u_focus;
  float radius = max(1.0, point.w * p.w * sqrt(u_camera.z)) * (focused ? 1.5 : 1.0);
  float extent = radius + ((color.a > 0.0 || focused) ? 13.0 : 1.0);
  vec2 corner = vec2((gl_VertexID & 1) == 0 ? -1.0 : 1.0, gl_VertexID < 2 ? -1.0 : 1.0);
  vec2 pixel = p.xy + corner * extent;
  gl_Position = vec4(clip(pixel), p.z, 1.0);
  float alpha = u_focus >= 0 && !focused && texelFetch(u_neighbors, address, 0).r == 0.0 ? 0.2 : clamp(p.w, 0.4, 1.0);
  v_color = vec4(focused ? vec3(1.0) : color.rgb, alpha);
  v_radius = radius;
  v_extent = extent;
  v_local = corner;
}`;
const nodeFragment = `#version 300 es
precision highp float;
precision highp int;
in vec2 v_local;
in vec4 v_color;
in float v_radius;
in float v_extent;
uniform bool u_glowPass;
out vec4 outColor;
void main() {
  float distance = length(v_local) * v_extent;
  if (distance > v_extent) discard;
  if (!u_glowPass) {
    if (distance >= v_radius - 0.7) discard;
    outColor = v_color;
    return;
  }
  if (distance < v_radius - 0.7) discard;
  float solid = 1.0 - smoothstep(v_radius - 0.7, v_radius + 0.7, distance);
  float glow = v_extent > v_radius + 2.0 ? exp(-max(0.0, distance - v_radius) * 0.35) * 0.22 : 0.0;
  float alpha = max(solid, glow) * v_color.a;
  if (alpha < 0.01) discard;
  outColor = vec4(v_color.rgb, alpha);
}`;
const edgeVertex = `#version 300 es
precision highp float;
precision highp int;
${projection}
layout(location = 0) in vec2 a_endpoints;
layout(location = 1) in float a_derived;
uniform int u_focus;
// Actual framebuffer/CSS size, including fractional-DPR resize rounding.
uniform vec2 u_pixelRatio;
out vec2 v_edgeLocal;
flat out float v_edgeLength;
flat out vec4 v_color;
void main() {
  vec4 a = project(positionAt(int(a_endpoints.x)).xyz);
  vec4 b = project(positionAt(int(a_endpoints.y)).xyz);
  vec2 delta = (b.xy - a.xy) * u_pixelRatio;
  float edgeLength = length(delta);
  vec2 direction = edgeLength > 0.00001 ? delta / edgeLength : vec2(1.0, 0.0);
  vec2 normal = vec2(-direction.y, direction.x);
  bool atEnd = (gl_VertexID & 1) != 0;
  // A one-physical-pixel line has a half-pixel coverage fringe on every side.
  float along = atEnd ? edgeLength + 0.5 : -0.5;
  float across = gl_VertexID < 2 ? -1.0 : 1.0;
  vec2 pixel = a.xy + (direction * along + normal * across) / u_pixelRatio;
  // Edges draw before nodes against cleared depth and never write depth. Keep
  // the original endpoint depth range without introducing fragment-depth writes.
  gl_Position = vec4(clip(pixel), atEnd ? b.z : a.z, 1.0);
  v_edgeLocal = vec2(along, across);
  v_edgeLength = edgeLength;
  bool incident = int(a_endpoints.x) == u_focus || int(a_endpoints.y) == u_focus;
  vec3 color = incident ? vec3(0.596, 0.855, 0.98) : u_focus >= 0 ? vec3(0.078, 0.125, 0.169)
    : a_derived > 0.5 ? vec3(0.220, 0.314, 0.408) : vec3(0.125, 0.200, 0.263);
  v_color = vec4(color, incident ? 1.0 : 0.75);
}`;
const edgeFragment = `#version 300 es
precision highp float;
in vec2 v_edgeLocal;
flat in float v_edgeLength;
flat in vec4 v_color;
out vec4 outColor;
void main() {
  // True/near-zero projected segments have no visible length, not a square dot.
  if (v_edgeLength <= 0.00001) discard;
  // Box-filter coverage in the segment's physical-pixel frame. Interval overlap
  // keeps subpixel-length edges proportional instead of brightening their caps.
  float crossCoverage = clamp(1.0 - abs(v_edgeLocal.y), 0.0, 1.0);
  float endCoverage = clamp(min(v_edgeLocal.x + 0.5, v_edgeLength)
    - max(v_edgeLocal.x - 0.5, 0.0), 0.0, 1.0);
  float coverage = crossCoverage * endCoverage;
  if (coverage <= 0.0) discard;
  outColor = vec4(v_color.rgb, v_color.a * coverage);
}`;

type Program = { program: WebGLProgram; uniforms: Map<string, WebGLUniformLocation | null> };

/** Analytically antialiased edge quads and node/body halos share one position texture. */
export class MemoryWebGLRenderer {
  readonly gl: WebGL2RenderingContext;
  private programs: WebGLProgram[] = [];
  private textures: WebGLTexture[] = [];
  private buffers: WebGLBuffer[] = [];
  private arrays: WebGLVertexArrayObject[] = [];
  private node!: Program;
  private edge!: Program;
  private nodeArray!: WebGLVertexArrayObject;
  private edgeArray!: WebGLVertexArrayObject;
  private positions!: WebGLTexture;
  private colors!: WebGLTexture;
  private neighbors!: WebGLTexture;
  private edgeBuffer!: WebGLBuffer;
  private scene: MemoryGpuScene | null = null;
  private pickIndex = new MemoryPickIndex();
  private coordinateRevision = 0;
  private focus = -2;
  private width = 1;
  private height = 1;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { alpha: true, antialias: false, depth: true, preserveDrawingBuffer: false });
    if (!gl) throw new Error("WebGL2 unavailable");
    this.gl = gl;
    try {
      this.node = this.program(nodeVertex, nodeFragment);
      this.edge = this.program(edgeVertex, edgeFragment);
      this.nodeArray = this.array(); this.edgeArray = this.array();
      this.positions = this.texture(); this.colors = this.texture(); this.neighbors = this.texture();
      this.edgeBuffer = this.buffer();
      gl.bindVertexArray(this.edgeArray); gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeBuffer);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 12, 0); gl.vertexAttribDivisor(0, 1);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 12, 8); gl.vertexAttribDivisor(1, 1);
    } catch (error) { this.dispose(); throw error; }
  }

  private program(vertexSource: string, fragmentSource: string): Program {
    const gl = this.gl, shaders: WebGLShader[] = [];
    try {
      for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]] as const) {
        const shader = gl.createShader(type);
        if (!shader) throw new Error("WebGL shader allocation failed");
        shaders.push(shader); gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "WebGL shader compilation failed");
      }
      const program = gl.createProgram();
      if (!program) throw new Error("WebGL program allocation failed");
      this.programs.push(program);
      shaders.forEach(shader => gl.attachShader(program, shader)); gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "WebGL program linking failed");
      return { program, uniforms: new Map() };
    } finally { shaders.forEach(shader => gl.deleteShader(shader)); }
  }
  private texture() {
    const gl = this.gl, texture = gl.createTexture();
    if (!texture) throw new Error("WebGL texture allocation failed");
    this.textures.push(texture); gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }
  private array() {
    const array = this.gl.createVertexArray();
    if (!array) throw new Error("WebGL vertex array allocation failed");
    this.arrays.push(array); return array;
  }
  private buffer() {
    const buffer = this.gl.createBuffer();
    if (!buffer) throw new Error("WebGL buffer allocation failed");
    this.buffers.push(buffer); return buffer;
  }
  private uniform(program: Program, name: string) {
    if (!program.uniforms.has(name)) program.uniforms.set(name, this.gl.getUniformLocation(program.program, name));
    return program.uniforms.get(name)!;
  }
  private dataTexture(texture: WebGLTexture, data: Float32Array | Uint8Array) {
    const gl = this.gl, byte = data instanceof Uint8Array;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, byte ? gl.R8 : gl.RGBA32F, MEMORY_TEXTURE_WIDTH,
      data.length / MEMORY_TEXTURE_WIDTH / (byte ? 1 : 4), 0, byte ? gl.RED : gl.RGBA, byte ? gl.UNSIGNED_BYTE : gl.FLOAT, data);
  }
  setScene(scene: MemoryGpuScene) {
    this.scene = scene; this.focus = -2;
    this.coordinateRevision++; this.pickIndex.invalidate();
    this.dataTexture(this.positions, scene.coordinates); this.dataTexture(this.colors, scene.colors);
    this.dataTexture(this.neighbors, scene.neighbors);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.edgeBuffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, scene.edges.subarray(0, scene.edgeCount * 3), this.gl.STATIC_DRAW);
  }
  updateCoordinates() {
    if (this.scene) {
      // The old frame is still visible. Its hit targets remain valid until draw.
      this.coordinateRevision++;
      this.dataTexture(this.positions, this.scene.coordinates);
    }
  }
  resize(width: number, height: number, dpr: number) {
    // Assigning either canvas dimension clears its buffer, even at the same size.
    this.pickIndex.invalidate();
    this.width = Math.max(1, width); this.height = Math.max(1, height);
    this.canvas.width = Math.max(1, Math.round(width * dpr)); this.canvas.height = Math.max(1, Math.round(height * dpr));
  }
  private configure(program: Program, camera: MemoryCamera3D, focus: number) {
    const gl = this.gl;
    gl.useProgram(program.program);
    for (const [unit, name, texture] of [[0, "u_positions", this.positions], [1, "u_colors", this.colors], [2, "u_neighbors", this.neighbors]] as const) {
      gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, texture); gl.uniform1i(this.uniform(program, name), unit);
    }
    gl.uniform2f(this.uniform(program, "u_viewport"), this.width, this.height);
    gl.uniform2f(this.uniform(program, "u_pixelRatio"), this.canvas.width / this.width, this.canvas.height / this.height);
    gl.uniform3f(this.uniform(program, "u_camera"), camera.yaw, camera.pitch, camera.zoom);
    gl.uniform1f(this.uniform(program, "u_scale"), Math.min(this.width, this.height) * 0.4 / this.scene!.extent);
    gl.uniform1i(this.uniform(program, "u_focus"), focus);
  }
  draw(camera: MemoryCamera3D, focus: number) {
    const gl = this.gl, scene = this.scene;
    if (!scene || gl.isContextLost()) return;
    if (focus !== this.focus) { markMemoryNeighbors(scene, focus); this.dataTexture(this.neighbors, scene.neighbors); this.focus = focus; }
    // Include camera-dependent index maintenance in render cost, not pointer latency.
    this.pickIndex.update(scene, camera, this.width, this.height, this.coordinateRevision);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0); gl.clearDepth(1); gl.depthMask(true); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.enable(gl.BLEND);
    // Store premultiplied RGB with coverage alpha for the transparent canvas.
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.CULL_FACE);
    this.configure(this.edge, camera, focus); gl.bindVertexArray(this.edgeArray); gl.depthMask(false);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, scene.edgeCount);
    this.configure(this.node, camera, focus); gl.bindVertexArray(this.nodeArray); gl.depthMask(true);
    gl.uniform1i(this.uniform(this.node, "u_glowPass"), 0);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, scene.nodes.length);
    // Transparent halos and antialiasing must not write depth and hide other nodes.
    gl.depthMask(false); gl.uniform1i(this.uniform(this.node, "u_glowPass"), 1);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, scene.nodes.length);
    gl.depthMask(true);
  }
  pick(x: number, y: number) {
    const gl = this.gl, scene = this.scene;
    if (!scene || gl.isContextLost() || x < 0 || y < 0 || x > this.width || y > this.height) return -1;
    // Input targets the displayed frame, not a camera/geometry update queued for
    // the next draw. Never project the whole graph on the pointer event path.
    return this.pickIndex.pick(x, y, this.focus);
  }
  /** Used by the opt-in measurement harness, never by ordinary interaction. */
  finish() { this.gl.finish(); }
  dispose() {
    const gl = this.gl;
    this.programs.forEach(program => gl.deleteProgram(program)); this.textures.forEach(texture => gl.deleteTexture(texture));
    this.buffers.forEach(buffer => gl.deleteBuffer(buffer)); this.arrays.forEach(array => gl.deleteVertexArray(array));
    this.pickIndex.dispose();
    this.programs = []; this.textures = []; this.buffers = []; this.arrays = []; this.scene = null;
  }
}
