import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import type { MemoryCamera3D, MemoryPoint3D } from "./memory-3d.js";

const NODE_VERT = `#version 300 es
precision highp float;

in vec2 a_quad_vertex;
in vec3 a_position;
in vec4 a_color;
in vec4 a_meta; // (baseRadius, isRoot, status, pickId)

uniform float u_yaw;
uniform float u_pitch;
uniform float u_zoom;
uniform float u_scale;
uniform vec2 u_viewport;
uniform float u_extent;

uniform bool u_picking_mode;
uniform vec2 u_pick_target;

out vec2 v_uv;
out vec4 v_color;
out float v_glow;
out float v_radius_px;
out float v_pick_id;

void main() {
  float cy = cos(u_yaw);
  float sy = sin(u_yaw);
  float cp = cos(u_pitch);
  float sp = sin(u_pitch);

  float rx = a_position.x * cy + a_position.z * sy;
  float depth = -a_position.x * sy + a_position.z * cy;
  float ry = a_position.y * cp - depth * sp;
  float rz = a_position.y * sp + depth * cp;

  float perspective = 650.0 / max(120.0, 650.0 + rz * u_scale);

  float ndc_x = rx * u_scale * u_zoom * perspective * (2.0 / u_viewport.x);
  float ndc_y = ry * u_scale * u_zoom * perspective * (2.0 / u_viewport.y);
  float norm_z = clamp(rz / (u_extent * 2.0), -0.9, 0.9);

  float baseRadius = a_meta.x;
  float isRoot = a_meta.y;
  float status = a_meta.z;
  bool isHighlighted = (status == 1.0);
  bool isDimmed = (status == 3.0);

  float r = max(1.0, baseRadius * perspective * sqrt(u_zoom)) * (isHighlighted ? 1.5 : 1.0);
  v_radius_px = r;

  bool hasGlow = (isRoot > 0.5 || isHighlighted);
  float glowPadding = hasGlow ? 13.0 : 1.5;
  v_glow = hasGlow ? 1.0 : 0.0;

  if (u_picking_mode) {
    float pickRadius = max(7.0, r + 3.0);
    float dx_px = (ndc_x - u_pick_target.x) * (u_viewport.x * 0.5);
    float dy_px = (ndc_y - u_pick_target.y) * (u_viewport.y * 0.5);
    vec2 pos_px = vec2(dx_px, dy_px) + a_quad_vertex * pickRadius;
    gl_Position = vec4(pos_px.x, pos_px.y, norm_z, 1.0);
    v_uv = a_quad_vertex;
    v_pick_id = a_meta.w;
  } else {
    float quadHalfSize = r + glowPadding;
    vec2 offset_ndc = a_quad_vertex * (quadHalfSize * 2.0 / u_viewport);
    gl_Position = vec4(ndc_x + offset_ndc.x, ndc_y + offset_ndc.y, norm_z, 1.0);
    v_uv = a_quad_vertex * (quadHalfSize / r);

    float alpha = isDimmed ? 0.2 : clamp(perspective, 0.4, 1.0);
    vec3 rgb = isHighlighted ? vec3(1.0, 1.0, 1.0) : a_color.rgb;
    v_color = vec4(rgb, alpha);
    v_pick_id = a_meta.w;
  }
}
`;

const NODE_FRAG = `#version 300 es
precision highp float;

in vec2 v_uv;
in vec4 v_color;
in float v_glow;
in float v_radius_px;
in float v_pick_id;

uniform bool u_picking_mode;

out vec4 fragColor;

void main() {
  float dist = length(v_uv);

  if (u_picking_mode) {
    if (dist > 1.0) {
      discard;
    }
    int id = int(v_pick_id + 0.5);
    float r = float(id & 0xFF) / 255.0;
    float g = float((id >> 8) & 0xFF) / 255.0;
    float b = float((id >> 16) & 0xFF) / 255.0;
    fragColor = vec4(r, g, b, 1.0);
    return;
  }

  if (dist <= 1.0) {
    float pixelFromEdge = (1.0 - dist) * v_radius_px;
    float edgeAlpha = clamp(pixelFromEdge, 0.0, 1.0);
    fragColor = vec4(v_color.rgb, v_color.a * edgeAlpha);
    gl_FragDepth = gl_FragCoord.z;
  } else {
    if (v_glow > 0.5) {
      float pixelPastEdge = (dist - 1.0) * v_radius_px;
      if (pixelPastEdge > 13.0) {
        discard;
      }
      float glowAlpha = exp(-pixelPastEdge / 4.2) * 0.7 * v_color.a;
      fragColor = vec4(v_color.rgb, glowAlpha);
      gl_FragDepth = 1.0;
    } else {
      discard;
    }
  }
}
`;

const EDGE_VERT = `#version 300 es
precision highp float;

in vec3 a_position;
in vec4 a_color;

uniform float u_yaw;
uniform float u_pitch;
uniform float u_zoom;
uniform float u_scale;
uniform vec2 u_viewport;
uniform float u_extent;

out vec4 v_color;

void main() {
  float cy = cos(u_yaw);
  float sy = sin(u_yaw);
  float cp = cos(u_pitch);
  float sp = sin(u_pitch);

  float rx = a_position.x * cy + a_position.z * sy;
  float depth = -a_position.x * sy + a_position.z * cy;
  float ry = a_position.y * cp - depth * sp;
  float rz = a_position.y * sp + depth * cp;

  float perspective = 650.0 / max(120.0, 650.0 + rz * u_scale);

  float ndc_x = rx * u_scale * u_zoom * perspective * (2.0 / u_viewport.x);
  float ndc_y = ry * u_scale * u_zoom * perspective * (2.0 / u_viewport.y);
  float norm_z = clamp(rz / (u_extent * 2.0), -0.9, 0.9);

  gl_Position = vec4(ndc_x, ndc_y, norm_z, 1.0);
  v_color = a_color;
}
`;

const EDGE_FRAG = `#version 300 es
precision highp float;

in vec4 v_color;
out vec4 fragColor;

void main() {
  fragColor = v_color;
}
`;

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Failed to create WebGL shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compilation error: ${info}`);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext, vertSrc: string, fragSrc: string): WebGLProgram {
  const vert = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
  const frag = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  const program = gl.createProgram();
  if (!program) throw new Error("Failed to create WebGL program");
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  gl.deleteShader(vert);
  gl.deleteShader(frag);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Program link error: ${info}`);
  }
  return program;
}

function parseHexColorFast(hex: string | undefined): [number, number, number, number] {
  if (!hex || hex[0] !== "#") return [115, 149, 173, 255];
  if (hex.length === 7) {
    const num = parseInt(hex.slice(1), 16);
    return [(num >> 16) & 255, (num >> 8) & 255, num & 255, 255];
  }
  if (hex.length === 4) {
    const r = parseInt(hex[1]! + hex[1]!, 16);
    const g = parseInt(hex[2]! + hex[2]!, 16);
    const b = parseInt(hex[3]! + hex[3]!, 16);
    return [r, g, b, 255];
  }
  return [115, 149, 173, 255];
}

export class WebGL2MemoryGraphRenderer {
  private gl: WebGL2RenderingContext;
  private nodeProgram: WebGLProgram;
  private edgeProgram: WebGLProgram;

  // Node Uniforms
  private uNodeYaw: WebGLUniformLocation | null;
  private uNodePitch: WebGLUniformLocation | null;
  private uNodeZoom: WebGLUniformLocation | null;
  private uNodeScale: WebGLUniformLocation | null;
  private uNodeViewport: WebGLUniformLocation | null;
  private uNodeExtent: WebGLUniformLocation | null;
  private uNodePickingMode: WebGLUniformLocation | null;
  private uNodePickTarget: WebGLUniformLocation | null;

  // Edge Uniforms
  private uEdgeYaw: WebGLUniformLocation | null;
  private uEdgePitch: WebGLUniformLocation | null;
  private uEdgeZoom: WebGLUniformLocation | null;
  private uEdgeScale: WebGLUniformLocation | null;
  private uEdgeViewport: WebGLUniformLocation | null;
  private uEdgeExtent: WebGLUniformLocation | null;

  // Node VAO and Buffers
  private nodeVao: WebGLVertexArrayObject | null = null;
  private quadVbo: WebGLBuffer | null = null;
  private quadIbo: WebGLBuffer | null = null;
  private nodePosVbo: WebGLBuffer | null = null;
  private nodeColorVbo: WebGLBuffer | null = null;
  private nodeMetaVbo: WebGLBuffer | null = null;

  // Edge VAO and Buffers
  private edgeVao: WebGLVertexArrayObject | null = null;
  private edgePosVbo: WebGLBuffer | null = null;
  private edgeColorVbo: WebGLBuffer | null = null;

  // Picking Framebuffer
  private pickFbo: WebGLFramebuffer | null = null;
  private pickColorRb: WebGLRenderbuffer | null = null;
  private pickDepthRb: WebGLRenderbuffer | null = null;
  private pickPixel = new Uint8Array(4);

  // Cached CPU graph data
  private nodes: MemoryGraphNode[] = [];
  private edges: MemoryGraphEdge[] = [];
  private nodeIndexMap = new Map<string, number>();
  private adjacency = new Map<string, Set<string>>();
  private nodeCount = 0;
  private edgeVertexCount = 0;

  // CPU buffer arrays for dynamic updates
  private metaArray = new Float32Array(0);
  private edgeColorArray = new Uint8Array(0);
  private currentFocus: string | null = null;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: true,
      depth: true,
      premultipliedAlpha: false
    });
    if (!gl) throw new Error("WebGL2 not supported");
    this.gl = gl;

    this.nodeProgram = createProgram(gl, NODE_VERT, NODE_FRAG);
    this.edgeProgram = createProgram(gl, EDGE_VERT, EDGE_FRAG);

    this.uNodeYaw = gl.getUniformLocation(this.nodeProgram, "u_yaw");
    this.uNodePitch = gl.getUniformLocation(this.nodeProgram, "u_pitch");
    this.uNodeZoom = gl.getUniformLocation(this.nodeProgram, "u_zoom");
    this.uNodeScale = gl.getUniformLocation(this.nodeProgram, "u_scale");
    this.uNodeViewport = gl.getUniformLocation(this.nodeProgram, "u_viewport");
    this.uNodeExtent = gl.getUniformLocation(this.nodeProgram, "u_extent");
    this.uNodePickingMode = gl.getUniformLocation(this.nodeProgram, "u_picking_mode");
    this.uNodePickTarget = gl.getUniformLocation(this.nodeProgram, "u_pick_target");

    this.uEdgeYaw = gl.getUniformLocation(this.edgeProgram, "u_yaw");
    this.uEdgePitch = gl.getUniformLocation(this.edgeProgram, "u_pitch");
    this.uEdgeZoom = gl.getUniformLocation(this.edgeProgram, "u_zoom");
    this.uEdgeScale = gl.getUniformLocation(this.edgeProgram, "u_scale");
    this.uEdgeViewport = gl.getUniformLocation(this.edgeProgram, "u_viewport");
    this.uEdgeExtent = gl.getUniformLocation(this.edgeProgram, "u_extent");

    this.initBuffers();
    this.initPickingFbo();
  }

  private initBuffers() {
    const gl = this.gl;

    // Node Quad geometry: unit square centered at origin
    this.nodeVao = gl.createVertexArray();
    gl.bindVertexArray(this.nodeVao);

    // Quad vertices: (-1, -1), (1, -1), (-1, 1), (1, 1)
    const quadVertices = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    this.quadVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
    gl.bufferData(gl.ARRAY_BUFFER, quadVertices, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // Quad indices: 0, 1, 2, 2, 1, 3
    const quadIndices = new Uint16Array([0, 1, 2, 2, 1, 3]);
    this.quadIbo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.quadIbo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, quadIndices, gl.STATIC_DRAW);

    // a_position (instance)
    this.nodePosVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nodePosVbo);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);

    // a_color (instance)
    this.nodeColorVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeColorVbo);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 0, 0);
    gl.vertexAttribDivisor(2, 1);

    // a_meta (instance: baseRadius, isRoot, status, pickId)
    this.nodeMetaVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeMetaVbo);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(3, 1);

    gl.bindVertexArray(null);

    // Edge VAO
    this.edgeVao = gl.createVertexArray();
    gl.bindVertexArray(this.edgeVao);

    this.edgePosVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgePosVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    this.edgeColorVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeColorVbo);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, 0, 0);

    gl.bindVertexArray(null);
  }

  private initPickingFbo() {
    const gl = this.gl;
    this.pickFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);

    this.pickColorRb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.pickColorRb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, 1, 1);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, this.pickColorRb);

    this.pickDepthRb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.pickDepthRb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, 1, 1);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.pickDepthRb);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  public setGraph(
    nodes: MemoryGraphNode[],
    edges: MemoryGraphEdge[],
    positions: Map<string, MemoryAtlasPosition>,
    coordinates: Map<string, MemoryPoint3D>
  ) {
    const gl = this.gl;
    this.nodes = nodes;
    this.edges = edges;
    this.nodeCount = nodes.length;

    this.nodeIndexMap.clear();
    nodes.forEach((n, idx) => this.nodeIndexMap.set(n.id, idx));

    this.adjacency.clear();
    for (const edge of edges) {
      if (!this.adjacency.has(edge.source)) this.adjacency.set(edge.source, new Set());
      if (!this.adjacency.has(edge.target)) this.adjacency.set(edge.target, new Set());
      this.adjacency.get(edge.source)!.add(edge.target);
      this.adjacency.get(edge.target)!.add(edge.source);
    }

    // Build Node Position buffer
    const posArray = new Float32Array(this.nodeCount * 3);
    const colorArray = new Uint8Array(this.nodeCount * 4);
    this.metaArray = new Float32Array(this.nodeCount * 4);

    for (let i = 0; i < this.nodeCount; i++) {
      const node = nodes[i]!;
      const coord = coordinates.get(node.id) ?? { x: 0, y: 0, z: 0 };
      posArray[i * 3 + 0] = coord.x;
      posArray[i * 3 + 1] = coord.y;
      posArray[i * 3 + 2] = coord.z;

      const [r, g, b, a] = parseHexColorFast(positions.get(node.id)?.color);
      colorArray[i * 4 + 0] = r;
      colorArray[i * 4 + 1] = g;
      colorArray[i * 4 + 2] = b;
      colorArray[i * 4 + 3] = a;

      const isRoot = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
      const baseRadius = isRoot ? 10.0 : node.type === "SOURCE" ? 4.6 : 2.1;
      this.metaArray[i * 4 + 0] = baseRadius;
      this.metaArray[i * 4 + 1] = isRoot ? 1.0 : 0.0;
      this.metaArray[i * 4 + 2] = 0.0; // status (normal)
      this.metaArray[i * 4 + 3] = i + 1; // pickId (1-based)
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.nodePosVbo);
    gl.bufferData(gl.ARRAY_BUFFER, posArray, gl.STATIC_DRAW);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeColorVbo);
    gl.bufferData(gl.ARRAY_BUFFER, colorArray, gl.STATIC_DRAW);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeMetaVbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.metaArray, gl.DYNAMIC_DRAW);

    // Build Edge Position and Color buffers
    const validEdges: Array<{ edge: MemoryGraphEdge; a: MemoryPoint3D; b: MemoryPoint3D }> = [];
    for (const edge of edges) {
      const a = coordinates.get(edge.source);
      const b = coordinates.get(edge.target);
      if (a && b) validEdges.push({ edge, a, b });
    }

    this.edgeVertexCount = validEdges.length * 2;
    const edgePosArray = new Float32Array(this.edgeVertexCount * 3);
    this.edgeColorArray = new Uint8Array(this.edgeVertexCount * 4);

    let vIdx = 0;
    for (let i = 0; i < validEdges.length; i++) {
      const item = validEdges[i]!;
      edgePosArray[vIdx * 3 + 0] = item.a.x;
      edgePosArray[vIdx * 3 + 1] = item.a.y;
      edgePosArray[vIdx * 3 + 2] = item.a.z;
      vIdx++;
      edgePosArray[vIdx * 3 + 0] = item.b.x;
      edgePosArray[vIdx * 3 + 1] = item.b.y;
      edgePosArray[vIdx * 3 + 2] = item.b.z;
      vIdx++;
    }

    this.recomputeEdgeColors(null);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgePosVbo);
    gl.bufferData(gl.ARRAY_BUFFER, edgePosArray, gl.STATIC_DRAW);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeColorVbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.edgeColorArray, gl.DYNAMIC_DRAW);

    // Reapply current focus if any
    this.setFocus(this.currentFocus);
  }

  public setFocus(focusNodeId: string | null) {
    this.currentFocus = focusNodeId;
    if (this.nodeCount === 0) return;
    const gl = this.gl;

    const neighbors = focusNodeId ? this.adjacency.get(focusNodeId) : null;

    for (let i = 0; i < this.nodeCount; i++) {
      const node = this.nodes[i]!;
      let status = 0.0;
      if (focusNodeId) {
        if (node.id === focusNodeId) status = 1.0; // highlighted
        else if (neighbors?.has(node.id)) status = 2.0; // neighbor
        else status = 3.0; // dimmed
      }
      this.metaArray[i * 4 + 2] = status;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeMetaVbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.metaArray);

    this.recomputeEdgeColors(focusNodeId);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeColorVbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.edgeColorArray);
  }

  private recomputeEdgeColors(focusNodeId: string | null) {
    let vIdx = 0;
    for (let i = 0; i < this.edges.length; i++) {
      const edge = this.edges[i]!;
      const incident = focusNodeId ? (edge.source === focusNodeId || edge.target === focusNodeId) : false;
      let r = 32, g = 51, b = 67; // #203343
      if (incident) {
        r = 152; g = 218; b = 250; // #98dafa
      } else if (focusNodeId) {
        r = 20; g = 32; b = 43; // #14202b
      } else if (edge.type === "DERIVED_FROM") {
        r = 56; g = 80; b = 104; // #385068
      }
      // Two vertices per edge
      this.edgeColorArray[vIdx * 4 + 0] = r;
      this.edgeColorArray[vIdx * 4 + 1] = g;
      this.edgeColorArray[vIdx * 4 + 2] = b;
      this.edgeColorArray[vIdx * 4 + 3] = 255;
      vIdx++;
      this.edgeColorArray[vIdx * 4 + 0] = r;
      this.edgeColorArray[vIdx * 4 + 1] = g;
      this.edgeColorArray[vIdx * 4 + 2] = b;
      this.edgeColorArray[vIdx * 4 + 3] = 255;
      vIdx++;
    }
  }

  public render(
    camera: MemoryCamera3D,
    scale: number,
    extent: number,
    width: number,
    height: number,
    dpr: number
  ) {
    const gl = this.gl;
    const fbWidth = Math.round(width * dpr);
    const fbHeight = Math.round(height * dpr);

    gl.viewport(0, 0, fbWidth, fbHeight);
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clearDepth(1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // 1. Draw Batched Edges
    if (this.edgeVertexCount > 0) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(false);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      gl.useProgram(this.edgeProgram);
      gl.uniform1f(this.uEdgeYaw, camera.yaw);
      gl.uniform1f(this.uEdgePitch, camera.pitch);
      gl.uniform1f(this.uEdgeZoom, camera.zoom);
      gl.uniform1f(this.uEdgeScale, scale);
      gl.uniform2f(this.uEdgeViewport, width, height);
      gl.uniform1f(this.uEdgeExtent, extent);

      gl.bindVertexArray(this.edgeVao);
      gl.drawArrays(gl.LINES, 0, this.edgeVertexCount);
    }

    // 2. Draw Instanced Nodes
    if (this.nodeCount > 0) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(true);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      gl.useProgram(this.nodeProgram);
      gl.uniform1f(this.uNodeYaw, camera.yaw);
      gl.uniform1f(this.uNodePitch, camera.pitch);
      gl.uniform1f(this.uNodeZoom, camera.zoom);
      gl.uniform1f(this.uNodeScale, scale);
      gl.uniform2f(this.uNodeViewport, width, height);
      gl.uniform1f(this.uNodeExtent, extent);
      gl.uniform1i(this.uNodePickingMode, 0);

      gl.bindVertexArray(this.nodeVao);
      gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, this.nodeCount);
      gl.bindVertexArray(null);
    }
  }

  public pick(
    mouseX: number,
    mouseY: number,
    camera: MemoryCamera3D,
    scale: number,
    extent: number,
    width: number,
    height: number
  ): string | null {
    if (this.nodeCount === 0 || !this.pickFbo) return null;
    const gl = this.gl;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
    gl.viewport(0, 0, 1, 1);

    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clearDepth(1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);

    gl.useProgram(this.nodeProgram);
    gl.uniform1f(this.uNodeYaw, camera.yaw);
    gl.uniform1f(this.uNodePitch, camera.pitch);
    gl.uniform1f(this.uNodeZoom, camera.zoom);
    gl.uniform1f(this.uNodeScale, scale);
    gl.uniform2f(this.uNodeViewport, width, height);
    gl.uniform1f(this.uNodeExtent, extent);
    gl.uniform1i(this.uNodePickingMode, 1);

    const targetNdcX = (mouseX / width) * 2.0 - 1.0;
    const targetNdcY = 1.0 - (mouseY / height) * 2.0;
    gl.uniform2f(this.uNodePickTarget, targetNdcX, targetNdcY);

    gl.bindVertexArray(this.nodeVao);
    gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, this.nodeCount);
    gl.bindVertexArray(null);

    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.pickPixel);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const pickId = this.pickPixel[0]! | (this.pickPixel[1]! << 8) | (this.pickPixel[2]! << 16);
    if (pickId > 0 && pickId <= this.nodes.length) {
      return this.nodes[pickId - 1]!.id;
    }
    return null;
  }

  public destroy() {
    const gl = this.gl;
    if (this.quadVbo) gl.deleteBuffer(this.quadVbo);
    if (this.quadIbo) gl.deleteBuffer(this.quadIbo);
    if (this.nodePosVbo) gl.deleteBuffer(this.nodePosVbo);
    if (this.nodeColorVbo) gl.deleteBuffer(this.nodeColorVbo);
    if (this.nodeMetaVbo) gl.deleteBuffer(this.nodeMetaVbo);
    if (this.nodeVao) gl.deleteVertexArray(this.nodeVao);

    if (this.edgePosVbo) gl.deleteBuffer(this.edgePosVbo);
    if (this.edgeColorVbo) gl.deleteBuffer(this.edgeColorVbo);
    if (this.edgeVao) gl.deleteVertexArray(this.edgeVao);

    if (this.pickColorRb) gl.deleteRenderbuffer(this.pickColorRb);
    if (this.pickDepthRb) gl.deleteRenderbuffer(this.pickDepthRb);
    if (this.pickFbo) gl.deleteFramebuffer(this.pickFbo);

    if (this.nodeProgram) gl.deleteProgram(this.nodeProgram);
    if (this.edgeProgram) gl.deleteProgram(this.edgeProgram);
  }
}
