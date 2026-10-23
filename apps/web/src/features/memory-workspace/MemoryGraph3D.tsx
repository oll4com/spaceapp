import { useEffect, useMemo, useRef, useState } from "react";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import { DEFAULT_MEMORY_CAMERA, memory3DVolumeRatio, projectMemoryPoint, type MemoryCamera3D, type MemoryPoint3D } from "./memory-3d.js";
import {
  MAX_LABELS_3D,
  WEBGL_EDGE_FRAG, WEBGL_EDGE_VERT, WEBGL_NODE_FRAG, WEBGL_NODE_VERT, WEBGL_PICK_FRAG, WEBGL_PICK_VERT,
  buildEdgeBuffers, buildNodeStyleBuffer, decodePickColor, edgeColorHex, hexToRgb, orderLabelCandidates, truncateLabel
} from "./memory-graph-3d-webgl.js";
import { GraphPerfRecorder, installGraphPerf } from "./memory-graph-perf.js";

export type MemoryGraph3DProps = {
  nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[];
  positions: Map<string, MemoryAtlasPosition>; coordinates: Map<string, MemoryPoint3D>;
  showTitles: boolean; selectedNodeId: string | null; onSelectNode: (id: string) => void;
  loading: boolean; resetToken: number;
};

export function MemoryGraph3D(props: MemoryGraph3DProps) {
  const [webglFailed, setWebglFailed] = useState(false);
  const webglSupported = useMemo(() => {
    try {
      const probe = document.createElement("canvas");
      return probe.getContext("webgl2") !== null;
    } catch {
      return false;
    }
  }, []);
  if (!webglSupported || webglFailed) return <MemoryGraph3DFallback {...props} />;
  return <MemoryGraph3DWebGL {...props} onEngineFailed={() => setWebglFailed(true)} />;
}

// ---------------------------------------------------------------------------
// WebGL2 renderer
// ---------------------------------------------------------------------------

type GLProgram = { program: WebGLProgram; uniforms: Map<string, WebGLUniformLocation | null> };

type Engine = {
  gl: WebGL2RenderingContext;
  node: GLProgram; edge: GLProgram; pick: GLProgram;
  vaoNode: WebGLVertexArrayObject; vaoEdge: WebGLVertexArrayObject;
  bufQuad: WebGLBuffer; bufPos: WebGLBuffer; bufStyle: WebGLBuffer;
  bufEdgePos: WebGLBuffer; bufEdgeColor: WebGLBuffer;
  pickFbo: WebGLFramebuffer; pickTex: WebGLTexture; pickDepth: WebGLRenderbuffer;
  order: string[]; indexOf: Map<string, number>;
  nodeCount: number; edgeCount: number; edgeVertCount: number;
  deviceWidth: number; deviceHeight: number; cssWidth: number; cssHeight: number;
  degree: Map<string, number>;
  labelPriority: string[];
  // #62: cached graph data for cheap focus-only updates and streaming edge refresh.
  edgePairs: number[]; // flat [srcIdx, dstIdx, ...] for edges with both endpoints present
  edgeList: MemoryGraphEdge[]; // edges matching edgePairs, in the same order
  colors: Map<string, string>;
  byId: Map<string, MemoryGraphNode>;
};

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`shader compile failed: ${log}`);
  }
  return shader;
}

function makeProgram(gl: WebGL2RenderingContext, vs: string, fs: string, uniformNames: string[]): GLProgram {
  const program = gl.createProgram()!;
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`program link failed: ${gl.getProgramInfoLog(program)}`);
  }
  const uniforms = new Map(uniformNames.map(name => [name, gl.getUniformLocation(program, name)] as const));
  return { program, uniforms };
}

const CAMERA_UNIFORMS = ["uYaw", "uPitch", "uZoom", "uZoomSqrt", "uScale", "uWidth", "uHeight", "uDepthRange"];

function setCameraUniforms(gl: WebGL2RenderingContext, prog: GLProgram, camera: MemoryCamera3D, scale: number, w: number, h: number, depthRange: number) {
  const u = (name: string): WebGLUniformLocation | null => prog.uniforms.get(name) ?? null;
  gl.uniform1f(u("uYaw"), camera.yaw);
  gl.uniform1f(u("uPitch"), camera.pitch);
  gl.uniform1f(u("uZoom"), camera.zoom);
  gl.uniform1f(u("uZoomSqrt"), Math.sqrt(camera.zoom));
  gl.uniform1f(u("uScale"), scale);
  gl.uniform1f(u("uWidth"), w);
  gl.uniform1f(u("uHeight"), h);
  gl.uniform1f(u("uDepthRange"), depthRange);
}

function createEngine(canvas: HTMLCanvasElement): Engine | null {
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = canvas.getContext("webgl2", { antialias: true, alpha: true, powerPreference: "low-power" });
  } catch {
    return null;
  }
  if (!gl) return null;
  try {
    const node = makeProgram(gl, WEBGL_NODE_VERT, WEBGL_NODE_FRAG, CAMERA_UNIFORMS);
    const edge = makeProgram(gl, WEBGL_EDGE_VERT, WEBGL_EDGE_FRAG, CAMERA_UNIFORMS);
    const pick = makeProgram(gl, WEBGL_PICK_VERT, WEBGL_PICK_FRAG, CAMERA_UNIFORMS);

    // Unit quad shared by the node and pick programs.
    const bufQuad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, bufQuad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    const bufPos = gl.createBuffer()!;
    const bufStyle = gl.createBuffer()!;
    const bufEdgePos = gl.createBuffer()!;
    const bufEdgeColor = gl.createBuffer()!;

    const vaoNode = gl.createVertexArray()!;
    gl.bindVertexArray(vaoNode);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufQuad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufPos);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufStyle);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 24, 0);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, 24, 8);
    gl.vertexAttribDivisor(3, 1);

    const vaoEdge = gl.createVertexArray()!;
    gl.bindVertexArray(vaoEdge);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufEdgePos);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufEdgeColor);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    // Offscreen target for GPU picking (RGBA8 color-coded instance ids).
    const pickTex = gl.createTexture()!;
    const pickDepth = gl.createRenderbuffer()!;
    const pickFbo = gl.createFramebuffer()!;

    gl.disable(gl.BLEND);
    return {
      gl, node, edge, pick, vaoNode, vaoEdge,
      bufQuad, bufPos, bufStyle, bufEdgePos, bufEdgeColor,
      pickFbo, pickTex, pickDepth,
      order: [], indexOf: new Map(), nodeCount: 0, edgeCount: 0, edgeVertCount: 0,
      deviceWidth: 1, deviceHeight: 1, cssWidth: 1, cssHeight: 1,
      degree: new Map(), labelPriority: [],
      edgePairs: [], edgeList: [], colors: new Map(), byId: new Map()
    };
  } catch {
    return null;
  }
}

function engineResize(engine: Engine, cssWidth: number, cssHeight: number) {
  const { gl } = engine;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const dw = Math.max(1, Math.round(cssWidth * dpr));
  const dh = Math.max(1, Math.round(cssHeight * dpr));
  if (dw === engine.deviceWidth && dh === engine.deviceHeight) return;
  engine.deviceWidth = dw; engine.deviceHeight = dh;
  engine.cssWidth = cssWidth; engine.cssHeight = cssHeight;
  gl.bindTexture(gl.TEXTURE_2D, engine.pickTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, dw, dh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.bindRenderbuffer(gl.RENDERBUFFER, engine.pickDepth);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, dw, dh);
  gl.bindFramebuffer(gl.FRAMEBUFFER, engine.pickFbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, engine.pickTex, 0);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, engine.pickDepth);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

function engineRebuildData(engine: Engine, nodes: MemoryGraphNode[], edges: MemoryGraphEdge[], coordinates: Map<string, MemoryPoint3D>, colors: Map<string, string>, focusId: string | null) {
  const { gl } = engine;
  const order = nodes.map(n => n.id);
  const indexOf = new Map(order.map((id, i) => [id, i]));
  const positions = new Float32Array(order.length * 3);
  for (let i = 0; i < order.length; i++) {
    const p = coordinates.get(order[i]!);
    positions[i * 3] = p?.x ?? 0; positions[i * 3 + 1] = p?.y ?? 0; positions[i * 3 + 2] = p?.z ?? 0;
  }
  // Cache the valid edge endpoint pairs so streaming position updates can
  // regenerate edge geometry without re-walking the edge list.
  const edgePairs: number[] = [];
  const edgeList: MemoryGraphEdge[] = [];
  for (const edge of edges) {
    const a = indexOf.get(edge.source);
    const b = indexOf.get(edge.target);
    if (a === undefined || b === undefined) continue;
    edgePairs.push(a, b);
    edgeList.push(edge);
  }
  const edgeBufs = buildEdgeBuffers(edges, indexOf, positions, focusId);

  gl.bindBuffer(gl.ARRAY_BUFFER, engine.bufPos);
  gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, engine.bufEdgePos);
  gl.bufferData(gl.ARRAY_BUFFER, edgeBufs.positions, gl.DYNAMIC_DRAW);

  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const labelPriority = [...nodes]
    .sort((a, b) =>
      Number(isMemoryCoreLabel(b.label)) - Number(isMemoryCoreLabel(a.label)) ||
      Number(b.type === "SOURCE") - Number(a.type === "SOURCE") ||
      (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(n => n.id);

  engine.order = order; engine.indexOf = indexOf;
  engine.nodeCount = order.length; engine.edgeCount = edges.length;
  engine.edgeVertCount = edgeBufs.count * 2;
  engine.degree = degree; engine.labelPriority = labelPriority;
  engine.edgePairs = edgePairs; engine.edgeList = edgeList;
  engine.colors = colors; engine.byId = new Map(nodes.map(n => [n.id, n]));
  // Focus-dependent styling goes through the cheap path below.
  engineUpdateFocus(engine, focusId);
}

/**
 * #62: hover/selection changes only rewrite the style and edge-color buffers.
 * Everything else (positions, edge geometry, degrees, label priority, color
 * map) depends on graph data alone and is left untouched.
 */
function engineUpdateFocus(engine: Engine, focusId: string | null) {
  const { gl } = engine;
  if (engine.nodeCount === 0) return;
  const nodes = [...engine.byId.values()];
  const neighbors = new Set<string>();
  if (focusId) for (const edge of engine.edgeList) {
    if (edge.source === focusId) neighbors.add(edge.target);
    if (edge.target === focusId) neighbors.add(edge.source);
  }
  const style = buildNodeStyleBuffer(nodes, id => engine.colors.get(id) ?? "#7395ad", focusId, neighbors);
  gl.bindBuffer(gl.ARRAY_BUFFER, engine.bufStyle);
  gl.bufferData(gl.ARRAY_BUFFER, style, gl.DYNAMIC_DRAW);
  const col = new Float32Array(engine.edgePairs.length * 3);
  for (let i = 0; i < engine.edgeList.length; i++) {
    const [r, g, b] = hexToRgb(edgeColorHex(engine.edgeList[i]!, focusId));
    col.set([r, g, b, r, g, b], i * 6);
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, engine.bufEdgeColor);
  gl.bufferData(gl.ARRAY_BUFFER, col, gl.DYNAMIC_DRAW);
}

/** Streaming layout chunks only move positions; edge endpoints follow via cached pairs. */
function engineUpdatePositions(engine: Engine, coordinates: Map<string, MemoryPoint3D>) {
  const { gl } = engine;
  const positions = new Float32Array(engine.order.length * 3);
  for (let i = 0; i < engine.order.length; i++) {
    const p = coordinates.get(engine.order[i]!);
    positions[i * 3] = p?.x ?? 0; positions[i * 3 + 1] = p?.y ?? 0; positions[i * 3 + 2] = p?.z ?? 0;
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, engine.bufPos);
  gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
  // #62: edges were baked at rebuild time; regenerate their endpoints so they
  // track nodes while the layout streams.
  const pairs = engine.edgePairs;
  if (pairs.length > 0) {
    const edgePos = new Float32Array(pairs.length * 3);
    for (let i = 0; i < pairs.length; i += 2) {
      const a = pairs[i]! * 3, b = pairs[i + 1]! * 3;
      edgePos.set([positions[a]!, positions[a + 1]!, positions[a + 2]!], i * 3);
      edgePos.set([positions[b]!, positions[b + 1]!, positions[b + 2]!], i * 3 + 3);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, engine.bufEdgePos);
    gl.bufferData(gl.ARRAY_BUFFER, edgePos, gl.DYNAMIC_DRAW);
  }
}

function engineRender(engine: Engine, camera: MemoryCamera3D, scale: number, depthRange: number) {
  const { gl } = engine;
  const w = engine.deviceWidth, h = engine.deviceHeight;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LESS);
  // #62: shaders work in CSS pixels (scale is CSS-based); the viewport still
  // covers the full device-pixel drawing buffer.
  const uw = engine.cssWidth, uh = engine.cssHeight;
  // Edges first, no depth write so nodes always win the depth test.
  gl.useProgram(engine.edge.program);
  setCameraUniforms(gl, engine.edge, camera, scale, uw, uh, depthRange);
  gl.bindVertexArray(engine.vaoEdge);
  gl.depthMask(false);
  gl.drawArrays(gl.LINES, 0, engine.edgeVertCount);
  // Instanced node quads.
  gl.useProgram(engine.node.program);
  setCameraUniforms(gl, engine.node, camera, scale, uw, uh, depthRange);
  gl.bindVertexArray(engine.vaoNode);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.depthMask(true);
  gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, engine.nodeCount);
  gl.disable(gl.BLEND);
  gl.bindVertexArray(null);
}

/** GPU picking: render id-encoded quads offscreen, read one pixel. ≤4ms at 50k. */
function enginePick(engine: Engine, xCss: number, yCss: number, camera: MemoryCamera3D, scale: number, depthRange: number): number | null {
  const { gl } = engine;
  const dpr = engine.deviceWidth / Math.max(1, engine.cssWidth);
  const px = Math.floor(xCss * dpr);
  const py = Math.floor((engine.cssHeight - yCss) * dpr);
  if (px < 0 || py < 0 || px >= engine.deviceWidth || py >= engine.deviceHeight) return null;
  gl.bindFramebuffer(gl.FRAMEBUFFER, engine.pickFbo);
  gl.viewport(0, 0, engine.deviceWidth, engine.deviceHeight);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LESS);
  gl.depthMask(true);
  gl.disable(gl.BLEND);
  gl.useProgram(engine.pick.program);
  setCameraUniforms(gl, engine.pick, camera, scale, engine.cssWidth, engine.cssHeight, depthRange);
  gl.bindVertexArray(engine.vaoNode);
  gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, engine.nodeCount);
  gl.bindVertexArray(null);
  const pixel = new Uint8Array(4);
  gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return decodePickColor(pixel[0]!, pixel[1]!, pixel[2]!);
}

function MemoryGraph3DWebGL({ nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode, loading, resetToken, onEngineFailed }: MemoryGraph3DProps & { onEngineFailed: () => void }) {
  const volumeRatio = useMemo(() => memory3DVolumeRatio([...coordinates.values()]), [coordinates]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef<MemoryCamera3D>({ ...DEFAULT_MEMORY_CAMERA });
  const engineRef = useRef<Engine | null>(null);
  const scheduleRef = useRef<() => void>(() => {});
  const live = useRef({ nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode });
  live.current = { nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode };
  const perfRef = useRef<GraphPerfRecorder | null>(null);
  if (!perfRef.current) {
    perfRef.current = new GraphPerfRecorder();
    installGraphPerf(perfRef.current);
  }

  useEffect(() => {
    cameraRef.current = { ...DEFAULT_MEMORY_CAMERA };
    scheduleRef.current();
  }, [resetToken]);

  // Full rebuild when the graph itself changes.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const { nodes, edges, coordinates, positions, selectedNodeId } = live.current;
    engineRebuildData(engine, nodes, edges, coordinates, positionsToColors(positions), selectedNodeId);
    perfRef.current?.configure("webgl2", nodes.length, edges.length);
    scheduleRef.current();
  }, [nodes, edges, positions]);

  // Streaming layout: only positions move, styles stay.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || engine.nodeCount === 0) return;
    engineUpdatePositions(engine, live.current.coordinates);
    scheduleRef.current();
  }, [coordinates]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (!canvas || !overlay) return;
    let engine: Engine | null = null;
    try {
      engine = createEngine(canvas);
    } catch {
      engine = null;
    }
    if (!engine) { onEngineFailed(); return; }
    engineRef.current = engine;
    const overlayCtx = overlay.getContext("2d");
    const d = live.current;
    try {
      engineRebuildData(engine, d.nodes, d.edges, d.coordinates, positionsToColors(d.positions), d.selectedNodeId);
    } catch {
      engineRef.current = null;
      onEngineFailed();
      return;
    }
    perfRef.current?.configure("webgl2", d.nodes.length, d.edges.length);

    let frame = 0;
    let hover: string | null = null;
    let lastFocus: string | null | undefined = undefined;
    let pickPending: { x: number; y: number } | null = null;
    let disposed = false;
    const pointers = new Map<number, { x: number; y: number }>();
    let dragged = false, downX = 0, downY = 0;
    let lastBenchAttr = 0;

    const extentOf = () => {
      let extent = 60;
      for (const p of live.current.coordinates.values()) {
        const r = Math.hypot(p.x, p.y, p.z);
        if (r > extent) extent = r;
      }
      return extent;
    };

    const render = () => {
      frame = 0;
      if (disposed || !engine) return;
      const { selectedNodeId } = live.current;
      const rect = canvas.getBoundingClientRect();
      const cssW = Math.max(1, rect.width), cssH = Math.max(1, rect.height);
      engineResize(engine, cssW, cssH);
      if (canvas.width !== engine.deviceWidth || canvas.height !== engine.deviceHeight) {
        canvas.width = engine.deviceWidth; canvas.height = engine.deviceHeight;
      }
      if (overlay.width !== engine.deviceWidth || overlay.height !== engine.deviceHeight) {
        overlay.width = engine.deviceWidth; overlay.height = engine.deviceHeight;
      }
      const extent = extentOf();
      const scale = Math.min(cssW, cssH) * 0.4 / extent;
      const depthRange = extent * 2;
      const focus = hover ?? selectedNodeId;
      if (focus !== lastFocus) {
        lastFocus = focus;
        try {
          // #62: hover/selection only needs style + edge-color refresh.
          engineUpdateFocus(engine, focus);
        } catch { /* keep last good frame */ }
      }
      const camera = cameraRef.current;
      const glStart = performance.now();
      engineRender(engine, camera, scale, depthRange);
      const glMs = performance.now() - glStart;
      // Throttled benchmark data attributes for maintainer verification (#62).
      const now = performance.now();
      if (!lastBenchAttr || now - lastBenchAttr > 1000) {
        lastBenchAttr = now;
        const snap = perfRef.current?.snapshot();
        if (snap && canvas) {
          canvas.dataset.frameP95Ms = snap.p95.toFixed(2);
          canvas.dataset.pickP95Ms = snap.pickP95.toFixed(2);
          canvas.dataset.renderer = snap.renderer;
        }
      }
      if (pickPending) {
        const pickStart = performance.now();
        const idx = enginePick(engine, pickPending.x, pickPending.y, camera, scale, depthRange);
        perfRef.current?.pick(performance.now() - pickStart);
        const next = idx === null ? null : engine.order[idx] ?? null;
        if (next !== hover) {
          hover = next;
          canvas.style.cursor = hover ? "pointer" : "grab";
          lastFocus = undefined; // force style refresh
          schedule();
        }
        pickPending = null;
      }
      const labelStart = performance.now();
      drawLabels();
      // #62: record per-render CPU cost, not the idle gap between frames.
      perfRef.current?.frame(glMs + performance.now() - labelStart);
      canvas.dataset.rotation = `${camera.yaw.toFixed(3)},${camera.pitch.toFixed(3)}`;
    };

    const drawLabels = () => {
      if (!overlayCtx || !engine) return;
      const { showTitles, selectedNodeId } = live.current;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      overlayCtx.clearRect(0, 0, engine.cssWidth, engine.cssHeight);
      const byId = engine.byId;
      if (!showTitles || byId.size === 0) return;
      const camera = cameraRef.current;
      const extent = extentOf();
      const scale = Math.min(engine.cssWidth, engine.cssHeight) * 0.4 / extent;
      const focus = hover ?? selectedNodeId;
      // Priority order is precomputed; project until the LOD budget is filled.
      const ordered: Array<{ id: string; label: string; type: MemoryGraphNode["type"]; isCore: boolean; degree: number; x: number; y: number }> = [];
      const consider = (id: string) => {
        const node = byId.get(id);
        if (!node || ordered.some(o => o.id === id)) return;
        if (node.type !== "SOURCE" && node.id !== focus && camera.zoom < 1.6) return;
        const p = live.current.coordinates.get(id);
        if (!p) return;
        const s = projectMemoryPoint(p, camera, scale, engine.cssWidth, engine.cssHeight);
        ordered.push({ id, label: node.label, type: node.type, isCore: isMemoryCoreLabel(node.label), degree: engine.degree.get(id) ?? 0, x: s.x, y: s.y });
      };
      if (focus) consider(focus);
      for (const id of engine.labelPriority) {
        if (ordered.length >= MAX_LABELS_3D) break;
        consider(id);
      }
      const ranked = orderLabelCandidates(ordered, { showTitles, focusId: focus, zoom: camera.zoom });
      const labelBoxes: Array<{ x: number; y: number; w: number }> = [];
      overlayCtx.font = "11px system-ui, sans-serif";
      for (const c of ranked) {
        const label = truncateLabel(c.label);
        const x = c.x + 9, y = c.y, w = overlayCtx.measureText(label).width;
        if (x + w > engine.cssWidth || y < 14 || y > engine.cssHeight - 5) continue;
        if (labelBoxes.some(box => Math.abs(box.y - y) < 16 && x < box.x + box.w + 5 && x + w + 5 > box.x)) continue;
        labelBoxes.push({ x, y, w });
        overlayCtx.fillStyle = "#09111bea";
        overlayCtx.fillRect(x - 3, y - 11, w + 6, 16);
        overlayCtx.fillStyle = c.isCore ? "#fff0b0" : "#c6dfed";
        overlayCtx.fillText(label, x, y + 1);
      }
    };

    const schedule = () => { if (!frame) frame = requestAnimationFrame(render); };
    scheduleRef.current = schedule;
    const resize = () => schedule();
    const local = (event: PointerEvent) => { const rect = canvas.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
    const down = (event: PointerEvent) => {
      canvas.focus(); canvas.setPointerCapture(event.pointerId);
      const p = local(event); pointers.set(event.pointerId, p); downX = p.x; downY = p.y; dragged = false; hover = null; lastFocus = undefined;
      schedule();
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
      } else {
        pickPending = p;
      }
      schedule();
    };
    const up = (event: PointerEvent) => {
      const p = local(event);
      if (!dragged && pointers.size === 1 && engine) {
        const extent = extentOf();
        const scale = Math.min(engine.cssWidth, engine.cssHeight) * 0.4 / extent;
        const pickStart = performance.now();
        const idx = enginePick(engine, p.x, p.y, cameraRef.current, scale, extent * 2);
        perfRef.current?.pick(performance.now() - pickStart);
        const id = idx === null ? null : engine.order[idx] ?? null;
        if (id) live.current.onSelectNode(id);
      }
      pointers.delete(event.pointerId);
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };
    const cancel = (event: PointerEvent) => { pointers.delete(event.pointerId); dragged = true; };
    const wheel = (event: WheelEvent) => { event.preventDefault(); cameraRef.current.zoom = Math.max(0.35, Math.min(5, cameraRef.current.zoom * Math.exp(-event.deltaY * 0.001))); schedule(); };
    const key = (event: KeyboardEvent) => {
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault(); cameraRef.current.yaw += event.key === "ArrowLeft" ? -0.15 : event.key === "ArrowRight" ? 0.15 : 0;
        cameraRef.current.pitch += event.key === "ArrowUp" ? -0.15 : event.key === "ArrowDown" ? 0.15 : 0; schedule();
      } else if (event.key === "Enter") { const node = live.current.nodes.find(node => node.id === live.current.selectedNodeId) ?? live.current.nodes.find(node => isMemoryCoreLabel(node.label)); if (node) live.current.onSelectNode(node.id); }
    };
    const onContextLost = (event: Event) => {
      event.preventDefault();
      disposed = true;
      engineRef.current = null;
      onEngineFailed();
    };
    const observer = new ResizeObserver(resize); observer.observe(canvas); resize();
    canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointermove", move); canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", cancel); canvas.addEventListener("wheel", wheel, { passive: false }); canvas.addEventListener("keydown", key); canvas.addEventListener("webglcontextlost", onContextLost);
    render();
    return () => {
      disposed = true; observer.disconnect(); cancelAnimationFrame(frame);
      engineRef.current = null;
      scheduleRef.current = () => {};
      canvas.removeEventListener("pointerdown", down); canvas.removeEventListener("pointermove", move); canvas.removeEventListener("pointerup", up); canvas.removeEventListener("pointercancel", cancel); canvas.removeEventListener("wheel", wheel); canvas.removeEventListener("keydown", key); canvas.removeEventListener("webglcontextlost", onContextLost);
    };
  }, []);

  useEffect(() => { scheduleRef.current(); }, [showTitles, selectedNodeId]);

  return (
    <div className="memory-3d-surface">
      <canvas ref={canvasRef} tabIndex={0} role="application" aria-label="3D memory graph. Drag or use arrow keys to rotate 360 degrees. Scroll or pinch to zoom. Click a node to open." aria-busy={loading} data-titles-visible={showTitles} data-layout-volume={volumeRatio.toFixed(4)} />
      <canvas ref={overlayRef} className="memory-3d-labels" aria-hidden="true" />
      <span className="memory-3d-hint">Drag to rotate 360° · Scroll or pinch to zoom · Click to explore</span>
    </div>
  );
}

function positionsToColors(positions: Map<string, MemoryAtlasPosition>): Map<string, string> {
  return new Map([...positions].map(([id, p]) => [id, p.color]));
}

// ---------------------------------------------------------------------------
// Canvas 2D fallback (unchanged behavior, used without WebGL2 or on context loss)
// ---------------------------------------------------------------------------

function MemoryGraph3DFallback({ nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode, loading, resetToken }: MemoryGraph3DProps) {
  const volumeRatio = useMemo(() => memory3DVolumeRatio([...coordinates.values()]), [coordinates]);
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
    if (!canvas) return;
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
      const extent = Math.max(60, ...[...coordinates.values()].map(p => Math.hypot(p.x, p.y, p.z)));
      const scale = Math.min(width, height) * 0.4 / extent;
      const projected = new Map(nodes.flatMap(node => {
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
      const ordered = nodes.filter(node => projected.has(node.id)).sort((a, b) => projected.get(b.id)!.z - projected.get(a.id)!.z);
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
  }, []);
  useEffect(() => { redrawRef.current(); }, [nodes, edges, positions, coordinates, showTitles, selectedNodeId]);
  return <div className="memory-3d-surface"><canvas ref={canvasRef} tabIndex={0} role="application" aria-label="3D memory graph. Drag or use arrow keys to rotate 360 degrees. Scroll or pinch to zoom. Click a node to open." aria-busy={loading} data-titles-visible={showTitles} data-layout-volume={volumeRatio.toFixed(4)} /><span className="memory-3d-hint">Drag to rotate 360° · Scroll or pinch to zoom · Click to explore</span></div>;
}
