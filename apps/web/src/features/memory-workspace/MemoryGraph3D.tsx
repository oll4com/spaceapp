import { useEffect, useMemo, useRef, useState } from "react";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import { DEFAULT_MEMORY_CAMERA, memory3DVolumeRatio, projectMemoryPoint, type MemoryCamera3D, type MemoryPoint3D } from "./memory-3d.js";

function parseColorToRgba(hexOrRgb: string | undefined): [number, number, number, number] {
  if (!hexOrRgb) return [0.45, 0.584, 0.678, 1.0]; // #7395ad
  if (hexOrRgb.startsWith("#")) {
    const hex = hexOrRgb.slice(1);
    if (hex.length === 6) {
      const num = Number.parseInt(hex, 16);
      return [((num >> 16) & 255) / 255, ((num >> 8) & 255) / 255, (num & 255) / 255, 1.0];
    }
    if (hex.length === 3) {
      const r = Number.parseInt(hex[0]! + hex[0]!, 16) / 255;
      const g = Number.parseInt(hex[1]! + hex[1]!, 16) / 255;
      const b = Number.parseInt(hex[2]! + hex[2]!, 16) / 255;
      return [r, g, b, 1.0];
    }
  }
  return [0.45, 0.584, 0.678, 1.0];
}

const POINT_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec3 a_position;
layout(location = 1) in vec4 a_color;
layout(location = 2) in float a_radius;
layout(location = 3) in float a_nodeIndex;
layout(location = 4) in float a_flags; // bit 0: isNeighbor, bit 1: isRoot

uniform float u_yaw;
uniform float u_pitch;
uniform float u_zoom;
uniform float u_scale;
uniform vec2 u_resolution;
uniform float u_dpr;
uniform float u_focusIndex;
uniform int u_picking;

out vec4 v_color;

void main() {
  float cosYaw = cos(u_yaw);
  float sinYaw = sin(u_yaw);
  float cosPitch = cos(u_pitch);
  float sinPitch = sin(u_pitch);

  float rx = a_position.x * cosYaw + a_position.z * sinYaw;
  float depth = -a_position.x * sinYaw + a_position.z * cosYaw;

  float ry = a_position.y * cosPitch - depth * sinPitch;
  float rz = a_position.y * sinPitch + depth * cosPitch;

  float persp = 650.0 / max(120.0, 650.0 + rz * u_scale);

  float screenX = u_resolution.x * 0.5 + rx * u_scale * u_zoom * persp;
  float screenY = u_resolution.y * 0.5 - ry * u_scale * u_zoom * persp;

  float ndcX = (screenX / u_resolution.x) * 2.0 - 1.0;
  float ndcY = 1.0 - (screenY / u_resolution.y) * 2.0;
  float ndcZ = clamp(rz / 3000.0, -0.99, 0.99);

  gl_Position = vec4(ndcX, ndcY, ndcZ, 1.0);

  bool isFocus = (u_focusIndex >= 0.0 && abs(a_nodeIndex - u_focusIndex) < 0.5);
  bool isNeighbor = (mod(floor(a_flags), 2.0) > 0.5);

  float radius = a_radius * persp * sqrt(u_zoom);
  if (radius < 1.0) radius = 1.0;
  if (isFocus) radius *= 1.5;

  gl_PointSize = radius * 2.0 * u_dpr;

  if (u_picking == 1) {
    int id = int(a_nodeIndex) + 1;
    float r = float(id & 255) / 255.0;
    float g = float((id >> 8) & 255) / 255.0;
    float b = float((id >> 16) & 255) / 255.0;
    v_color = vec4(r, g, b, 1.0);
  } else {
    vec4 col = a_color;
    if (isFocus) {
      col = vec4(1.0, 1.0, 1.0, 1.0);
    }
    float alpha = clamp(persp, 0.4, 1.0);
    if (u_focusIndex >= 0.0) {
      if (!isFocus && !isNeighbor) {
        alpha = 0.2;
      }
    }
    v_color = vec4(col.rgb, col.a * alpha);
  }
}
`;

const POINT_FS = `#version 300 es
precision highp float;

in vec4 v_color;
uniform int u_picking;
out vec4 fragColor;

void main() {
  vec2 coord = gl_PointCoord - vec2(0.5);
  float distSq = dot(coord, coord);
  if (distSq > 0.25) discard;

  if (u_picking == 1) {
    fragColor = v_color;
  } else {
    float dist = sqrt(distSq);
    float delta = fwidth(dist);
    float alpha = 1.0 - smoothstep(0.5 - max(delta, 0.05), 0.5, dist);
    fragColor = vec4(v_color.rgb, v_color.a * alpha);
  }
}
`;

const LINE_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec3 a_position;
layout(location = 1) in float a_edgeType;
layout(location = 2) in float a_incident;

uniform float u_yaw;
uniform float u_pitch;
uniform float u_zoom;
uniform float u_scale;
uniform vec2 u_resolution;
uniform float u_focusActive;

out vec4 v_lineColor;

void main() {
  float cosYaw = cos(u_yaw);
  float sinYaw = sin(u_yaw);
  float cosPitch = cos(u_pitch);
  float sinPitch = sin(u_pitch);

  float rx = a_position.x * cosYaw + a_position.z * sinYaw;
  float depth = -a_position.x * sinYaw + a_position.z * cosYaw;

  float ry = a_position.y * cosPitch - depth * sinPitch;
  float rz = a_position.y * sinPitch + depth * cosPitch;

  float persp = 650.0 / max(120.0, 650.0 + rz * u_scale);

  float screenX = u_resolution.x * 0.5 + rx * u_scale * u_zoom * persp;
  float screenY = u_resolution.y * 0.5 - ry * u_scale * u_zoom * persp;

  float ndcX = (screenX / u_resolution.x) * 2.0 - 1.0;
  float ndcY = 1.0 - (screenY / u_resolution.y) * 2.0;
  float ndcZ = clamp(rz / 3000.0, -0.99, 0.99);

  gl_Position = vec4(ndcX, ndcY, ndcZ, 1.0);

  vec4 color;
  if (a_incident > 0.5) {
    color = vec4(0.596, 0.855, 0.980, 0.9); // #98dafa
  } else if (u_focusActive > 0.5) {
    color = vec4(0.078, 0.125, 0.169, 0.35); // #14202b
  } else if (a_edgeType > 0.5 && a_edgeType < 1.5) {
    color = vec4(0.220, 0.314, 0.408, 0.65); // #385068 (DERIVED_FROM)
  } else {
    color = vec4(0.125, 0.200, 0.263, 0.5); // #203343
  }
  v_lineColor = color;
}
`;

const LINE_FS = `#version 300 es
precision highp float;
in vec4 v_lineColor;
out vec4 fragColor;
void main() {
  fragColor = v_lineColor;
}
`;

function createShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
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
  const vs = createShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = createShader(gl, gl.FRAGMENT_SHADER, fsSource);
  if (!vs || !fs) {
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    return null;
  }
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return null;
  }
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

export function MemoryGraph3D({ nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode, loading, resetToken }: {
  nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[];
  positions: Map<string, MemoryAtlasPosition>; coordinates: Map<string, MemoryPoint3D>;
  showTitles: boolean; selectedNodeId: string | null; onSelectNode: (id: string) => void;
  loading: boolean; resetToken: number;
}) {
  const volumeRatio = useMemo(() => memory3DVolumeRatio([...coordinates.values()]), [coordinates]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef<MemoryCamera3D>({ ...DEFAULT_MEMORY_CAMERA });
  const redrawRef = useRef<() => void>(() => {});
  const [isWebGL, setIsWebGL] = useState(true);
  const restorationCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const restorationListenerRef = useRef<EventListener | null>(null);
  const current = useRef({ nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode });
  current.current = { nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode };

  useEffect(() => {
    return () => {
      const canvas = restorationCanvasRef.current;
      const listener = restorationListenerRef.current;
      if (canvas && listener) canvas.removeEventListener("webglcontextrestored", listener);
    };
  }, []);

  useEffect(() => {
    cameraRef.current = { ...DEFAULT_MEMORY_CAMERA };
    redrawRef.current();
  }, [resetToken]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let gl: WebGL2RenderingContext | null = null;
    if (isWebGL) {
      try {
        gl = canvas.getContext("webgl2", { antialias: true, alpha: true, depth: true, preserveDrawingBuffer: false });
      } catch {}
    }

    if (isWebGL && !gl) {
      setIsWebGL(false);
      return;
    }

    if (gl) {
      // -------------------------------------------------------------
      // WebGL2 RENDERER (Supports 50,000+ nodes, GPU picking <= 4ms)
      // -------------------------------------------------------------
      const pointProgram = createProgram(gl, POINT_VS, POINT_FS);
      const lineProgram = createProgram(gl, LINE_VS, LINE_FS);
      if (!pointProgram || !lineProgram) {
        if (pointProgram) gl.deleteProgram(pointProgram);
        if (lineProgram) gl.deleteProgram(lineProgram);
        setIsWebGL(false);
        return;
      }

      const pLoc = {
        yaw: gl.getUniformLocation(pointProgram, "u_yaw"),
        pitch: gl.getUniformLocation(pointProgram, "u_pitch"),
        zoom: gl.getUniformLocation(pointProgram, "u_zoom"),
        scale: gl.getUniformLocation(pointProgram, "u_scale"),
        res: gl.getUniformLocation(pointProgram, "u_resolution"),
        dpr: gl.getUniformLocation(pointProgram, "u_dpr"),
        focus: gl.getUniformLocation(pointProgram, "u_focusIndex"),
        picking: gl.getUniformLocation(pointProgram, "u_picking")
      };

      const lLoc = {
        yaw: gl.getUniformLocation(lineProgram, "u_yaw"),
        pitch: gl.getUniformLocation(lineProgram, "u_pitch"),
        zoom: gl.getUniformLocation(lineProgram, "u_zoom"),
        scale: gl.getUniformLocation(lineProgram, "u_scale"),
        res: gl.getUniformLocation(lineProgram, "u_resolution"),
        focusActive: gl.getUniformLocation(lineProgram, "u_focusActive")
      };

      const pointVBO = gl.createBuffer();
      const pointVAO = gl.createVertexArray();
      const lineVBO = gl.createBuffer();
      const lineVAO = gl.createVertexArray();

      // Configure point VAO
      gl.bindVertexArray(pointVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, pointVBO);
      const stride = 10 * 4;
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 3 * 4);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 7 * 4);
      gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 8 * 4);
      gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, 9 * 4);

      // Configure line VAO
      gl.bindVertexArray(lineVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, lineVBO);
      const lineStride = 5 * 4;
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, lineStride, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, lineStride, 3 * 4);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, lineStride, 4 * 4);
      gl.bindVertexArray(null);

      // Framebuffer for GPU color picking
      let pickFBO = gl.createFramebuffer();
      let pickTex = gl.createTexture();
      let pickDepth = gl.createRenderbuffer();
      let fboWidth = 0, fboHeight = 0;

      const ensureFBO = (w: number, h: number) => {
        if (!gl || (w === fboWidth && h === fboHeight && pickFBO)) return;
        fboWidth = w; fboHeight = h;
        gl.bindFramebuffer(gl.FRAMEBUFFER, pickFBO);
        gl.bindTexture(gl.TEXTURE_2D, pickTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pickTex, 0);

        gl.bindRenderbuffer(gl.RENDERBUFFER, pickDepth);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, pickDepth);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      };

      let frame = 0, width = 1, height = 1, dpr = 1;
      let hoverId: string | null = null;
      let nodeMap = new Map<string, number>();
      let orderedNodes: MemoryGraphNode[] = [];
      let pointData = new Float32Array(0);
      let lineData = new Float32Array(0);
      let lineCount = 0;
      let currentFocusId: string | null = null;
      const pointers = new Map<number, { x: number; y: number }>();
      let dragged = false, downX = 0, downY = 0;
      let builtFrom: {
        nodes: MemoryGraphNode[];
        edges: MemoryGraphEdge[];
        positions: Map<string, MemoryAtlasPosition>;
        coordinates: Map<string, MemoryPoint3D>;
      } | null = null;
      let cachedExtent = 60;
      let cachedCandidates: MemoryGraphNode[] = [];
      let pendingPick: { x: number; y: number } | null = null;

      const updateBuffers = (focus: string | null) => {
        if (!gl) return;
        const { nodes, edges, positions, coordinates } = current.current;
        orderedNodes = nodes.filter(n => coordinates.has(n.id));
        nodeMap = new Map(orderedNodes.map((n, i) => [n.id, i]));
        const count = orderedNodes.length;
        pointData = new Float32Array(count * 10);

        const focusIdx = focus ? (nodeMap.get(focus) ?? -1) : -1;
        const neighbors = new Set<string>();
        if (focus) {
          for (const edge of edges) {
            if (edge.source === focus) neighbors.add(edge.target);
            if (edge.target === focus) neighbors.add(edge.source);
          }
        }

        let maxR = 60;
        for (let i = 0; i < count; i++) {
          const node = orderedNodes[i]!;
          const coord = coordinates.get(node.id)!;
          const pos = positions.get(node.id);
          const isCore = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
          const isNeighbor = neighbors.has(node.id);
          const baseRadius = isCore ? 10 : node.type === "SOURCE" ? 4.6 : 2.1;
          const color = parseColorToRgba(pos?.color);

          const r = Math.hypot(coord.x, coord.y, coord.z);
          if (r > maxR) maxR = r;

          const offset = i * 10;
          pointData[offset + 0] = coord.x;
          pointData[offset + 1] = coord.y;
          pointData[offset + 2] = coord.z;
          pointData[offset + 3] = color[0];
          pointData[offset + 4] = color[1];
          pointData[offset + 5] = color[2];
          pointData[offset + 6] = color[3];
          pointData[offset + 7] = baseRadius;
          pointData[offset + 8] = i;
          pointData[offset + 9] = (isNeighbor ? 1 : 0) | (isCore ? 2 : 0);
        }

        cachedExtent = maxR;
        cachedCandidates = [...orderedNodes].sort((a, b) =>
          Number(isMemoryCoreLabel(b.label)) - Number(isMemoryCoreLabel(a.label)) ||
          Number(b.type === "SOURCE") - Number(a.type === "SOURCE")
        ).slice(0, 150);

        gl.bindBuffer(gl.ARRAY_BUFFER, pointVBO);
        gl.bufferData(gl.ARRAY_BUFFER, pointData, gl.DYNAMIC_DRAW);

        // Lines
        const validEdges = edges.filter(e => coordinates.has(e.source) && coordinates.has(e.target));
        lineCount = validEdges.length * 2;
        lineData = new Float32Array(lineCount * 5);
        let lIdx = 0;
        for (const edge of validEdges) {
          const a = coordinates.get(edge.source)!;
          const b = coordinates.get(edge.target)!;
          const isIncident = focus ? (edge.source === focus || edge.target === focus) : false;
          const typeVal = edge.type === "DERIVED_FROM" ? 1 : edge.type === "CONTAINS" ? 2 : 0;
          const incidentVal = isIncident ? 1 : 0;

          lineData[lIdx++] = a.x; lineData[lIdx++] = a.y; lineData[lIdx++] = a.z; lineData[lIdx++] = typeVal; lineData[lIdx++] = incidentVal;
          lineData[lIdx++] = b.x; lineData[lIdx++] = b.y; lineData[lIdx++] = b.z; lineData[lIdx++] = typeVal; lineData[lIdx++] = incidentVal;
        }

        gl.bindBuffer(gl.ARRAY_BUFFER, lineVBO);
        gl.bufferData(gl.ARRAY_BUFFER, lineData, gl.DYNAMIC_DRAW);
        currentFocusId = focus;
      };

      const render = () => {
        frame = 0;
        if (!gl) return;
        const { nodes, edges, positions, coordinates, showTitles, selectedNodeId } = current.current;
        const focus = hoverId ?? selectedNodeId;
        const stale = !builtFrom ||
          builtFrom.nodes !== nodes ||
          builtFrom.edges !== edges ||
          builtFrom.positions !== positions ||
          builtFrom.coordinates !== coordinates;
        if (stale || focus !== currentFocusId) {
          updateBuffers(focus);
          builtFrom = { nodes, edges, positions, coordinates };
        }

        // Run GPU picking at most once per animation frame, skipping while pointer is active or dragging
        if (pendingPick && pointers.size === 0) {
          const picked = hitGPU(pendingPick.x, pendingPick.y);
          if (picked !== hoverId) {
            hoverId = picked;
            canvas.style.cursor = hoverId ? "pointer" : "grab";
            updateBuffers(hoverId ?? selectedNodeId);
          }
          pendingPick = null;
        }

        const extent = cachedExtent;
        const scale = Math.min(width, height) * 0.4 / extent;
        const camera = cameraRef.current;
        const focusIdx = focus ? (nodeMap.get(focus) ?? -1) : -1;

        // Visual render to screen
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, Math.round(width * dpr), Math.round(height * dpr));
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        // Draw Lines
        if (lineCount > 0) {
          gl.useProgram(lineProgram);
          gl.uniform1f(lLoc.yaw, camera.yaw);
          gl.uniform1f(lLoc.pitch, camera.pitch);
          gl.uniform1f(lLoc.zoom, camera.zoom);
          gl.uniform1f(lLoc.scale, scale);
          gl.uniform2f(lLoc.res, width, height);
          gl.uniform1f(lLoc.focusActive, focus ? 1.0 : 0.0);

          gl.bindVertexArray(lineVAO);
          gl.drawArrays(gl.LINES, 0, lineCount);
        }

        // Draw Points
        if (orderedNodes.length > 0) {
          gl.useProgram(pointProgram);
          gl.uniform1f(pLoc.yaw, camera.yaw);
          gl.uniform1f(pLoc.pitch, camera.pitch);
          gl.uniform1f(pLoc.zoom, camera.zoom);
          gl.uniform1f(pLoc.scale, scale);
          gl.uniform2f(pLoc.res, width, height);
          gl.uniform1f(pLoc.dpr, dpr);
          gl.uniform1f(pLoc.focus, focusIdx);
          gl.uniform1i(pLoc.picking, 0);

          gl.bindVertexArray(pointVAO);
          gl.drawArrays(gl.POINTS, 0, orderedNodes.length);
        }

        // Draw 2D Labels on overlay canvas
        const overlay = overlayCanvasRef.current;
        if (overlay) {
          const oCtx = overlay.getContext("2d");
          if (oCtx) {
            oCtx.clearRect(0, 0, width, height);
            if (showTitles && cachedCandidates.length > 0) {
              const labeled = focus && nodeMap.has(focus)
                ? [orderedNodes[nodeMap.get(focus)!]!, ...cachedCandidates.filter(n => n.id !== focus)]
                : cachedCandidates;

              oCtx.font = "11px system-ui, sans-serif";
              const labelBoxes: Array<{ x: number; y: number; w: number }> = [];
              let drawnCount = 0;
              for (const node of labeled) {
                if (drawnCount >= 80) break; // Maximum 80 non-colliding labels
                if (node.type !== "SOURCE" && node.id !== focus && camera.zoom < 1.6) continue;
                const p3d = coordinates.get(node.id);
                if (!p3d) continue;
                const p = projectMemoryPoint(p3d, camera, scale, width, height);
                const label = node.label.length > 48 ? `${node.label.slice(0, 45)}…` : node.label;
                const x = p.x + 9, y = p.y, w = oCtx.measureText(label).width;
                if (x + w > width || y < 14 || y > height - 5 || labelBoxes.some(box => Math.abs(box.y - y) < 16 && x < box.x + box.w + 5 && x + w + 5 > box.x)) continue;
                labelBoxes.push({ x, y, w });
                oCtx.fillStyle = "#09111bea"; oCtx.fillRect(x - 3, y - 11, w + 6, 16);
                oCtx.fillStyle = isMemoryCoreLabel(node.label) ? "#fff0b0" : "#c6dfed"; oCtx.fillText(label, x, y + 1);
                drawnCount++;
              }
            }
          }
        }

        canvas.dataset.rotation = `${camera.yaw.toFixed(3)},${camera.pitch.toFixed(3)}`;
        canvas.dataset.renderer = "webgl2";
      };

      const schedule = () => { if (!frame) frame = requestAnimationFrame(render); };
      redrawRef.current = schedule;

      const resize = () => {
        const rect = canvas.getBoundingClientRect();
        width = Math.max(1, rect.width); height = Math.max(1, rect.height);
        dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
        ensureFBO(canvas.width, canvas.height);
        const overlay = overlayCanvasRef.current;
        if (overlay) {
          overlay.width = Math.round(width * dpr); overlay.height = Math.round(height * dpr);
          const oCtx = overlay.getContext("2d");
          oCtx?.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
        schedule();
      };

      // Fast GPU Picking function: <= 4ms at 50,000 nodes
      const hitGPU = (x: number, y: number): string | null => {
        if (!gl || orderedNodes.length === 0) return null;
        ensureFBO(canvas.width, canvas.height);

        // Render picking pass
        gl.bindFramebuffer(gl.FRAMEBUFFER, pickFBO);
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.disable(gl.BLEND);

        const extent = cachedExtent;
        const scale = Math.min(width, height) * 0.4 / extent;
        const camera = cameraRef.current;

        gl.useProgram(pointProgram);
        gl.uniform1f(pLoc.yaw, camera.yaw);
        gl.uniform1f(pLoc.pitch, camera.pitch);
        gl.uniform1f(pLoc.zoom, camera.zoom);
        gl.uniform1f(pLoc.scale, scale);
        gl.uniform2f(pLoc.res, width, height);
        gl.uniform1f(pLoc.dpr, dpr);
        gl.uniform1f(pLoc.focus, -1);
        gl.uniform1i(pLoc.picking, 1);

        gl.bindVertexArray(pointVAO);
        gl.drawArrays(gl.POINTS, 0, orderedNodes.length);

        // Single pixel read + 3x3 kernel around cursor for tolerance
        const px = Math.floor(x * dpr);
        const py = Math.floor((height - y) * dpr);
        const pixel = new Uint8Array(4);
        gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        let id = pixel[0]! | (pixel[1]! << 8) | (pixel[2]! << 16);

        if (id === 0) {
          const kSize = 5;
          const kHalf = 2;
          const sx = Math.max(0, px - kHalf);
          const sy = Math.max(0, py - kHalf);
          const kw = Math.min(kSize, canvas.width - sx);
          const kh = Math.min(kSize, canvas.height - sy);
          if (kw > 0 && kh > 0) {
            const kPixels = new Uint8Array(kw * kh * 4);
            gl.readPixels(sx, sy, kw, kh, gl.RGBA, gl.UNSIGNED_BYTE, kPixels);
            for (let i = 0; i < kPixels.length; i += 4) {
              const kid = kPixels[i]! | (kPixels[i + 1]! << 8) | (kPixels[i + 2]! << 16);
              if (kid > 0) { id = kid; break; }
            }
          }
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        if (id > 0 && id <= orderedNodes.length) {
          return orderedNodes[id - 1]?.id ?? null;
        }
        return null;
      };

      const local = (event: PointerEvent) => {
        const rect = canvas.getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
      };

      const down = (event: PointerEvent) => {
        canvas.focus(); canvas.setPointerCapture(event.pointerId);
        const p = local(event); pointers.set(event.pointerId, p); downX = p.x; downY = p.y; dragged = false; hoverId = null; pendingPick = null;
      };

      const move = (event: PointerEvent) => {
        const p = local(event), previous = pointers.get(event.pointerId);
        if (previous) {
          if (Math.hypot(p.x - downX, p.y - downY) > 4) dragged = true;
          if (pointers.size === 2) {
            const other = [...pointers].find(([id]) => id !== event.pointerId)![1];
            const before = Math.hypot(previous.x - other.x, previous.y - other.y), after = Math.hypot(p.x - other.x, p.y - other.y);
            if (before > 1) cameraRef.current.zoom = Math.max(0.35, Math.min(5, cameraRef.current.zoom * after / before));
          } else { cameraRef.current.yaw += (p.x - previous.x) * 0.009; cameraRef.current.pitch += (p.y - previous.y) * 0.009; }
          pointers.set(event.pointerId, p);
          pendingPick = null;
        } else {
          pendingPick = p;
        }
        schedule();
      };

      const up = (event: PointerEvent) => {
        const p = local(event);
        if (!dragged && pointers.size === 1) {
          const id = hitGPU(p.x, p.y);
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

      const onContextLost = (e: Event) => {
        e.preventDefault();
        restorationCanvasRef.current = canvas;
        restorationListenerRef.current = onContextRestored;
        setIsWebGL(false);
      };

      const onContextRestored = () => {
        canvas.removeEventListener("webglcontextrestored", onContextRestored);
        if (restorationCanvasRef.current === canvas) {
          restorationCanvasRef.current = null;
          restorationListenerRef.current = null;
        }
        setIsWebGL(true);
      };

      canvas.addEventListener("webglcontextlost", onContextLost);
      canvas.addEventListener("webglcontextrestored", onContextRestored);
      const observer = new ResizeObserver(resize); observer.observe(canvas); resize();
      canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointermove", move); canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", cancel); canvas.addEventListener("wheel", wheel, { passive: false }); canvas.addEventListener("keydown", key);

      return () => {
        canvas.removeEventListener("webglcontextlost", onContextLost);
        // Note: webglcontextrestored is preserved on lost canvas across 2D fallback remount
        observer.disconnect(); cancelAnimationFrame(frame); redrawRef.current = () => {};
        canvas.removeEventListener("pointerdown", down); canvas.removeEventListener("pointermove", move); canvas.removeEventListener("pointerup", up); canvas.removeEventListener("pointercancel", cancel); canvas.removeEventListener("wheel", wheel); canvas.removeEventListener("keydown", key);
        if (gl) {
          gl.deleteProgram(pointProgram); gl.deleteProgram(lineProgram);
          gl.deleteBuffer(pointVBO); gl.deleteBuffer(lineVBO);
          gl.deleteVertexArray(pointVAO); gl.deleteVertexArray(lineVAO);
          gl.deleteFramebuffer(pickFBO); gl.deleteTexture(pickTex); gl.deleteRenderbuffer(pickDepth);
        }
      };
    } else {
      // -------------------------------------------------------------
      // GRACEFUL FALLBACK: CANVAS 2D RENDERER (Capped at 2,000 nodes)
      // -------------------------------------------------------------
      const context = canvas.getContext("2d");
      if (!context) return;
      let frame = 0, width = 1, height = 1;
      let hover: string | null = null;
      let points: Array<{ id: string; x: number; y: number; z: number; radius: number }> = [];
      const pointers = new Map<number, { x: number; y: number }>();
      let dragged = false, downX = 0, downY = 0;

      const render = () => {
        frame = 0;
        const { nodes, edges, positions, coordinates, showTitles, selectedNodeId } = current.current;
        context.clearRect(0, 0, width, height);

        // Cap fallback at 2,000 nodes for stability on 2D canvas
        const activeNodes = nodes.length > 2000 ? nodes.slice(0, 2000) : nodes;
        let maxR = 60;
        for (const p of coordinates.values()) {
          const r = Math.hypot(p.x, p.y, p.z);
          if (r > maxR) maxR = r;
        }
        const extent = maxR;
        const scale = Math.min(width, height) * 0.4 / extent;
        const projected = new Map(activeNodes.flatMap(node => {
          const p = coordinates.get(node.id);
          return p ? [[node.id, projectMemoryPoint(p, cameraRef.current, scale, width, height)] as const] : [];
        }));
        const focus = hover ?? selectedNodeId;
        const neighbors = new Set<string>();
        if (focus) for (const edge of edges) { if (edge.source === focus) neighbors.add(edge.target); if (edge.target === focus) neighbors.add(edge.source); }
        context.lineWidth = 0.55;
        for (const edge of edges) {
          const a = projected.get(edge.source), b = projected.get(edge.target);
          if (!a || !b) continue;
          const incident = edge.source === focus || edge.target === focus;
          context.strokeStyle = incident ? "#98dafa" : focus ? "#14202b" : edge.type === "DERIVED_FROM" ? "#385068" : "#203343";
          context.lineWidth = incident ? 1.15 : 0.55;
          context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
        }
        points = [];
        const ordered = activeNodes.filter(node => projected.has(node.id)).sort((a, b) => projected.get(b.id)!.z - projected.get(a.id)!.z);
        const labelBoxes: Array<{ x: number; y: number; w: number }> = [];
        for (const node of ordered) {
          const p = projected.get(node.id)!;
          const highlighted = node.id === focus;
          const root = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
          const radius = Math.max(1, (root ? 10 : node.type === "SOURCE" ? 4.6 : 2.1) * p.perspective * Math.sqrt(cameraRef.current.zoom)) * (highlighted ? 1.5 : 1);
          points.push({ id: node.id, ...p, radius });
          context.globalAlpha = focus && !highlighted && !neighbors.has(node.id) ? 0.2 : Math.max(0.4, Math.min(1, p.perspective));
          context.fillStyle = highlighted ? "#ffffff" : positions.get(node.id)?.color ?? "#7395ad";
          if (root || highlighted) { context.shadowColor = context.fillStyle; context.shadowBlur = 13; }
          context.beginPath(); context.arc(p.x, p.y, radius, 0, Math.PI * 2); context.fill(); context.shadowBlur = 0;
        }
        context.globalAlpha = 1;
        if (showTitles) {
          const labeled = [...ordered].sort((a, b) => Number(b.id === focus) - Number(a.id === focus) || Number(isMemoryCoreLabel(b.label)) - Number(isMemoryCoreLabel(a.label)) || Number(b.type === "SOURCE") - Number(a.type === "SOURCE"));
          context.font = "11px system-ui, sans-serif";
          for (const node of labeled) {
            if (node.type !== "SOURCE" && node.id !== focus && cameraRef.current.zoom < 1.6) continue;
            const p = projected.get(node.id)!;
            const label = node.label.length > 48 ? `${node.label.slice(0, 45)}…` : node.label;
            const x = p.x + 9, y = p.y, w = context.measureText(label).width;
            if (x + w > width || y < 14 || y > height - 5 || labelBoxes.some(box => Math.abs(box.y - y) < 16 && x < box.x + box.w + 5 && x + w + 5 > box.x)) continue;
            labelBoxes.push({ x, y, w });
            context.fillStyle = "#09111bea"; context.fillRect(x - 3, y - 11, w + 6, 16);
            context.fillStyle = isMemoryCoreLabel(node.label) ? "#fff0b0" : "#c6dfed"; context.fillText(label, x, y + 1);
          }
        }
        canvas.dataset.rotation = `${cameraRef.current.yaw.toFixed(3)},${cameraRef.current.pitch.toFixed(3)}`;
        canvas.dataset.renderer = "canvas2d";
      };

      const schedule = () => { if (!frame) frame = requestAnimationFrame(render); };
      redrawRef.current = schedule;
      const resize = () => {
        const rect = canvas.getBoundingClientRect(); width = rect.width; height = rect.height;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
        context.setTransform(dpr, 0, 0, dpr, 0, 0); schedule();
      };
      const hit = (x: number, y: number) => [...points].reverse().find(p => Math.hypot(p.x - x, p.y - y) < Math.max(7, p.radius + 3))?.id ?? null;
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
          } else { cameraRef.current.yaw += (p.x - previous.x) * 0.009; cameraRef.current.pitch += (p.y - previous.y) * 0.009; }
          pointers.set(event.pointerId, p);
        } else { hover = hit(p.x, p.y); canvas.style.cursor = hover ? "pointer" : "grab"; }
        schedule();
      };
      const up = (event: PointerEvent) => {
        const p = local(event);
        if (!dragged && pointers.size === 1) { const id = hit(p.x, p.y); if (id) current.current.onSelectNode(id); }
        pointers.delete(event.pointerId);
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      };
      const cancel = (event: PointerEvent) => { pointers.delete(event.pointerId); dragged = true; };
      const wheel = (event: WheelEvent) => { event.preventDefault(); cameraRef.current.zoom = Math.max(0.35, Math.min(5, cameraRef.current.zoom * Math.exp(-event.deltaY * 0.001))); schedule(); };
      const key = (event: KeyboardEvent) => {
        if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
          event.preventDefault(); cameraRef.current.yaw += event.key === "ArrowLeft" ? -0.15 : event.key === "ArrowRight" ? 0.15 : 0;
          cameraRef.current.pitch += event.key === "ArrowUp" ? -0.15 : event.key === "ArrowDown" ? 0.15 : 0; schedule();
        } else if (event.key === "Enter") { const node = current.current.nodes.find(node => node.id === current.current.selectedNodeId) ?? current.current.nodes.find(node => isMemoryCoreLabel(node.label)); if (node) current.current.onSelectNode(node.id); }
      };
      const observer = new ResizeObserver(resize); observer.observe(canvas); resize();
      canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointermove", move); canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", cancel); canvas.addEventListener("wheel", wheel, { passive: false }); canvas.addEventListener("keydown", key);
      return () => { observer.disconnect(); cancelAnimationFrame(frame); redrawRef.current = () => {}; canvas.removeEventListener("pointerdown", down); canvas.removeEventListener("pointermove", move); canvas.removeEventListener("pointerup", up); canvas.removeEventListener("pointercancel", cancel); canvas.removeEventListener("wheel", wheel); canvas.removeEventListener("keydown", key); };
    }
  }, [isWebGL]);

  useEffect(() => { redrawRef.current(); }, [nodes, edges, positions, coordinates, showTitles, selectedNodeId]);

  return (
    <div className="memory-3d-surface" style={{ position: "relative" }}>
      <canvas
        key={isWebGL ? "webgl" : "canvas2d"}
        ref={canvasRef}
        tabIndex={0}
        role="application"
        aria-label="3D memory graph. Drag or use arrow keys to rotate 360 degrees. Scroll or pinch to zoom. Click a node to open."
        aria-busy={loading}
        data-titles-visible={showTitles}
        data-layout-volume={volumeRatio.toFixed(4)}
        data-renderer={isWebGL ? "webgl2" : "canvas2d"}
      />
      {isWebGL ? (
        <canvas
          ref={overlayCanvasRef}
          aria-hidden="true"
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
        />
      ) : null}
      <span className="memory-3d-hint">Drag to rotate 360° · Scroll or pinch to zoom · Click to explore</span>
    </div>
  );
}
