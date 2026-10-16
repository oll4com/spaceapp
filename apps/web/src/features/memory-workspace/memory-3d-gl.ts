import type { MemoryCamera3D } from "./memory-3d.js";
import type { PackedMemoryGraph } from "./memory-3d-buffers.js";
import { focusNeighborStates } from "./memory-3d-pick.js";

const NODE_VERTEX = `#version 300 es
layout(location=0) in vec2 aCorner;
layout(location=2) in vec3 aColor;
layout(location=3) in float aRadius;
layout(location=4) in float aState;
uniform float uYaw;
uniform float uPitch;
uniform float uZoom;
uniform float uScale;
uniform float uWidth;
uniform float uHeight;
uniform float uHasFocus;
uniform sampler2D uPositions;
uniform float uPositionWidth;
out vec2 vCorner;
out vec3 vColor;
out float vAlpha;
out float vGlow;
vec3 fetchPosition(int id) {
  int width = int(uPositionWidth);
  return texelFetch(uPositions, ivec2(id - (id / width) * width, id / width), 0).xyz;
}
void main() {
  vec3 aPosition = fetchPosition(gl_InstanceID);
  float cy = cos(uYaw);
  float sy = sin(uYaw);
  float x = aPosition.x * cy + aPosition.z * sy;
  float depth = -aPosition.x * sy + aPosition.z * cy;
  float cp = cos(uPitch);
  float sp = sin(uPitch);
  float y = aPosition.y * cp - depth * sp;
  float z = aPosition.y * sp + depth * cp;
  float perspective = 650.0 / max(120.0, 650.0 + z * uScale);
  float highlighted = step(1.5, aState);
  float radius = max(1.0, aRadius * perspective * sqrt(max(uZoom, 0.0001))) * mix(1.0, 1.5, highlighted);
  vec2 screen = vec2(uWidth * 0.5 + x * uScale * uZoom * perspective, uHeight * 0.5 - y * uScale * uZoom * perspective) + aCorner * radius;
  gl_Position = vec4(screen.x / uWidth * 2.0 - 1.0, 1.0 - screen.y / uHeight * 2.0, clamp(z / 4000.0, -1.0, 1.0), 1.0);
  vCorner = aCorner;
  vColor = mix(aColor, vec3(1.0), highlighted);
  float visible = max(0.4, min(1.0, perspective));
  vAlpha = (uHasFocus > 0.5 && highlighted < 0.5 && aState < 0.5) ? 0.2 : visible;
  vGlow = max(highlighted, step(8.0, aRadius));
}`;

const NODE_FRAGMENT = `#version 300 es
precision mediump float;
in vec2 vCorner;
in vec3 vColor;
in float vAlpha;
in float vGlow;
out vec4 fragColor;
void main() {
  float dist = length(vCorner);
  if (dist > 1.0) discard;
  float edge = smoothstep(1.0, 0.82, dist);
  vec3 color = vColor + vGlow * smoothstep(1.0, 0.45, dist) * 0.35;
  fragColor = vec4(color, vAlpha * edge);
}`;

const EDGE_VERTEX = `#version 300 es
precision highp float;
layout(location=0) in vec2 aCorner;
layout(location=1) in vec3 aParams;
uniform float uYawCos;
uniform float uYawSin;
uniform float uPitchCos;
uniform float uPitchSin;
uniform float uZoom;
uniform float uScale;
uniform float uWidth;
uniform float uHeight;
uniform float uFocus;
uniform sampler2D uPositions;
uniform float uPositionWidth;
out vec4 vColor;
vec3 fetchPosition(int id) {
  int width = int(uPositionWidth);
  return texelFetch(uPositions, ivec2(id - (id / width) * width, id / width), 0).xyz;
}
vec3 project(vec3 p) {
  float x = p.x * uYawCos + p.z * uYawSin;
  float depth = -p.x * uYawSin + p.z * uYawCos;
  float y = p.y * uPitchCos - depth * uPitchSin;
  float z = p.y * uPitchSin + depth * uPitchCos;
  float perspective = 650.0 / max(120.0, 650.0 + z * uScale);
  return vec3(uWidth * 0.5 + x * uScale * uZoom * perspective, uHeight * 0.5 - y * uScale * uZoom * perspective, z);
}
void main() {
  bool incident = uFocus >= 0.0 && (aParams.x == uFocus || aParams.y == uFocus);
  vec3 start = project(fetchPosition(int(aParams.x)));
  vec3 end = project(fetchPosition(int(aParams.y)));
  vec2 delta = end.xy - start.xy;
  float len = length(delta);
  vec2 normal = len < 0.001 ? vec2(0.0, 1.0) : vec2(-delta.y, delta.x) / len;
  float width = incident ? 1.15 : 0.55;
  float along = aCorner.x * 0.5 + 0.5;
  vec2 screen = mix(start.xy, end.xy, along) + normal * aCorner.y * width * 0.5;
  float depth = mix(start.z, end.z, along);
  gl_Position = vec4(screen.x / uWidth * 2.0 - 1.0, 1.0 - screen.y / uHeight * 2.0, clamp(depth / 4000.0, -1.0, 1.0), 1.0);
  vec3 color = incident ? vec3(0.596, 0.855, 0.980)
    : uFocus >= 0.0 ? vec3(0.078, 0.125, 0.169)
    : aParams.z > 0.5 ? vec3(0.220, 0.314, 0.408)
    : vec3(0.125, 0.200, 0.263);
  vColor = vec4(color, 1.0);
}`;

const EDGE_FRAGMENT = `#version 300 es
precision mediump float;
in vec4 vColor;
out vec4 fragColor;
void main() { fragColor = vColor; }`;

const QUAD = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
const POSITION_TEXTURE_WIDTH = 256;

interface ProgramHandles {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
  shaders: WebGLShader[];
  uniformNames: string[];
}

interface ParallelShaderCompile {
  COMPLETION_STATUS_KHR: number;
}

const NODE_UNIFORMS = ["uYaw", "uPitch", "uZoom", "uScale", "uWidth", "uHeight", "uHasFocus", "uPositions", "uPositionWidth"];
const EDGE_UNIFORMS = ["uYawCos", "uYawSin", "uPitchCos", "uPitchSin", "uZoom", "uScale", "uWidth", "uHeight", "uFocus", "uPositions", "uPositionWidth"];
const UPLOAD_ROWS = 8;
const EDGE_PARAM_SLICE = 16_384;
const PUMP_BUDGET_MS = 8;

type StaticStage = "colors" | "radii" | "states" | "edgeAlloc" | "edgeUpload" | "done";
type CompileStage = "idle" | "node" | "edge" | "link" | "ready";
type GLCanvas = HTMLCanvasElement | OffscreenCanvas;

interface MemoryGraphGLMetrics {
  uploadMs?: number;
  positionMs?: number;
}

export class MemoryGraphWebGL {
  readonly canvas: GLCanvas;
  private gl: WebGL2RenderingContext;
  private lost = false;
  private nodeProgram: ProgramHandles | null = null;
  private edgeProgram: ProgramHandles | null = null;
  private nodeVao: WebGLVertexArrayObject | null = null;
  private edgeVao: WebGLVertexArrayObject | null = null;
  private buffers: WebGLBuffer[] = [];
  private count = 0;
  private edgeCount = 0;
  private focus = -1;
  private xyz: Float32Array = new Float32Array();
  private colors: Uint8Array = new Uint8Array();
  private radii: Float32Array = new Float32Array();
  private states: Uint8Array = new Uint8Array();
  private edgePairs: Uint32Array = new Uint32Array();
  private edgeTypes: Uint8Array = new Uint8Array();
  private edgeParams: Float32Array = new Float32Array();
  private textures: WebGLTexture[] = [];
  private front = 0;
  private texWidth = 0;
  private texHeight = 0;
  private positionsDirty = true;
  private compileStage: CompileStage = "idle";
  private parallel: ParallelShaderCompile | null = null;
  private pendingShaders: WebGLShader[] = [];
  private staticStage: StaticStage = "done";
  private edgeParamsDirty = false;
  private edgeParamCursor = 0;
  private edgeUploadCursor = 0;
  private positionGeneration = 0;
  private uploadedGeneration = -1;
  private fillGeneration = 0;
  private filling = false;
  private uploadRow = 0;
  private fillTexture = 0;
  private rowImage = new Float32Array();
  private dpr = 1;
  private nodeColorBuffer: WebGLBuffer | null = null;
  private nodeRadiusBuffer: WebGLBuffer | null = null;
  private nodeStateBuffer: WebGLBuffer | null = null;
  private edgeParamBuffer: WebGLBuffer | null = null;
  onContextLost: () => void = () => undefined;
  onContextRestored: () => void = () => undefined;
  onMetrics: (metrics: MemoryGraphGLMetrics) => void = metrics => {
    const root = globalThis as typeof globalThis & { __spaceMemoryUploadMs?: number; __spaceMemoryPositionMs?: number };
    if (metrics.uploadMs !== undefined) root.__spaceMemoryUploadMs = metrics.uploadMs;
    if (metrics.positionMs !== undefined) root.__spaceMemoryPositionMs = Math.max(root.__spaceMemoryPositionMs ?? 0, metrics.positionMs);
  };

  private constructor(canvas: GLCanvas, gl: WebGL2RenderingContext) {
    this.canvas = canvas;
    this.gl = gl;
    canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      this.lost = true;
      this.onContextLost();
    });
    canvas.addEventListener("webglcontextrestored", () => {
      this.lost = false;
      this.recover();
      this.onContextRestored();
    });
  }

  static create(canvas: GLCanvas): MemoryGraphWebGL | null {
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      depth: true,
      stencil: false,
      premultipliedAlpha: false,
      powerPreference: "high-performance"
    });
    if (!gl) return null;
    try {
      return new MemoryGraphWebGL(canvas, gl);
    } catch {
      return null;
    }
  }

  get contextLost() { return this.lost || this.gl.isContextLost(); }

  rendererLabel(): string {
    const extension = this.gl.getExtension("WEBGL_debug_renderer_info");
    if (!extension) return this.gl.getParameter(this.gl.RENDERER) as string;
    return this.gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) as string;
  }

  setGraph(packed: Pick<PackedMemoryGraph, "count" | "edgeCount" | "xyz" | "colors" | "radii" | "edgePairs" | "edgeTypes">) {
    const started = performance.now();
    this.count = packed.count;
    this.edgeCount = packed.edgeCount;
    this.xyz = packed.xyz;
    this.colors = packed.colors;
    this.radii = packed.radii;
    this.edgePairs = packed.edgePairs;
    this.edgeTypes = packed.edgeTypes;
    this.states = new Uint8Array(packed.count);
    this.focus = -1;
    this.edgeParamsDirty = true;
    this.edgeParamCursor = 0;
    this.edgeUploadCursor = 0;
    this.staticStage = "colors";
    this.positionGeneration++;
    this.filling = false;
    this.uploadRow = 0;
    this.positionsDirty = true;
    this.onMetrics({ uploadMs: performance.now() - started });
    if (this.count === 0) this.clearFrame();
  }

  /** Drop the uploaded graph and wipe the canvas so a cleared search cannot leave stale nodes. */
  clearGraph() {
    this.count = 0;
    this.edgeCount = 0;
    this.focus = -1;
    this.states = new Uint8Array();
    this.edgeParamsDirty = false;
    this.positionsDirty = false;
    this.filling = false;
    this.staticStage = "done";
    this.uploadedGeneration = this.positionGeneration;
    this.clearFrame();
  }

  clearFrame() {
    if (this.contextLost || this.gl.isContextLost()) return;
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width || 1, this.canvas.height || 1);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  setDeviceScale(dpr: number) {
    this.dpr = dpr;
  }

  /** Advance compile and uploads by a few milliseconds so one turn stays under the long-task budget. */
  pump(budgetMs = PUMP_BUDGET_MS): boolean {
    if (this.contextLost) return true;
    const deadline = performance.now() + budgetMs;
    if (this.compileStage !== "ready") {
      this.pumpCompile();
      return false;
    }
    if (this.edgeParamsDirty) {
      this.pumpEdgeParams();
      return false;
    }
    if (this.staticStage !== "done") {
      this.pumpStaticBuffer();
      return false;
    }
    if (this.count > 0 && (this.filling || this.uploadedGeneration !== this.positionGeneration)) {
      this.pumpPositions(deadline);
    }
    return this.idle();
  }

  idle(): boolean {
    if (this.contextLost) return true;
    if (this.compileStage !== "ready" || this.edgeParamsDirty || this.staticStage !== "done" || this.filling) return false;
    if (this.count === 0) return true;
    return this.uploadedGeneration === this.positionGeneration;
  }

  startCompile() {
    if (this.contextLost || this.gl.isContextLost()) return;
    this.discardGpu();
    this.parallel = this.gl.getExtension("KHR_parallel_shader_compile") as ParallelShaderCompile | null;
    this.compileStage = "node";
  }

  /** Keep the latest positions. The texture is filled in row slices on later turns. */
  setPositions(xyz: Float32Array) {
    this.xyz = xyz;
    this.positionGeneration++;
    this.positionsDirty = true;
  }

  setFocus(index: number) {
    const focus = index >= 0 && index < this.count ? index : -1;
    if (focus === this.focus && this.states.length === this.count) return;
    this.focus = focus;
    focusNeighborStates(this.edgePairs, focus, this.count, this.states);
    if (this.contextLost || !this.nodeStateBuffer) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeStateBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.states, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  get nodeCount() { return this.count; }

  get uploadedCount() { return this.uploadedGeneration; }

  /** GPU elapsed time for this frame when `sync` is set, otherwise null. */
  render(camera: MemoryCamera3D, scale: number, width: number, height: number, sync = false): number | null {
    if (this.contextLost || width <= 0 || height <= 0) return null;
    this.pump();
    if (!this.nodeProgram || !this.edgeProgram || this.compileStage !== "ready" || this.uploadedGeneration < 0) return null;
    const gl = this.gl;
    const dpr = Math.min(this.dpr || 1, 2);
    const bufferWidth = Math.max(1, Math.round(width * dpr));
    const bufferHeight = Math.max(1, Math.round(height * dpr));
    if (this.canvas.width !== bufferWidth || this.canvas.height !== bufferHeight) {
      this.canvas.width = bufferWidth;
      this.canvas.height = bufferHeight;
    }
    gl.viewport(0, 0, bufferWidth, bufferHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    if (this.contextLost) return null;
    this.bindPositions();
    this.drawEdges(camera, scale, width, height);
    this.drawNodes(camera, scale, width, height);
    gl.bindVertexArray(null);
    if (sync) this.waitForGpu();
    return null;
  }

  /** gl.finish returns before SwiftShader retires worker commands. A flushed fence waits for them. */
  private waitForGpu() {
    const gl = this.gl;
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    if (!fence) {
      gl.finish();
      return;
    }
    gl.clientWaitSync(fence, gl.SYNC_FLUSH_COMMANDS_BIT, 2_000_000_000);
    gl.deleteSync(fence);
  }

  recover() {
    if (this.gl.isContextLost()) return;
    this.lost = false;
    this.uploadedGeneration = -1;
    this.filling = false;
    this.staticStage = this.count > 0 ? "colors" : "done";
    this.edgeParamsDirty = this.edgeCount > 0;
    this.edgeParamCursor = 0;
    this.positionGeneration++;
    this.startCompile();
  }

  dispose() {
    if (this.gl.isContextLost()) return;
    const gl = this.gl;
    if (this.nodeVao) gl.deleteVertexArray(this.nodeVao);
    if (this.edgeVao) gl.deleteVertexArray(this.edgeVao);
    for (const texture of this.textures) gl.deleteTexture(texture);
    this.textures = [];
    for (const buffer of this.buffers) gl.deleteBuffer(buffer);
    if (this.nodeProgram) gl.deleteProgram(this.nodeProgram.program);
    if (this.edgeProgram) gl.deleteProgram(this.edgeProgram.program);
  }

  private pumpCompile() {
    try {
      if (this.compileStage === "idle") this.startCompile();
      if (this.compileStage === "node") {
        if (this.parallel) {
          this.nodeProgram = this.linkUnblocked(NODE_VERTEX, NODE_FRAGMENT, NODE_UNIFORMS);
          this.edgeProgram = this.linkUnblocked(EDGE_VERTEX, EDGE_FRAGMENT, EDGE_UNIFORMS);
          this.compileStage = "link";
          return;
        }
        this.nodeProgram = this.link(NODE_VERTEX, NODE_FRAGMENT, NODE_UNIFORMS);
        this.compileStage = "edge";
        return;
      }
      if (this.compileStage === "edge") {
        this.edgeProgram = this.link(EDGE_VERTEX, EDGE_FRAGMENT, EDGE_UNIFORMS);
        this.finishVertexArrays();
        this.compileStage = "ready";
        return;
      }
      if (this.compileStage === "link") {
        const extension = this.parallel;
        if (!extension || !this.nodeProgram || !this.edgeProgram) throw new Error("WebGL program allocation failed.");
        const gl = this.gl;
        const nodeDone = gl.getProgramParameter(this.nodeProgram.program, extension.COMPLETION_STATUS_KHR);
        const edgeDone = gl.getProgramParameter(this.edgeProgram.program, extension.COMPLETION_STATUS_KHR);
        if (!nodeDone || !edgeDone) return;
        this.finalizeProgram(this.nodeProgram);
        this.finalizeProgram(this.edgeProgram);
        this.finishVertexArrays();
        this.compileStage = "ready";
      }
    } catch {
      this.lost = true;
      this.compileStage = "ready";
      this.onContextLost();
    }
  }

  private finishVertexArrays() {
    const gl = this.gl;
    this.nodeVao = gl.createVertexArray();
    this.edgeVao = gl.createVertexArray();
    this.buffers = [];
    this.nodeColorBuffer = this.buffer();
    this.nodeRadiusBuffer = this.buffer();
    this.nodeStateBuffer = this.buffer();
    this.edgeParamBuffer = this.buffer();
    const quad = this.buffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
    this.configureNodeVao(quad);
    this.configureEdgeVao(quad);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  private discardGpu() {
    if (this.gl.isContextLost()) return;
    const gl = this.gl;
    for (const texture of this.textures) gl.deleteTexture(texture);
    this.textures = [];
    this.texWidth = 0;
    this.texHeight = 0;
    this.uploadedGeneration = -1;
    for (const buffer of this.buffers) gl.deleteBuffer(buffer);
    this.buffers = [];
    this.nodeColorBuffer = null;
    this.nodeRadiusBuffer = null;
    this.nodeStateBuffer = null;
    this.edgeParamBuffer = null;
    if (this.nodeVao) gl.deleteVertexArray(this.nodeVao);
    if (this.edgeVao) gl.deleteVertexArray(this.edgeVao);
    this.nodeVao = null;
    this.edgeVao = null;
    if (this.nodeProgram) gl.deleteProgram(this.nodeProgram.program);
    if (this.edgeProgram) gl.deleteProgram(this.edgeProgram.program);
    this.nodeProgram = null;
    this.edgeProgram = null;
    for (const shader of this.pendingShaders) gl.deleteShader(shader);
    this.pendingShaders = [];
  }

  private configureNodeVao(quad: WebGLBuffer) {
    const gl = this.gl;
    gl.bindVertexArray(this.nodeVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeColorBuffer);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.UNSIGNED_BYTE, true, 0, 0);
    gl.vertexAttribDivisor(2, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeRadiusBuffer);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(3, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeStateBuffer);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 1, gl.UNSIGNED_BYTE, false, 0, 0);
    gl.vertexAttribDivisor(4, 1);
  }

  private configureEdgeVao(quad: WebGLBuffer) {
    const gl = this.gl;
    gl.bindVertexArray(this.edgeVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeParamBuffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);
  }

  private pumpEdgeParams() {
    if (this.edgeParams.length !== this.edgeCount * 3) {
      this.edgeParams = new Float32Array(this.edgeCount * 3);
      this.edgeParamCursor = 0;
    }
    const sliceEnd = Math.min(this.edgeCount, this.edgeParamCursor + EDGE_PARAM_SLICE);
    for (let edge = this.edgeParamCursor; edge < sliceEnd; edge++) {
      const cursor = edge * 3;
      this.edgeParams[cursor] = this.edgePairs[edge * 2] ?? -1;
      this.edgeParams[cursor + 1] = this.edgePairs[edge * 2 + 1] ?? -1;
      this.edgeParams[cursor + 2] = this.edgeTypes[edge] ?? 0;
    }
    this.edgeParamCursor = sliceEnd;
    if (this.edgeParamCursor >= this.edgeCount) this.edgeParamsDirty = false;
  }

  private pumpStaticBuffer() {
    if (this.contextLost || !this.nodeColorBuffer || !this.nodeRadiusBuffer || !this.nodeStateBuffer || !this.edgeParamBuffer) return;
    const gl = this.gl;
    if (this.staticStage === "colors") {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeColorBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.colors, gl.STATIC_DRAW);
      this.staticStage = "radii";
    } else if (this.staticStage === "radii") {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeRadiusBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.radii, gl.STATIC_DRAW);
      this.staticStage = "states";
    } else if (this.staticStage === "states") {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeStateBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.states, gl.DYNAMIC_DRAW);
      this.staticStage = "edgeAlloc";
    } else if (this.staticStage === "edgeAlloc") {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeParamBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.edgeParams.byteLength, gl.STATIC_DRAW);
      this.edgeUploadCursor = 0;
      this.staticStage = "edgeUpload";
    } else if (this.staticStage === "edgeUpload") {
      const floats = Math.min(EDGE_PARAM_SLICE * 3, this.edgeParams.length - this.edgeUploadCursor);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeParamBuffer);
      if (floats > 0) {
        gl.bufferSubData(gl.ARRAY_BUFFER, this.edgeUploadCursor * 4, this.edgeParams.subarray(this.edgeUploadCursor, this.edgeUploadCursor + floats));
        this.edgeUploadCursor += floats;
      }
      if (this.edgeUploadCursor >= this.edgeParams.length) this.staticStage = "done";
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  /** One texture allocation per call, then row slices, so a cold driver cannot fill a whole task. */
  private pumpPositions(deadline: number) {
    const width = POSITION_TEXTURE_WIDTH;
    const height = Math.max(1, Math.ceil(this.count / width));
    if (!this.filling) {
      try {
        if (!this.prepareTextureSlot(width, height)) return;
      } catch {
        this.lost = true;
        this.onContextLost();
        return;
      }
      this.filling = true;
      this.uploadRow = 0;
      this.fillGeneration = this.positionGeneration;
      this.fillTexture = this.front ^ 1;
    }
    const started = performance.now();
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.textures[this.fillTexture] ?? null);
    const floatsPerRow = width * 4;
    if (this.rowImage.length < floatsPerRow * UPLOAD_ROWS) this.rowImage = new Float32Array(floatsPerRow * UPLOAD_ROWS);
    if (this.uploadRow < height && performance.now() < deadline) {
      const rows = Math.min(UPLOAD_ROWS, height - this.uploadRow);
      const rowStart = this.uploadRow * width;
      for (let local = 0; local < rows * width; local++) {
        const index = rowStart + local;
        const target = local * 4;
        if (index >= this.count) {
          this.rowImage[target] = 0;
          this.rowImage[target + 1] = 0;
          this.rowImage[target + 2] = 0;
          continue;
        }
        const source = index * 3;
        this.rowImage[target] = this.xyz[source] ?? 0;
        this.rowImage[target + 1] = this.xyz[source + 1] ?? 0;
        this.rowImage[target + 2] = this.xyz[source + 2] ?? 0;
      }
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, this.uploadRow, width, rows, gl.RGBA, gl.FLOAT, this.rowImage.subarray(0, rows * floatsPerRow));
      this.uploadRow += rows;
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    if (this.uploadRow >= height) {
      this.front = this.fillTexture;
      this.uploadedGeneration = this.fillGeneration;
      this.filling = false;
      this.positionsDirty = false;
    }
    this.onMetrics({ positionMs: performance.now() - started });
  }

  private prepareTextureSlot(width: number, height: number): boolean {
    if (this.textures.length === 2 && this.texWidth === width && this.texHeight === height) return true;
    const gl = this.gl;
    if (this.texWidth !== width || this.texHeight !== height) {
      for (const texture of this.textures) gl.deleteTexture(texture);
      this.textures = [];
      this.texWidth = width;
      this.texHeight = height;
      this.uploadedGeneration = -1;
      this.front = 0;
    }
    const texture = gl.createTexture();
    if (!texture) throw new Error("WebGL texture allocation failed.");
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.getError();
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, width, height);
    const error = gl.getError();
    gl.bindTexture(gl.TEXTURE_2D, null);
    if (error !== gl.NO_ERROR) throw new Error(`Position texture allocation failed (${error}).`);
    this.textures.push(texture);
    return this.textures.length === 2;
  }

  private bindPositions() {
    if (!this.nodeProgram || !this.edgeProgram || this.textures.length < 2) return;
    const gl = this.gl;
    const texture = this.textures[this.front] ?? null;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    for (const program of [this.nodeProgram, this.edgeProgram]) {
      gl.useProgram(program.program);
      gl.uniform1i(program.uniforms.uPositions ?? null, 0);
      gl.uniform1f(program.uniforms.uPositionWidth ?? null, this.texWidth);
    }
  }

  private drawNodes(camera: MemoryCamera3D, scale: number, width: number, height: number) {
    if (!this.nodeProgram || !this.nodeVao || this.count === 0) return;
    const gl = this.gl;
    gl.useProgram(this.nodeProgram.program);
    this.setCamera(this.nodeProgram, camera, scale, width, height);
    gl.uniform1f(this.nodeProgram.uniforms.uHasFocus ?? null, this.focus >= 0 ? 1 : 0);
    gl.bindVertexArray(this.nodeVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
  }

  private drawEdges(camera: MemoryCamera3D, scale: number, width: number, height: number) {
    if (!this.edgeProgram || !this.edgeVao || this.edgeCount === 0) return;
    const gl = this.gl;
    gl.useProgram(this.edgeProgram.program);
    const uniforms = this.edgeProgram.uniforms;
    gl.uniform1f(uniforms.uYawCos ?? null, Math.cos(camera.yaw));
    gl.uniform1f(uniforms.uYawSin ?? null, Math.sin(camera.yaw));
    gl.uniform1f(uniforms.uPitchCos ?? null, Math.cos(camera.pitch));
    gl.uniform1f(uniforms.uPitchSin ?? null, Math.sin(camera.pitch));
    gl.uniform1f(uniforms.uZoom ?? null, camera.zoom);
    gl.uniform1f(uniforms.uScale ?? null, scale);
    gl.uniform1f(uniforms.uWidth ?? null, width);
    gl.uniform1f(uniforms.uHeight ?? null, height);
    gl.uniform1f(uniforms.uFocus ?? null, this.focus);
    gl.bindVertexArray(this.edgeVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.edgeCount);
  }

  private setCamera(program: ProgramHandles, camera: MemoryCamera3D, scale: number, width: number, height: number) {
    const gl = this.gl;
    gl.uniform1f(program.uniforms.uYaw ?? null, camera.yaw);
    gl.uniform1f(program.uniforms.uPitch ?? null, camera.pitch);
    gl.uniform1f(program.uniforms.uZoom ?? null, camera.zoom);
    gl.uniform1f(program.uniforms.uScale ?? null, scale);
    gl.uniform1f(program.uniforms.uWidth ?? null, width);
    gl.uniform1f(program.uniforms.uHeight ?? null, height);
  }

  private buffer() {
    const buffer = this.gl.createBuffer();
    if (!buffer) throw new Error("WebGL buffer allocation failed.");
    this.buffers.push(buffer);
    return buffer;
  }

  private link(vertexSource: string, fragmentSource: string, uniformNames: string[]): ProgramHandles {
    const linked = this.linkUnblocked(vertexSource, fragmentSource, uniformNames);
    this.finalizeProgram(linked);
    return linked;
  }

  /** Submits compile and link without asking for status, so KHR_parallel_shader_compile can run off the caller. */
  private linkUnblocked(vertexSource: string, fragmentSource: string, uniformNames: string[]): ProgramHandles {
    const gl = this.gl;
    const program = gl.createProgram();
    if (!program) throw new Error("WebGL program allocation failed.");
    const vertex = this.compileShader(gl.VERTEX_SHADER, vertexSource);
    const fragment = this.compileShader(gl.FRAGMENT_SHADER, fragmentSource);
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    return { program, uniforms: {}, shaders: [vertex, fragment], uniformNames };
  }

  private finalizeProgram(linked: ProgramHandles) {
    const gl = this.gl;
    for (const shader of linked.shaders) {
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader) ?? "compile failed";
        gl.deleteShader(shader);
        throw new Error(log);
      }
    }
    if (!gl.getProgramParameter(linked.program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(linked.program) ?? "link failed";
      gl.deleteProgram(linked.program);
      throw new Error(log);
    }
    for (const shader of linked.shaders) {
      const index = this.pendingShaders.indexOf(shader);
      if (index >= 0) this.pendingShaders.splice(index, 1);
      gl.deleteShader(shader);
    }
    linked.shaders = [];
    for (const name of linked.uniformNames) linked.uniforms[name] = gl.getUniformLocation(linked.program, name);
  }

  private compileShader(type: number, source: string) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) throw new Error("WebGL shader allocation failed.");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    this.pendingShaders.push(shader);
    return shader;
  }
}
