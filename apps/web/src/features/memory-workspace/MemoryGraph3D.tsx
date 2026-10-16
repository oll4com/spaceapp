import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import {
  DEFAULT_MEMORY_CAMERA,
  memory3DVolumeRatio,
  projectMemoryPoint,
  selectVisibleLabels,
  SpatialPickingIndex,
  type MemoryCamera3D,
  type MemoryPoint3D
} from "./memory-3d.js";

function parseHexColor(hex: string | undefined): [number, number, number, number] {
  if (hex && hex.startsWith("#")) {
    if (hex.length === 7) {
      const r = parseInt(hex.slice(1, 3), 16) / 255;
      const g = parseInt(hex.slice(3, 5), 16) / 255;
      const b = parseInt(hex.slice(5, 7), 16) / 255;
      return [r, g, b, 1.0];
    }
    if (hex.length === 9) {
      const r = parseInt(hex.slice(1, 3), 16) / 255;
      const g = parseInt(hex.slice(3, 5), 16) / 255;
      const b = parseInt(hex.slice(5, 7), 16) / 255;
      const a = parseInt(hex.slice(7, 9), 16) / 255;
      return [r, g, b, a];
    }
  }
  return [115 / 255, 149 / 255, 173 / 255, 1.0]; // #7395ad
}

function createShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Could not create WebGL shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile failed: ${info ?? "unknown error"}`);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext, vsSource: string, fsSource: string): WebGLProgram {
  const vs = createShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = createShader(gl, gl.FRAGMENT_SHADER, fsSource);
  const program = gl.createProgram();
  if (!program) throw new Error("Could not create WebGL program");
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Program link failed: ${info ?? "unknown error"}`);
  }
  return program;
}

// Node vertex shader: transforms 3D position through yaw/pitch/perspective math and expands quad billboard
const NODE_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec2 aQuadCoord;
layout(location = 1) in vec3 aNodePos;
layout(location = 2) in vec4 aColor;
layout(location = 3) in vec4 aParams; // x: baseR, y: isCore, z: isFocus, w: isNeighbor

uniform float uYaw;
uniform float uPitch;
uniform float uZoom;
uniform float uScale;
uniform vec2 uViewport;
uniform float uExtent;
uniform float uHasFocus;

out vec2 vQuadCoord;
out float vRadius;
out float vHalo;
out vec4 vColor;
out vec4 vParams;
out float vPerspective;

void main() {
  float cosYaw = cos(uYaw);
  float sinYaw = sin(uYaw);
  float rx = aNodePos.x * cosYaw + aNodePos.z * sinYaw;
  float depth = -aNodePos.x * sinYaw + aNodePos.z * cosYaw;

  float cosPitch = cos(uPitch);
  float sinPitch = sin(uPitch);
  float ry = aNodePos.y * cosPitch - depth * sinPitch;
  float rz = aNodePos.y * sinPitch + depth * cosPitch;

  float perspective = 650.0 / max(120.0, 650.0 + rz * uScale);

  vec2 screenCenter = vec2(
    uViewport.x * 0.5 + rx * uScale * uZoom * perspective,
    uViewport.y * 0.5 - ry * uScale * uZoom * perspective
  );

  float baseR = aParams.x;
  float isCore = aParams.y;
  float isFocus = aParams.z;
  float isNeighbor = aParams.w;

  float radius = max(1.0, baseR * perspective * sqrt(uZoom)) * (isFocus > 0.5 ? 1.5 : 1.0);
  float halo = (isCore > 0.5 || isFocus > 0.5) ? 14.0 : 2.0;
  float totalR = radius + halo;

  vec2 screenPos = screenCenter + aQuadCoord * totalR;

  vec2 ndcPos = vec2(
    (screenPos.x / uViewport.x) * 2.0 - 1.0,
    1.0 - (screenPos.y / uViewport.y) * 2.0
  );

  // Map depth to NDC [-1, 1], with slight bias towards camera so nodes render on top of incident lines
  float ndcZ = clamp(rz / (3.0 * uExtent) - 0.002, -0.999, 0.999);
  gl_Position = vec4(ndcPos, ndcZ, 1.0);

  vQuadCoord = aQuadCoord * totalR;
  vRadius = radius;
  vHalo = halo;
  vPerspective = perspective;
  vParams = aParams;

  float alpha;
  if (uHasFocus > 0.5 && isFocus < 0.5 && isNeighbor < 0.5) {
    alpha = 0.2;
  } else {
    alpha = clamp(perspective, 0.4, 1.0);
  }

  vec3 rgb = isFocus > 0.5 ? vec3(1.0, 1.0, 1.0) : aColor.rgb;
  vColor = vec4(rgb, alpha);
}
`;

// Node fragment shader: draws antialiased circle with glow around core or focused nodes
const NODE_FS = `#version 300 es
precision highp float;

in vec2 vQuadCoord;
in float vRadius;
in float vHalo;
in vec4 vColor;
in vec4 vParams;
in float vPerspective;

out vec4 fragColor;

void main() {
  float dist = length(vQuadCoord);
  float r = vRadius;
  float halo = vHalo;

  if (dist > r + halo) {
    discard;
  }

  float circleAlpha = 1.0 - smoothstep(r - 1.0, r, dist);
  bool hasGlow = (vParams.y > 0.5 || vParams.z > 0.5);
  float glowAlpha = 0.0;
  if (hasGlow) {
    glowAlpha = (1.0 - smoothstep(r - 1.0, r + halo, dist)) * 0.75;
  }

  if (circleAlpha > 0.001) {
    vec3 col = vColor.rgb;
    float a = vColor.a * circleAlpha;
    if (hasGlow && glowAlpha > 0.0) {
      a = max(a, glowAlpha * 0.85);
    }
    fragColor = vec4(col, a);
  } else if (hasGlow && glowAlpha > 0.001) {
    fragColor = vec4(vColor.rgb, glowAlpha * 0.6);
  } else {
    discard;
  }
}
`;

// Edge vertex shader: transforms line endpoints in 3D
const EDGE_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aVertexPos;
layout(location = 1) in vec2 aEdgeParams; // x: isDerived (0 or 1), y: isIncident (0 or 1)

uniform float uYaw;
uniform float uPitch;
uniform float uZoom;
uniform float uScale;
uniform vec2 uViewport;
uniform float uExtent;
uniform float uHasFocus;

out vec4 vColor;

void main() {
  float cosYaw = cos(uYaw);
  float sinYaw = sin(uYaw);
  float rx = aVertexPos.x * cosYaw + aVertexPos.z * sinYaw;
  float depth = -aVertexPos.x * sinYaw + aVertexPos.z * cosYaw;

  float cosPitch = cos(uPitch);
  float sinPitch = sin(uPitch);
  float ry = aVertexPos.y * cosPitch - depth * sinPitch;
  float rz = aVertexPos.y * sinPitch + depth * cosPitch;

  float perspective = 650.0 / max(120.0, 650.0 + rz * uScale);

  vec2 screenPos = vec2(
    uViewport.x * 0.5 + rx * uScale * uZoom * perspective,
    uViewport.y * 0.5 - ry * uScale * uZoom * perspective
  );

  vec2 ndcPos = vec2(
    (screenPos.x / uViewport.x) * 2.0 - 1.0,
    1.0 - (screenPos.y / uViewport.y) * 2.0
  );

  float ndcZ = clamp(rz / (3.0 * uExtent), -0.999, 0.999);
  gl_Position = vec4(ndcPos, ndcZ, 1.0);

  float isDerived = aEdgeParams.x;
  float isIncident = aEdgeParams.y;

  vec3 col;
  if (isIncident > 0.5) {
    col = vec3(0.596, 0.855, 0.980); // #98dafa
  } else if (uHasFocus > 0.5) {
    col = vec3(0.078, 0.125, 0.169); // #14202b
  } else if (isDerived > 0.5) {
    col = vec3(0.220, 0.314, 0.408); // #385068
  } else {
    col = vec3(0.125, 0.200, 0.263); // #203343
  }

  float alpha = isIncident > 0.5 ? 1.0 : (uHasFocus > 0.5 ? 0.35 : 0.8);
  vColor = vec4(col, alpha);
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
  const volumeRatio = useMemo(() => memory3DVolumeRatio([...coordinates.values()]), [coordinates]);
  const containerRef = useRef<HTMLDivElement>(null);
  const webglCanvasRef = useRef<HTMLCanvasElement>(null);
  const labelCanvasRef = useRef<HTMLCanvasElement>(null);
  const fallbackCanvasRef = useRef<HTMLCanvasElement>(null);

  const [useFallback, setUseFallback] = useState(false);
  const cameraRef = useRef<MemoryCamera3D>({ ...DEFAULT_MEMORY_CAMERA });
  const redrawRef = useRef<() => void>(() => {});

  const current = useRef({
    nodes,
    edges,
    positions,
    coordinates,
    showTitles,
    selectedNodeId,
    onSelectNode
  });
  current.current = { nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode };

  useEffect(() => {
    cameraRef.current = { ...DEFAULT_MEMORY_CAMERA };
    redrawRef.current();
  }, [resetToken]);

  useEffect(() => {
    redrawRef.current();
  }, [nodes, edges, positions, coordinates, showTitles, selectedNodeId]);

  // Test WebGL2 support
  useEffect(() => {
    if (typeof HTMLCanvasElement === "undefined") {
      setUseFallback(true);
      return;
    }
    const testCanvas = document.createElement("canvas");
    const gl = testCanvas.getContext("webgl2");
    if (!gl) {
      setUseFallback(true);
    }
  }, []);

  // WebGL2 Renderer Lifecycle
  useEffect(() => {
    if (useFallback) return;
    const canvas = webglCanvasRef.current;
    const labelCanvas = labelCanvasRef.current;
    if (!canvas || !labelCanvas) return;

    let gl: WebGL2RenderingContext | null = null;
    try {
      gl = canvas.getContext("webgl2", { alpha: true, antialias: true, depth: true, preserveDrawingBuffer: false });
    } catch {
      setUseFallback(true);
      return;
    }
    if (!gl) {
      setUseFallback(true);
      return;
    }

    const labelCtx = labelCanvas.getContext("2d");
    if (!labelCtx) {
      setUseFallback(true);
      return;
    }

    let nodeProgram: WebGLProgram | null = null;
    let edgeProgram: WebGLProgram | null = null;

    let quadVao: WebGLVertexArrayObject | null = null;
    let edgeVao: WebGLVertexArrayObject | null = null;

    let quadBuffer: WebGLBuffer | null = null;
    let nodePosBuffer: WebGLBuffer | null = null;
    let nodeColorBuffer: WebGLBuffer | null = null;
    let nodeParamsBuffer: WebGLBuffer | null = null;

    let edgePosBuffer: WebGLBuffer | null = null;
    let edgeParamBuffer: WebGLBuffer | null = null;

    try {
      nodeProgram = createProgram(gl, NODE_VS, NODE_FS);
      edgeProgram = createProgram(gl, EDGE_VS, EDGE_FS);

      // Node billboard quad VAO
      quadVao = gl.createVertexArray();
      quadBuffer = gl.createBuffer();
      nodePosBuffer = gl.createBuffer();
      nodeColorBuffer = gl.createBuffer();
      nodeParamsBuffer = gl.createBuffer();

      gl.bindVertexArray(quadVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, nodePosBuffer);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(1, 1);

      gl.bindBuffer(gl.ARRAY_BUFFER, nodeColorBuffer);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(2, 1);

      gl.bindBuffer(gl.ARRAY_BUFFER, nodeParamsBuffer);
      gl.enableVertexAttribArray(3);
      gl.vertexAttribPointer(3, 4, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(3, 1);
      gl.bindVertexArray(null);

      // Edge lines VAO
      edgeVao = gl.createVertexArray();
      edgePosBuffer = gl.createBuffer();
      edgeParamBuffer = gl.createBuffer();

      gl.bindVertexArray(edgeVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, edgePosBuffer);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, edgeParamBuffer);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
    } catch {
      setUseFallback(true);
      return;
    }

    let frame = 0;
    let width = 1;
    let height = 1;
    let dpr = 1;
    let hover: string | null = null;
    let spatialIndex: SpatialPickingIndex | null = null;

    let lastPickYaw = NaN;
    let lastPickPitch = NaN;
    let lastPickZoom = NaN;
    let lastPickScale = NaN;
    let lastPickWidth = NaN;
    let lastPickHeight = NaN;

    const pointers = new Map<number, { x: number; y: number }>();
    let dragged = false;
    let downX = 0;
    let downY = 0;

    let lastNodes: MemoryGraphNode[] | null = null;
    let lastEdges: MemoryGraphEdge[] | null = null;
    let lastPositions: Map<string, MemoryAtlasPosition> | null = null;
    let lastCoordinates: Map<string, MemoryPoint3D> | null = null;
    let lastFocus: string | null = null;
    let focusDirty = true;

    let validNodes: MemoryGraphNode[] = [];
    let validEdges: MemoryGraphEdge[] = [];
    let cachedNodeCount = 0;
    let cachedEdgeVertexCount = 0;

    const updateDataBuffers = () => {
      const { nodes, edges, positions, coordinates } = current.current;
      validNodes = [];
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i]!;
        if (coordinates.has(node.id)) validNodes.push(node);
      }
      cachedNodeCount = validNodes.length;

      const posData = new Float32Array(validNodes.length * 3);
      const colorData = new Float32Array(validNodes.length * 4);
      for (let i = 0; i < validNodes.length; i++) {
        const node = validNodes[i]!;
        const c = coordinates.get(node.id)!;
        posData[i * 3] = c.x;
        posData[i * 3 + 1] = c.y;
        posData[i * 3 + 2] = c.z;

        const col = parseHexColor(positions.get(node.id)?.color);
        colorData[i * 4] = col[0]!;
        colorData[i * 4 + 1] = col[1]!;
        colorData[i * 4 + 2] = col[2]!;
        colorData[i * 4 + 3] = col[3]!;
      }

      gl!.bindBuffer(gl!.ARRAY_BUFFER, nodePosBuffer);
      gl!.bufferData(gl!.ARRAY_BUFFER, posData, gl!.DYNAMIC_DRAW);

      gl!.bindBuffer(gl!.ARRAY_BUFFER, nodeColorBuffer);
      gl!.bufferData(gl!.ARRAY_BUFFER, colorData, gl!.DYNAMIC_DRAW);

      validEdges = [];
      for (let i = 0; i < edges.length; i++) {
        const edge = edges[i]!;
        if (coordinates.has(edge.source) && coordinates.has(edge.target)) {
          validEdges.push(edge);
        }
      }
      cachedEdgeVertexCount = validEdges.length * 2;

      const edgePosData = new Float32Array(validEdges.length * 6);
      for (let i = 0; i < validEdges.length; i++) {
        const edge = validEdges[i]!;
        const c1 = coordinates.get(edge.source)!;
        const c2 = coordinates.get(edge.target)!;
        edgePosData[i * 6] = c1.x;
        edgePosData[i * 6 + 1] = c1.y;
        edgePosData[i * 6 + 2] = c1.z;
        edgePosData[i * 6 + 3] = c2.x;
        edgePosData[i * 6 + 4] = c2.y;
        edgePosData[i * 6 + 5] = c2.z;
      }

      gl!.bindBuffer(gl!.ARRAY_BUFFER, edgePosBuffer);
      gl!.bufferData(gl!.ARRAY_BUFFER, edgePosData, gl!.DYNAMIC_DRAW);

      lastNodes = nodes;
      lastEdges = edges;
      lastPositions = positions;
      lastCoordinates = coordinates;
      focusDirty = true;
      spatialIndex = null;
    };

    const updateFocusBuffers = (focus: string | null) => {
      const neighbors = new Set<string>();
      if (focus) {
        for (let i = 0; i < validEdges.length; i++) {
          const edge = validEdges[i]!;
          if (edge.source === focus) neighbors.add(edge.target);
          if (edge.target === focus) neighbors.add(edge.source);
        }
      }

      const nodeParamsData = new Float32Array(validNodes.length * 4);
      for (let i = 0; i < validNodes.length; i++) {
        const node = validNodes[i]!;
        const isCore = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
        const baseR = isCore ? 10.0 : node.type === "SOURCE" ? 4.6 : 2.1;
        const isFocus = node.id === focus ? 1.0 : 0.0;
        const isNeighbor = neighbors.has(node.id) ? 1.0 : 0.0;

        nodeParamsData[i * 4] = baseR;
        nodeParamsData[i * 4 + 1] = isCore ? 1.0 : 0.0;
        nodeParamsData[i * 4 + 2] = isFocus;
        nodeParamsData[i * 4 + 3] = isNeighbor;
      }

      gl!.bindBuffer(gl!.ARRAY_BUFFER, nodeParamsBuffer);
      gl!.bufferData(gl!.ARRAY_BUFFER, nodeParamsData, gl!.DYNAMIC_DRAW);

      const edgeParamData = new Float32Array(validEdges.length * 4);
      for (let i = 0; i < validEdges.length; i++) {
        const edge = validEdges[i]!;
        const isDerived = edge.type === "DERIVED_FROM" ? 1.0 : 0.0;
        const isIncident = edge.source === focus || edge.target === focus ? 1.0 : 0.0;

        edgeParamData[i * 4] = isDerived;
        edgeParamData[i * 4 + 1] = isIncident;
        edgeParamData[i * 4 + 2] = isDerived;
        edgeParamData[i * 4 + 3] = isIncident;
      }

      gl!.bindBuffer(gl!.ARRAY_BUFFER, edgeParamBuffer);
      gl!.bufferData(gl!.ARRAY_BUFFER, edgeParamData, gl!.DYNAMIC_DRAW);

      lastFocus = focus;
      focusDirty = false;
    };

    const render = () => {
      frame = 0;
      if (!gl || gl.isContextLost()) return;

      const { nodes, edges, positions, coordinates, showTitles, selectedNodeId } = current.current;
      const focus = hover ?? selectedNodeId;

      if (nodes !== lastNodes || edges !== lastEdges || coordinates !== lastCoordinates || positions !== lastPositions) {
        updateDataBuffers();
      }

      if (focus !== lastFocus || focusDirty) {
        updateFocusBuffers(focus);
      }

      const extent = Math.max(60, ...[...coordinates.values()].map(p => Math.hypot(p.x, p.y, p.z)));
      const scale = (Math.min(width, height) * 0.4) / extent;
      const camera = cameraRef.current;

      gl.viewport(0, 0, Math.round(width * dpr), Math.round(height * dpr));
      gl.clearColor(0, 0, 0, 0);
      gl.clearDepth(1.0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      const viewportVec = [width, height];
      const hasFocusVal = focus ? 1.0 : 0.0;

      // Draw Edges
      if (cachedEdgeVertexCount > 0 && edgeProgram && edgeVao) {
        gl.useProgram(edgeProgram);
        gl.uniform1f(gl.getUniformLocation(edgeProgram, "uYaw"), camera.yaw);
        gl.uniform1f(gl.getUniformLocation(edgeProgram, "uPitch"), camera.pitch);
        gl.uniform1f(gl.getUniformLocation(edgeProgram, "uZoom"), camera.zoom);
        gl.uniform1f(gl.getUniformLocation(edgeProgram, "uScale"), scale);
        gl.uniform2f(gl.getUniformLocation(edgeProgram, "uViewport"), viewportVec[0]!, viewportVec[1]!);
        gl.uniform1f(gl.getUniformLocation(edgeProgram, "uExtent"), extent);
        gl.uniform1f(gl.getUniformLocation(edgeProgram, "uHasFocus"), hasFocusVal);

        gl.bindVertexArray(edgeVao);
        gl.drawArrays(gl.LINES, 0, cachedEdgeVertexCount);
        gl.bindVertexArray(null);
      }

      // Draw Instanced Nodes
      if (cachedNodeCount > 0 && nodeProgram && quadVao) {
        gl.useProgram(nodeProgram);
        gl.uniform1f(gl.getUniformLocation(nodeProgram, "uYaw"), camera.yaw);
        gl.uniform1f(gl.getUniformLocation(nodeProgram, "uPitch"), camera.pitch);
        gl.uniform1f(gl.getUniformLocation(nodeProgram, "uZoom"), camera.zoom);
        gl.uniform1f(gl.getUniformLocation(nodeProgram, "uScale"), scale);
        gl.uniform2f(gl.getUniformLocation(nodeProgram, "uViewport"), viewportVec[0]!, viewportVec[1]!);
        gl.uniform1f(gl.getUniformLocation(nodeProgram, "uExtent"), extent);
        gl.uniform1f(gl.getUniformLocation(nodeProgram, "uHasFocus"), hasFocusVal);

        gl.bindVertexArray(quadVao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, cachedNodeCount);
        gl.bindVertexArray(null);
      }

      // Draw Labels on 2D Overlay Canvas
      labelCtx.clearRect(0, 0, width, height);
      if (showTitles) {
        labelCtx.font = "11px system-ui, sans-serif";
        const neighbors = new Set<string>();
        if (focus) {
          for (let i = 0; i < validEdges.length; i++) {
            const edge = validEdges[i]!;
            if (edge.source === focus) neighbors.add(edge.target);
            if (edge.target === focus) neighbors.add(edge.source);
          }
        }
        const labelsToDraw = selectVisibleLabels({
          nodes: validNodes,
          coordinates,
          camera,
          scale,
          width,
          height,
          focus,
          neighbors,
          maxLabels: 50,
          measureText: t => labelCtx.measureText(t).width
        });

        for (let i = 0; i < labelsToDraw.length; i++) {
          const item = labelsToDraw[i]!;
          labelCtx.fillStyle = "#09111bea";
          labelCtx.fillRect(item.x - 3, item.y - 11, item.width + 6, 16);
          labelCtx.fillStyle = item.isCore ? "#fff0b0" : "#c6dfed";
          labelCtx.fillText(item.text, item.x, item.y + 1);
        }
      }

      canvas.dataset.rotation = `${camera.yaw.toFixed(3)},${camera.pitch.toFixed(3)}`;
    };

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(render);
    };
    redrawRef.current = schedule;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      dpr = Math.min(window.devicePixelRatio || 1, 2);

      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      labelCanvas.width = Math.round(width * dpr);
      labelCanvas.height = Math.round(height * dpr);
      labelCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

      schedule();
    };

    const ensureSpatialIndex = () => {
      const camera = cameraRef.current;
      const { coordinates } = current.current;
      const extent = Math.max(60, ...[...coordinates.values()].map(p => Math.hypot(p.x, p.y, p.z)));
      const scale = (Math.min(width, height) * 0.4) / extent;

      if (
        spatialIndex &&
        lastPickYaw === camera.yaw &&
        lastPickPitch === camera.pitch &&
        lastPickZoom === camera.zoom &&
        lastPickScale === scale &&
        lastPickWidth === width &&
        lastPickHeight === height
      ) {
        return;
      }

      const focus = hover ?? current.current.selectedNodeId;
      const projectedForHit: Array<{ id: string; x: number; y: number; z: number; radius: number }> = [];

      for (let i = 0; i < validNodes.length; i++) {
        const node = validNodes[i]!;
        const coord = coordinates.get(node.id);
        if (!coord) continue;

        const isCore = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
        const baseR = isCore ? 10.0 : node.type === "SOURCE" ? 4.6 : 2.1;
        const isFocus = node.id === focus;

        const p = projectMemoryPoint(coord, camera, scale, width, height);
        const radius = Math.max(1, baseR * p.perspective * Math.sqrt(camera.zoom)) * (isFocus ? 1.5 : 1);
        projectedForHit.push({ id: node.id, x: p.x, y: p.y, z: p.z, radius });
      }

      spatialIndex = new SpatialPickingIndex(projectedForHit);
      lastPickYaw = camera.yaw;
      lastPickPitch = camera.pitch;
      lastPickZoom = camera.zoom;
      lastPickScale = scale;
      lastPickWidth = width;
      lastPickHeight = height;
    };

    const pickNode = (screenX: number, screenY: number): string | null => {
      ensureSpatialIndex();
      return spatialIndex?.findHit(screenX, screenY) ?? null;
    };

    const local = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    const down = (event: PointerEvent) => {
      canvas.focus();
      canvas.setPointerCapture(event.pointerId);
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
      } else {
        hover = pickNode(p.x, p.y);
        canvas.style.cursor = hover ? "pointer" : "grab";
      }
      schedule();
    };

    const up = (event: PointerEvent) => {
      const p = local(event);
      if (!dragged && pointers.size === 1) {
        const id = pickNode(p.x, p.y);
        if (id) current.current.onSelectNode(id);
      }
      pointers.delete(event.pointerId);
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };

    const cancel = (event: PointerEvent) => {
      pointers.delete(event.pointerId);
      dragged = true;
    };

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
        const node =
          current.current.nodes.find(node => node.id === current.current.selectedNodeId) ??
          current.current.nodes.find(node => isMemoryCoreLabel(node.label));
        if (node) current.current.onSelectNode(node.id);
      }
    };

    const onContextLost = (event: Event) => {
      event.preventDefault();
      setUseFallback(true);
    };

    const onContextRestored = () => {
      setUseFallback(false);
      schedule();
    };

    canvas.addEventListener("webglcontextlost", onContextLost);
    canvas.addEventListener("webglcontextrestored", onContextRestored);
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", cancel);
    canvas.addEventListener("wheel", wheel, { passive: false });
    canvas.addEventListener("keydown", key);

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      redrawRef.current = () => {};

      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", cancel);
      canvas.removeEventListener("wheel", wheel);
      canvas.removeEventListener("keydown", key);

      if (gl) {
        if (quadBuffer) gl.deleteBuffer(quadBuffer);
        if (nodePosBuffer) gl.deleteBuffer(nodePosBuffer);
        if (nodeColorBuffer) gl.deleteBuffer(nodeColorBuffer);
        if (nodeParamsBuffer) gl.deleteBuffer(nodeParamsBuffer);
        if (edgePosBuffer) gl.deleteBuffer(edgePosBuffer);
        if (edgeParamBuffer) gl.deleteBuffer(edgeParamBuffer);
        if (quadVao) gl.deleteVertexArray(quadVao);
        if (edgeVao) gl.deleteVertexArray(edgeVao);
        if (nodeProgram) gl.deleteProgram(nodeProgram);
        if (edgeProgram) gl.deleteProgram(edgeProgram);
      }
    };
  }, [useFallback]);

  // Fallback Canvas 2D Renderer (capped at 2,000 nodes)
  useEffect(() => {
    if (!useFallback) return;
    const canvas = fallbackCanvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    let frame = 0,
      width = 1,
      height = 1;
    let hover: string | null = null;
    let points: Array<{ id: string; x: number; y: number; z: number; radius: number }> = [];
    const pointers = new Map<number, { x: number; y: number }>();
    let dragged = false,
      downX = 0,
      downY = 0;

    const render = () => {
      frame = 0;
      const { nodes: rawNodes, edges: rawEdges, positions, coordinates, showTitles, selectedNodeId } = current.current;
      // Cap at 2,000 nodes for 2D fallback
      const nodes = rawNodes.length > 2000 ? rawNodes.slice(0, 2000) : rawNodes;
      const nodeIds = new Set(nodes.map(n => n.id));
      const edges = rawEdges.filter(e => nodeIds.has(e.source) && nodeIds.has(e.target));

      context.clearRect(0, 0, width, height);
      const extent = Math.max(60, ...[...coordinates.values()].map(p => Math.hypot(p.x, p.y, p.z)));
      const scale = (Math.min(width, height) * 0.4) / extent;
      const projected = new Map(
        nodes.flatMap(node => {
          const p = coordinates.get(node.id);
          return p ? [[node.id, projectMemoryPoint(p, cameraRef.current, scale, width, height)] as const] : [];
        })
      );
      const focus = hover ?? selectedNodeId;
      const neighbors = new Set<string>();
      if (focus) {
        for (const edge of edges) {
          if (edge.source === focus) neighbors.add(edge.target);
          if (edge.target === focus) neighbors.add(edge.source);
        }
      }
      context.lineWidth = 0.55;
      for (const edge of edges) {
        const a = projected.get(edge.source),
          b = projected.get(edge.target);
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
      points = [];
      const ordered = nodes
        .filter(node => projected.has(node.id))
        .sort((a, b) => projected.get(b.id)!.z - projected.get(a.id)!.z);
      const labelBoxes: Array<{ x: number; y: number; w: number }> = [];
      for (const node of ordered) {
        const p = projected.get(node.id)!;
        const highlighted = node.id === focus;
        const root = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
        const radius =
          Math.max(1, (root ? 10 : node.type === "SOURCE" ? 4.6 : 2.1) * p.perspective * Math.sqrt(cameraRef.current.zoom)) *
          (highlighted ? 1.5 : 1);
        points.push({ id: node.id, ...p, radius });
        context.globalAlpha =
          focus && !highlighted && !neighbors.has(node.id) ? 0.2 : Math.max(0.4, Math.min(1, p.perspective));
        context.fillStyle = highlighted ? "#ffffff" : positions.get(node.id)?.color ?? "#7395ad";
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
      if (showTitles) {
        const labeled = [...ordered].sort(
          (a, b) =>
            Number(b.id === focus) - Number(a.id === focus) ||
            Number(isMemoryCoreLabel(b.label)) - Number(isMemoryCoreLabel(a.label)) ||
            Number(b.type === "SOURCE") - Number(a.type === "SOURCE")
        );
        context.font = "11px system-ui, sans-serif";
        for (const node of labeled) {
          if (node.type !== "SOURCE" && node.id !== focus && cameraRef.current.zoom < 1.6) continue;
          const p = projected.get(node.id)!;
          const label = node.label.length > 48 ? `${node.label.slice(0, 45)}…` : node.label;
          const x = p.x + 9,
            y = p.y,
            w = context.measureText(label).width;
          if (
            x + w > width ||
            y < 14 ||
            y > height - 5 ||
            labelBoxes.some(box => Math.abs(box.y - y) < 16 && x < box.x + box.w + 5 && x + w + 5 > box.x)
          )
            continue;
          labelBoxes.push({ x, y, w });
          context.fillStyle = "#09111bea";
          context.fillRect(x - 3, y - 11, w + 6, 16);
          context.fillStyle = isMemoryCoreLabel(node.label) ? "#fff0b0" : "#c6dfed";
          context.fillText(label, x, y + 1);
        }
      }
      canvas.dataset.rotation = `${cameraRef.current.yaw.toFixed(3)},${cameraRef.current.pitch.toFixed(3)}`;
    };

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(render);
    };
    redrawRef.current = schedule;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      schedule();
    };

    const hit = (x: number, y: number) =>
      [...points].reverse().find(p => Math.hypot(p.x - x, p.y - y) < Math.max(7, p.radius + 3))?.id ?? null;

    const local = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    const down = (event: PointerEvent) => {
      canvas.focus();
      canvas.setPointerCapture(event.pointerId);
      const p = local(event);
      pointers.set(event.pointerId, p);
      downX = p.x;
      downY = p.y;
      dragged = false;
      hover = null;
    };

    const move = (event: PointerEvent) => {
      const p = local(event),
        previous = pointers.get(event.pointerId);
      if (previous) {
        if (Math.hypot(p.x - downX, p.y - downY) > 4) dragged = true;
        if (pointers.size === 2) {
          const other = [...pointers].find(([id]) => id !== event.pointerId)![1];
          const before = Math.hypot(previous.x - other.x, previous.y - other.y),
            after = Math.hypot(p.x - other.x, p.y - other.y);
          if (before > 1) cameraRef.current.zoom = Math.max(0.35, Math.min(5, (cameraRef.current.zoom * after) / before));
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

    const cancel = (event: PointerEvent) => {
      pointers.delete(event.pointerId);
      dragged = true;
    };

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
        const node =
          current.current.nodes.find(node => node.id === current.current.selectedNodeId) ??
          current.current.nodes.find(node => isMemoryCoreLabel(node.label));
        if (node) current.current.onSelectNode(node.id);
      }
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", cancel);
    canvas.addEventListener("wheel", wheel, { passive: false });
    canvas.addEventListener("keydown", key);

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      redrawRef.current = () => {};
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", cancel);
      canvas.removeEventListener("wheel", wheel);
      canvas.removeEventListener("keydown", key);
    };
  }, [useFallback]);

  useEffect(() => {
    redrawRef.current();
  }, [nodes, edges, positions, coordinates, showTitles, selectedNodeId, useFallback]);

  return (
    <div ref={containerRef} className="memory-3d-surface" style={{ position: "relative" }}>
      {!useFallback ? (
        <>
          <canvas
            ref={webglCanvasRef}
            tabIndex={0}
            role="application"
            aria-label="3D memory graph. Drag or use arrow keys to rotate 360 degrees. Scroll or pinch to zoom. Click a node to open."
            aria-busy={loading}
            data-titles-visible={showTitles}
            data-layout-volume={volumeRatio.toFixed(4)}
            style={{ width: "100%", height: "100%", display: "block" }}
          />
          <canvas
            ref={labelCanvasRef}
            className="memory-3d-labels"
            aria-hidden="true"
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              pointerEvents: "none"
            }}
          />
        </>
      ) : (
        <canvas
          ref={fallbackCanvasRef}
          tabIndex={0}
          role="application"
          aria-label="3D memory graph. Drag or use arrow keys to rotate 360 degrees. Scroll or pinch to zoom. Click a node to open."
          aria-busy={loading}
          data-titles-visible={showTitles}
          data-layout-volume={volumeRatio.toFixed(4)}
          style={{ width: "100%", height: "100%", display: "block" }}
        />
      )}
      <span className="memory-3d-hint">Drag to rotate 360° · Scroll or pinch to zoom · Click to explore</span>
    </div>
  );
}
