import { useEffect, useMemo, useRef } from "react";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import {
  DEFAULT_MEMORY_CAMERA,
  FALLBACK_CANVAS_2D_EDGE_CAP,
  FALLBACK_CANVAS_2D_NODE_CAP,
  MAX_DRAWN_MEMORY_LABELS,
  MAX_MEASURED_MEMORY_LABELS,
  computeMemory3DExtent,
  createMemorySpatialPicker3D,
  memory3DVolumeRatioFromMap,
  projectMemoryPoint,
  selectMemoryLabelsLOD,
  type MemoryCamera3D,
  type MemoryCoordinateMap3D,
  type MemoryPoint3D
} from "./memory-3d.js";

const EDGE_VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_pos;
layout(location = 1) in float a_kind;
uniform float u_cosYaw;
uniform float u_sinYaw;
uniform float u_cosPitch;
uniform float u_sinPitch;
uniform float u_scale;
uniform float u_zoom;
uniform float u_width;
uniform float u_height;
uniform float u_extent;
uniform float u_hasFocus;
uniform float u_depthBias;
out vec4 v_color;
void main() {
  float xRot = a_pos.x * u_cosYaw + a_pos.z * u_sinYaw;
  float depth = -a_pos.x * u_sinYaw + a_pos.z * u_cosYaw;
  float yRot = a_pos.y * u_cosPitch - depth * u_sinPitch;
  float zRot = a_pos.y * u_sinPitch + depth * u_cosPitch;
  float perspective = 650.0 / max(120.0, 650.0 + zRot * u_scale);
  float sx = u_width * 0.5 + xRot * u_scale * u_zoom * perspective;
  float sy = u_height * 0.5 - yRot * u_scale * u_zoom * perspective;
  float ndcX = (sx / max(1.0, u_width)) * 2.0 - 1.0;
  float ndcY = 1.0 - (sy / max(1.0, u_height)) * 2.0;
  float clipZ = clamp(zRot / max(90.0, u_extent * 1.5) + u_depthBias, -0.995, 0.995);
  gl_Position = vec4(ndcX, ndcY, clipZ, 1.0);
  if (a_kind > 1.5) {
    v_color = vec4(0.596, 0.855, 0.980, 0.92);
  } else if (u_hasFocus > 0.5) {
    v_color = vec4(0.078, 0.125, 0.169, 0.45);
  } else if (a_kind > 0.5) {
    v_color = vec4(0.220, 0.314, 0.408, 0.72);
  } else {
    v_color = vec4(0.125, 0.200, 0.263, 0.65);
  }
}
`;

const EDGE_FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 outColor;
void main() {
  outColor = v_color;
}
`;

const NODE_VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec3 a_pos;
layout(location = 2) in vec3 a_color;
layout(location = 3) in vec2 a_meta;
layout(location = 4) in float a_focusState;
uniform float u_cosYaw;
uniform float u_sinYaw;
uniform float u_cosPitch;
uniform float u_sinPitch;
uniform float u_scale;
uniform float u_zoom;
uniform float u_width;
uniform float u_height;
uniform float u_extent;
out vec2 v_local;
out float v_coreRadius;
out float v_quadRadius;
out float v_hasGlow;
out vec3 v_color;
out float v_alpha;
void main() {
  float xRot = a_pos.x * u_cosYaw + a_pos.z * u_sinYaw;
  float depth = -a_pos.x * u_sinYaw + a_pos.z * u_cosYaw;
  float yRot = a_pos.y * u_cosPitch - depth * u_sinPitch;
  float zRot = a_pos.y * u_sinPitch + depth * u_cosPitch;
  float perspective = 650.0 / max(120.0, 650.0 + zRot * u_scale);
  bool highlighted = a_focusState > 2.5;
  bool dimmed = a_focusState > 0.5 && a_focusState < 1.5;
  bool isRoot = a_meta.y > 0.5;
  float coreRadius = max(1.0, a_meta.x * perspective * sqrt(u_zoom)) * (highlighted ? 1.5 : 1.0);
  bool hasGlow = isRoot || highlighted;
  float quadRadius = coreRadius + (hasGlow ? 9.0 : 1.25);
  float sx = u_width * 0.5 + xRot * u_scale * u_zoom * perspective + a_corner.x * quadRadius;
  float sy = u_height * 0.5 - yRot * u_scale * u_zoom * perspective + a_corner.y * quadRadius;
  float ndcX = (sx / max(1.0, u_width)) * 2.0 - 1.0;
  float ndcY = 1.0 - (sy / max(1.0, u_height)) * 2.0;
  float depthBias = highlighted ? -0.004 : (isRoot ? -0.002 : 0.0);
  float clipZ = clamp(zRot / max(90.0, u_extent * 1.5) + depthBias, -0.995, 0.995);
  gl_Position = vec4(ndcX, ndcY, clipZ, 1.0);
  v_local = a_corner * quadRadius;
  v_coreRadius = coreRadius;
  v_quadRadius = quadRadius;
  v_hasGlow = hasGlow ? 1.0 : 0.0;
  v_color = highlighted ? vec3(1.0, 1.0, 1.0) : a_color;
  v_alpha = dimmed ? 0.2 : clamp(perspective, 0.4, 1.0);
}
`;

const NODE_FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec2 v_local;
in float v_coreRadius;
in float v_quadRadius;
in float v_hasGlow;
in vec3 v_color;
in float v_alpha;
out vec4 outColor;
void main() {
  float dist = length(v_local);
  if (dist > v_quadRadius) {
    discard;
  }
  if (dist <= v_coreRadius) {
    float edgeSmooth = 1.0 - smoothstep(max(0.0, v_coreRadius - 0.9), v_coreRadius + 0.35, dist);
    outColor = vec4(v_color, v_alpha * edgeSmooth);
    return;
  }
  if (v_hasGlow < 0.5) {
    discard;
  }
  float glowT = (dist - v_coreRadius) / max(1.0, v_quadRadius - v_coreRadius);
  float glowAlpha = exp(-glowT * glowT * 3.8) * 0.42 * v_alpha;
  if (glowAlpha < 0.015) {
    discard;
  }
  outColor = vec4(v_color, glowAlpha);
}
`;

const colorRgbCache = new Map<string, [number, number, number]>();
function parseHexColorRgb(color: string): [number, number, number] {
  const cached = colorRgbCache.get(color);
  if (cached) return cached;
  const clean = color.startsWith("#") ? color.slice(1) : color;
  let rgb: [number, number, number] = [0.451, 0.584, 0.678];
  if (clean.length >= 6) {
    const num = Number.parseInt(clean.slice(0, 6), 16);
    if (Number.isFinite(num)) {
      rgb = [((num >> 16) & 255) / 255, ((num >> 8) & 255) / 255, (num & 255) / 255];
    }
  }
  colorRgbCache.set(color, rgb);
  return rgb;
}

interface WebGLGraphResources {
  gl: WebGL2RenderingContext;
  edgeProgram: WebGLProgram;
  nodeProgram: WebGLProgram;
  edgeVao: WebGLVertexArrayObject;
  edgeVbo: WebGLBuffer;
  incidentEdgeVao: WebGLVertexArrayObject;
  incidentEdgeVbo: WebGLBuffer;
  nodeVao: WebGLVertexArrayObject;
  quadVbo: WebGLBuffer;
  nodeStaticVbo: WebGLBuffer;
  nodeFocusVbo: WebGLBuffer;
  edgeUniforms: {
    cosYaw: WebGLUniformLocation | null;
    sinYaw: WebGLUniformLocation | null;
    cosPitch: WebGLUniformLocation | null;
    sinPitch: WebGLUniformLocation | null;
    scale: WebGLUniformLocation | null;
    zoom: WebGLUniformLocation | null;
    width: WebGLUniformLocation | null;
    height: WebGLUniformLocation | null;
    extent: WebGLUniformLocation | null;
    hasFocus: WebGLUniformLocation | null;
    depthBias: WebGLUniformLocation | null;
  };
  nodeUniforms: {
    cosYaw: WebGLUniformLocation | null;
    sinYaw: WebGLUniformLocation | null;
    cosPitch: WebGLUniformLocation | null;
    sinPitch: WebGLUniformLocation | null;
    scale: WebGLUniformLocation | null;
    zoom: WebGLUniformLocation | null;
    width: WebGLUniformLocation | null;
    height: WebGLUniformLocation | null;
    extent: WebGLUniformLocation | null;
  };
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext, vsSource: string, fsSource: string): WebGLProgram | null {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
  if (!vs || !fs) {
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    return null;
  }
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

function initWebGLResources(gl: WebGL2RenderingContext): WebGLGraphResources | null {
  if (typeof gl.isContextLost === "function" && gl.isContextLost()) return null;
  const edgeProgram = createProgram(gl, EDGE_VERTEX_SHADER, EDGE_FRAGMENT_SHADER);
  const nodeProgram = createProgram(gl, NODE_VERTEX_SHADER, NODE_FRAGMENT_SHADER);
  if (!edgeProgram || !nodeProgram) return null;

  const edgeVao = gl.createVertexArray();
  const edgeVbo = gl.createBuffer();
  const incidentEdgeVao = gl.createVertexArray();
  const incidentEdgeVbo = gl.createBuffer();
  const nodeVao = gl.createVertexArray();
  const quadVbo = gl.createBuffer();
  const nodeStaticVbo = gl.createBuffer();
  const nodeFocusVbo = gl.createBuffer();
  if (!edgeVao || !edgeVbo || !incidentEdgeVao || !incidentEdgeVbo || !nodeVao || !quadVbo || !nodeStaticVbo || !nodeFocusVbo) {
    return null;
  }

  gl.bindVertexArray(edgeVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, edgeVbo);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 16, 12);

  gl.bindVertexArray(incidentEdgeVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, incidentEdgeVbo);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 16, 12);

  gl.bindVertexArray(nodeVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
  gl.vertexAttribDivisor(0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, nodeStaticVbo);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 32, 0);
  gl.vertexAttribDivisor(1, 1);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 32, 12);
  gl.vertexAttribDivisor(2, 1);
  gl.enableVertexAttribArray(3);
  gl.vertexAttribPointer(3, 2, gl.FLOAT, false, 32, 24);
  gl.vertexAttribDivisor(3, 1);

  gl.bindBuffer(gl.ARRAY_BUFFER, nodeFocusVbo);
  gl.enableVertexAttribArray(4);
  gl.vertexAttribPointer(4, 1, gl.FLOAT, false, 4, 0);
  gl.vertexAttribDivisor(4, 1);

  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  return {
    gl,
    edgeProgram,
    nodeProgram,
    edgeVao,
    edgeVbo,
    incidentEdgeVao,
    incidentEdgeVbo,
    nodeVao,
    quadVbo,
    nodeStaticVbo,
    nodeFocusVbo,
    edgeUniforms: {
      cosYaw: gl.getUniformLocation(edgeProgram, "u_cosYaw"),
      sinYaw: gl.getUniformLocation(edgeProgram, "u_sinYaw"),
      cosPitch: gl.getUniformLocation(edgeProgram, "u_cosPitch"),
      sinPitch: gl.getUniformLocation(edgeProgram, "u_sinPitch"),
      scale: gl.getUniformLocation(edgeProgram, "u_scale"),
      zoom: gl.getUniformLocation(edgeProgram, "u_zoom"),
      width: gl.getUniformLocation(edgeProgram, "u_width"),
      height: gl.getUniformLocation(edgeProgram, "u_height"),
      extent: gl.getUniformLocation(edgeProgram, "u_extent"),
      hasFocus: gl.getUniformLocation(edgeProgram, "u_hasFocus"),
      depthBias: gl.getUniformLocation(edgeProgram, "u_depthBias")
    },
    nodeUniforms: {
      cosYaw: gl.getUniformLocation(nodeProgram, "u_cosYaw"),
      sinYaw: gl.getUniformLocation(nodeProgram, "u_sinYaw"),
      cosPitch: gl.getUniformLocation(nodeProgram, "u_cosPitch"),
      sinPitch: gl.getUniformLocation(nodeProgram, "u_sinPitch"),
      scale: gl.getUniformLocation(nodeProgram, "u_scale"),
      zoom: gl.getUniformLocation(nodeProgram, "u_zoom"),
      width: gl.getUniformLocation(nodeProgram, "u_width"),
      height: gl.getUniformLocation(nodeProgram, "u_height"),
      extent: gl.getUniformLocation(nodeProgram, "u_extent")
    }
  };
}

export function MemoryGraph3D({
  nodes,
  edges,
  positions,
  coordinates,
  showTitles,
  selectedNodeId,
  onSelectNode,
  loading,
  resetToken
}: {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  positions: Map<string, MemoryAtlasPosition>;
  coordinates: Map<string, MemoryPoint3D>;
  showTitles: boolean;
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
  loading: boolean;
  resetToken: number;
}) {
  const volumeRatio = useMemo(() => memory3DVolumeRatioFromMap(coordinates), [coordinates]);
  const glCanvasRef = useRef<HTMLCanvasElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef<MemoryCamera3D>({ ...DEFAULT_MEMORY_CAMERA });
  const redrawRef = useRef<() => void>(() => {});
  const current = useRef({ nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode });
  current.current = { nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode };

  useEffect(() => {
    cameraRef.current = { ...DEFAULT_MEMORY_CAMERA };
    redrawRef.current();
  }, [resetToken]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const glCanvas = glCanvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    let glContext: WebGL2RenderingContext | null = null;
    try {
      glContext = (glCanvas?.getContext("webgl2", {
        alpha: true,
        antialias: true,
        depth: true,
        powerPreference: "high-performance"
      }) as WebGL2RenderingContext | null) ?? null;
    } catch {
      glContext = null;
    }

    let webgl: WebGLGraphResources | null = glContext ? initWebGLResources(glContext) : null;
    let contextLost = false;
    let frame = 0;
    let width = 1;
    let height = 1;
    let dpr = 1;
    let hover: string | null = null;
    const pointers = new Map<number, { x: number; y: number }>();
    let dragged = false;
    let downX = 0;
    let downY = 0;

    const spatialPicker = createMemorySpatialPicker3D();
    let pickerDirty = true;
    const labelWidthCache = new Map<string, number>();
    const measureLabelWidth = (text: string) => {
      const cached = labelWidthCache.get(text);
      if (cached !== undefined) return cached;
      const w = context.measureText(text).width;
      if (labelWidthCache.size > 4096) labelWidthCache.clear();
      labelWidthCache.set(text, w);
      return w;
    };

    // Cached topology & GPU buffers so camera rotation/zoom performs zero CPU node/edge loops.
    let cachedNodesRef: MemoryGraphNode[] | null = null;
    let cachedEdgesRef: MemoryGraphEdge[] | null = null;
    let cachedPositionsRef: Map<string, MemoryAtlasPosition> | null = null;
    let cachedCoordinatesRef: Map<string, MemoryPoint3D> | null = null;
    let cachedCoordVersion: number | undefined;
    let cachedFocusId: string | null | undefined = undefined;
    let cachedExtent = 60;

    let activeNodes: MemoryGraphNode[] = [];
    let nodeIdToActiveIndex = new Map<string, number>();
    let adjacencyByActiveIndex: number[][] = [];
    let incidentEdgesByActiveIndex: number[][] = [];
    let validEdgeSourceIdx = new Int32Array(0);
    let validEdgeTargetIdx = new Int32Array(0);
    let validEdgeKind = new Float32Array(0);
    let validEdgeCount = 0;

    let nodePosArray = new Float32Array(0);
    let nodeStaticData = new Float32Array(0);
    let nodeFocusData = new Float32Array(0);
    let edgeVertexData = new Float32Array(0);
    let incidentEdgeVertexData = new Float32Array(0);
    let incidentEdgeVertexCount = 0;
    let activeNeighbors = new Set<string>();

    const markBuffersDirty = () => {
      cachedNodesRef = null;
      cachedEdgesRef = null;
      cachedPositionsRef = null;
      cachedCoordinatesRef = null;
      cachedCoordVersion = undefined;
      cachedFocusId = undefined;
      pickerDirty = true;
    };

    const syncWebGLBuffers = (
      nodesList: MemoryGraphNode[],
      edgesList: MemoryGraphEdge[],
      posMap: Map<string, MemoryAtlasPosition>,
      coordMapInput: Map<string, MemoryPoint3D>,
      focusId: string | null,
      res: WebGLGraphResources
    ) => {
      const coordMap = (coordMapInput as MemoryCoordinateMap3D).backingMap ?? coordMapInput;
      const coordVersion = (coordMapInput as MemoryCoordinateMap3D).version;
      const topologyChanged =
        nodesList !== cachedNodesRef ||
        edgesList !== cachedEdgesRef ||
        posMap !== cachedPositionsRef;
      const coordsChanged =
        topologyChanged ||
        coordMapInput !== cachedCoordinatesRef ||
        coordVersion !== cachedCoordVersion;
      const focusChanged = topologyChanged || focusId !== cachedFocusId;

      if (topologyChanged) {
        activeNodes = [];
        nodeIdToActiveIndex = new Map<string, number>();
        for (let i = 0; i < nodesList.length; i++) {
          const n = nodesList[i]!;
          if (coordMap.has(n.id)) {
            nodeIdToActiveIndex.set(n.id, activeNodes.length);
            activeNodes.push(n);
          }
        }
        const nCount = activeNodes.length;
        adjacencyByActiveIndex = Array.from({ length: nCount }, () => []);
        incidentEdgesByActiveIndex = Array.from({ length: nCount }, () => []);

        if (validEdgeSourceIdx.length < edgesList.length) {
          validEdgeSourceIdx = new Int32Array(edgesList.length);
          validEdgeTargetIdx = new Int32Array(edgesList.length);
          validEdgeKind = new Float32Array(edgesList.length);
        }
        validEdgeCount = 0;
        for (let e = 0; e < edgesList.length; e++) {
          const edge = edgesList[e]!;
          const a = nodeIdToActiveIndex.get(edge.source);
          const b = nodeIdToActiveIndex.get(edge.target);
          if (a === undefined || b === undefined) continue;
          const idx = validEdgeCount++;
          validEdgeSourceIdx[idx] = a;
          validEdgeTargetIdx[idx] = b;
          validEdgeKind[idx] = edge.type === "DERIVED_FROM" ? 1.0 : 0.0;
          adjacencyByActiveIndex[a]!.push(b);
          adjacencyByActiveIndex[b]!.push(a);
          incidentEdgesByActiveIndex[a]!.push(idx);
          if (b !== a) incidentEdgesByActiveIndex[b]!.push(idx);
        }

        if (nodePosArray.length < nCount * 3) nodePosArray = new Float32Array(nCount * 3);
        if (nodeStaticData.length < nCount * 8) nodeStaticData = new Float32Array(nCount * 8);
        if (nodeFocusData.length < nCount) nodeFocusData = new Float32Array(nCount);
        if (edgeVertexData.length < validEdgeCount * 8) edgeVertexData = new Float32Array(validEdgeCount * 8);

        for (let i = 0; i < nCount; i++) {
          const node = activeNodes[i]!;
          const [r, g, b] = parseHexColorRgb(posMap.get(node.id)?.color ?? "#7395ad");
          const root = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
          const baseRadius = root ? 10.0 : node.type === "SOURCE" ? 4.6 : 2.1;
          const base8 = i * 8;
          nodeStaticData[base8 + 3] = r;
          nodeStaticData[base8 + 4] = g;
          nodeStaticData[base8 + 5] = b;
          nodeStaticData[base8 + 6] = baseRadius;
          nodeStaticData[base8 + 7] = root ? 1.0 : 0.0;
        }
        cachedNodesRef = nodesList;
        cachedEdgesRef = edgesList;
        cachedPositionsRef = posMap;
      }

      if (coordsChanged) {
        const nCount = activeNodes.length;
        cachedExtent = computeMemory3DExtent(coordMapInput);
        for (let i = 0; i < nCount; i++) {
          const p = coordMap.get(activeNodes[i]!.id);
          const x = p ? p.x : 0;
          const y = p ? p.y : 0;
          const z = p ? p.z : 0;
          const base3 = i * 3;
          nodePosArray[base3] = x;
          nodePosArray[base3 + 1] = y;
          nodePosArray[base3 + 2] = z;
          const base8 = i * 8;
          nodeStaticData[base8] = x;
          nodeStaticData[base8 + 1] = y;
          nodeStaticData[base8 + 2] = z;
        }
        res.gl.bindBuffer(res.gl.ARRAY_BUFFER, res.nodeStaticVbo);
        res.gl.bufferData(
          res.gl.ARRAY_BUFFER,
          nodeStaticData.subarray(0, nCount * 8),
          res.gl.DYNAMIC_DRAW
        );

        for (let e = 0; e < validEdgeCount; e++) {
          const a3 = validEdgeSourceIdx[e]! * 3;
          const b3 = validEdgeTargetIdx[e]! * 3;
          const kind = validEdgeKind[e]!;
          const base8 = e * 8;
          edgeVertexData[base8] = nodePosArray[a3]!;
          edgeVertexData[base8 + 1] = nodePosArray[a3 + 1]!;
          edgeVertexData[base8 + 2] = nodePosArray[a3 + 2]!;
          edgeVertexData[base8 + 3] = kind;
          edgeVertexData[base8 + 4] = nodePosArray[b3]!;
          edgeVertexData[base8 + 5] = nodePosArray[b3 + 1]!;
          edgeVertexData[base8 + 6] = nodePosArray[b3 + 2]!;
          edgeVertexData[base8 + 7] = kind;
        }
        res.gl.bindBuffer(res.gl.ARRAY_BUFFER, res.edgeVbo);
        res.gl.bufferData(
          res.gl.ARRAY_BUFFER,
          edgeVertexData.subarray(0, validEdgeCount * 8),
          res.gl.DYNAMIC_DRAW
        );
        cachedCoordinatesRef = coordMapInput;
        cachedCoordVersion = coordVersion;
        pickerDirty = true;
      }

      if (focusChanged || coordsChanged) {
        const nCount = activeNodes.length;
        activeNeighbors = new Set<string>();
        const focusIdx = focusId !== null ? nodeIdToActiveIndex.get(focusId) : undefined;
        if (focusIdx === undefined) {
          nodeFocusData.fill(0, 0, nCount);
          incidentEdgeVertexCount = 0;
        } else {
          nodeFocusData.fill(1.0, 0, nCount);
          nodeFocusData[focusIdx] = 3.0;
          const nbrs = adjacencyByActiveIndex[focusIdx] ?? [];
          for (let i = 0; i < nbrs.length; i++) {
            const ni = nbrs[i]!;
            if (ni !== focusIdx) nodeFocusData[ni] = 2.0;
            activeNeighbors.add(activeNodes[ni]!.id);
          }
          const incEdges = incidentEdgesByActiveIndex[focusIdx] ?? [];
          if (incidentEdgeVertexData.length < incEdges.length * 8) {
            incidentEdgeVertexData = new Float32Array(incEdges.length * 8);
          }
          for (let i = 0; i < incEdges.length; i++) {
            const e = incEdges[i]!;
            const a3 = validEdgeSourceIdx[e]! * 3;
            const b3 = validEdgeTargetIdx[e]! * 3;
            const base8 = i * 8;
            incidentEdgeVertexData[base8] = nodePosArray[a3]!;
            incidentEdgeVertexData[base8 + 1] = nodePosArray[a3 + 1]!;
            incidentEdgeVertexData[base8 + 2] = nodePosArray[a3 + 2]!;
            incidentEdgeVertexData[base8 + 3] = 2.0;
            incidentEdgeVertexData[base8 + 4] = nodePosArray[b3]!;
            incidentEdgeVertexData[base8 + 5] = nodePosArray[b3 + 1]!;
            incidentEdgeVertexData[base8 + 6] = nodePosArray[b3 + 2]!;
            incidentEdgeVertexData[base8 + 7] = 2.0;
          }
          incidentEdgeVertexCount = incEdges.length * 2;
          res.gl.bindBuffer(res.gl.ARRAY_BUFFER, res.incidentEdgeVbo);
          res.gl.bufferData(
            res.gl.ARRAY_BUFFER,
            incidentEdgeVertexData.subarray(0, incEdges.length * 8),
            res.gl.DYNAMIC_DRAW
          );
        }
        res.gl.bindBuffer(res.gl.ARRAY_BUFFER, res.nodeFocusVbo);
        res.gl.bufferData(
          res.gl.ARRAY_BUFFER,
          nodeFocusData.subarray(0, nCount),
          res.gl.DYNAMIC_DRAW
        );
        res.gl.bindBuffer(res.gl.ARRAY_BUFFER, null);
        cachedFocusId = focusId;
      }
    };

    const renderFallback2D = (
      nodesList: MemoryGraphNode[],
      edgesList: MemoryGraphEdge[],
      posMap: Map<string, MemoryAtlasPosition>,
      coordMapInput: Map<string, MemoryPoint3D>,
      focus: string | null,
      titlesVisible: boolean
    ) => {
      if (glCanvas) glCanvas.style.display = "none";
      canvas.dataset.renderer = "canvas2d";
      context.clearRect(0, 0, width, height);

      const coordMap = (coordMapInput as MemoryCoordinateMap3D).backingMap ?? coordMapInput;
      const cappedNodes =
        nodesList.length > FALLBACK_CANVAS_2D_NODE_CAP
          ? [...nodesList]
              .sort(
                (a, b) =>
                  Number(b.id === focus) - Number(a.id === focus) ||
                  Number(isMemoryCoreLabel(b.label)) - Number(isMemoryCoreLabel(a.label)) ||
                  Number(b.type === "SOURCE") - Number(a.type === "SOURCE")
              )
              .slice(0, FALLBACK_CANVAS_2D_NODE_CAP)
          : nodesList;
      const cappedNodeIds =
        cappedNodes.length === nodesList.length ? null : new Set(cappedNodes.map(n => n.id));
      const cappedEdges =
        edgesList.length > FALLBACK_CANVAS_2D_EDGE_CAP || cappedNodeIds
          ? edgesList
              .filter(e => !cappedNodeIds || (cappedNodeIds.has(e.source) && cappedNodeIds.has(e.target)))
              .slice(0, FALLBACK_CANVAS_2D_EDGE_CAP)
          : edgesList;

      cachedExtent = computeMemory3DExtent(coordMapInput);
      const scale = (Math.min(width, height) * 0.4) / cachedExtent;
      const projected = new Map<string, { x: number; y: number; z: number; perspective: number }>();
      for (let i = 0; i < cappedNodes.length; i++) {
        const node = cappedNodes[i]!;
        const p = coordMap.get(node.id);
        if (p) projected.set(node.id, projectMemoryPoint(p, cameraRef.current, scale, width, height));
      }

      const neighbors = new Set<string>();
      if (focus) {
        for (let i = 0; i < cappedEdges.length; i++) {
          const edge = cappedEdges[i]!;
          if (edge.source === focus) neighbors.add(edge.target);
          if (edge.target === focus) neighbors.add(edge.source);
        }
      }

      context.lineWidth = 0.55;
      for (let i = 0; i < cappedEdges.length; i++) {
        const edge = cappedEdges[i]!;
        const a = projected.get(edge.source);
        const b = projected.get(edge.target);
        if (!a || !b) continue;
        const incident = edge.source === focus || edge.target === focus;
        context.strokeStyle = incident
          ? "#98dafa"
          : focus
            ? "#14202b"
            : edge.type === "DERIVED_FROM"
              ? "#385068"
              : "#203343";
        context.lineWidth = incident ? 1.15 : 0.55;
        context.beginPath();
        context.moveTo(a.x, a.y);
        context.lineTo(b.x, b.y);
        context.stroke();
      }

      const ordered = cappedNodes
        .filter(node => projected.has(node.id))
        .sort((a, b) => projected.get(b.id)!.z - projected.get(a.id)!.z);

      for (let i = 0; i < ordered.length; i++) {
        const node = ordered[i]!;
        const p = projected.get(node.id)!;
        const highlighted = node.id === focus;
        const root = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
        const radius =
          Math.max(
            1,
            (root ? 10 : node.type === "SOURCE" ? 4.6 : 2.1) *
              p.perspective *
              Math.sqrt(cameraRef.current.zoom)
          ) * (highlighted ? 1.5 : 1);
        context.globalAlpha =
          focus && !highlighted && !neighbors.has(node.id)
            ? 0.2
            : Math.max(0.4, Math.min(1, p.perspective));
        context.fillStyle = highlighted ? "#ffffff" : posMap.get(node.id)?.color ?? "#7395ad";
        if (root || highlighted) {
          context.shadowColor = context.fillStyle;
          context.shadowBlur = 13;
        }
        context.beginPath();
        context.arc(p.x, p.y, radius, 0, Math.PI * 2);
        context.fill();
        context.shadowBlur = 0;
      }
      context.globalAlpha = 1;

      if (titlesVisible) {
        context.font = "11px system-ui, sans-serif";
        const { labels } = selectMemoryLabelsLOD({
          nodes: cappedNodes,
          coordinates: coordMapInput,
          camera: cameraRef.current,
          scale,
          width,
          height,
          focusId: focus,
          neighbors,
          measureTextWidth: measureLabelWidth,
          maxMeasured: MAX_MEASURED_MEMORY_LABELS,
          maxDrawn: MAX_DRAWN_MEMORY_LABELS
        });
        for (let i = 0; i < labels.length; i++) {
          const lbl = labels[i]!;
          context.fillStyle = "#09111bea";
          context.fillRect(lbl.x - 3, lbl.y - 11, lbl.width + 6, 16);
          context.fillStyle = lbl.core ? "#fff0b0" : "#c6dfed";
          context.fillText(lbl.text, lbl.x, lbl.y + 1);
        }
      }

      activeNodes = cappedNodes;
      pickerDirty = true;
    };

    const render = () => {
      frame = 0;
      const { nodes: nodesList, edges: edgesList, positions: posMap, coordinates: coordMapInput, showTitles: titlesVisible, selectedNodeId: selId } =
        current.current;
      const focus = hover ?? selId;

      if (!contextLost && webgl && !(typeof webgl.gl.isContextLost === "function" && webgl.gl.isContextLost())) {
        if (glCanvas) glCanvas.style.display = "block";
        canvas.dataset.renderer = "webgl2";
        syncWebGLBuffers(nodesList, edgesList, posMap, coordMapInput, focus, webgl);

        const gl = webgl.gl;
        const pixelW = Math.max(1, Math.round(width * dpr));
        const pixelH = Math.max(1, Math.round(height * dpr));
        gl.viewport(0, 0, pixelW, pixelH);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.clearDepth(1.0);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        const scale = (Math.min(width, height) * 0.4) / cachedExtent;
        const cosYaw = Math.cos(cameraRef.current.yaw);
        const sinYaw = Math.sin(cameraRef.current.yaw);
        const cosPitch = Math.cos(cameraRef.current.pitch);
        const sinPitch = Math.sin(cameraRef.current.pitch);
        const zoom = cameraRef.current.zoom;

        if (validEdgeCount > 0) {
          gl.useProgram(webgl.edgeProgram);
          gl.uniform1f(webgl.edgeUniforms.cosYaw, cosYaw);
          gl.uniform1f(webgl.edgeUniforms.sinYaw, sinYaw);
          gl.uniform1f(webgl.edgeUniforms.cosPitch, cosPitch);
          gl.uniform1f(webgl.edgeUniforms.sinPitch, sinPitch);
          gl.uniform1f(webgl.edgeUniforms.scale, scale);
          gl.uniform1f(webgl.edgeUniforms.zoom, zoom);
          gl.uniform1f(webgl.edgeUniforms.width, width);
          gl.uniform1f(webgl.edgeUniforms.height, height);
          gl.uniform1f(webgl.edgeUniforms.extent, cachedExtent);
          gl.uniform1f(webgl.edgeUniforms.hasFocus, focus ? 1.0 : 0.0);
          gl.uniform1f(webgl.edgeUniforms.depthBias, 0.002);
          gl.bindVertexArray(webgl.edgeVao);
          gl.drawArrays(gl.LINES, 0, validEdgeCount * 2);

          if (incidentEdgeVertexCount > 0) {
            gl.uniform1f(webgl.edgeUniforms.depthBias, -0.001);
            gl.bindVertexArray(webgl.incidentEdgeVao);
            gl.drawArrays(gl.LINES, 0, incidentEdgeVertexCount);
          }
        }

        if (activeNodes.length > 0) {
          gl.useProgram(webgl.nodeProgram);
          gl.uniform1f(webgl.nodeUniforms.cosYaw, cosYaw);
          gl.uniform1f(webgl.nodeUniforms.sinYaw, sinYaw);
          gl.uniform1f(webgl.nodeUniforms.cosPitch, cosPitch);
          gl.uniform1f(webgl.nodeUniforms.sinPitch, sinPitch);
          gl.uniform1f(webgl.nodeUniforms.scale, scale);
          gl.uniform1f(webgl.nodeUniforms.zoom, zoom);
          gl.uniform1f(webgl.nodeUniforms.width, width);
          gl.uniform1f(webgl.nodeUniforms.height, height);
          gl.uniform1f(webgl.nodeUniforms.extent, cachedExtent);
          gl.bindVertexArray(webgl.nodeVao);
          gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, activeNodes.length);
        }
        gl.bindVertexArray(null);

        context.clearRect(0, 0, width, height);
        if (titlesVisible) {
          context.font = "11px system-ui, sans-serif";
          const { labels } = selectMemoryLabelsLOD({
            nodes: activeNodes,
            coordinates: coordMapInput,
            camera: cameraRef.current,
            scale,
            width,
            height,
            focusId: focus,
            neighbors: activeNeighbors,
            measureTextWidth: measureLabelWidth,
            maxMeasured: MAX_MEASURED_MEMORY_LABELS,
            maxDrawn: MAX_DRAWN_MEMORY_LABELS
          });
          for (let i = 0; i < labels.length; i++) {
            const lbl = labels[i]!;
            context.fillStyle = "#09111bea";
            context.fillRect(lbl.x - 3, lbl.y - 11, lbl.width + 6, 16);
            context.fillStyle = lbl.core ? "#fff0b0" : "#c6dfed";
            context.fillText(lbl.text, lbl.x, lbl.y + 1);
          }
        }
      } else {
        renderFallback2D(nodesList, edgesList, posMap, coordMapInput, focus, titlesVisible);
      }

      canvas.dataset.rotation = `${cameraRef.current.yaw.toFixed(3)},${cameraRef.current.pitch.toFixed(3)}`;
    };

    const schedule = () => {
      if (frame) return;
      let syncDone = false;
      const id = requestAnimationFrame(() => {
        syncDone = true;
        render();
      });
      if (!syncDone) frame = id;
    };
    redrawRef.current = schedule;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, rect.width || canvas.clientWidth || 1);
      height = Math.max(1, rect.height || canvas.clientHeight || 1);
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const pixelW = Math.round(width * dpr);
      const pixelH = Math.round(height * dpr);
      canvas.width = pixelW;
      canvas.height = pixelH;
      if (glCanvas) {
        glCanvas.width = pixelW;
        glCanvas.height = pixelH;
      }
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      pickerDirty = true;
      schedule();
    };

    const hit = (x: number, y: number) => {
      const { nodes: nodesList, coordinates: coordMapInput, selectedNodeId: selId } = current.current;
      const candidateNodes = activeNodes.length > 0 ? activeNodes : nodesList;
      if (candidateNodes.length === 0) return null;
      if (pickerDirty) {
        const scale = (Math.min(width, height) * 0.4) / Math.max(60, cachedExtent);
        spatialPicker.update(
          candidateNodes,
          coordMapInput,
          cameraRef.current,
          scale,
          width,
          height,
          hover ?? selId
        );
        pickerDirty = false;
      }
      return spatialPicker.pick(x, y);
    };

    const local = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    const down = (event: PointerEvent) => {
      canvas.focus();
      if (typeof canvas.setPointerCapture === "function") {
        try {
          canvas.setPointerCapture(event.pointerId);
        } catch {
          // Ignore synthetic pointer events in headless tests without active pointerId.
        }
      }
      const p = local(event);
      pointers.set(event.pointerId, p);
      downX = p.x;
      downY = p.y;
      dragged = false;
      hover = null;
    };

    const move = (event: PointerEvent) => {
      const p = local(event);
      const previous = pointers.get(event.pointerId);
      if (previous) {
        if (Math.hypot(p.x - downX, p.y - downY) > 4) dragged = true;
        if (pointers.size === 2) {
          const other = [...pointers].find(([id]) => id !== event.pointerId)![1];
          const before = Math.hypot(previous.x - other.x, previous.y - other.y);
          const after = Math.hypot(p.x - other.x, p.y - other.y);
          if (before > 1) {
            cameraRef.current.zoom = Math.max(0.35, Math.min(5, (cameraRef.current.zoom * after) / before));
          }
        } else {
          cameraRef.current.yaw += (p.x - previous.x) * 0.009;
          cameraRef.current.pitch += (p.y - previous.y) * 0.009;
        }
        pointers.set(event.pointerId, p);
        pickerDirty = true;
        schedule();
      } else {
        const nextHover = hit(p.x, p.y);
        canvas.style.cursor = nextHover ? "pointer" : "grab";
        if (nextHover !== hover) {
          hover = nextHover;
          schedule();
        }
      }
    };

    const up = (event: PointerEvent) => {
      const p = local(event);
      if (!dragged && pointers.size === 1) {
        const id = hit(p.x, p.y);
        if (id) current.current.onSelectNode(id);
      }
      pointers.delete(event.pointerId);
      if (typeof canvas.hasPointerCapture === "function" && canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
    };

    const cancel = (event: PointerEvent) => {
      pointers.delete(event.pointerId);
      dragged = true;
    };

    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      cameraRef.current.zoom = Math.max(0.35, Math.min(5, cameraRef.current.zoom * Math.exp(-event.deltaY * 0.001)));
      pickerDirty = true;
      schedule();
    };

    const key = (event: KeyboardEvent) => {
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        cameraRef.current.yaw += event.key === "ArrowLeft" ? -0.15 : event.key === "ArrowRight" ? 0.15 : 0;
        cameraRef.current.pitch += event.key === "ArrowUp" ? -0.15 : event.key === "ArrowDown" ? 0.15 : 0;
        pickerDirty = true;
        schedule();
      } else if (event.key === "Enter") {
        const node =
          current.current.nodes.find(n => n.id === current.current.selectedNodeId) ??
          current.current.nodes.find(n => isMemoryCoreLabel(n.label));
        if (node) current.current.onSelectNode(node.id);
      }
    };

    const handleContextLost = (event: Event) => {
      event.preventDefault();
      contextLost = true;
      markBuffersDirty();
      render();
    };

    const handleContextRestored = () => {
      contextLost = false;
      markBuffersDirty();
      if (glContext) {
        webgl = initWebGLResources(glContext);
      }
      render();
    };

    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
    observer?.observe(canvas);
    resize();

    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", cancel);
    canvas.addEventListener("wheel", wheel, { passive: false });
    canvas.addEventListener("keydown", key);
    canvas.addEventListener("webglcontextlost", handleContextLost);
    canvas.addEventListener("webglcontextrestored", handleContextRestored);
    glCanvas?.addEventListener("webglcontextlost", handleContextLost);
    glCanvas?.addEventListener("webglcontextrestored", handleContextRestored);

    return () => {
      observer?.disconnect();
      cancelAnimationFrame(frame);
      redrawRef.current = () => {};
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", cancel);
      canvas.removeEventListener("wheel", wheel);
      canvas.removeEventListener("keydown", key);
      canvas.removeEventListener("webglcontextlost", handleContextLost);
      canvas.removeEventListener("webglcontextrestored", handleContextRestored);
      glCanvas?.removeEventListener("webglcontextlost", handleContextLost);
      glCanvas?.removeEventListener("webglcontextrestored", handleContextRestored);
    };
  }, []);

  useEffect(() => {
    redrawRef.current();
  }, [nodes, edges, positions, coordinates, showTitles, selectedNodeId]);

  return (
    <div className="memory-3d-surface">
      <canvas ref={glCanvasRef} className="memory-3d-webgl-canvas" aria-hidden="true" />
      <canvas
        ref={canvasRef}
        className="memory-3d-overlay-canvas"
        tabIndex={0}
        role="application"
        aria-label="3D memory graph. Drag or use arrow keys to rotate 360 degrees. Scroll or pinch to zoom. Click a node to open."
        aria-busy={loading}
        data-titles-visible={showTitles}
        data-layout-volume={volumeRatio.toFixed(4)}
      />
      <span className="memory-3d-hint">Drag to rotate 360° · Scroll or pinch to zoom · Click to explore</span>
    </div>
  );
}
