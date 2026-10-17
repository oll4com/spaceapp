import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import type { MemoryCamera3D, MemoryPoint3D } from "./memory-3d.js";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import { isMemoryCoreLabel, memoryGraphNodeStyle } from "./memory-graph-visuals.js";

/**
 * WebGL2 renderer for the 3D memory graph.
 *
 * It exists because the Canvas 2D path does per-frame work proportional to the node count: it
 * projects every node on the CPU, sorts all nodes by depth, strokes every edge as its own path and
 * draws every node with `arc()`. At 50,000 nodes that is the bottleneck, not the drawing.
 *
 * This module draws the whole graph in two draw calls (one instanced node pass, one batched line
 * pass) and keeps the existing look: the projection below reproduces `projectMemoryPoint` exactly,
 * including its clamped `650 / max(120, 650 + z * scale)` perspective term, so colours, sizes and
 * depth ordering match what the 2D path produced.
 *
 * Picking is done on the GPU: node ids are rendered into an offscreen framebuffer and read back as
 * a single pixel, which costs the same at 50,000 nodes as at 100.
 */

const NODE_VERTEX = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec3 aOffset;
layout(location = 2) in vec3 aColor;
layout(location = 3) in float aSize;
layout(location = 4) in float aId;
layout(location = 5) in float aNeighbor;

uniform float uYaw, uPitch, uScale, uZoom, uWidth, uHeight;
uniform float uFocus;          // -1 when nothing is focused
uniform float uCoreId;         // the canonical index node, highlighted like before
uniform float uDpr;

out vec3 vColor;
out float vAlpha;

void main() {
  // Identical to projectMemoryPoint: yaw around Y, then pitch around X.
  float x = aOffset.x * cos(uYaw) + aOffset.z * sin(uYaw);
  float depth = -aOffset.x * sin(uYaw) + aOffset.z * cos(uYaw);
  float y = aOffset.y * cos(uPitch) - depth * sin(uPitch);
  float z = aOffset.y * sin(uPitch) + depth * cos(uPitch);

  float perspective = 650.0 / max(120.0, 650.0 + z * uScale);
  float sx = uWidth * 0.5 + x * uScale * uZoom * perspective;
  float sy = uHeight * 0.5 - y * uScale * uZoom * perspective;

  bool hasFocus = uFocus >= -0.5;
  bool isFocus = hasFocus && abs(aId - uFocus) < 0.5;
  bool isNeighbor = aNeighbor > 0.5;
  bool isCore = abs(aId - uCoreId) < 0.5;

  float radius = max(1.0, aSize * perspective * sqrt(uZoom)) * (isFocus ? 1.5 : 1.0);
  vec2 corner = aCorner * radius * uDpr;
  vec2 screen = vec2(sx, sy) * uDpr + corner;

  vec2 ndc = vec2(screen.x / (uWidth * uDpr) * 2.0 - 1.0, 1.0 - screen.y / (uHeight * uDpr) * 2.0);
  gl_Position = vec4(ndc, clamp(0.5 - z * 0.0025, 0.0, 1.0), 1.0);

  vColor = isFocus ? vec3(1.0) : aColor;
  bool faded = hasFocus && !isFocus && !isNeighbor;
  vAlpha = faded ? 0.2 : clamp(max(0.4, min(1.0, perspective)), 0.4, 1.0);
  if (isCore && !hasFocus) vAlpha = 1.0;
}`;

const NODE_FRAGMENT = `#version 300 es
precision highp float;
in vec3 vColor;
in float vAlpha;
out vec4 frag;
void main() { frag = vec4(vColor, vAlpha); }`;

const PICK_VERTEX = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec3 aOffset;
layout(location = 3) in float aSize;
layout(location = 4) in float aId;

uniform float uYaw, uPitch, uScale, uZoom, uWidth, uHeight, uDpr;
flat out float vId;

void main() {
  vId = aId;
  float x = aOffset.x * cos(uYaw) + aOffset.z * sin(uYaw);
  float depth = -aOffset.x * sin(uYaw) + aOffset.z * cos(uYaw);
  float y = aOffset.y * cos(uPitch) - depth * sin(uPitch);
  float z = aOffset.y * sin(uPitch) + depth * cos(uPitch);
  float perspective = 650.0 / max(120.0, 650.0 + z * uScale);
  float sx = uWidth * 0.5 + x * uScale * uZoom * perspective;
  float sy = uHeight * 0.5 - y * uScale * uZoom * perspective;
  float radius = max(1.0, aSize * perspective * sqrt(uZoom)) + 3.0;   // same slack as the old hit test
  vec2 screen = vec2(sx, sy) * uDpr + aCorner * radius * uDpr;
  vec2 ndc = vec2(screen.x / (uWidth * uDpr) * 2.0 - 1.0, 1.0 - screen.y / (uHeight * uDpr) * 2.0);
  gl_Position = vec4(ndc, clamp(0.5 - z * 0.0025, 0.0, 1.0), 1.0);
}`;

const PICK_FRAGMENT = `#version 300 es
precision highp float;
flat in float vId;
out vec4 frag;
void main() {
  float id = vId + 1.0;                       // 0 stays "nothing here"
  frag = vec4(floor(id / 65536.0) / 255.0, floor(mod(id, 65536.0) / 256.0) / 255.0, mod(id, 256.0) / 255.0, 1.0);
}`;

const EDGE_VERTEX = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aOffset;
layout(location = 1) in vec3 aColor;

uniform float uYaw, uPitch, uScale, uZoom, uWidth, uHeight, uDpr;

out vec3 vColor;

void main() {
  vColor = aColor;
  float x = aOffset.x * cos(uYaw) + aOffset.z * sin(uYaw);
  float depth = -aOffset.x * sin(uYaw) + aOffset.z * cos(uYaw);
  float y = aOffset.y * cos(uPitch) - depth * sin(uPitch);
  float z = aOffset.y * sin(uPitch) + depth * cos(uPitch);
  float perspective = 650.0 / max(120.0, 650.0 + z * uScale);
  float sx = uWidth * 0.5 + x * uScale * uZoom * perspective;
  float sy = uHeight * 0.5 - y * uScale * uZoom * perspective;
  vec2 screen = vec2(sx, sy) * uDpr;
  vec2 ndc = vec2(screen.x / (uWidth * uDpr) * 2.0 - 1.0, 1.0 - screen.y / (uHeight * uDpr) * 2.0);
  gl_Position = vec4(ndc, clamp(0.5 - z * 0.0025, 0.0, 1.0), 1.0);
}`;

const EDGE_FRAGMENT = `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 frag;
void main() { frag = vec4(vColor, 1.0); }`;

type Placement = { id: string; x: number; y: number; perspective: number; z: number };

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  const normalised = value.length === 3 ? value.split("").map((c) => c + c).join("") : value;
  const int = Number.parseInt(normalised.slice(0, 6), 16);
  if (!Number.isFinite(int)) return [0.45, 0.58, 0.68];
  return [((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255];
}

/**
 * Colour parsing is memoised: there are a handful of distinct hex values (node styles, canonical
 * index, ten edge types), but the graph has 150,000 edges. Parsing per edge showed up as a main
 * thread long task at 50,000 nodes.
 */
const COLOR_CACHE = new Map<string, [number, number, number]>();
function colorOf(hex: string): [number, number, number] {
  let cached = COLOR_CACHE.get(hex);
  if (!cached) { cached = hexToRgb(hex); COLOR_CACHE.set(hex, cached); }
  return cached;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("shader allocation failed");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "unknown";
    gl.deleteShader(shader);
    throw new Error(`memory graph shader failed: ${log}`);
  }
  return shader;
}

function link(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error("program allocation failed");
  const vs = compile(gl, gl.VERTEX_SHADER, vertex);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragment);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? "unknown";
    gl.deleteProgram(program);
    throw new Error(`memory graph program failed: ${log}`);
  }
  return program;
}

export class MemoryGraphWebGL {
  private readonly gl: WebGL2RenderingContext;
  private readonly nodeProgram: WebGLProgram;
  private readonly pickProgram: WebGLProgram;
  private readonly edgeProgram: WebGLProgram;
  private readonly quadBuffer: WebGLBuffer;
  private readonly offsetBuffer: WebGLBuffer;
  private readonly colorBuffer: WebGLBuffer;
  private readonly sizeBuffer: WebGLBuffer;
  private readonly idBuffer: WebGLBuffer;
  private readonly neighborBuffer: WebGLBuffer;
  private readonly edgeOffsetBuffer: WebGLBuffer;
  private readonly edgeColorBuffer: WebGLBuffer;
  private readonly nodeVao: WebGLVertexArrayObject;
  private readonly pickVao: WebGLVertexArrayObject;
  private readonly edgeVao: WebGLVertexArrayObject;
  private readonly pickTexture: WebGLTexture;
  private readonly pickDepth: WebGLRenderbuffer;
  private readonly pickFramebuffer: WebGLFramebuffer;
  private readonly pixel = new Uint8Array(4);

  private nodeCount = 0;
  private edgeVertexCount = 0;
  private ids: string[] = [];
  private nodeOffsets = new Float32Array(0);
  private index = new Map<string, number>();
  private neighbors = new Uint8Array(0);
  private adjacency: number[][] = [];
  private edgePairs = new Uint32Array(0);
  private idValues: Float32Array | null = null;
  private coreId = -1;
  // Slot order used by the bounded label pass: core first, then SOURCE files, then the rest.
  // Projecting slots 0..limit-1 in upload order meant a focused node that happened to upload late
  // could never be labelled, while the 2D path labelled it.
  private labelPriority = new Uint32Array(0);

  /** Returns null when WebGL2 is unavailable, so the caller can keep the 2D fallback. */
  static create(canvas: HTMLCanvasElement): MemoryGraphWebGL | null {
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: true, premultipliedAlpha: false });
    return gl ? new MemoryGraphWebGL(gl) : null;
  }

  private constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.nodeProgram = link(gl, NODE_VERTEX, NODE_FRAGMENT);
    this.pickProgram = link(gl, PICK_VERTEX, PICK_FRAGMENT);
    this.edgeProgram = link(gl, EDGE_VERTEX, EDGE_FRAGMENT);

    const buffer = () => {
      const created = gl.createBuffer();
      if (!created) throw new Error("buffer allocation failed");
      return created;
    };
    this.quadBuffer = buffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    this.offsetBuffer = buffer();
    this.colorBuffer = buffer();
    this.sizeBuffer = buffer();
    this.idBuffer = buffer();
    this.neighborBuffer = buffer();
    this.edgeOffsetBuffer = buffer();
    this.edgeColorBuffer = buffer();

    const vao = () => {
      const created = gl.createVertexArray();
      if (!created) throw new Error("vertex array allocation failed");
      return created;
    };
    this.nodeVao = vao();
    this.pickVao = vao();
    this.edgeVao = vao();

    const attach = (vaoId: WebGLVertexArrayObject, bufferId: WebGLBuffer, location: number, size: number, divisor: number) => {
      gl.bindVertexArray(vaoId);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufferId);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
      if (divisor > 0) gl.vertexAttribDivisor(location, divisor);
    };

    for (const vaoId of [this.nodeVao, this.pickVao]) {
      gl.bindVertexArray(vaoId);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
    }
    attach(this.nodeVao, this.offsetBuffer, 1, 3, 1);
    attach(this.nodeVao, this.colorBuffer, 2, 3, 1);
    attach(this.nodeVao, this.sizeBuffer, 3, 1, 1);
    attach(this.nodeVao, this.idBuffer, 4, 1, 1);
    attach(this.nodeVao, this.neighborBuffer, 5, 1, 1);
    attach(this.pickVao, this.offsetBuffer, 1, 3, 1);
    attach(this.pickVao, this.sizeBuffer, 3, 1, 1);
    attach(this.pickVao, this.idBuffer, 4, 1, 1);

    gl.bindVertexArray(this.edgeVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeOffsetBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeColorBuffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    const texture = gl.createTexture();
    const depth = gl.createRenderbuffer();
    const framebuffer = gl.createFramebuffer();
    if (!texture || !depth || !framebuffer) throw new Error("offscreen buffers unavailable");
    this.pickTexture = texture;
    this.pickDepth = depth;
    this.pickFramebuffer = framebuffer;
  }

  get available(): boolean {
    return true;
  }

  /** Uploads a new graph. Cheap when the graph is unchanged, so callers may call it on every render. */
  setGraph(
    nodes: MemoryGraphNode[],
    edges: MemoryGraphEdge[],
    coordinates: Map<string, MemoryPoint3D>,
    atlas: Map<string, MemoryAtlasPosition>
  ): void {
    const gl = this.gl;
    this.ids = [];
    this.index = new Map();
    // A core node is optional per graph; without this reset a graph that has none inherits the
    // previous graph's slot and the shader highlights an unrelated node.
    this.coreId = -1;
    // Preallocated typed arrays, written by index. Building `number[]` with push and converting
    // afterwards allocated and copied ~1.2 MB of temporary arrays per upload, which is what turned
    // the first upload into a >100 ms main-thread task at 50,000 nodes.
    const nodeStride = nodes.length * 3;
    const offsets = new Float32Array(nodeStride);
    const colors = new Float32Array(nodeStride);
    const sizes = new Float32Array(nodes.length);
    const sourceSlots: number[] = [];
    let slot = 0;

    for (const node of nodes) {
      const point = coordinates.get(node.id);
      if (!point) continue;
      this.index.set(node.id, slot);
      this.ids.push(node.id);
      const style = memoryGraphNodeStyle(node);
      const tint = atlas.get(node.id)?.color ?? style.color;
      const [r, g, b] = colorOf(tint);
      offsets[slot * 3] = point.x;
      offsets[slot * 3 + 1] = point.y;
      offsets[slot * 3 + 2] = point.z;
      colors[slot * 3] = r;
      colors[slot * 3 + 1] = g;
      colors[slot * 3 + 2] = b;
      sizes[slot] = isMemoryCoreLabel(node.label) ? Math.max(style.size, 11) : style.size;
      if (isMemoryCoreLabel(node.label)) this.coreId = slot;
      if (node.type === "SOURCE") sourceSlots.push(slot);
      slot += 1;
    }
    this.nodeCount = slot;
    this.nodeOffsets = offsets.subarray(0, this.nodeCount * 3);
    // Label candidate order, built once per upload: core, then SOURCE files, then the rest. The
    // per-frame pass only walks this array, so the bound stays fixed while the *choice* of which
    // nodes get the budget no longer depends on upload position. The focused node is promoted by
    // `projectAll`, since focus changes without a graph upload.
    {
      const isSource = new Uint8Array(this.nodeCount);
      for (const sourceSlot of sourceSlots) if (sourceSlot < this.nodeCount) isSource[sourceSlot] = 1;
      const order = new Uint32Array(this.nodeCount);
      let cursor = 0;
      if (this.coreId >= 0 && this.coreId < this.nodeCount) order[cursor++] = this.coreId;
      for (let i = 0; i < this.nodeCount; i++) if (isSource[i] && i !== this.coreId) order[cursor++] = i;
      for (let i = 0; i < this.nodeCount; i++) if (!isSource[i] && i !== this.coreId) order[cursor++] = i;
      this.labelPriority = order;
    }
    // Adjacency is only needed for focus highlighting, so it is built on the first `setFocus` call
    // with a real selection instead of on every graph upload — that allocation was O(edges) with one
    // array per node and showed up as a long task at 50,000 nodes.
    this.edgePairs = new Uint32Array(0);

    const edgeStride = edges.length * 6;
    const edgeOffsets = new Float32Array(edgeStride);
    const edgeColors = new Float32Array(edgeStride);
    const pairs = new Uint32Array(edges.length * 2);
    let edgeVertex = 0, pairCount = 0;
    for (const edge of edges) {
      const from = this.index.get(edge.source);
      const to = this.index.get(edge.target);
      if (from === undefined || to === undefined) continue;
      pairs[pairCount] = from;
      pairs[pairCount + 1] = to;
      pairCount += 2;
      const [er, eg, eb] = colorOf(edgeTypeColor(edge));
      const base = edgeVertex * 3;
      edgeOffsets[base] = offsets[from * 3]!;
      edgeOffsets[base + 1] = offsets[from * 3 + 1]!;
      edgeOffsets[base + 2] = offsets[from * 3 + 2]!;
      edgeOffsets[base + 3] = offsets[to * 3]!;
      edgeOffsets[base + 4] = offsets[to * 3 + 1]!;
      edgeOffsets[base + 5] = offsets[to * 3 + 2]!;
      edgeColors[base] = er; edgeColors[base + 1] = eg; edgeColors[base + 2] = eb;
      edgeColors[base + 3] = er; edgeColors[base + 4] = eg; edgeColors[base + 5] = eb;
      edgeVertex += 2;
    }
    this.edgePairs = pairs.subarray(0, pairCount);
    this.adjacency = [];
    this.edgeVertexCount = edgeVertex;

    gl.bindBuffer(gl.ARRAY_BUFFER, this.offsetBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.nodeOffsets, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, colors.subarray(0, this.nodeCount * 3), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.sizeBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, sizes.subarray(0, this.nodeCount), gl.DYNAMIC_DRAW);
    // Instance ids never change for a given node count; only rebuild when the buffer is too small.
    if (!this.idValues || this.idValues.length < this.nodeCount) {
      const idValues = new Float32Array(this.nodeCount);
      for (let i = 0; i < this.nodeCount; i++) idValues[i] = i;
      this.idValues = idValues;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.idBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, idValues, gl.DYNAMIC_DRAW);
    }
    // `neighbors` is written by index in `setFocus`, so it has to match the node count. It used to
    // stay `new Uint8Array(0)`, and typed arrays ignore out-of-bounds stores, so every neighbour
    // write was silently dropped: the instanced attribute uploaded empty and focused neighbours
    // never faded. Reallocate only when the count changes, since callers may call this per render.
    if (this.neighbors.length !== this.nodeCount) this.neighbors = new Uint8Array(this.nodeCount);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.neighborBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.neighbors, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeOffsetBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, edgeOffsets.subarray(0, this.edgeVertexCount * 3), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeColorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, edgeColors.subarray(0, this.edgeVertexCount * 3), gl.DYNAMIC_DRAW);
  }

  /** Recomputes the focus neighbourhood once per selection change, never per frame. */
  setFocus(nodeId: string | null): void {
    const gl = this.gl;
    this.neighbors.fill(0);
    const slot = nodeId === null ? undefined : this.index.get(nodeId);
    if (slot !== undefined) {
      if (this.adjacency.length === 0) this.buildAdjacency();
      for (const neighbor of this.adjacency[slot] ?? []) this.neighbors[neighbor] = 1;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.neighborBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.neighbors, gl.DYNAMIC_DRAW);
  }

  private buildAdjacency(): void {
    const adjacency: number[][] = Array.from({ length: this.nodeCount }, () => []);
    for (let i = 0; i < this.edgePairs.length; i += 2) {
      const from = this.edgePairs[i]!;
      const to = this.edgePairs[i + 1]!;
      adjacency[from]?.push(to);
      adjacency[to]?.push(from);
    }
    this.adjacency = adjacency;
  }

  private uniforms(camera: MemoryCamera3D, width: number, height: number, dpr: number, scale: number) {
    return {
      uYaw: camera.yaw, uPitch: camera.pitch, uScale: scale, uZoom: camera.zoom,
      uWidth: width, uHeight: height, uDpr: dpr,
    } as const;
  }

  render(camera: MemoryCamera3D, focusId: string | null, width: number, height: number, scale: number, dpr: number): void {
    const gl = this.gl;
    const u = this.uniforms(camera, width, height, dpr, scale);
    gl.viewport(0, 0, Math.round(width * dpr), Math.round(height * dpr));
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    if (this.edgeVertexCount > 0) {
      gl.useProgram(this.edgeProgram);
      for (const [name, value] of Object.entries(u)) gl.uniform1f(gl.getUniformLocation(this.edgeProgram, name), value);
      gl.bindVertexArray(this.edgeVao);
      gl.drawArrays(gl.LINES, 0, this.edgeVertexCount);
    }

    if (this.nodeCount > 0) {
      gl.useProgram(this.nodeProgram);
      for (const [name, value] of Object.entries(u)) gl.uniform1f(gl.getUniformLocation(this.nodeProgram, name), value);
      const focusSlot = focusId === null ? -1 : (this.index.get(focusId) ?? -1);
      gl.uniform1f(gl.getUniformLocation(this.nodeProgram, "uFocus"), focusSlot);
      gl.uniform1f(gl.getUniformLocation(this.nodeProgram, "uCoreId"), this.coreId);
      gl.bindVertexArray(this.nodeVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.nodeCount);
    }
    gl.bindVertexArray(null);
  }

  /** GPU picking: one instanced pass into an offscreen target, then one pixel read back. */
  pick(x: number, y: number, camera: MemoryCamera3D, width: number, height: number, scale: number, dpr: number): string | null {
    const gl = this.gl;
    if (this.nodeCount === 0) return null;
    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const pixelHeight = Math.max(1, Math.round(height * dpr));

    gl.bindTexture(gl.TEXTURE_2D, this.pickTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, pixelWidth, pixelHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.pickDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, pixelWidth, pixelHeight);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.pickTexture, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.pickDepth);

    gl.viewport(0, 0, pixelWidth, pixelHeight);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    const u = this.uniforms(camera, width, height, dpr, scale);
    gl.useProgram(this.pickProgram);
    for (const [name, value] of Object.entries(u)) gl.uniform1f(gl.getUniformLocation(this.pickProgram, name), value);
    gl.bindVertexArray(this.pickVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.nodeCount);
    gl.readPixels(Math.round(x * dpr), pixelHeight - 1 - Math.round(y * dpr), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.pixel);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);

    const encoded = (this.pixel[0]! << 16) | (this.pixel[1]! << 8) | this.pixel[2]!;
    if (encoded === 0) return null;
    return this.ids[encoded - 1] ?? null;
  }

  /**
   * Screen placements for the label pass. Bounded by `limit` so the caller can measure text for a
   * fixed number of candidates no matter how large the graph is.
   */
  projectAll(camera: MemoryCamera3D, width: number, height: number, scale: number, limit: number, focusId?: string | null): Placement[] {
    const placements: Placement[] = [];
    const cosY = Math.cos(camera.yaw), sinY = Math.sin(camera.yaw);
    const cosP = Math.cos(camera.pitch), sinP = Math.sin(camera.pitch);
    const focusSlot = focusId === undefined || focusId === null ? -1 : (this.index.get(focusId) ?? -1);
    const order = this.labelPriority;
    const orderLength = Math.min(order.length, this.nodeCount);
    // k === -1 is the focus slot: it is promoted ahead of the ordered candidates without rebuilding
    // the array on every frame.
    for (let k = -1; k < orderLength && placements.length < limit; k++) {
      const slot = k < 0 ? focusSlot : order[k]!;
      if (slot < 0 || slot >= this.nodeCount) continue;
      if (k >= 0 && slot === focusSlot) continue;
      const px = this.nodeOffsets[slot * 3] ?? 0;
      const py = this.nodeOffsets[slot * 3 + 1] ?? 0;
      const pz = this.nodeOffsets[slot * 3 + 2] ?? 0;
      const x = px * cosY + pz * sinY;
      const depth = -px * sinY + pz * cosY;
      const y = py * cosP - depth * sinP;
      const z = py * sinP + depth * cosP;
      const perspective = 650 / Math.max(120, 650 + z * scale);
      placements.push({
        id: this.ids[slot]!,
        x: width / 2 + x * scale * camera.zoom * perspective,
        y: height / 2 - y * scale * camera.zoom * perspective,
        z,
        perspective,
      });
    }
    return placements;
  }

  dispose(): void {
    const gl = this.gl;
    for (const program of [this.nodeProgram, this.pickProgram, this.edgeProgram]) gl.deleteProgram(program);
    for (const buffer of [this.quadBuffer, this.offsetBuffer, this.colorBuffer, this.sizeBuffer, this.idBuffer, this.neighborBuffer, this.edgeOffsetBuffer, this.edgeColorBuffer]) gl.deleteBuffer(buffer);
    for (const vao of [this.nodeVao, this.pickVao, this.edgeVao]) gl.deleteVertexArray(vao);
    gl.deleteTexture(this.pickTexture);
    gl.deleteRenderbuffer(this.pickDepth);
    gl.deleteFramebuffer(this.pickFramebuffer);
  }
}

function edgeTypeColor(edge: MemoryGraphEdge): string {
  switch (edge.type) {
    case "TAGGED_WITH": return edge.origin === "EXPLICIT_TAG" ? "#d9aa4f" : "#9d854e";
    case "SEMANTICALLY_RELATED": return "#4fa99a";
    case "CONFLICTS_WITH": return "#c45d66";
    case "DUPLICATES": return "#d1845f";
    case "SUPERSEDES": return "#a987d0";
    case "BELONGS_TO_ROOM": return "#4f6f94";
    case "DERIVED_FROM": return "#675b78";
    case "CACHED_AS": return "#51565c";
    case "CONTAINS": return "#40504f";
    default: return "#40504f";
  }
}
