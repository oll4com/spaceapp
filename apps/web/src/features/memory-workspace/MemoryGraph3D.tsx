import { useEffect, useMemo, useRef } from "react";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import {
  DEFAULT_MEMORY_CAMERA,
  FALLBACK_CANVAS_2D_NODE_CAP,
  MemorySpatialPicker3D,
  PackedMemoryCoordinates3D,
  memory3DVolumeRatio,
  projectMemoryPoint,
  selectFallback2DGraph,
  type MemoryCamera3D,
  type MemoryPoint3D
} from "./memory-3d.js";

function parseHexColor(hex: string): [number, number, number] {
  const cleaned = hex.startsWith("#") ? hex.slice(1) : hex;
  if (cleaned.length >= 6) {
    const num = Number.parseInt(cleaned.slice(0, 6), 16);
    if (!Number.isNaN(num)) {
      return [
        ((num >> 16) & 0xff) / 255,
        ((num >> 8) & 0xff) / 255,
        (num & 0xff) / 255
      ];
    }
  }
  return [0x73 / 255, 0x95 / 255, 0xad / 255];
}

const EDGE_VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_position;
uniform float u_yaw;
uniform float u_pitch;
uniform float u_zoom;
uniform float u_scale;
uniform vec2 u_viewport;
uniform float u_depthBias;

void main() {
  float cosY = cos(u_yaw);
  float sinY = sin(u_yaw);
  float cosP = cos(u_pitch);
  float sinP = sin(u_pitch);

  float rx = a_position.x * cosY + a_position.z * sinY;
  float depth = -a_position.x * sinY + a_position.z * cosY;
  float ry = a_position.y * cosP - depth * sinP;
  float rz = a_position.y * sinP + depth * cosP;

  float perspective = 650.0 / max(120.0, 650.0 + rz * u_scale);
  float clipX = (rx * u_scale * u_zoom * perspective) / max(1.0, u_viewport.x * 0.5);
  float clipY = (ry * u_scale * u_zoom * perspective) / max(1.0, u_viewport.y * 0.5);
  float clipZ = clamp((rz * u_scale) / 2400.0 + u_depthBias, -0.99, 0.99);

  gl_Position = vec4(clipX, clipY, clipZ, 1.0);
}
`;

const EDGE_FRAGMENT_SHADER = `#version 300 es
precision mediump float;
uniform vec4 u_color;
out vec4 outColor;

void main() {
  outColor = vec4(u_color.rgb * u_color.a, u_color.a);
}
`;

const NODE_VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec3 a_position;
layout(location = 2) in vec4 a_style;
layout(location = 3) in float a_highlight;

uniform float u_yaw;
uniform float u_pitch;
uniform float u_zoom;
uniform float u_scale;
uniform vec2 u_viewport;
uniform float u_hasFocus;

out vec2 v_corner;
out float v_radius;
out float v_quadRadius;
out vec4 v_color;

void main() {
  float cosY = cos(u_yaw);
  float sinY = sin(u_yaw);
  float cosP = cos(u_pitch);
  float sinP = sin(u_pitch);

  float rx = a_position.x * cosY + a_position.z * sinY;
  float depth = -a_position.x * sinY + a_position.z * cosY;
  float ry = a_position.y * cosP - depth * sinP;
  float rz = a_position.y * sinP + depth * cosP;

  float perspective = 650.0 / max(120.0, 650.0 + rz * u_scale);
  bool isFocus = a_highlight > 1.5;
  bool isNeighbor = a_highlight > 0.5;
  float radius = max(1.0, a_style.w * perspective * sqrt(u_zoom)) * (isFocus ? 1.5 : 1.0);
  float quadRadius = radius + 1.0;

  float halfW = max(1.0, u_viewport.x * 0.5);
  float halfH = max(1.0, u_viewport.y * 0.5);
  float centerClipX = (rx * u_scale * u_zoom * perspective) / halfW;
  float centerClipY = (ry * u_scale * u_zoom * perspective) / halfH;

  vec2 offsetClip = (a_corner * quadRadius) / vec2(halfW, halfH);
  float clipZ = clamp((rz * u_scale) / 2400.0 - (isFocus ? 0.008 : 0.0), -0.99, 0.99);

  float alpha = (u_hasFocus > 0.5 && !isFocus && !isNeighbor)
    ? 0.2
    : clamp(perspective, 0.4, 1.0);
  vec3 rgb = isFocus ? vec3(1.0, 1.0, 1.0) : a_style.rgb;

  v_corner = a_corner;
  v_radius = radius;
  v_quadRadius = quadRadius;
  v_color = vec4(rgb, alpha);
  gl_Position = vec4(centerClipX + offsetClip.x, centerClipY + offsetClip.y, clipZ, 1.0);
}
`;

const NODE_FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec2 v_corner;
in float v_radius;
in float v_quadRadius;
in vec4 v_color;
out vec4 outColor;

void main() {
  float distPx = length(v_corner) * v_quadRadius;
  if (distPx > v_radius + 0.75) {
    discard;
  }
  float edgeAlpha = 1.0 - smoothstep(max(0.0, v_radius - 0.55), v_radius + 0.75, distPx);
  float a = v_color.a * edgeAlpha;
  outColor = vec4(v_color.rgb * a, a);
}
`;

interface WebGLGraphResources {
  gl: WebGL2RenderingContext;
  edgeProgram: WebGLProgram;
  nodeProgram: WebGLProgram;
  edgeVao: WebGLVertexArrayObject;
  nodeVao: WebGLVertexArrayObject;
  quadBuffer: WebGLBuffer;
  positionBuffer: WebGLBuffer;
  styleBuffer: WebGLBuffer;
  highlightBuffer: WebGLBuffer;
  standardEdgeIndexBuffer: WebGLBuffer;
  derivedEdgeIndexBuffer: WebGLBuffer;
  focusEdgeIndexBuffer: WebGLBuffer;
  edgeUniforms: {
    yaw: WebGLUniformLocation | null;
    pitch: WebGLUniformLocation | null;
    zoom: WebGLUniformLocation | null;
    scale: WebGLUniformLocation | null;
    viewport: WebGLUniformLocation | null;
    depthBias: WebGLUniformLocation | null;
    color: WebGLUniformLocation | null;
  };
  nodeUniforms: {
    yaw: WebGLUniformLocation | null;
    pitch: WebGLUniformLocation | null;
    zoom: WebGLUniformLocation | null;
    scale: WebGLUniformLocation | null;
    viewport: WebGLUniformLocation | null;
    hasFocus: WebGLUniformLocation | null;
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

function linkProgram(gl: WebGL2RenderingContext, vsSource: string, fsSource: string): WebGLProgram | null {
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
  const edgeProgram = linkProgram(gl, EDGE_VERTEX_SHADER, EDGE_FRAGMENT_SHADER);
  const nodeProgram = linkProgram(gl, NODE_VERTEX_SHADER, NODE_FRAGMENT_SHADER);
  if (!edgeProgram || !nodeProgram) return null;

  const edgeVao = gl.createVertexArray();
  const nodeVao = gl.createVertexArray();
  const quadBuffer = gl.createBuffer();
  const positionBuffer = gl.createBuffer();
  const styleBuffer = gl.createBuffer();
  const highlightBuffer = gl.createBuffer();
  const standardEdgeIndexBuffer = gl.createBuffer();
  const derivedEdgeIndexBuffer = gl.createBuffer();
  const focusEdgeIndexBuffer = gl.createBuffer();

  if (
    !edgeVao ||
    !nodeVao ||
    !quadBuffer ||
    !positionBuffer ||
    !styleBuffer ||
    !highlightBuffer ||
    !standardEdgeIndexBuffer ||
    !derivedEdgeIndexBuffer ||
    !focusEdgeIndexBuffer
  ) {
    return null;
  }

  // Edge VAO binds shared positionBuffer at location 0
  gl.bindVertexArray(edgeVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

  // Node VAO binds unit quad corners at location 0, instanced attributes at locations 1..3
  gl.bindVertexArray(nodeVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(1, 1);

  gl.bindBuffer(gl.ARRAY_BUFFER, styleBuffer);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(2, 1);

  gl.bindBuffer(gl.ARRAY_BUFFER, highlightBuffer);
  gl.enableVertexAttribArray(3);
  gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(3, 1);

  gl.bindVertexArray(null);

  return {
    gl,
    edgeProgram,
    nodeProgram,
    edgeVao,
    nodeVao,
    quadBuffer,
    positionBuffer,
    styleBuffer,
    highlightBuffer,
    standardEdgeIndexBuffer,
    derivedEdgeIndexBuffer,
    focusEdgeIndexBuffer,
    edgeUniforms: {
      yaw: gl.getUniformLocation(edgeProgram, "u_yaw"),
      pitch: gl.getUniformLocation(edgeProgram, "u_pitch"),
      zoom: gl.getUniformLocation(edgeProgram, "u_zoom"),
      scale: gl.getUniformLocation(edgeProgram, "u_scale"),
      viewport: gl.getUniformLocation(edgeProgram, "u_viewport"),
      depthBias: gl.getUniformLocation(edgeProgram, "u_depthBias"),
      color: gl.getUniformLocation(edgeProgram, "u_color")
    },
    nodeUniforms: {
      yaw: gl.getUniformLocation(nodeProgram, "u_yaw"),
      pitch: gl.getUniformLocation(nodeProgram, "u_pitch"),
      zoom: gl.getUniformLocation(nodeProgram, "u_zoom"),
      scale: gl.getUniformLocation(nodeProgram, "u_scale"),
      viewport: gl.getUniformLocation(nodeProgram, "u_viewport"),
      hasFocus: gl.getUniformLocation(nodeProgram, "u_hasFocus")
    }
  };
}

export function MemoryGraph3D({ nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode, loading, resetToken }: {
  nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[];
  positions: Map<string, MemoryAtlasPosition>; coordinates: Map<string, MemoryPoint3D>;
  showTitles: boolean; selectedNodeId: string | null; onSelectNode: (id: string) => void;
  loading: boolean; resetToken: number;
}) {
  const volumeRatio = useMemo(
    () => (coordinates instanceof PackedMemoryCoordinates3D ? coordinates.volumeRatio : memory3DVolumeRatio([...coordinates.values()])),
    [coordinates]
  );
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef<MemoryCamera3D>({ ...DEFAULT_MEMORY_CAMERA });
  const redrawRef = useRef<() => void>(() => {});
  const syncTopologyRef = useRef<() => void>(() => {});
  const syncCoordinatesRef = useRef<() => void>(() => {});
  const syncFocusRef = useRef<() => void>(() => {});
  const current = useRef({ nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode });
  current.current = { nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode };

  useEffect(() => {
    cameraRef.current = { ...DEFAULT_MEMORY_CAMERA };
    redrawRef.current();
  }, [resetToken]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const overlayCanvas = overlayCanvasRef.current;
    const overlayContext = overlayCanvas?.getContext("2d") ?? null;

    let glResources: WebGLGraphResources | null = null;
    let contextLost = false;
    let triedWebGL = false;

    const tryInitWebGL = () => {
      try {
        triedWebGL = true;
        const gl = canvas.getContext("webgl2", {
          alpha: true,
          antialias: true,
          depth: true,
          powerPreference: "high-performance",
          premultipliedAlpha: true
        }) as WebGL2RenderingContext | null;
        if (gl && typeof gl.createVertexArray === "function") {
          glResources = initWebGLResources(gl);
        } else {
          glResources = null;
        }
      } catch {
        glResources = null;
      }
      canvas.dataset.renderer = glResources && !contextLost ? "webgl2" : "canvas2d";
    };

    tryInitWebGL();
    const fallback2DContext = !glResources ? canvas.getContext("2d") : null;
    if (!glResources && !fallback2DContext && !overlayContext) return;

    const picker = new MemorySpatialPicker3D();
    let frame = 0, width = 1, height = 1, dpr = 1;
    let hover: string | null = null;
    const pointers = new Map<number, { x: number; y: number }>();
    let dragged = false, downX = 0, downY = 0;

    // Indexed topology cache for zero-loop WebGL frame rendering
    let nodeIndexById = new Map<string, number>();
    let rootNodeIndices: number[] = [];
    let adjacency = new Map<number, number[]>();
    let incidentEdgeVertices = new Map<number, Uint32Array>();
    let standardEdgeCount = 0;
    let derivedEdgeCount = 0;
    let focusEdgeCount = 0;
    let highlightArray = new Float32Array(0);
    let activeHighlightIndices: number[] = [];
    let uploadedFocusId: string | null | undefined = undefined;

    const uploadTopologyAndStyles = () => {
      const { nodes, edges, positions, coordinates } = current.current;
      picker.setGraph(nodes, coordinates);
      nodeIndexById = new Map(nodes.map((node, idx) => [node.id, idx]));
      rootNodeIndices = [];
      adjacency = new Map();
      const incidentMap = new Map<number, number[]>();

      const count = nodes.length;
      const styles = new Float32Array(count * 4);
      highlightArray = new Float32Array(count);
      activeHighlightIndices = [];
      uploadedFocusId = undefined;

      for (let i = 0; i < count; i++) {
        const node = nodes[i]!;
        const isRoot = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
        if (isRoot) rootNodeIndices.push(i);
        const colorHex = positions.get(node.id)?.color ?? "#7395ad";
        const [r, g, b] = parseHexColor(colorHex);
        const offset = i * 4;
        styles[offset] = r;
        styles[offset + 1] = g;
        styles[offset + 2] = b;
        styles[offset + 3] = isRoot ? 10 : node.type === "SOURCE" ? 4.6 : 2.1;
      }

      const stdIndices: number[] = [];
      const derIndices: number[] = [];
      for (let e = 0; e < edges.length; e++) {
        const edge = edges[e]!;
        const a = nodeIndexById.get(edge.source);
        const b = nodeIndexById.get(edge.target);
        if (a === undefined || b === undefined || a === b) continue;
        if (edge.type === "DERIVED_FROM") {
          derIndices.push(a, b);
        } else {
          stdIndices.push(a, b);
        }
        let neighborsA = adjacency.get(a);
        if (!neighborsA) { neighborsA = []; adjacency.set(a, neighborsA); }
        neighborsA.push(b);
        let neighborsB = adjacency.get(b);
        if (!neighborsB) { neighborsB = []; adjacency.set(b, neighborsB); }
        neighborsB.push(a);

        let incA = incidentMap.get(a);
        if (!incA) { incA = []; incidentMap.set(a, incA); }
        incA.push(a, b);
        let incB = incidentMap.get(b);
        if (!incB) { incB = []; incidentMap.set(b, incB); }
        incB.push(a, b);
      }

      incidentEdgeVertices = new Map();
      for (const [idx, verts] of incidentMap) {
        incidentEdgeVertices.set(idx, Uint32Array.from(verts));
      }

      const stdTyped = Uint32Array.from(stdIndices);
      const derTyped = Uint32Array.from(derIndices);
      standardEdgeCount = stdTyped.length;
      derivedEdgeCount = derTyped.length;

      if (glResources && !contextLost) {
        const { gl } = glResources;
        gl.bindBuffer(gl.ARRAY_BUFFER, glResources.positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, picker.coordinatesArray, gl.DYNAMIC_DRAW);

        gl.bindBuffer(gl.ARRAY_BUFFER, glResources.styleBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, styles, gl.DYNAMIC_DRAW);

        gl.bindBuffer(gl.ARRAY_BUFFER, glResources.highlightBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, highlightArray, gl.DYNAMIC_DRAW);

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, glResources.standardEdgeIndexBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, stdTyped, gl.STATIC_DRAW);

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, glResources.derivedEdgeIndexBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, derTyped, gl.STATIC_DRAW);
      }
    };

    const uploadCoordinatesOnly = () => {
      const { nodes, coordinates } = current.current;
      picker.setGraph(nodes, coordinates);
      if (glResources && !contextLost) {
        const { gl } = glResources;
        gl.bindBuffer(gl.ARRAY_BUFFER, glResources.positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, picker.coordinatesArray, gl.DYNAMIC_DRAW);
      }
    };

    const updateFocusBuffers = (focusId: string | null) => {
      if (uploadedFocusId === focusId) return;
      uploadedFocusId = focusId;
      for (let i = 0; i < activeHighlightIndices.length; i++) {
        highlightArray[activeHighlightIndices[i]!] = 0;
      }
      activeHighlightIndices = [];
      focusEdgeCount = 0;

      const focusIdx = focusId ? nodeIndexById.get(focusId) : undefined;
      if (focusIdx !== undefined) {
        const neighbors = adjacency.get(focusIdx);
        if (neighbors) {
          for (let i = 0; i < neighbors.length; i++) {
            const nIdx = neighbors[i]!;
            highlightArray[nIdx] = 1;
            activeHighlightIndices.push(nIdx);
          }
        }
        highlightArray[focusIdx] = 2;
        activeHighlightIndices.push(focusIdx);
      }

      if (glResources && !contextLost) {
        const { gl } = glResources;
        gl.bindBuffer(gl.ARRAY_BUFFER, glResources.highlightBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, highlightArray, gl.DYNAMIC_DRAW);

        const incVerts = focusIdx !== undefined ? incidentEdgeVertices.get(focusIdx) : undefined;
        if (incVerts && incVerts.length > 0) {
          focusEdgeCount = incVerts.length;
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, glResources.focusEdgeIndexBuffer);
          gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, incVerts, gl.DYNAMIC_DRAW);
        }
      }
    };

    const renderFallback2D = (targetCtx: CanvasRenderingContext2D) => {
      const { nodes, edges, positions, coordinates, showTitles, selectedNodeId } = current.current;
      targetCtx.clearRect(0, 0, width, height);
      const capped = selectFallback2DGraph(nodes, edges, hover ?? selectedNodeId, FALLBACK_CANVAS_2D_NODE_CAP);
      const extent = Math.max(60, picker.extent);
      const scale = Math.min(width, height) * 0.4 / extent;
      const projected = new Map(capped.nodes.flatMap(node => {
        const p = coordinates.get(node.id);
        return p ? [[node.id, projectMemoryPoint(p, cameraRef.current, scale, width, height)] as const] : [];
      }));
      const focus = hover ?? selectedNodeId;
      const neighbors = new Set<string>();
      if (focus) {
        for (const edge of capped.edges) {
          if (edge.source === focus) neighbors.add(edge.target);
          if (edge.target === focus) neighbors.add(edge.source);
        }
      }
      targetCtx.lineWidth = 0.55;
      for (const edge of capped.edges) {
        const a = projected.get(edge.source), b = projected.get(edge.target);
        if (!a || !b) continue;
        const incident = edge.source === focus || edge.target === focus;
        targetCtx.strokeStyle = incident ? "#98dafa" : focus ? "#14202b" : edge.type === "DERIVED_FROM" ? "#385068" : "#203343";
        targetCtx.lineWidth = incident ? 1.15 : 0.55;
        targetCtx.beginPath(); targetCtx.moveTo(a.x, a.y); targetCtx.lineTo(b.x, b.y); targetCtx.stroke();
      }
      const ordered = capped.nodes.filter(node => projected.has(node.id)).sort((a, b) => projected.get(b.id)!.z - projected.get(a.id)!.z);
      for (const node of ordered) {
        const p = projected.get(node.id)!;
        const highlighted = node.id === focus;
        const root = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
        const radius = Math.max(1, (root ? 10 : node.type === "SOURCE" ? 4.6 : 2.1) * p.perspective * Math.sqrt(cameraRef.current.zoom)) * (highlighted ? 1.5 : 1);
        targetCtx.globalAlpha = focus && !highlighted && !neighbors.has(node.id) ? 0.2 : Math.max(0.4, Math.min(1, p.perspective));
        targetCtx.fillStyle = highlighted ? "#ffffff" : positions.get(node.id)?.color ?? "#7395ad";
        if (root || highlighted) { targetCtx.shadowColor = targetCtx.fillStyle; targetCtx.shadowBlur = 13; }
        targetCtx.beginPath(); targetCtx.arc(p.x, p.y, radius, 0, Math.PI * 2); targetCtx.fill(); targetCtx.shadowBlur = 0;
      }
      targetCtx.globalAlpha = 1;
      if (showTitles) {
        targetCtx.font = "11px system-ui, sans-serif";
        const { labels } = picker.selectLabels({
          camera: cameraRef.current,
          width,
          height,
          showTitles,
          focusId: focus,
          measureWidth: text => targetCtx.measureText(text).width
        });
        for (const item of labels) {
          targetCtx.fillStyle = "#09111bea";
          targetCtx.fillRect(item.x - 3, item.y - 11, item.width + 6, 16);
          targetCtx.fillStyle = item.isCore ? "#fff0b0" : "#c6dfed";
          targetCtx.fillText(item.text, item.x, item.y + 1);
        }
      }
    };

    const renderWebGL2 = (res: WebGLGraphResources) => {
      const { nodes, positions, coordinates, showTitles, selectedNodeId } = current.current;
      const { gl } = res;
      const focus = hover ?? selectedNodeId;
      updateFocusBuffers(focus);

      const extent = Math.max(60, picker.extent);
      const scale = Math.min(width, height) * 0.4 / extent;
      const camera = cameraRef.current;

      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      // 1. Batched Edges Pass
      if (standardEdgeCount > 0 || derivedEdgeCount > 0) {
        gl.useProgram(res.edgeProgram);
        gl.uniform1f(res.edgeUniforms.yaw, camera.yaw);
        gl.uniform1f(res.edgeUniforms.pitch, camera.pitch);
        gl.uniform1f(res.edgeUniforms.zoom, camera.zoom);
        gl.uniform1f(res.edgeUniforms.scale, scale);
        gl.uniform2f(res.edgeUniforms.viewport, width, height);
        gl.uniform1f(res.edgeUniforms.depthBias, 0.012);
        gl.bindVertexArray(res.edgeVao);

        if (focus) {
          gl.uniform4f(res.edgeUniforms.color, 0x14 / 255, 0x20 / 255, 0x2b / 255, 0.72);
          if (standardEdgeCount > 0) {
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, res.standardEdgeIndexBuffer);
            gl.drawElements(gl.LINES, standardEdgeCount, gl.UNSIGNED_INT, 0);
          }
          if (derivedEdgeCount > 0) {
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, res.derivedEdgeIndexBuffer);
            gl.drawElements(gl.LINES, derivedEdgeCount, gl.UNSIGNED_INT, 0);
          }
          if (focusEdgeCount > 0) {
            gl.uniform1f(res.edgeUniforms.depthBias, 0.004);
            gl.uniform4f(res.edgeUniforms.color, 0x98 / 255, 0xda / 255, 0xfa / 255, 0.96);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, res.focusEdgeIndexBuffer);
            gl.drawElements(gl.LINES, focusEdgeCount, gl.UNSIGNED_INT, 0);
          }
        } else {
          if (standardEdgeCount > 0) {
            gl.uniform4f(res.edgeUniforms.color, 0x20 / 255, 0x33 / 255, 0x43 / 255, 0.85);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, res.standardEdgeIndexBuffer);
            gl.drawElements(gl.LINES, standardEdgeCount, gl.UNSIGNED_INT, 0);
          }
          if (derivedEdgeCount > 0) {
            gl.uniform4f(res.edgeUniforms.color, 0x38 / 255, 0x50 / 255, 0x68 / 255, 0.9);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, res.derivedEdgeIndexBuffer);
            gl.drawElements(gl.LINES, derivedEdgeCount, gl.UNSIGNED_INT, 0);
          }
        }
      }

      // 2. Instanced Nodes Pass (depth handled by GPU)
      if (nodes.length > 0) {
        gl.useProgram(res.nodeProgram);
        gl.uniform1f(res.nodeUniforms.yaw, camera.yaw);
        gl.uniform1f(res.nodeUniforms.pitch, camera.pitch);
        gl.uniform1f(res.nodeUniforms.zoom, camera.zoom);
        gl.uniform1f(res.nodeUniforms.scale, scale);
        gl.uniform2f(res.nodeUniforms.viewport, width, height);
        gl.uniform1f(res.nodeUniforms.hasFocus, focus ? 1.0 : 0.0);
        gl.bindVertexArray(res.nodeVao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nodes.length);
      }

      gl.bindVertexArray(null);

      // 3. Overlay 2D Pass: Root/Focus halo + Bounded Level-of-Detail Labels
      if (overlayContext) {
        overlayContext.clearRect(0, 0, width, height);
        const haloTargets = [...rootNodeIndices];
        const focusIdx = focus ? nodeIndexById.get(focus) : undefined;
        if (focusIdx !== undefined && !haloTargets.includes(focusIdx)) {
          haloTargets.push(focusIdx);
        }
        for (const idx of haloTargets) {
          const node = nodes[idx];
          if (!node) continue;
          const pt = coordinates.get(node.id);
          if (!pt) continue;
          const proj = projectMemoryPoint(pt, camera, scale, width, height);
          const isFocus = node.id === focus;
          const isRoot = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
          const radius = Math.max(1, (isRoot ? 10 : node.type === "SOURCE" ? 4.6 : 2.1) * proj.perspective * Math.sqrt(camera.zoom)) * (isFocus ? 1.5 : 1);
          const color = isFocus ? "#ffffff" : positions.get(node.id)?.color ?? "#7395ad";
          overlayContext.save();
          overlayContext.globalAlpha = Math.max(0.4, Math.min(1, proj.perspective));
          overlayContext.fillStyle = color;
          overlayContext.shadowColor = color;
          overlayContext.shadowBlur = 13;
          overlayContext.beginPath();
          overlayContext.arc(proj.x, proj.y, radius, 0, Math.PI * 2);
          overlayContext.fill();
          overlayContext.restore();
        }

        if (showTitles) {
          overlayContext.font = "11px system-ui, sans-serif";
          const { labels } = picker.selectLabels({
            camera,
            width,
            height,
            showTitles,
            focusId: focus,
            measureWidth: text => overlayContext.measureText(text).width
          });
          for (const item of labels) {
            overlayContext.fillStyle = "#09111bea";
            overlayContext.fillRect(item.x - 3, item.y - 11, item.width + 6, 16);
            overlayContext.fillStyle = item.isCore ? "#fff0b0" : "#c6dfed";
            overlayContext.fillText(item.text, item.x, item.y + 1);
          }
        }
      }
    };

    const render = () => {
      frame = 0;
      if (glResources && !contextLost) {
        canvas.dataset.renderer = "webgl2";
        renderWebGL2(glResources);
      } else {
        canvas.dataset.renderer = "canvas2d";
        const target2D = fallback2DContext ?? overlayContext;
        if (target2D) renderFallback2D(target2D);
      }
      canvas.dataset.rotation = `${cameraRef.current.yaw.toFixed(3)},${cameraRef.current.pitch.toFixed(3)}`;
    };

    const schedule = () => { if (!frame) frame = requestAnimationFrame(render); };
    redrawRef.current = schedule;
    syncTopologyRef.current = () => { uploadTopologyAndStyles(); schedule(); };
    syncCoordinatesRef.current = () => { uploadCoordinatesOnly(); schedule(); };
    syncFocusRef.current = () => { schedule(); };

    uploadTopologyAndStyles();

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, rect.width || 1);
      height = Math.max(1, rect.height || 1);
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      if (fallback2DContext) {
        fallback2DContext.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      if (overlayCanvas && overlayContext) {
        overlayCanvas.width = Math.round(width * dpr);
        overlayCanvas.height = Math.round(height * dpr);
        overlayContext.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      schedule();
    };

    const hit = (x: number, y: number) => picker.pick(x, y, cameraRef.current, width, height, hover ?? current.current.selectedNodeId);
    const local = (event: PointerEvent) => { const rect = canvas.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
    const down = (event: PointerEvent) => {
      canvas.focus(); canvas.setPointerCapture(event.pointerId);
      const p = local(event); pointers.set(event.pointerId, p); downX = p.x; downY = p.y; dragged = false; hover = null;
    };
    const move = (event: PointerEvent) => {
      const p = local(event), previous = pointers.get(event.pointerId);
      if (previous) {
        if (Math.hypot(p.x - downX, p.y - downY) > 4) dragged = true;
        if (pointers.size === 2) {
          const other = [...pointers].find(([id]) => id !== event.pointerId)![1];
          const before = Math.hypot(previous.x - other.x, previous.y - other.y), after = Math.hypot(p.x - other.x, p.y - other.y);
          if (before > 1) cameraRef.current.zoom = Math.max(0.35, Math.min(5, cameraRef.current.zoom * after / before));
        } else {
          cameraRef.current.yaw += (p.x - previous.x) * 0.009;
          cameraRef.current.pitch += (p.y - previous.y) * 0.009;
        }
        pointers.set(event.pointerId, p);
      } else {
        hover = hit(p.x, p.y);
        canvas.style.cursor = hover ? "pointer" : "grab";
      }
      schedule();
    };
    const up = (event: PointerEvent) => {
      const p = local(event);
      if (!dragged && pointers.size === 1) {
        const id = hit(p.x, p.y);
        if (id) current.current.onSelectNode(id);
      }
      pointers.delete(event.pointerId);
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };
    const cancel = (event: PointerEvent) => { pointers.delete(event.pointerId); dragged = true; };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      cameraRef.current.zoom = Math.max(0.35, Math.min(5, cameraRef.current.zoom * Math.exp(-event.deltaY * 0.001)));
      schedule();
    };
    const key = (event: KeyboardEvent) => {
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        cameraRef.current.yaw += event.key === "ArrowLeft" ? -0.15 : event.key === "ArrowRight" ? 0.15 : 0;
        cameraRef.current.pitch += event.key === "ArrowUp" ? -0.15 : event.key === "ArrowDown" ? 0.15 : 0;
        schedule();
      } else if (event.key === "Enter") {
        const node = current.current.nodes.find(node => node.id === current.current.selectedNodeId) ?? current.current.nodes.find(node => isMemoryCoreLabel(node.label));
        if (node) current.current.onSelectNode(node.id);
      }
    };
    const onContextLost = (event: Event) => {
      event.preventDefault();
      contextLost = true;
      canvas.dataset.renderer = "canvas2d";
      schedule();
    };
    const onContextRestored = () => {
      contextLost = false;
      if (triedWebGL) {
        tryInitWebGL();
        uploadTopologyAndStyles();
        uploadedFocusId = undefined;
      }
      schedule();
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
    canvas.addEventListener("webglcontextlost", onContextLost);
    canvas.addEventListener("webglcontextrestored", onContextRestored);

    return () => {
      observer?.disconnect();
      cancelAnimationFrame(frame);
      redrawRef.current = () => {};
      syncTopologyRef.current = () => {};
      syncCoordinatesRef.current = () => {};
      syncFocusRef.current = () => {};
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", cancel);
      canvas.removeEventListener("wheel", wheel);
      canvas.removeEventListener("keydown", key);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
    };
  }, []);

  useEffect(() => {
    syncTopologyRef.current();
  }, [nodes, edges, positions]);

  useEffect(() => {
    syncCoordinatesRef.current();
  }, [coordinates]);

  useEffect(() => {
    syncFocusRef.current();
  }, [showTitles, selectedNodeId]);

  return (
    <div className="memory-3d-surface">
      <canvas
        ref={canvasRef}
        tabIndex={0}
        role="application"
        aria-label="3D memory graph. Drag or use arrow keys to rotate 360 degrees. Scroll or pinch to zoom. Click a node to open."
        aria-busy={loading}
        data-titles-visible={showTitles}
        data-layout-volume={volumeRatio.toFixed(4)}
      />
      <canvas
        ref={overlayCanvasRef}
        className="memory-3d-labels"
        aria-hidden="true"
        style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
      />
      <span className="memory-3d-hint">Drag to rotate 360° · Scroll or pinch to zoom · Click to explore</span>
    </div>
  );
}
