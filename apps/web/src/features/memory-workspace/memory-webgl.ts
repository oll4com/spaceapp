import type { MemoryCamera3D, MemoryPoint3D } from "./memory-3d.js";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import type { ProjectedNodePoint } from "./memory-picking.js";

const NODE_VS = `#version 300 es
precision highp float;
in vec3 aPosition;
in float aRadius;
in vec4 aColor;
in float aFlags;

uniform float uYaw;
uniform float uPitch;
uniform float uZoom;
uniform float uScale;
uniform vec2 uViewport;
uniform float uDpr;

out vec4 vColor;
out float vFlags;
out float vPerspective;

void main() {
  float cosY = cos(uYaw);
  float sinY = sin(uYaw);
  float x1 = aPosition.x * cosY + aPosition.z * sinY;
  float depth1 = -aPosition.x * sinY + aPosition.z * cosY;

  float cosP = cos(uPitch);
  float sinP = sin(uPitch);
  float y1 = aPosition.y * cosP - depth1 * sinP;
  float z1 = aPosition.y * sinP + depth1 * cosP;

  float perspective = 650.0 / max(120.0, 650.0 + z1 * uScale);
  float screenX = uViewport.x * 0.5 + x1 * uScale * uZoom * perspective;
  float screenY = uViewport.y * 0.5 - y1 * uScale * uZoom * perspective;
  float ndcX = (screenX / uViewport.x) * 2.0 - 1.0;
  float ndcY = 1.0 - (screenY / uViewport.y) * 2.0;
  float ndcZ = clamp(z1 / 10000.0, -0.99, 0.99);

  gl_Position = vec4(ndcX, ndcY, ndcZ, 1.0);

  bool isHighlighted = (mod(aFlags, 2.0) >= 1.0);
  float currentRadius = aRadius * perspective * sqrt(uZoom) * (isHighlighted ? 1.5 : 1.0);
  gl_PointSize = max(2.0, currentRadius * 2.0 * uDpr);

  vColor = aColor;
  vFlags = aFlags;
  vPerspective = perspective;
}
`;

const NODE_FS = `#version 300 es
precision highp float;
in vec4 vColor;
in float vFlags;
in float vPerspective;

out vec4 fragColor;

void main() {
  vec2 coord = gl_PointCoord - vec2(0.5);
  float dist = length(coord);
  if (dist > 0.5) discard;

  bool isHighlighted = (mod(vFlags, 2.0) >= 1.0);
  bool isRoot = (mod(floor(vFlags / 2.0), 2.0) >= 1.0);
  bool isDimmed = (vFlags >= 4.0);

  float alpha = smoothstep(0.5, 0.42, dist);
  if (isDimmed) {
    alpha *= 0.2;
  } else {
    alpha *= max(0.4, min(1.0, vPerspective));
  }

  if (isHighlighted || isRoot) {
    float halo = smoothstep(0.5, 0.25, dist);
    vec3 col = isHighlighted ? vec3(1.0, 1.0, 1.0) : vColor.rgb;
    fragColor = vec4(col, max(alpha, halo * 0.85));
  } else {
    fragColor = vec4(vColor.rgb, alpha * vColor.a);
  }
}
`;

const EDGE_VS = `#version 300 es
precision highp float;
in vec3 aPosition;
in vec4 aColor;

uniform float uYaw;
uniform float uPitch;
uniform float uZoom;
uniform float uScale;
uniform vec2 uViewport;

out vec4 vColor;

void main() {
  float cosY = cos(uYaw);
  float sinY = sin(uYaw);
  float x1 = aPosition.x * cosY + aPosition.z * sinY;
  float depth1 = -aPosition.x * sinY + aPosition.z * cosY;

  float cosP = cos(uPitch);
  float sinP = sin(uPitch);
  float y1 = aPosition.y * cosP - depth1 * sinP;
  float z1 = aPosition.y * sinP + depth1 * cosP;

  float perspective = 650.0 / max(120.0, 650.0 + z1 * uScale);
  float screenX = uViewport.x * 0.5 + x1 * uScale * uZoom * perspective;
  float screenY = uViewport.y * 0.5 - y1 * uScale * uZoom * perspective;

  float ndcX = (screenX / uViewport.x) * 2.0 - 1.0;
  float ndcY = 1.0 - (screenY / uViewport.y) * 2.0;
  float ndcZ = clamp(z1 / 10000.0, -0.99, 0.99);

  gl_Position = vec4(ndcX, ndcY, ndcZ, 1.0);
  vColor = aColor;
}
`;

const EDGE_FS = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 fragColor;
void main() {
  fragColor = vColor;
}
`;

function createShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error("WebGL shader compile error:", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext, vsSource: string, fsSource: string): WebGLProgram | null {
  const vs = createShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = createShader(gl, gl.FRAGMENT_SHADER, fsSource);
  if (!vs || !fs) return null;

  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error("WebGL program link error:", gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

const colorCache = new Map<string, [number, number, number]>();

export function parseHexColor(hex: string): [number, number, number] {
  let cached = colorCache.get(hex);
  if (cached) return cached;
  let clean = hex.startsWith("#") ? hex.slice(1) : hex;
  if (clean.length === 3) {
    clean = clean[0]! + clean[0]! + clean[1]! + clean[1]! + clean[2]! + clean[2]!;
  }
  const intVal = parseInt(clean, 16) || 0;
  cached = [
    ((intVal >> 16) & 255) / 255,
    ((intVal >> 8) & 255) / 255,
    (intVal & 255) / 255
  ];
  if (colorCache.size < 500) colorCache.set(hex, cached);
  return cached;
}

export class MemoryWebGLRenderer {
  private gl: WebGL2RenderingContext;
  private nodeProgram: WebGLProgram | null = null;
  private edgeProgram: WebGLProgram | null = null;

  private nodeVAO: WebGLVertexArrayObject | null = null;
  private nodeVBO: WebGLBuffer | null = null;

  private edgeVAO: WebGLVertexArrayObject | null = null;
  private edgeVBO: WebGLBuffer | null = null;

  private nodeUniforms: Record<string, WebGLUniformLocation | null> = {};
  private edgeUniforms: Record<string, WebGLUniformLocation | null> = {};

  private nodeBufferData: Float32Array = new Float32Array(0);
  private edgeBufferData: Float32Array = new Float32Array(0);

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.init();
  }

  private init(): boolean {
    const gl = this.gl;
    this.nodeProgram = createProgram(gl, NODE_VS, NODE_FS);
    this.edgeProgram = createProgram(gl, EDGE_VS, EDGE_FS);

    if (!this.nodeProgram || !this.edgeProgram) return false;

    // Node uniforms & attributes:
    this.nodeUniforms = {
      uYaw: gl.getUniformLocation(this.nodeProgram, "uYaw"),
      uPitch: gl.getUniformLocation(this.nodeProgram, "uPitch"),
      uZoom: gl.getUniformLocation(this.nodeProgram, "uZoom"),
      uScale: gl.getUniformLocation(this.nodeProgram, "uScale"),
      uViewport: gl.getUniformLocation(this.nodeProgram, "uViewport"),
      uDpr: gl.getUniformLocation(this.nodeProgram, "uDpr")
    };

    this.nodeVAO = gl.createVertexArray();
    this.nodeVBO = gl.createBuffer();
    gl.bindVertexArray(this.nodeVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeVBO);

    // Stride: 9 floats (3 pos, 1 radius, 4 color, 1 flags)
    const stride = 9 * 4;
    const aPos = gl.getAttribLocation(this.nodeProgram, "aPosition");
    const aRadius = gl.getAttribLocation(this.nodeProgram, "aRadius");
    const aColor = gl.getAttribLocation(this.nodeProgram, "aColor");
    const aFlags = gl.getAttribLocation(this.nodeProgram, "aFlags");

    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, stride, 0);

    gl.enableVertexAttribArray(aRadius);
    gl.vertexAttribPointer(aRadius, 1, gl.FLOAT, false, stride, 3 * 4);

    gl.enableVertexAttribArray(aColor);
    gl.vertexAttribPointer(aColor, 4, gl.FLOAT, false, stride, 4 * 4);

    gl.enableVertexAttribArray(aFlags);
    gl.vertexAttribPointer(aFlags, 1, gl.FLOAT, false, stride, 8 * 4);

    // Edge uniforms & attributes:
    this.edgeUniforms = {
      uYaw: gl.getUniformLocation(this.edgeProgram, "uYaw"),
      uPitch: gl.getUniformLocation(this.edgeProgram, "uPitch"),
      uZoom: gl.getUniformLocation(this.edgeProgram, "uZoom"),
      uScale: gl.getUniformLocation(this.edgeProgram, "uScale"),
      uViewport: gl.getUniformLocation(this.edgeProgram, "uViewport")
    };

    this.edgeVAO = gl.createVertexArray();
    this.edgeVBO = gl.createBuffer();
    gl.bindVertexArray(this.edgeVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeVBO);

    // Stride: 7 floats (3 pos, 4 color)
    const edgeStride = 7 * 4;
    const edgePos = gl.getAttribLocation(this.edgeProgram, "aPosition");
    const edgeColor = gl.getAttribLocation(this.edgeProgram, "aColor");

    gl.enableVertexAttribArray(edgePos);
    gl.vertexAttribPointer(edgePos, 3, gl.FLOAT, false, edgeStride, 0);

    gl.enableVertexAttribArray(edgeColor);
    gl.vertexAttribPointer(edgeColor, 4, gl.FLOAT, false, edgeStride, 3 * 4);

    gl.bindVertexArray(null);
    return true;
  }

  render(
    nodes: MemoryGraphNode[],
    edges: MemoryGraphEdge[],
    positions: Map<string, MemoryAtlasPosition>,
    coordinates: Map<string, MemoryPoint3D>,
    camera: MemoryCamera3D,
    scale: number,
    width: number,
    height: number,
    dpr: number,
    focus: string | null
  ): ProjectedNodePoint[] {
    const gl = this.gl;
    if (!this.nodeProgram || !this.edgeProgram) return [];

    gl.viewport(0, 0, Math.round(width * dpr), Math.round(height * dpr));
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // 1. Identify neighbors of focus
    const neighbors = new Set<string>();
    if (focus) {
      for (const edge of edges) {
        if (edge.source === focus) neighbors.add(edge.target);
        if (edge.target === focus) neighbors.add(edge.source);
      }
    }

    // 2. Prepare Edges Buffer
    const edgeVertexCount = edges.length * 2;
    const edgeFloats = edgeVertexCount * 7;
    if (this.edgeBufferData.length < edgeFloats) {
      this.edgeBufferData = new Float32Array(Math.max(edgeFloats, this.edgeBufferData.length * 2));
    }

    let edgeOffset = 0;
    const eBuf = this.edgeBufferData;
    for (const edge of edges) {
      const a = coordinates.get(edge.source);
      const b = coordinates.get(edge.target);
      if (!a || !b) continue;

      const incident = edge.source === focus || edge.target === focus;
      const colorHex = incident
        ? "#98dafa"
        : focus
          ? "#14202b"
          : edge.type === "DERIVED_FROM"
            ? "#385068"
            : "#203343";
      const [cr, cg, cb] = parseHexColor(colorHex);
      const ca = incident ? 1.0 : focus ? 0.4 : 0.8;

      // Endpoint A
      eBuf[edgeOffset++] = a.x;
      eBuf[edgeOffset++] = a.y;
      eBuf[edgeOffset++] = a.z;
      eBuf[edgeOffset++] = cr;
      eBuf[edgeOffset++] = cg;
      eBuf[edgeOffset++] = cb;
      eBuf[edgeOffset++] = ca;

      // Endpoint B
      eBuf[edgeOffset++] = b.x;
      eBuf[edgeOffset++] = b.y;
      eBuf[edgeOffset++] = b.z;
      eBuf[edgeOffset++] = cr;
      eBuf[edgeOffset++] = cg;
      eBuf[edgeOffset++] = cb;
      eBuf[edgeOffset++] = ca;
    }

    // Draw Edges
    if (edgeOffset > 0) {
      gl.useProgram(this.edgeProgram);
      gl.uniform1f(this.edgeUniforms.uYaw!, camera.yaw);
      gl.uniform1f(this.edgeUniforms.uPitch!, camera.pitch);
      gl.uniform1f(this.edgeUniforms.uZoom!, camera.zoom);
      gl.uniform1f(this.edgeUniforms.uScale!, scale);
      gl.uniform2f(this.edgeUniforms.uViewport!, width, height);

      gl.bindVertexArray(this.edgeVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeVBO);
      gl.bufferData(gl.ARRAY_BUFFER, eBuf.subarray(0, edgeOffset), gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.LINES, 0, edgeOffset / 7);
    }

    // 3. Prepare Nodes Buffer and CPU Projected Points for Picking / Labels
    const nodeCount = nodes.length;
    const nodeFloats = nodeCount * 9;
    if (this.nodeBufferData.length < nodeFloats) {
      this.nodeBufferData = new Float32Array(Math.max(nodeFloats, this.nodeBufferData.length * 2));
    }

    let nodeOffset = 0;
    const nBuf = this.nodeBufferData;
    const projectedPoints: ProjectedNodePoint[] = [];

    const cosY = Math.cos(camera.yaw);
    const sinY = Math.sin(camera.yaw);
    const cosP = Math.cos(camera.pitch);
    const sinP = Math.sin(camera.pitch);

    for (const node of nodes) {
      const p = coordinates.get(node.id);
      if (!p) continue;

      const isRoot = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
      const isHighlighted = node.id === focus;
      const isDimmed = Boolean(focus && !isHighlighted && !neighbors.has(node.id));

      const baseRadius = isRoot ? 10 : node.type === "SOURCE" ? 4.6 : 2.1;
      const hex = isHighlighted ? "#ffffff" : positions.get(node.id)?.color ?? "#7395ad";
      const [r, g, b] = parseHexColor(hex);
      const a = 1.0;

      let flags = 0;
      if (isHighlighted) flags |= 1;
      if (isRoot) flags |= 2;
      if (isDimmed) flags |= 4;

      nBuf[nodeOffset++] = p.x;
      nBuf[nodeOffset++] = p.y;
      nBuf[nodeOffset++] = p.z;
      nBuf[nodeOffset++] = baseRadius;
      nBuf[nodeOffset++] = r;
      nBuf[nodeOffset++] = g;
      nBuf[nodeOffset++] = b;
      nBuf[nodeOffset++] = a;
      nBuf[nodeOffset++] = flags;

      // Calculate projected screen coords for spatial index & picking:
      const x1 = p.x * cosY + p.z * sinY;
      const depth1 = -p.x * sinY + p.z * cosY;
      const y1 = p.y * cosP - depth1 * sinP;
      const z1 = p.y * sinP + depth1 * cosP;

      const perspective = 650 / Math.max(120, 650 + z1 * scale);
      const sx = width * 0.5 + x1 * scale * camera.zoom * perspective;
      const sy = height * 0.5 - y1 * scale * camera.zoom * perspective;
      const radius = Math.max(1, baseRadius * perspective * Math.sqrt(camera.zoom)) * (isHighlighted ? 1.5 : 1);

      projectedPoints.push({
        id: node.id,
        x: sx,
        y: sy,
        z: z1,
        radius,
        perspective
      });
    }

    // Draw Nodes
    if (nodeOffset > 0) {
      gl.useProgram(this.nodeProgram);
      gl.uniform1f(this.nodeUniforms.uYaw!, camera.yaw);
      gl.uniform1f(this.nodeUniforms.uPitch!, camera.pitch);
      gl.uniform1f(this.nodeUniforms.uZoom!, camera.zoom);
      gl.uniform1f(this.nodeUniforms.uScale!, scale);
      gl.uniform2f(this.nodeUniforms.uViewport!, width, height);
      gl.uniform1f(this.nodeUniforms.uDpr!, dpr);

      gl.bindVertexArray(this.nodeVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeVBO);
      gl.bufferData(gl.ARRAY_BUFFER, nBuf.subarray(0, nodeOffset), gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.POINTS, 0, nodeOffset / 9);
    }

    gl.bindVertexArray(null);
    return projectedPoints;
  }

  destroy(): void {
    const gl = this.gl;
    if (this.nodeProgram) gl.deleteProgram(this.nodeProgram);
    if (this.edgeProgram) gl.deleteProgram(this.edgeProgram);
    if (this.nodeVAO) gl.deleteVertexArray(this.nodeVAO);
    if (this.nodeVBO) gl.deleteBuffer(this.nodeVBO);
    if (this.edgeVAO) gl.deleteVertexArray(this.edgeVAO);
    if (this.edgeVBO) gl.deleteBuffer(this.edgeVBO);
  }
}
