import { useEffect, useMemo, useRef } from "react";
import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import {
  DEFAULT_MEMORY_CAMERA,
  MAX_MEMORY_3D_FALLBACK_NODES,
  MAX_MEMORY_3D_LABELS,
  MEMORY_3D_EDGE_FRAGMENT_SHADER,
  MEMORY_3D_EDGE_VERTEX_SHADER,
  MEMORY_3D_NODE_FRAGMENT_SHADER,
  MEMORY_3D_NODE_VERTEX_SHADER,
  buildMemory3DSpatialIndex,
  buildMemory3DWebGLBuffers,
  computeMemory3DExtent,
  memory3DVolumeRatio,
  pickMemory3DNode,
  selectMemory3DFallbackNodes,
  selectMemory3DLabels,
  updateMemory3DFocusAttributes,
  type Memory3DSpatialBuffers,
  type Memory3DSpatialIndex,
  type Memory3DWebGLBuffers,
  type MemoryCamera3D,
  type MemoryPoint3D
} from "./memory-3d.js";

interface WebGLSceneResources {
  gl: WebGL2RenderingContext;
  edgeProgram: WebGLProgram;
  nodeProgram: WebGLProgram;
  edgeVao: WebGLVertexArrayObject;
  nodeVao: WebGLVertexArrayObject;
  edgePosBuffer: WebGLBuffer;
  edgeMetaBuffer: WebGLBuffer;
  quadCornerBuffer: WebGLBuffer;
  nodePosBuffer: WebGLBuffer;
  nodeStyleBuffer: WebGLBuffer;
  nodeFocusBuffer: WebGLBuffer;
  edgeUniforms: {
    uViewport: WebGLUniformLocation | null;
    uScale: WebGLUniformLocation | null;
    uYaw: WebGLUniformLocation | null;
    uPitch: WebGLUniformLocation | null;
    uZoom: WebGLUniformLocation | null;
    uFocusIndex: WebGLUniformLocation | null;
  };
  nodeUniforms: {
    uViewport: WebGLUniformLocation | null;
    uScale: WebGLUniformLocation | null;
    uYaw: WebGLUniformLocation | null;
    uPitch: WebGLUniformLocation | null;
    uZoom: WebGLUniformLocation | null;
    uHasFocus: WebGLUniformLocation | null;
  };
}

/**
 * Compiles a GLSL shader of the specified type (vertex or fragment).
 *
 * @param gl WebGL2 context.
 * @param type Shader type enum (gl.VERTEX_SHADER or gl.FRAGMENT_SHADER).
 * @param source GLSL source code string.
 * @returns Compiled WebGLShader or null if compilation failed.
 */
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

/**
 * Links vertex and fragment shaders into an executable WebGLProgram.
 *
 * @param gl WebGL2 context.
 * @param vsSource Vertex shader GLSL code.
 * @param fsSource Fragment shader GLSL code.
 * @returns Linked WebGLProgram or null on failure.
 */
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

/**
 * Allocates and configures all WebGL2 programs, VAOs, uniform locations, and buffers.
 *
 * @param gl WebGL2 context.
 * @returns Initialized WebGLSceneResources or null if any resource allocation failed.
 */
function initWebGLResources(gl: WebGL2RenderingContext): WebGLSceneResources | null {
  const edgeProgram = createProgram(gl, MEMORY_3D_EDGE_VERTEX_SHADER, MEMORY_3D_EDGE_FRAGMENT_SHADER);
  const nodeProgram = createProgram(gl, MEMORY_3D_NODE_VERTEX_SHADER, MEMORY_3D_NODE_FRAGMENT_SHADER);
  const edgeVao = gl.createVertexArray();
  const nodeVao = gl.createVertexArray();
  const edgePosBuffer = gl.createBuffer();
  const edgeMetaBuffer = gl.createBuffer();
  const quadCornerBuffer = gl.createBuffer();
  const nodePosBuffer = gl.createBuffer();
  const nodeStyleBuffer = gl.createBuffer();
  const nodeFocusBuffer = gl.createBuffer();

  if (
    !edgeProgram ||
    !nodeProgram ||
    !edgeVao ||
    !nodeVao ||
    !edgePosBuffer ||
    !edgeMetaBuffer ||
    !quadCornerBuffer ||
    !nodePosBuffer ||
    !nodeStyleBuffer ||
    !nodeFocusBuffer
  ) {
    return null;
  }

  // Configure Edge VAO
  gl.bindVertexArray(edgeVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, edgePosBuffer);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, edgeMetaBuffer);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);

  // Configure Node Instanced VAO
  gl.bindVertexArray(nodeVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadCornerBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, nodePosBuffer);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(1, 1);

  gl.bindBuffer(gl.ARRAY_BUFFER, nodeStyleBuffer);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(2, 1);

  gl.bindBuffer(gl.ARRAY_BUFFER, nodeFocusBuffer);
  gl.enableVertexAttribArray(3);
  gl.vertexAttribPointer(3, 1, gl.UNSIGNED_BYTE, false, 0, 0);
  gl.vertexAttribDivisor(3, 1);

  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  return {
    gl,
    edgeProgram,
    nodeProgram,
    edgeVao,
    nodeVao,
    edgePosBuffer,
    edgeMetaBuffer,
    quadCornerBuffer,
    nodePosBuffer,
    nodeStyleBuffer,
    nodeFocusBuffer,
    edgeUniforms: {
      uViewport: gl.getUniformLocation(edgeProgram, "uViewport"),
      uScale: gl.getUniformLocation(edgeProgram, "uScale"),
      uYaw: gl.getUniformLocation(edgeProgram, "uYaw"),
      uPitch: gl.getUniformLocation(edgeProgram, "uPitch"),
      uZoom: gl.getUniformLocation(edgeProgram, "uZoom"),
      uFocusIndex: gl.getUniformLocation(edgeProgram, "uFocusIndex")
    },
    nodeUniforms: {
      uViewport: gl.getUniformLocation(nodeProgram, "uViewport"),
      uScale: gl.getUniformLocation(nodeProgram, "uScale"),
      uYaw: gl.getUniformLocation(nodeProgram, "uYaw"),
      uPitch: gl.getUniformLocation(nodeProgram, "uPitch"),
      uZoom: gl.getUniformLocation(nodeProgram, "uZoom"),
      uHasFocus: gl.getUniformLocation(nodeProgram, "uHasFocus")
    }
  };
}

/**
 * Interactive 3D memory graph surface using WebGL2 instanced rendering,
 * incremental worker coordinates, 3D spatial index picking, and 2D LOD label overlay.
 * Automatically falls back to Canvas 2D (capped at 2,000 nodes) upon WebGL context loss.
 */
export function MemoryGraph3D({
  nodes,
  edges,
  positions,
  coordinates,
  packedCoordinates,
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
  packedCoordinates?: Float32Array | null;
  showTitles: boolean;
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
  loading: boolean;
  resetToken: number;
}) {
  const volumeRatio = useMemo(
    () =>
      packedCoordinates && packedCoordinates.length >= 12
        ? memory3DVolumeRatio(packedCoordinates)
        : memory3DVolumeRatio([...coordinates.values()]),
    [coordinates, packedCoordinates]
  );
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef<MemoryCamera3D>({ ...DEFAULT_MEMORY_CAMERA });
  const redrawRef = useRef<() => void>(() => {});
  const syncSceneRef = useRef<(topologyChanged: boolean) => void>(() => {});
  const current = useRef({
    nodes,
    edges,
    positions,
    coordinates,
    packedCoordinates: packedCoordinates ?? null,
    showTitles,
    selectedNodeId,
    onSelectNode
  });
  current.current = {
    nodes,
    edges,
    positions,
    coordinates,
    packedCoordinates: packedCoordinates ?? null,
    showTitles,
    selectedNodeId,
    onSelectNode
  };

  useEffect(() => {
    cameraRef.current = { ...DEFAULT_MEMORY_CAMERA };
    redrawRef.current();
  }, [resetToken]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const overlayCanvas = overlayCanvasRef.current;
    if (!canvas || !overlayCanvas) return;

    let glContext: WebGL2RenderingContext | null = null;
    try {
      glContext = canvas.getContext("webgl2", {
        antialias: true,
        alpha: true,
        depth: true,
        powerPreference: "high-performance",
        preserveDrawingBuffer: false
      });
    } catch {
      glContext = null;
    }

    let webglResources = glContext ? initWebGLResources(glContext) : null;
    let contextLost = false;
    const fallback2DContext = !webglResources ? canvas.getContext("2d") : null;
    const overlayContext = overlayCanvas.getContext("2d");

    let frame = 0;
    let width = 1;
    let height = 1;
    let dpr = 1;
    let hover: string | null = null;
    const pointers = new Map<number, { x: number; y: number }>();
    let dragged = false;
    let downX = 0;
    let downY = 0;

    let gpuBuffers: Memory3DWebGLBuffers | null = null;
    let spatialIndex: Memory3DSpatialIndex | null = null;
    let spatialDirty = true;
    const spatialBuffers: Memory3DSpatialBuffers = {
      screenX: new Float32Array(0),
      screenY: new Float32Array(0),
      depthZ: new Float32Array(0),
      perspective: new Float32Array(0),
      radii: new Float32Array(0),
      visible: new Uint8Array(0),
      isCoreSource: new Uint8Array(0),
      isSource: new Uint8Array(0),
      cellHead: new Int32Array(0),
      nextInCell: new Int32Array(0)
    };
    const labelWidthCache = new Map<string, number>();

    const measureLabelWidth = (ctx: CanvasRenderingContext2D | null, text: string): number => {
      const cached = labelWidthCache.get(text);
      if (cached !== undefined) return cached;
      const measured = ctx ? ctx.measureText(text).width : text.length * 6.2;
      if (labelWidthCache.size > 4096) labelWidthCache.clear();
      labelWidthCache.set(text, measured);
      return measured;
    };

    const uploadAllGpuBuffers = (resources: WebGLSceneResources, buffers: Memory3DWebGLBuffers) => {
      const { gl } = resources;
      gl.bindBuffer(gl.ARRAY_BUFFER, resources.nodePosBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, buffers.instancePositions, gl.DYNAMIC_DRAW);

      gl.bindBuffer(gl.ARRAY_BUFFER, resources.nodeStyleBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, buffers.instanceStyles, gl.STATIC_DRAW);

      gl.bindBuffer(gl.ARRAY_BUFFER, resources.nodeFocusBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, buffers.instanceFocusState, gl.DYNAMIC_DRAW);

      gl.bindBuffer(gl.ARRAY_BUFFER, resources.edgePosBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, buffers.edgePositions, gl.DYNAMIC_DRAW);

      gl.bindBuffer(gl.ARRAY_BUFFER, resources.edgeMetaBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, buffers.edgeMeta, gl.STATIC_DRAW);

      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    };

    const syncSceneBuffers = (topologyChanged: boolean) => {
      spatialDirty = true;
      if (!webglResources || contextLost) {
        gpuBuffers = null;
        return;
      }
      const { nodes, edges, positions, coordinates, packedCoordinates } = current.current;
      if (!topologyChanged && gpuBuffers && gpuBuffers.nodeCount === nodes.length) {
        // Fast path for incremental worker layout frames: update 3D coordinates in-place without rebuilding styles/meta.
        const count = nodes.length;
        const pos = gpuBuffers.instancePositions;
        const hasPacked = Boolean(packedCoordinates && packedCoordinates.length >= count * 3);
        if (hasPacked) {
          pos.set(packedCoordinates!.subarray(0, count * 3));
        } else {
          for (let i = 0; i < count; i++) {
            const p = coordinates.get(nodes[i]!.id);
            const base = i * 3;
            pos[base] = p?.x ?? 0;
            pos[base + 1] = p?.y ?? 0;
            pos[base + 2] = p?.z ?? 0;
          }
        }
        const edgePos = gpuBuffers.edgePositions;
        const edgeMeta = gpuBuffers.edgeMeta;
        const edgeCount = gpuBuffers.edgeVertexCount / 2;
        for (let e = 0; e < edgeCount; e++) {
          const vBase = e * 6;
          const aBase = edgeMeta[vBase]! * 3;
          const bBase = edgeMeta[vBase + 1]! * 3;
          edgePos[vBase] = pos[aBase]!;
          edgePos[vBase + 1] = pos[aBase + 1]!;
          edgePos[vBase + 2] = pos[aBase + 2]!;
          edgePos[vBase + 3] = pos[bBase]!;
          edgePos[vBase + 4] = pos[bBase + 1]!;
          edgePos[vBase + 5] = pos[bBase + 2]!;
        }
        const { gl } = webglResources;
        gl.bindBuffer(gl.ARRAY_BUFFER, webglResources.nodePosBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, pos);
        gl.bindBuffer(gl.ARRAY_BUFFER, webglResources.edgePosBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, edgePos);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        return;
      }

      gpuBuffers = buildMemory3DWebGLBuffers({
        nodes,
        edges,
        positions,
        coordinates,
        packedCoordinates
      });
      const focus = hover ?? current.current.selectedNodeId;
      updateMemory3DFocusAttributes(gpuBuffers, focus);
      uploadAllGpuBuffers(webglResources, gpuBuffers);
    };

    let cachedFallbackSubset: {
      nodesRef: MemoryGraphNode[];
      edgesRef: MemoryGraphEdge[];
      selectedId: string | null;
      result: { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] };
    } | null = null;

    const getFallbackSubset = () => {
      const { nodes, edges, selectedNodeId } = current.current;
      if (
        cachedFallbackSubset &&
        cachedFallbackSubset.nodesRef === nodes &&
        cachedFallbackSubset.edgesRef === edges &&
        cachedFallbackSubset.selectedId === selectedNodeId
      ) {
        return cachedFallbackSubset.result;
      }
      const result = selectMemory3DFallbackNodes(nodes, edges, selectedNodeId, MAX_MEMORY_3D_FALLBACK_NODES);
      cachedFallbackSubset = { nodesRef: nodes, edgesRef: edges, selectedId: selectedNodeId, result };
      return result;
    };

    const ensureSpatialIndex = (activeNodes: MemoryGraphNode[], scaleOverride?: number): Memory3DSpatialIndex => {
      if (!spatialDirty && spatialIndex && spatialIndex.nodes === activeNodes && spatialIndex.width === width && spatialIndex.height === height) {
        return spatialIndex;
      }
      const { nodes: fullNodes, coordinates, packedCoordinates, selectedNodeId } = current.current;
      const focus = hover ?? selectedNodeId;
      let activePacked: Float32Array | null = null;
      if (activeNodes === fullNodes) {
        activePacked = packedCoordinates;
      } else if (packedCoordinates && activeNodes.length > 0) {
        const fullIndexMap = new Map<string, number>();
        for (let i = 0; i < fullNodes.length; i++) fullIndexMap.set(fullNodes[i]!.id, i);
        const subsetCoords = new Float32Array(activeNodes.length * 3);
        for (let i = 0; i < activeNodes.length; i++) {
          const origIdx = fullIndexMap.get(activeNodes[i]!.id);
          if (origIdx !== undefined) {
            subsetCoords[i * 3] = packedCoordinates[origIdx * 3]!;
            subsetCoords[i * 3 + 1] = packedCoordinates[origIdx * 3 + 1]!;
            subsetCoords[i * 3 + 2] = packedCoordinates[origIdx * 3 + 2]!;
          }
        }
        activePacked = subsetCoords;
      }

      spatialIndex = buildMemory3DSpatialIndex({
        nodes: activeNodes,
        coordinates,
        packedCoordinates: activePacked,
        camera: cameraRef.current,
        scale: scaleOverride,
        width,
        height,
        focusId: focus,
        buffers: spatialBuffers
      });
      spatialDirty = false;
      return spatialIndex;
    };

    const renderLabelsOverlay = (
      ctx: CanvasRenderingContext2D,
      spatial: Memory3DSpatialIndex,
      focus: string | null,
      showTitles: boolean,
      clearFirst: boolean
    ): number => {
      if (clearFirst) {
        ctx.clearRect(0, 0, width, height);
      }
      if (!showTitles) return 0;
      ctx.font = "11px system-ui, sans-serif";
      const labels = selectMemory3DLabels({
        spatial,
        showTitles,
        camera: cameraRef.current,
        focusId: focus,
        maxLabels: MAX_MEMORY_3D_LABELS,
        measureTextWidth: text => measureLabelWidth(ctx, text)
      });
      for (let i = 0; i < labels.length; i++) {
        const item = labels[i]!;
        ctx.fillStyle = "#09111bea";
        ctx.fillRect(item.x - 3, item.y - 11, item.width + 6, 16);
        ctx.fillStyle = item.isCore ? "#fff0b0" : "#c6dfed";
        ctx.fillText(item.text, item.x, item.y + 1);
      }
      return labels.length;
    };

    const renderFallback2D = () => {
      const { positions, showTitles, selectedNodeId } = current.current;
      const capped = getFallbackSubset();
      const activeNodes = capped.nodes;
      const activeEdges = capped.edges;
      canvas.dataset.renderer = "canvas2d";
      canvas.dataset.fallbackNodeCap = String(MAX_MEMORY_3D_FALLBACK_NODES);
      canvas.dataset.renderedNodeCount = String(activeNodes.length);
      canvas.dataset.renderedEdgeCount = String(activeEdges.length);
      canvas.dataset.rotation = `${cameraRef.current.yaw.toFixed(3)},${cameraRef.current.pitch.toFixed(3)}`;
      const ctx = fallback2DContext ?? overlayContext;
      if (!ctx) return;
      if (fallback2DContext && overlayContext) {
        overlayContext.clearRect(0, 0, width, height);
      }
      ctx.clearRect(0, 0, width, height);

      const spatial = ensureSpatialIndex(activeNodes);
      const focus = hover ?? selectedNodeId;
      const neighbors = new Set<string>();
      if (focus) {
        for (let i = 0; i < activeEdges.length; i++) {
          const edge = activeEdges[i]!;
          if (edge.source === focus) neighbors.add(edge.target);
          if (edge.target === focus) neighbors.add(edge.source);
        }
      }

      const nodeIdxMap = new Map<string, number>();
      for (let i = 0; i < activeNodes.length; i++) nodeIdxMap.set(activeNodes[i]!.id, i);

      ctx.lineWidth = 0.55;
      for (let i = 0; i < activeEdges.length; i++) {
        const edge = activeEdges[i]!;
        const aIdx = nodeIdxMap.get(edge.source);
        const bIdx = nodeIdxMap.get(edge.target);
        if (aIdx === undefined || bIdx === undefined || spatial.visible[aIdx] === 0 || spatial.visible[bIdx] === 0) continue;
        const incident = edge.source === focus || edge.target === focus;
        ctx.strokeStyle = incident ? "#98dafa" : focus ? "#14202b" : edge.type === "DERIVED_FROM" ? "#385068" : "#203343";
        ctx.lineWidth = incident ? 1.15 : 0.55;
        ctx.beginPath();
        ctx.moveTo(spatial.screenX[aIdx]!, spatial.screenY[aIdx]!);
        ctx.lineTo(spatial.screenX[bIdx]!, spatial.screenY[bIdx]!);
        ctx.stroke();
      }

      const drawOrder: number[] = [];
      for (let i = 0; i < activeNodes.length; i++) {
        if (spatial.visible[i] === 1) drawOrder.push(i);
      }
      drawOrder.sort((a, b) => spatial.depthZ[b]! - spatial.depthZ[a]!);

      for (let k = 0; k < drawOrder.length; k++) {
        const i = drawOrder[k]!;
        const node = activeNodes[i]!;
        const sx = spatial.screenX[i]!;
        const sy = spatial.screenY[i]!;
        const persp = spatial.perspective[i]!;
        const radius = spatial.radii[i]!;
        const highlighted = node.id === focus;
        const root = spatial.isCoreSource[i] === 1;
        ctx.globalAlpha = focus && !highlighted && !neighbors.has(node.id) ? 0.2 : Math.max(0.4, Math.min(1, persp));
        ctx.fillStyle = highlighted ? "#ffffff" : positions.get(node.id)?.color ?? "#7395ad";
        if (root || highlighted) {
          ctx.shadowColor = ctx.fillStyle;
          ctx.shadowBlur = 13;
        }
        ctx.beginPath();
        ctx.arc(sx, sy, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }
      ctx.globalAlpha = 1;

      const labelCount = renderLabelsOverlay(ctx, spatial, focus, showTitles, false);
      canvas.dataset.renderer = "canvas2d";
      canvas.dataset.fallbackNodeCap = String(MAX_MEMORY_3D_FALLBACK_NODES);
      canvas.dataset.renderedNodeCount = String(activeNodes.length);
      canvas.dataset.renderedEdgeCount = String(activeEdges.length);
      canvas.dataset.renderedLabelCount = String(labelCount);
      canvas.dataset.rotation = `${cameraRef.current.yaw.toFixed(3)},${cameraRef.current.pitch.toFixed(3)}`;
    };

    const renderWebGL2 = (resources: WebGLSceneResources) => {
      const { gl } = resources;
      const { nodes, coordinates, packedCoordinates, showTitles, selectedNodeId } = current.current;
      if (!gpuBuffers || gpuBuffers.nodeCount !== nodes.length) {
        syncSceneBuffers(true);
      }
      if (!gpuBuffers) return;

      const focus = hover ?? selectedNodeId;
      if (updateMemory3DFocusAttributes(gpuBuffers, focus)) {
        gl.bindBuffer(gl.ARRAY_BUFFER, resources.nodeFocusBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, gpuBuffers.instanceFocusState);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
      }

      const extent = computeMemory3DExtent(coordinates, packedCoordinates);
      const scale = (Math.min(width, height) * 0.4) / extent;

      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clearDepth(1.0);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      if (gpuBuffers.edgeVertexCount > 0) {
        gl.useProgram(resources.edgeProgram);
        gl.uniform2f(resources.edgeUniforms.uViewport, width, height);
        gl.uniform1f(resources.edgeUniforms.uScale, scale);
        gl.uniform1f(resources.edgeUniforms.uYaw, cameraRef.current.yaw);
        gl.uniform1f(resources.edgeUniforms.uPitch, cameraRef.current.pitch);
        gl.uniform1f(resources.edgeUniforms.uZoom, cameraRef.current.zoom);
        gl.uniform1f(resources.edgeUniforms.uFocusIndex, gpuBuffers.focusedIndex);
        gl.bindVertexArray(resources.edgeVao);
        gl.drawArrays(gl.LINES, 0, gpuBuffers.edgeVertexCount);
      }

      if (gpuBuffers.nodeCount > 0) {
        gl.useProgram(resources.nodeProgram);
        gl.uniform2f(resources.nodeUniforms.uViewport, width, height);
        gl.uniform1f(resources.nodeUniforms.uScale, scale);
        gl.uniform1f(resources.nodeUniforms.uYaw, cameraRef.current.yaw);
        gl.uniform1f(resources.nodeUniforms.uPitch, cameraRef.current.pitch);
        gl.uniform1f(resources.nodeUniforms.uZoom, cameraRef.current.zoom);
        gl.uniform1f(resources.nodeUniforms.uHasFocus, gpuBuffers.focusedIndex >= 0 ? 1 : 0);
        gl.bindVertexArray(resources.nodeVao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, gpuBuffers.nodeCount);
      }

      gl.bindVertexArray(null);

      let labelCount = 0;
      if (overlayContext) {
        if (showTitles) {
          const spatial = ensureSpatialIndex(nodes, scale);
          labelCount = renderLabelsOverlay(overlayContext, spatial, focus, true, true);
        } else {
          overlayContext.clearRect(0, 0, width, height);
        }
      }

      canvas.dataset.renderer = "webgl2";
      canvas.dataset.renderedNodeCount = String(gpuBuffers.nodeCount);
      canvas.dataset.renderedEdgeCount = String(gpuBuffers.edgeVertexCount / 2);
      canvas.dataset.renderedLabelCount = String(labelCount);
      canvas.dataset.rotation = `${cameraRef.current.yaw.toFixed(3)},${cameraRef.current.pitch.toFixed(3)}`;
    };

    const frameTimes: number[] = [];
    const render = () => {
      frame = 0;
      const t0 = performance.now();
      if (webglResources && !contextLost) {
        renderWebGL2(webglResources);
      } else {
        renderFallback2D();
      }
      const dur = performance.now() - t0;
      if (frameTimes.length >= 120) frameTimes.shift();
      frameTimes.push(dur);
      if (typeof window !== "undefined") {
        const sorted = [...frameTimes].sort((a, b) => a - b);
        const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
        const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
        (window as unknown as { __SPACE_MEMORY_3D_METRICS__?: unknown }).__SPACE_MEMORY_3D_METRICS__ = {
          renderer: webglResources && !contextLost ? "webgl2" : "canvas2d",
          nodeCount: current.current.nodes.length,
          edgeCount: current.current.edges.length,
          lastFrameMs: Math.round(dur * 100) / 100,
          p50Ms: Math.round(p50 * 100) / 100,
          p95Ms: Math.round(p95 * 100) / 100,
          sampleCount: frameTimes.length
        };
      }
    };

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(render);
    };
    redrawRef.current = () => {
      spatialDirty = true;
      schedule();
    };
    syncSceneRef.current = (topologyChanged: boolean) => {
      syncSceneBuffers(topologyChanged);
      schedule();
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, rect.width || canvas.clientWidth || 800);
      height = Math.max(1, rect.height || canvas.clientHeight || 600);
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const pixelW = Math.max(1, Math.round(width * dpr));
      const pixelH = Math.max(1, Math.round(height * dpr));
      canvas.width = pixelW;
      canvas.height = pixelH;
      overlayCanvas.width = pixelW;
      overlayCanvas.height = pixelH;
      if (fallback2DContext) fallback2DContext.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (overlayContext) overlayContext.setTransform(dpr, 0, 0, dpr, 0, 0);
      spatialDirty = true;
      schedule();
    };

    const hit = (x: number, y: number): string | null => {
      const { nodes } = current.current;
      const activeNodes =
        webglResources && !contextLost
          ? nodes
          : getFallbackSubset().nodes;
      const spatial = ensureSpatialIndex(activeNodes);
      return pickMemory3DNode(spatial, x, y);
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
          if (before > 1) cameraRef.current.zoom = Math.max(0.35, Math.min(5, (cameraRef.current.zoom * after) / before));
        } else {
          cameraRef.current.yaw += (p.x - previous.x) * 0.009;
          cameraRef.current.pitch += (p.y - previous.y) * 0.009;
        }
        pointers.set(event.pointerId, p);
        spatialDirty = true;
        schedule();
      } else {
        const nextHover = hit(p.x, p.y);
        if (nextHover !== hover) {
          hover = nextHover;
          canvas.style.cursor = hover ? "pointer" : "grab";
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
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };

    const cancel = (event: PointerEvent) => {
      pointers.delete(event.pointerId);
      dragged = true;
    };

    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      cameraRef.current.zoom = Math.max(0.35, Math.min(5, cameraRef.current.zoom * Math.exp(-event.deltaY * 0.001)));
      spatialDirty = true;
      schedule();
    };

    const key = (event: KeyboardEvent) => {
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        cameraRef.current.yaw += event.key === "ArrowLeft" ? -0.15 : event.key === "ArrowRight" ? 0.15 : 0;
        cameraRef.current.pitch += event.key === "ArrowUp" ? -0.15 : event.key === "ArrowDown" ? 0.15 : 0;
        canvas.dataset.rotation = `${cameraRef.current.yaw.toFixed(3)},${cameraRef.current.pitch.toFixed(3)}`;
        spatialDirty = true;
        schedule();
      } else if (event.key === "Enter") {
        const node =
          current.current.nodes.find(n => n.id === current.current.selectedNodeId) ??
          current.current.nodes.find(n => isMemoryCoreLabel(n.label));
        if (node) current.current.onSelectNode(node.id);
      }
    };

    const onContextLost = (event: Event) => {
      event.preventDefault();
      contextLost = true;
      webglResources = null;
      gpuBuffers = null;
      spatialDirty = true;
      renderFallback2D();
      schedule();
    };

    const onContextRestored = () => {
      if (!glContext || (typeof glContext.isContextLost === "function" && glContext.isContextLost())) {
        try {
          glContext = canvas.getContext("webgl2", {
            antialias: true,
            alpha: true,
            depth: true,
            powerPreference: "high-performance",
            preserveDrawingBuffer: false
          });
        } catch {
          glContext = null;
        }
      }
      if (!glContext) return;
      contextLost = false;
      webglResources = initWebGLResources(glContext);
      syncSceneBuffers(true);
      render();
    };

    syncSceneBuffers(true);
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    render();

    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", cancel);
    canvas.addEventListener("wheel", wheel, { passive: false });
    canvas.addEventListener("keydown", key);
    canvas.addEventListener("webglcontextlost", onContextLost);
    canvas.addEventListener("webglcontextrestored", onContextRestored);

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      if (webglResources) {
        const { gl } = webglResources;
        gl.deleteBuffer(webglResources.edgePosBuffer);
        gl.deleteBuffer(webglResources.edgeMetaBuffer);
        gl.deleteBuffer(webglResources.quadCornerBuffer);
        gl.deleteBuffer(webglResources.nodePosBuffer);
        gl.deleteBuffer(webglResources.nodeStyleBuffer);
        gl.deleteBuffer(webglResources.nodeFocusBuffer);
        gl.deleteVertexArray(webglResources.edgeVao);
        gl.deleteVertexArray(webglResources.nodeVao);
        gl.deleteProgram(webglResources.edgeProgram);
        gl.deleteProgram(webglResources.nodeProgram);
      }
      redrawRef.current = () => {};
      syncSceneRef.current = () => {};
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", cancel);
      canvas.removeEventListener("wheel", wheel);
      canvas.removeEventListener("keydown", key);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      if (typeof window !== "undefined") {
        delete (window as unknown as { __SPACE_MEMORY_3D_METRICS__?: unknown }).__SPACE_MEMORY_3D_METRICS__;
      }
    };
  }, []);

  useEffect(() => {
    syncSceneRef.current(true);
  }, [nodes, edges, positions]);

  useEffect(() => {
    syncSceneRef.current(false);
  }, [coordinates, packedCoordinates]);

  useEffect(() => {
    redrawRef.current();
  }, [showTitles, selectedNodeId]);

  return (
    <div className="memory-3d-surface" style={{ position: "relative" }}>
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
        className="memory-3d-label-overlay"
        aria-hidden="true"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
      />
      <span className="memory-3d-hint">Drag to rotate 360° · Scroll or pinch to zoom · Click to explore</span>
    </div>
  );
}
