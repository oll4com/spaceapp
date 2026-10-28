import { useEffect, useMemo, useRef } from "react";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import {
  DEFAULT_MEMORY_CAMERA,
  memory3DVolumeRatio,
  packMemoryGraph3DBuffers,
  pickMemoryNode3D,
  projectMemoryPoint,
  type MemoryCamera3D,
  type MemoryPoint3D
} from "./memory-3d.js";

const NODE_VERTEX_SHADER = `
attribute vec3 a_position;
attribute vec3 a_color;
attribute float a_size;
attribute float a_highlight;
uniform vec2 u_resolution;
uniform vec2 u_rotation;
uniform float u_zoom;
uniform float u_scale;
uniform float u_dpr;
varying vec3 v_color;
varying float v_alpha;
varying float v_highlight;
void main() {
  float cosY = cos(u_rotation.x);
  float sinY = sin(u_rotation.x);
  float cosP = cos(u_rotation.y);
  float sinP = sin(u_rotation.y);
  float x = a_position.x * cosY + a_position.z * sinY;
  float depth = -a_position.x * sinY + a_position.z * cosY;
  float y = a_position.y * cosP - depth * sinP;
  float z = a_position.y * sinP + depth * cosP;
  float perspective = 650.0 / max(120.0, 650.0 + z * u_scale);
  float sx = u_resolution.x * 0.5 + x * u_scale * u_zoom * perspective;
  float sy = u_resolution.y * 0.5 - y * u_scale * u_zoom * perspective;
  vec2 clip = (vec2(sx, sy) / u_resolution) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, clamp(z * u_scale / 4000.0, -0.99, 0.99), 1.0);
  float boost = a_highlight > 1.5 ? 1.5 : 1.0;
  float radius = max(1.0, a_size * perspective * sqrt(u_zoom)) * boost;
  gl_PointSize = radius * 2.0 * u_dpr;
  v_color = a_highlight > 1.5 ? vec3(1.0, 1.0, 1.0) : a_color;
  v_alpha = a_highlight < 0.0 ? 0.2 : clamp(perspective, 0.4, 1.0);
  v_highlight = a_highlight;
}
`;

const NODE_FRAGMENT_SHADER = `
precision mediump float;
varying vec3 v_color;
varying float v_alpha;
varying float v_highlight;
void main() {
  vec2 c = gl_PointCoord - vec2(0.5);
  float distSq = dot(c, c);
  if (distSq > 0.25) discard;
  float edgeSmooth = smoothstep(0.25, 0.18, distSq);
  gl_FragColor = vec4(v_color, v_alpha * edgeSmooth);
}
`;

const EDGE_VERTEX_SHADER = `
attribute vec3 a_position;
attribute vec3 a_color;
uniform vec2 u_resolution;
uniform vec2 u_rotation;
uniform float u_zoom;
uniform float u_scale;
varying vec3 v_color;
void main() {
  float cosY = cos(u_rotation.x);
  float sinY = sin(u_rotation.x);
  float cosP = cos(u_rotation.y);
  float sinP = sin(u_rotation.y);
  float x = a_position.x * cosY + a_position.z * sinY;
  float depth = -a_position.x * sinY + a_position.z * cosY;
  float y = a_position.y * cosP - depth * sinP;
  float z = a_position.y * sinP + depth * cosP;
  float perspective = 650.0 / max(120.0, 650.0 + z * u_scale);
  float sx = u_resolution.x * 0.5 + x * u_scale * u_zoom * perspective;
  float sy = u_resolution.y * 0.5 - y * u_scale * u_zoom * perspective;
  vec2 clip = (vec2(sx, sy) / u_resolution) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, clamp((z * u_scale / 4000.0) + 0.01, -0.99, 0.99), 1.0);
  v_color = a_color;
}
`;

const EDGE_FRAGMENT_SHADER = `
precision mediump float;
varying vec3 v_color;
void main() {
  gl_FragColor = vec4(v_color, 0.85);
}
`;

function compileProgram(gl: WebGLRenderingContext, vsSource: string, fsSource: string): WebGLProgram | null {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  };
  const vs = compile(gl.VERTEX_SHADER, vsSource);
  const fs = compile(gl.FRAGMENT_SHADER, fsSource);
  if (!vs || !fs) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
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
  const packed = useMemo(() => packMemoryGraph3DBuffers(nodes, edges, coordinates, positions), [nodes, edges, coordinates, positions]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef<MemoryCamera3D>({ ...DEFAULT_MEMORY_CAMERA });
  const redrawRef = useRef<() => void>(() => {});
  const current = useRef({ nodes, edges, positions, coordinates, packed, showTitles, selectedNodeId, onSelectNode });
  current.current = { nodes, edges, positions, coordinates, packed, showTitles, selectedNodeId, onSelectNode };

  useEffect(() => {
    cameraRef.current = { ...DEFAULT_MEMORY_CAMERA };
    redrawRef.current();
  }, [resetToken]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const overlay = overlayRef.current;
    const overlayCtx = overlay?.getContext("2d") ?? null;

    // Prefer WebGL for 50,000+ node hardware-accelerated rendering; fallback to 2D canvas in headless test environments.
    let gl: WebGLRenderingContext | null;
    try {
      gl = (canvas.getContext("webgl", { antialias: true, alpha: true }) ||
        canvas.getContext("experimental-webgl", { antialias: true, alpha: true })) as WebGLRenderingContext | null;
    } catch {
      gl = null;
    }

    const nodeProgram = gl ? compileProgram(gl, NODE_VERTEX_SHADER, NODE_FRAGMENT_SHADER) : null;
    const edgeProgram = gl ? compileProgram(gl, EDGE_VERTEX_SHADER, EDGE_FRAGMENT_SHADER) : null;
    const webglReady = Boolean(gl && nodeProgram && edgeProgram);
    const context2d = !webglReady ? canvas.getContext("2d") : null;
    if (!webglReady && !context2d) return;

    canvas.dataset.renderer = webglReady ? "webgl" : "2d";

    const glState = webglReady && gl && nodeProgram && edgeProgram ? {
      gl,
      nodeProgram,
      edgeProgram,
      posBuffer: gl.createBuffer(),
      colorBuffer: gl.createBuffer(),
      sizeBuffer: gl.createBuffer(),
      highlightBuffer: gl.createBuffer(),
      edgePosBuffer: gl.createBuffer(),
      edgeColorBuffer: gl.createBuffer(),
      uploadedPacked: null as typeof packed | null,
      uploadedFocus: undefined as string | null | undefined
    } : null;

    let frame = 0, width = 1, height = 1, dpr = 1;
    let hover: string | null = null;
    const pointers = new Map<number, { x: number; y: number }>();
    let dragged = false, downX = 0, downY = 0;

    const renderLabels = (targetCtx: CanvasRenderingContext2D, focus: string | null, scale: number) => {
      const { nodes, coordinates, showTitles } = current.current;
      if (!showTitles) return;
      const labelBoxes: Array<{ x: number; y: number; w: number }> = [];
      const candidates = nodes.filter(
        node => coordinates.has(node.id) && (node.type === "SOURCE" || node.id === focus || (cameraRef.current.zoom >= 1.6 && nodes.length <= 2_500))
      );
      candidates.sort(
        (a, b) =>
          Number(b.id === focus) - Number(a.id === focus) ||
          Number(isMemoryCoreLabel(b.label)) - Number(isMemoryCoreLabel(a.label)) ||
          Number(b.type === "SOURCE") - Number(a.type === "SOURCE")
      );
      targetCtx.font = "11px system-ui, sans-serif";
      const maxLabels = Math.min(candidates.length, 64);
      for (let i = 0; i < maxLabels; i++) {
        const node = candidates[i]!;
        const p = projectMemoryPoint(coordinates.get(node.id)!, cameraRef.current, scale, width, height);
        const label = node.label.length > 48 ? `${node.label.slice(0, 45)}…` : node.label;
        const x = p.x + 9, y = p.y, w = targetCtx.measureText(label).width;
        if (x + w > width || y < 14 || y > height - 5 || labelBoxes.some(box => Math.abs(box.y - y) < 16 && x < box.x + box.w + 5 && x + w + 5 > box.x)) continue;
        labelBoxes.push({ x, y, w });
        targetCtx.fillStyle = "#09111bea";
        targetCtx.fillRect(x - 3, y - 11, w + 6, 16);
        targetCtx.fillStyle = isMemoryCoreLabel(node.label) ? "#fff0b0" : "#c6dfed";
        targetCtx.fillText(label, x, y + 1);
      }
    };

    const renderWebGL = () => {
      if (!glState) return;
      const { gl, nodeProgram, edgeProgram } = glState;
      const { packed, selectedNodeId } = current.current;
      const focus = hover ?? selectedNodeId;
      const nodeCount = packed.nodeIds.length;
      const edgeCount = packed.edgeIndices.length / 2;
      const scale = Math.min(width, height) * 0.4 / packed.extent;

      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      if (glState.uploadedPacked !== packed) {
        gl.bindBuffer(gl.ARRAY_BUFFER, glState.posBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, packed.positions, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, glState.colorBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, packed.colors, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, glState.sizeBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, packed.sizes, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, glState.edgePosBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, packed.edgePositions, gl.STATIC_DRAW);
        glState.uploadedPacked = packed;
        glState.uploadedFocus = undefined;
      }

      if (glState.uploadedFocus !== focus) {
        const highlights = new Float32Array(nodeCount);
        const focusIdx = focus ? (packed.nodeIndex.get(focus) ?? -1) : -1;
        if (focusIdx >= 0) {
          const adj = packed.neighbors.get(focusIdx);
          for (let i = 0; i < nodeCount; i++) {
            highlights[i] = i === focusIdx ? 2.0 : adj?.has(i) ? 1.0 : -1.0;
          }
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, glState.highlightBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, highlights, gl.DYNAMIC_DRAW);

        if (edgeCount > 0) {
          if (focusIdx >= 0) {
            const dynamicEdgeColors = new Float32Array(packed.edgeColors.length);
            for (let e = 0; e < edgeCount; e++) {
              const a = packed.edgeIndices[e * 2]!;
              const b = packed.edgeIndices[e * 2 + 1]!;
              const incident = a === focusIdx || b === focusIdx;
              const offset = e * 6;
              const [r, g, bl] = incident ? [0.596, 0.855, 0.98] : [0.078, 0.125, 0.168];
              dynamicEdgeColors[offset] = r; dynamicEdgeColors[offset + 1] = g; dynamicEdgeColors[offset + 2] = bl;
              dynamicEdgeColors[offset + 3] = r; dynamicEdgeColors[offset + 4] = g; dynamicEdgeColors[offset + 5] = bl;
            }
            gl.bindBuffer(gl.ARRAY_BUFFER, glState.edgeColorBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, dynamicEdgeColors, gl.DYNAMIC_DRAW);
          } else {
            gl.bindBuffer(gl.ARRAY_BUFFER, glState.edgeColorBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, packed.edgeColors, gl.STATIC_DRAW);
          }
        }
        glState.uploadedFocus = focus;
      }

      if (edgeCount > 0) {
        gl.useProgram(edgeProgram);
        const posLoc = gl.getAttribLocation(edgeProgram, "a_position");
        const colLoc = gl.getAttribLocation(edgeProgram, "a_color");
        gl.bindBuffer(gl.ARRAY_BUFFER, glState.edgePosBuffer);
        gl.enableVertexAttribArray(posLoc);
        gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, glState.edgeColorBuffer);
        gl.enableVertexAttribArray(colLoc);
        gl.vertexAttribPointer(colLoc, 3, gl.FLOAT, false, 0, 0);
        gl.uniform2f(gl.getUniformLocation(edgeProgram, "u_resolution"), width, height);
        gl.uniform2f(gl.getUniformLocation(edgeProgram, "u_rotation"), cameraRef.current.yaw, cameraRef.current.pitch);
        gl.uniform1f(gl.getUniformLocation(edgeProgram, "u_zoom"), cameraRef.current.zoom);
        gl.uniform1f(gl.getUniformLocation(edgeProgram, "u_scale"), scale);
        gl.drawArrays(gl.LINES, 0, edgeCount * 2);
      }

      if (nodeCount > 0) {
        gl.useProgram(nodeProgram);
        const posLoc = gl.getAttribLocation(nodeProgram, "a_position");
        const colLoc = gl.getAttribLocation(nodeProgram, "a_color");
        const sizeLoc = gl.getAttribLocation(nodeProgram, "a_size");
        const hiLoc = gl.getAttribLocation(nodeProgram, "a_highlight");

        gl.bindBuffer(gl.ARRAY_BUFFER, glState.posBuffer);
        gl.enableVertexAttribArray(posLoc);
        gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, glState.colorBuffer);
        gl.enableVertexAttribArray(colLoc);
        gl.vertexAttribPointer(colLoc, 3, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, glState.sizeBuffer);
        gl.enableVertexAttribArray(sizeLoc);
        gl.vertexAttribPointer(sizeLoc, 1, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, glState.highlightBuffer);
        gl.enableVertexAttribArray(hiLoc);
        gl.vertexAttribPointer(hiLoc, 1, gl.FLOAT, false, 0, 0);

        gl.uniform2f(gl.getUniformLocation(nodeProgram, "u_resolution"), width, height);
        gl.uniform2f(gl.getUniformLocation(nodeProgram, "u_rotation"), cameraRef.current.yaw, cameraRef.current.pitch);
        gl.uniform1f(gl.getUniformLocation(nodeProgram, "u_zoom"), cameraRef.current.zoom);
        gl.uniform1f(gl.getUniformLocation(nodeProgram, "u_scale"), scale);
        gl.uniform1f(gl.getUniformLocation(nodeProgram, "u_dpr"), dpr);
        gl.drawArrays(gl.POINTS, 0, nodeCount);
      }

      if (overlayCtx) {
        overlayCtx.clearRect(0, 0, width, height);
        renderLabels(overlayCtx, focus, scale);
      }
    };

    const renderFallback2D = () => {
      if (!context2d) return;
      const { nodes, edges, positions, coordinates, packed, selectedNodeId } = current.current;
      context2d.clearRect(0, 0, width, height);
      const scale = Math.min(width, height) * 0.4 / packed.extent;
      const projected = new Map(nodes.flatMap(node => {
        const p = coordinates.get(node.id);
        return p ? [[node.id, projectMemoryPoint(p, cameraRef.current, scale, width, height)] as const] : [];
      }));
      const focus = hover ?? selectedNodeId;
      const neighbors = new Set<string>();
      if (focus) for (const edge of edges) { if (edge.source === focus) neighbors.add(edge.target); if (edge.target === focus) neighbors.add(edge.source); }
      context2d.lineWidth = 0.55;
      for (const edge of edges) {
        const a = projected.get(edge.source), b = projected.get(edge.target);
        if (!a || !b) continue;
        const incident = edge.source === focus || edge.target === focus;
        context2d.strokeStyle = incident ? "#98dafa" : focus ? "#14202b" : edge.type === "DERIVED_FROM" ? "#385068" : "#203343";
        context2d.lineWidth = incident ? 1.15 : 0.55;
        context2d.beginPath(); context2d.moveTo(a.x, a.y); context2d.lineTo(b.x, b.y); context2d.stroke();
      }
      const ordered = nodes.filter(node => projected.has(node.id)).sort((a, b) => projected.get(b.id)!.z - projected.get(a.id)!.z);
      for (const node of ordered) {
        const p = projected.get(node.id)!;
        const highlighted = node.id === focus;
        const root = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
        const radius = Math.max(1, (root ? 10 : node.type === "SOURCE" ? 4.6 : 2.1) * p.perspective * Math.sqrt(cameraRef.current.zoom)) * (highlighted ? 1.5 : 1);
        context2d.globalAlpha = focus && !highlighted && !neighbors.has(node.id) ? 0.2 : Math.max(0.4, Math.min(1, p.perspective));
        context2d.fillStyle = highlighted ? "#ffffff" : positions.get(node.id)?.color ?? "#7395ad";
        if (root || highlighted) { context2d.shadowColor = context2d.fillStyle; context2d.shadowBlur = 13; }
        context2d.beginPath(); context2d.arc(p.x, p.y, radius, 0, Math.PI * 2); context2d.fill(); context2d.shadowBlur = 0;
      }
      context2d.globalAlpha = 1;
      renderLabels(context2d, focus, scale);
    };

    const render = () => {
      frame = 0;
      if (webglReady) renderWebGL();
      else renderFallback2D();
      canvas.dataset.rotation = `${cameraRef.current.yaw.toFixed(3)},${cameraRef.current.pitch.toFixed(3)}`;
    };

    const schedule = () => { if (!frame) frame = requestAnimationFrame(render); };
    redrawRef.current = schedule;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      if (context2d) context2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (overlay && overlayCtx) {
        overlay.width = Math.round(width * dpr);
        overlay.height = Math.round(height * dpr);
        overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      schedule();
    };

    const hit = (x: number, y: number) =>
      pickMemoryNode3D(current.current.packed, cameraRef.current, width, height, x, y, hover ?? current.current.selectedNodeId);

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
  }, []);

  useEffect(() => { redrawRef.current(); }, [nodes, edges, positions, coordinates, packed, showTitles, selectedNodeId]);

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
        data-node-count={packed.nodeIds.length}
      />
      <canvas
        ref={overlayRef}
        aria-hidden="true"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
      />
      <span className="memory-3d-hint">Drag to rotate 360° · Scroll or pinch to zoom · Click to explore</span>
    </div>
  );
}
