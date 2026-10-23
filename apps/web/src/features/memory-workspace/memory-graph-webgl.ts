import { MemoryPickIndex, memoryNodeRadius, projectMemoryPoints, type MemoryCamera3D } from "./memory-3d.js";

/**
 * WebGL2 renderer for the 3D memory graph. Nodes are one instanced draw call
 * (billboard quads), edges are one batched line draw call, and depth is
 * resolved by the GPU — no per-frame CPU sort. Projection math mirrors
 * projectMemoryPoint exactly, so the WebGL view matches the Canvas 2D look:
 * same camera, same sizes, same colors, same focus dimming.
 */

export interface MemoryWebGLScene {
  /** Flat XYZ world positions, one triple per node. */
  positions: Float32Array;
  /** Flat RGB triples per node, components in 0..1. */
  colors: Float32Array;
  /** Base radius per node before perspective/zoom scaling. */
  baseSizes: Float32Array;
  /** Flat XYZ positions, two endpoints per edge. */
  edgePositions: Float32Array;
  /** Flat RGB triples, two per edge (base color when nothing is focused). */
  edgeColors: Float32Array;
  /** Node index per edge vertex, two per edge; drives focus highlighting. */
  edgeNodeIndices: Float32Array;
  /** Largest world-space distance from the origin; sets depth range. */
  extent: number;
}

/**
 * Parse a #rrggbb CSS color into 0..1 RGB components; a muted slate on bad input.
 * @param hex CSS hex color, with or without the leading "#".
 * @returns [r, g, b] triple in 0..1.
 */
export function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  if (!Number.isFinite(value)) return [0.45, 0.58, 0.68];
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

const NODE_VERTEX = `#version 300 es
in vec2 aCorner;
in vec3 aPos;
in vec3 aColor;
in float aSize;
in float aDim;
in float aHighlight;
uniform float uCosYaw;
uniform float uSinYaw;
uniform float uCosPitch;
uniform float uSinPitch;
uniform float uScale;
uniform float uZoom;
uniform vec2 uCenter;
uniform vec2 uViewport;
uniform float uDepthScale;
out vec3 vColor;
out float vAlpha;
out vec2 vLocal;
out float vHighlight;
void main() {
  float x = aPos.x * uCosYaw + aPos.z * uSinYaw;
  float depth = -aPos.x * uSinYaw + aPos.z * uCosYaw;
  float y = aPos.y * uCosPitch - depth * uSinPitch;
  float z = aPos.y * uSinPitch + depth * uCosPitch;
  float perspective = 650.0 / max(120.0, 650.0 + z * uScale);
  float cx = uCenter.x + x * uScale * uZoom * perspective;
  float cy = uCenter.y - y * uScale * uZoom * perspective;
  float radius = max(1.0, aSize * perspective * sqrt(uZoom)) * (aHighlight > 0.5 ? 1.5 : 1.0);
  float pad = aHighlight > 0.5 ? radius * 0.9 : radius * 0.3;
  float halfSize = radius + pad;
  vec2 pixel = vec2(cx + aCorner.x * halfSize, cy + aCorner.y * halfSize);
  gl_Position = vec4(pixel.x / uViewport.x * 2.0 - 1.0, 1.0 - pixel.y / uViewport.y * 2.0, clamp(z * uDepthScale, -1.0, 1.0), 1.0);
  vColor = aColor;
  vAlpha = aDim > 0.5 ? 0.2 : clamp(perspective, 0.4, 1.0);
  vLocal = aCorner * (halfSize / radius);
  vHighlight = aHighlight;
}`;

const NODE_FRAGMENT = `#version 300 es
precision mediump float;
in vec3 vColor;
in float vAlpha;
in vec2 vLocal;
in float vHighlight;
out vec4 outColor;
void main() {
  float distance = length(vLocal);
  float alpha = vAlpha;
  if (distance <= 1.0) {
    alpha *= smoothstep(1.0, 0.82, distance);
  } else if (vHighlight > 0.5) {
    alpha *= max(0.0, 1.0 - (distance - 1.0) / 0.9) * 0.55;
  } else {
    alpha = 0.0;
  }
  if (alpha <= 0.004) discard;
  outColor = vec4(vColor, alpha);
}`;

const EDGE_VERTEX = `#version 300 es
in vec3 aPos;
in vec3 aColor;
in float aNodeIndex;
uniform float uCosYaw;
uniform float uSinYaw;
uniform float uCosPitch;
uniform float uSinPitch;
uniform float uScale;
uniform float uZoom;
uniform vec2 uCenter;
uniform vec2 uViewport;
uniform float uDepthScale;
uniform float uFocus;
uniform vec3 uIncidentColor;
uniform vec3 uDimColor;
out vec3 vColor;
void main() {
  float x = aPos.x * uCosYaw + aPos.z * uSinYaw;
  float depth = -aPos.x * uSinYaw + aPos.z * uCosYaw;
  float y = aPos.y * uCosPitch - depth * uSinPitch;
  float z = aPos.y * uSinPitch + depth * uCosPitch;
  float perspective = 650.0 / max(120.0, 650.0 + z * uScale);
  float cx = uCenter.x + x * uScale * uZoom * perspective;
  float cy = uCenter.y - y * uScale * uZoom * perspective;
  gl_Position = vec4(cx / uViewport.x * 2.0 - 1.0, 1.0 - cy / uViewport.y * 2.0, clamp(z * uDepthScale, -1.0, 1.0), 1.0);
  vColor = uFocus < -0.5 ? aColor : (abs(aNodeIndex - uFocus) < 0.5 ? uIncidentColor : uDimColor);
}`;

const EDGE_FRAGMENT = `#version 300 es
precision mediump float;
in vec3 vColor;
out vec4 outColor;
void main() {
  outColor = vec4(vColor, 1.0);
}`;

/**
 * Compile one GLSL shader, throwing with the driver log on failure.
 * @param gl The WebGL2 context.
 * @param type gl.VERTEX_SHADER or gl.FRAGMENT_SHADER.
 * @param source GLSL 300 es source.
 * @returns The compiled shader.
 */
function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("WebGL2 shader allocation failed");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`WebGL2 shader failed to compile: ${log ?? "unknown error"}`);
  }
  return shader;
}

/**
 * Link a vertex and fragment shader into a program, throwing on failure.
 * @param gl The WebGL2 context.
 * @param vertex Vertex shader GLSL source.
 * @param fragment Fragment shader GLSL source.
 * @returns The linked program.
 */
function createProgram(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error("WebGL2 program allocation failed");
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertex);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragment);
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  // The shaders are linked into the program now; release the shader objects
  // so repeated renderer creation (context restore) does not leak them.
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`WebGL2 program failed to link: ${log ?? "unknown error"}`);
  }
  return program;
}

const QUAD_CORNERS = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);

export class MemoryGraphWebGLRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly nodeProgram: WebGLProgram;
  private readonly edgeProgram: WebGLProgram;
  private readonly nodeVao: WebGLVertexArrayObject;
  private readonly edgeVao: WebGLVertexArrayObject;
  private readonly buffers: WebGLBuffer[] = [];
  private readonly nodeUniforms: Record<string, WebGLUniformLocation | null> = {};
  private readonly edgeUniforms: Record<string, WebGLUniformLocation | null> = {};
  private scene: MemoryWebGLScene | null = null;
  private nodeCount = 0;
  private edgeVertexCount = 0;
  private dimBuffer: WebGLBuffer | null = null;
  private highlightBuffer: WebGLBuffer | null = null;
  private edgePositionBuffer: WebGLBuffer | null = null;
  private pickIndex = new MemoryPickIndex();
  private projected: Float32Array = new Float32Array(0);
  private radii: Float32Array = new Float32Array(0);

  static isSupported(): boolean {
    if (typeof document === "undefined") return false;
    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2");
      if (!gl) return false;
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      return true;
    } catch {
      return false;
    }
  }

  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { antialias: true, alpha: true, powerPreference: "high-performance" });
    if (!gl) throw new Error("WebGL2 context unavailable");
    this.gl = gl;
    this.nodeProgram = createProgram(gl, NODE_VERTEX, NODE_FRAGMENT);
    this.edgeProgram = createProgram(gl, EDGE_VERTEX, EDGE_FRAGMENT);
    for (const name of ["uCosYaw", "uSinYaw", "uCosPitch", "uSinPitch", "uScale", "uZoom", "uCenter", "uViewport", "uDepthScale"]) {
      this.nodeUniforms[name] = gl.getUniformLocation(this.nodeProgram, name);
      this.edgeUniforms[name] = gl.getUniformLocation(this.edgeProgram, name);
    }
    this.edgeUniforms.uFocus = gl.getUniformLocation(this.edgeProgram, "uFocus");
    this.edgeUniforms.uIncidentColor = gl.getUniformLocation(this.edgeProgram, "uIncidentColor");
    this.edgeUniforms.uDimColor = gl.getUniformLocation(this.edgeProgram, "uDimColor");
    const nodeVao = gl.createVertexArray();
    const edgeVao = gl.createVertexArray();
    if (!nodeVao || !edgeVao) throw new Error("WebGL2 VAO allocation failed");
    this.nodeVao = nodeVao;
    this.edgeVao = edgeVao;
    // Static quad corners, instanced once per node.
    gl.bindVertexArray(this.nodeVao);
    const cornerBuffer = this.createBuffer(new Float32Array(QUAD_CORNERS), gl.STATIC_DRAW);
    const cornerLocation = gl.getAttribLocation(this.nodeProgram, "aCorner");
    gl.enableVertexAttribArray(cornerLocation);
    gl.vertexAttribPointer(cornerLocation, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(cornerLocation, 0);
    gl.bindVertexArray(null);
  }

  /**
   * Allocate a GPU buffer, upload `data`, and track it for disposal.
   * @param data Float32 data to upload.
   * @param usage gl.STATIC_DRAW or gl.DYNAMIC_DRAW hint.
   * @returns The created buffer.
   */
  private createBuffer(data: Float32Array, usage: number): WebGLBuffer {
    const gl = this.gl;
    const buffer = gl.createBuffer();
    if (!buffer) throw new Error("WebGL2 buffer allocation failed");
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, usage);
    this.buffers.push(buffer);
    return buffer;
  }

  /**
   * Bind one per-node attribute as an instanced divisor-1 stream.
   * @param program The shader program owning the attribute.
   * @param vao Vertex array to attach the buffer to.
   * @param name Attribute name in the shader.
   * @param data Per-node data, one `size`-tuple per node.
   * @param size Components per attribute (1, 2, or 3).
   * @param usage gl.STATIC_DRAW or gl.DYNAMIC_DRAW hint.
   * @returns The created buffer.
   */
  private bindInstanced(program: WebGLProgram, vao: WebGLVertexArrayObject, name: string, data: Float32Array, size: number, usage: number): WebGLBuffer {
    const gl = this.gl;
    gl.bindVertexArray(vao);
    const buffer = this.createBuffer(data, usage);
    const location = gl.getAttribLocation(program, name);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(location, 1);
    gl.bindVertexArray(null);
    return buffer;
  }

  /**
   * Bind one per-vertex attribute (the batched edge lines), non-instanced.
   * @param program The shader program owning the attribute.
   * @param vao Vertex array to attach the buffer to.
   * @param name Attribute name in the shader.
   * @param data Per-vertex data, one `size`-tuple per vertex.
   * @param size Components per attribute (1 or 3).
   * @param usage Upload hint, defaults to gl.STATIC_DRAW.
   * @returns The created buffer.
   */
  private bindVertex(program: WebGLProgram, vao: WebGLVertexArrayObject, name: string, data: Float32Array, size: number, usage: number = this.gl.STATIC_DRAW): WebGLBuffer {
    const gl = this.gl;
    gl.bindVertexArray(vao);
    const buffer = this.createBuffer(data, usage);
    const location = gl.getAttribLocation(program, name);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return buffer;
  }

  /**
   * Upload a full scene, retiring the previous scene's GPU buffers.
   * @param scene Packed node/edge data; arrays are uploaded as-is.
   */
  setScene(scene: MemoryWebGLScene): void {
    const gl = this.gl;
    // Retire the previous scene's dynamic buffers.
    for (const buffer of this.buffers.splice(0)) gl.deleteBuffer(buffer);
    this.scene = scene;
    this.nodeCount = Math.floor(scene.positions.length / 3);
    this.edgeVertexCount = Math.floor(scene.edgePositions.length / 3);
    this.bindInstanced(this.nodeProgram, this.nodeVao, "aPos", scene.positions, 3, gl.DYNAMIC_DRAW);
    this.bindInstanced(this.nodeProgram, this.nodeVao, "aColor", scene.colors, 3, gl.STATIC_DRAW);
    this.bindInstanced(this.nodeProgram, this.nodeVao, "aSize", scene.baseSizes, 1, gl.STATIC_DRAW);
    this.dimBuffer = this.bindInstanced(this.nodeProgram, this.nodeVao, "aDim", new Float32Array(this.nodeCount), 1, gl.DYNAMIC_DRAW);
    this.highlightBuffer = this.bindInstanced(this.nodeProgram, this.nodeVao, "aHighlight", new Float32Array(this.nodeCount), 1, gl.DYNAMIC_DRAW);
    // Rebind the static corners after the buffer reset.
    gl.bindVertexArray(this.nodeVao);
    const cornerBuffer = this.createBuffer(new Float32Array(QUAD_CORNERS), gl.STATIC_DRAW);
    const cornerLocation = gl.getAttribLocation(this.nodeProgram, "aCorner");
    gl.enableVertexAttribArray(cornerLocation);
    gl.vertexAttribPointer(cornerLocation, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(cornerLocation, 0);
    gl.bindVertexArray(null);
    this.edgePositionBuffer = this.bindVertex(this.edgeProgram, this.edgeVao, "aPos", scene.edgePositions, 3, gl.DYNAMIC_DRAW);
    this.bindVertex(this.edgeProgram, this.edgeVao, "aColor", scene.edgeColors, 3);
    this.bindVertex(this.edgeProgram, this.edgeVao, "aNodeIndex", scene.edgeNodeIndices, 1);
    this.radii = new Float32Array(this.nodeCount);
  }

  /**
   * Update node and edge positions in place while the layout streams in.
   * @param positions New flat XYZ node positions.
   * @param edgePositions New flat XYZ edge endpoint positions.
   * @param extent New world-space extent; the depth range derives from it,
   * so it must follow the streamed positions, not the first snapshot's.
   */
  updatePositions(positions: Float32Array, edgePositions: Float32Array, extent?: number): void {
    if (!this.scene) return;
    this.scene = { ...this.scene, positions, edgePositions, ...(extent !== undefined ? { extent } : {}) };
    const gl = this.gl;
    gl.bindVertexArray(this.nodeVao);
    // The aPos buffer is the first dynamic buffer created for the scene.
    const buffer = this.buffers[0];
    if (buffer) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
    }
    gl.bindVertexArray(null);
    // Edges follow the same snapshots: without this upload they would stay
    // at the layout captured by setScene while the nodes move on.
    if (this.edgePositionBuffer) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.edgePositionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, edgePositions, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }
  }

  /** Drop the scene and clear the frame, e.g. when the graph becomes empty. */
  clear(): void {
    this.scene = null;
    this.projected = new Float32Array(0);
    const gl = this.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  /** Focus a node index (or -1 for none); neighbors stay lit, the rest dim. */
  setFocus(focusIndex: number, neighbors: ReadonlySet<number> | null): void {
    this.focusIndexValue = focusIndex;
    if (!this.dimBuffer || !this.highlightBuffer) return;
    const gl = this.gl;
    const dim = new Float32Array(this.nodeCount);
    const highlight = new Float32Array(this.nodeCount);
    if (focusIndex >= 0) {
      for (let i = 0; i < this.nodeCount; i++) {
        if (i !== focusIndex && !(neighbors?.has(i) ?? false)) dim[i] = 1;
      }
      if (focusIndex < this.nodeCount) highlight[focusIndex] = 1;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dimBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, dim);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.highlightBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, highlight);
  }

  /**
   * Draw edges (depth-write off) then the instanced node billboards, and
   * refresh the CPU-side projection used for picking and labels.
   * @param camera Camera orientation and zoom.
   * @param scale World-units to CSS pixels at zoom 1.
   * @param width Viewport width in CSS pixels.
   * @param height Viewport height in CSS pixels.
   */
  render(camera: MemoryCamera3D, scale: number, width: number, height: number): void {
    const gl = this.gl;
    if (!this.scene) return;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    const uniforms = {
      uCosYaw: Math.cos(camera.yaw), uSinYaw: Math.sin(camera.yaw),
      uCosPitch: Math.cos(camera.pitch), uSinPitch: Math.sin(camera.pitch),
      uScale: scale, uZoom: camera.zoom
    };
    const depthScale = 1 / Math.max(1, this.scene.extent * 2);
    // Edges first, without depth writes, so nodes sit cleanly on top.
    gl.depthMask(false);
    gl.useProgram(this.edgeProgram);
    for (const [name, value] of Object.entries(uniforms)) gl.uniform1f(this.edgeUniforms[name] ?? null, value);
    gl.uniform2f(this.edgeUniforms.uCenter ?? null, width / 2, height / 2);
    gl.uniform2f(this.edgeUniforms.uViewport ?? null, width, height);
    gl.uniform1f(this.edgeUniforms.uDepthScale ?? null, depthScale);
    gl.uniform1f(this.edgeUniforms.uFocus ?? null, this.focusIndexValue);
    const [ir, ig, ib] = hexToRgb("#98dafa");
    gl.uniform3f(this.edgeUniforms.uIncidentColor ?? null, ir, ig, ib);
    const [dr, dg, db] = hexToRgb("#14202b");
    gl.uniform3f(this.edgeUniforms.uDimColor ?? null, dr, dg, db);
    gl.bindVertexArray(this.edgeVao);
    gl.drawArrays(gl.LINES, 0, this.edgeVertexCount);
    gl.bindVertexArray(null);
    // Nodes: one instanced draw call for the whole graph.
    gl.depthMask(true);
    gl.useProgram(this.nodeProgram);
    for (const [name, value] of Object.entries(uniforms)) gl.uniform1f(this.nodeUniforms[name] ?? null, value);
    gl.uniform2f(this.nodeUniforms.uCenter ?? null, width / 2, height / 2);
    gl.uniform2f(this.nodeUniforms.uViewport ?? null, width, height);
    gl.uniform1f(this.nodeUniforms.uDepthScale ?? null, depthScale);
    gl.bindVertexArray(this.nodeVao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.nodeCount);
    gl.bindVertexArray(null);
    // CPU projection of the same frame powers picking and label placement.
    this.projected = projectMemoryPoints(this.scene.positions, camera, scale, width, height);
    for (let i = 0; i < this.nodeCount; i++) {
      // Pick radii must match the drawn radii, including the focused node's
      // 1.5x highlight, or clicks on its rim would miss the pick index.
      this.radii[i] = memoryNodeRadius(this.scene.baseSizes[i]!, this.projected[i * 4 + 3]!, camera.zoom, i === this.focusIndexValue);
    }
    this.pickIndex.rebuild(this.projected, this.radii);
  }

  private focusIndexValue = -1;

  /** Node index at a CSS-pixel position from the last rendered frame, or -1. */
  pick(x: number, y: number): number {
    if (!this.scene || this.projected.length === 0) return -1;
    return this.pickIndex.pick(x, y, this.projected, this.radii);
  }

  /** Projected [x, y, depth, perspective] quads from the last render. */
  projectedPoints(): Float32Array {
    return this.projected;
  }

  /** Delete every GPU resource this renderer allocated. */
  dispose(): void {
    const gl = this.gl;
    for (const buffer of this.buffers.splice(0)) gl.deleteBuffer(buffer);
    gl.deleteVertexArray(this.nodeVao);
    gl.deleteVertexArray(this.edgeVao);
    gl.deleteProgram(this.nodeProgram);
    gl.deleteProgram(this.edgeProgram);
    this.scene = null;
  }
}
