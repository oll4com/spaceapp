import { useEffect, useMemo, useRef, useState } from "react";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import { DEFAULT_MEMORY_CAMERA, memory3DVolumeRatio, projectMemoryPoint, type MemoryCamera3D, type MemoryPoint3D } from "./memory-3d.js";
import { MemoryGraphGLRenderer, type MemoryGraphGLEdgeInput, type MemoryGraphGLNodeInput } from "./memory-graph-gl.js";
import { memoryGraphLabelBudget, planMemoryGraphLabels, type MemoryGraphLabelCandidate } from "./memory-graph-labels.js";

interface MemoryGraph3DProps {
  nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[];
  positions: Map<string, MemoryAtlasPosition>; coordinates: Map<string, MemoryPoint3D>;
  showTitles: boolean; selectedNodeId: string | null; onSelectNode: (id: string) => void;
  loading: boolean; resetToken: number;
}

/** The Canvas 2D fallback keeps the historical 2,000-node budget. */
const FALLBACK_NODE_CAP = 2000;

function fallbackProps(props: MemoryGraph3DProps): MemoryGraph3DProps {
  if (props.nodes.length <= FALLBACK_NODE_CAP) return props;
  const nodes = props.nodes.slice(0, FALLBACK_NODE_CAP);
  const ids = new Set(nodes.map(node => node.id));
  return { ...props, nodes, edges: props.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)) };
}

export function MemoryGraph3D(props: MemoryGraph3DProps) {
  const [glUnavailable, setGlUnavailable] = useState(false);
  if (glUnavailable) return <MemoryGraph3DLegacy {...fallbackProps(props)} />;
  return <MemoryGraph3DGL {...props} onUnavailable={() => setGlUnavailable(true)} />;
}

interface GLGraphData {
  indexById: Map<string, number>;
  glNodes: MemoryGraphGLNodeInput[];
  glEdges: MemoryGraphGLEdgeInput[];
  flatPositions: Float32Array;
  /** Node indices in label priority order: core labels, then sources, then the rest. */
  labelPriority: number[];
}

/** Topology depends on the graph itself, not on the streamed positions. */
interface GLGraphTopology {
  indexById: Map<string, number>;
  baseNodes: Array<{ color: string; radius: number; glow: boolean }>;
  edgePairs: MemoryGraphGLEdgeInput[];
  labelPriority: number[];
}

function buildGLTopology({ nodes, edges, positions }: MemoryGraph3DProps): GLGraphTopology {
  const indexById = new Map(nodes.map((node, i) => [node.id, i]));
  const baseNodes = nodes.map(node => {
    const root = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
    return {
      color: positions.get(node.id)?.color ?? "#7395ad",
      radius: root ? 10 : node.type === "SOURCE" ? 4.6 : 2.1,
      glow: root
    };
  });
  const edgePairs: MemoryGraphGLEdgeInput[] = [];
  for (const edge of edges) {
    const a = indexById.get(edge.source), b = indexById.get(edge.target);
    if (a === undefined || b === undefined) continue;
    edgePairs.push({ a, b, color: edge.type === "DERIVED_FROM" ? "#385068" : "#203343" });
  }
  const labelPriority = nodes.map((_, i) => i).sort((a, b) =>
    Number(isMemoryCoreLabel(nodes[b]!.label)) - Number(isMemoryCoreLabel(nodes[a]!.label)) ||
    Number(nodes[b]!.type === "SOURCE") - Number(nodes[a]!.type === "SOURCE") ||
    a - b
  );
  return { indexById, baseNodes, edgePairs, labelPriority };
}

function MemoryGraph3DGL(props: MemoryGraph3DProps & { onUnavailable: () => void }) {
  const { nodes, edges, positions, coordinates, showTitles, selectedNodeId, loading, onUnavailable } = props;
  const volumeRatio = useMemo(() => memory3DVolumeRatio([...coordinates.values()]), [coordinates]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelsRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef<MemoryCamera3D>({ ...DEFAULT_MEMORY_CAMERA });
  const redrawRef = useRef<() => void>(() => {});
  const rendererRef = useRef<MemoryGraphGLRenderer | null>(null);
  const graphDataRef = useRef<GLGraphData | null>(null);
  const viewRef = useRef<{ scale: number; extent: number; dpr: number }>({ scale: 1, extent: 60, dpr: 1 });
  const extentCacheRef = useRef<{ positions: Float32Array; extent: number } | null>(null);
  const hoverIndexRef = useRef<number | null>(null);
  const focusKeyRef = useRef<string>("");
  const topologyRef = useRef<{ nodes: unknown; edges: unknown; positions: unknown; presentCount: number } | null>(null);
  const current = useRef(props);
  current.current = props;
  const [contextLost, setContextLost] = useState(false);
  const contextLostRef = useRef(false);
  contextLostRef.current = contextLost;

  const topology = useMemo(() => buildGLTopology(props), [nodes, edges, positions]);
  // Frame data is rebuilt per streamed layout update; it is deliberately
  // limited to tight O(nodes + edges) loops (no sorting or allocation-heavy
  // work) so applying an update stays cheap at 50,000 nodes.
  const graphData = useMemo<GLGraphData>(() => {
    const flatPositions = new Float32Array(nodes.length * 3);
    const glNodes = topology.baseNodes.map((base, i) => {
      const point = coordinates.get(nodes[i]!.id);
      if (point) {
        flatPositions[i * 3] = point.x;
        flatPositions[i * 3 + 1] = point.y;
        flatPositions[i * 3 + 2] = point.z;
      }
      return { ...base, present: point !== undefined };
    });
    const glEdges = topology.edgePairs.filter(edge => glNodes[edge.a]!.present && glNodes[edge.b]!.present);
    return { indexById: topology.indexById, glNodes, glEdges, flatPositions, labelPriority: topology.labelPriority };
  }, [topology, coordinates, nodes]);

  const applyFocus = () => {
    const renderer = rendererRef.current;
    const data = graphDataRef.current;
    if (!renderer || !data) return;
    const focusId = hoverIndexRef.current !== null ? current.current.nodes[hoverIndexRef.current]?.id : current.current.selectedNodeId;
    const focusIndex = focusId ? data.indexById.get(focusId) ?? -1 : -1;
    const key = `${focusIndex}:${data.glNodes.length}`;
    if (key === focusKeyRef.current) return;
    focusKeyRef.current = key;
    if (focusIndex < 0) {
      renderer.setFocus(-1, null);
      return;
    }
    const neighbors = new Set<number>();
    for (const edge of current.current.edges) {
      if (edge.source === focusId) { const target = data.indexById.get(edge.target); if (target !== undefined) neighbors.add(target); }
      if (edge.target === focusId) { const source = data.indexById.get(edge.source); if (source !== undefined) neighbors.add(source); }
    }
    renderer.setFocus(focusIndex, neighbors);
  };

  useEffect(() => {
    cameraRef.current = { ...DEFAULT_MEMORY_CAMERA };
    redrawRef.current();
  }, [props.resetToken]);

  useEffect(() => {
    graphDataRef.current = graphData;
    const renderer = rendererRef.current;
    if (renderer) {
      // Node/edge buffers are rebuilt only when the graph topology or the
      // set of positioned nodes changes; streamed layout updates just
      // re-upload the position texture. A presentCount change must rebuild
      // the node buffers too: setGraph bakes each node's presence into its
      // radius (0 = hidden), and setEdges alone would leave stale radii.
      const previous = topologyRef.current;
      const presentCount = coordinates.size;
      if (!previous || previous.nodes !== nodes || previous.edges !== edges || previous.positions !== positions || previous.presentCount !== presentCount) {
        renderer.setGraph(graphData.glNodes, graphData.glEdges);
        focusKeyRef.current = "";
      }
      topologyRef.current = { nodes, edges, positions, presentCount };
      renderer.updatePositions(graphData.flatPositions);
      applyFocus();
    }
    redrawRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphData]);

  useEffect(() => { applyFocus(); redrawRef.current(); }, [selectedNodeId, showTitles]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const labelCanvas = labelsRef.current;
    if (!canvas || !labelCanvas) return;
    const renderer = MemoryGraphGLRenderer.tryCreate(canvas);
    if (!renderer) {
      onUnavailable();
      return;
    }
    rendererRef.current = renderer;
    if (graphDataRef.current) {
      renderer.setGraph(graphDataRef.current.glNodes, graphDataRef.current.glEdges);
      renderer.updatePositions(graphDataRef.current.flatPositions);
      topologyRef.current = { nodes: current.current.nodes, edges: current.current.edges, positions: current.current.positions, presentCount: current.current.coordinates.size };
      focusKeyRef.current = "";
      applyFocus();
    }
    const labelContext = labelCanvas.getContext("2d");
    let frame = 0, width = 1, height = 1, dpr = 1;
    let pendingPick: { x: number; y: number } | null = null;
    const pointers = new Map<number, { x: number; y: number }>();
    let dragged = false, downX = 0, downY = 0;

    const extentOf = (flat: Float32Array) => {
      if (extentCacheRef.current?.positions === flat) return extentCacheRef.current.extent;
      let extent = 60;
      for (let i = 0; i < flat.length; i += 3) {
        const magnitude = Math.hypot(flat[i]!, flat[i + 1]!, flat[i + 2]!);
        if (magnitude > extent) extent = magnitude;
      }
      extentCacheRef.current = { positions: flat, extent };
      return extent;
    };

    const drawLabels = (scale: number) => {
      if (!labelContext) return;
      labelContext.clearRect(0, 0, width, height);
      const data = graphDataRef.current;
      if (!data || !current.current.showTitles) return;
      const camera = cameraRef.current;
      const focusId = hoverIndexRef.current !== null ? current.current.nodes[hoverIndexRef.current]?.id : current.current.selectedNodeId;
      const flat = data.flatPositions;
      const budget = memoryGraphLabelBudget(camera.zoom);
      labelContext.font = "11px system-ui, sans-serif";
      function* candidates(): Generator<MemoryGraphLabelCandidate> {
        const seen = new Set<number>();
        const emit = function* (index: number) {
          if (seen.has(index)) return;
          seen.add(index);
          // Nodes without coordinates project to the origin; never label them.
          if (!data!.glNodes[index]!.present) return;
          const node = current.current.nodes[index]!;
          // Check eligibility before projecting: the projection is the
          // expensive part, and at low zoom every MEMORY node is ineligible.
          const eligible = node.type === "SOURCE" || node.id === focusId || camera.zoom >= 1.6;
          if (!eligible) return;
          const projected = projectMemoryPoint({ x: flat[index * 3]!, y: flat[index * 3 + 1]!, z: flat[index * 3 + 2]! }, camera, scale, width, height);
          yield {
            id: node.id,
            label: node.label.length > 48 ? `${node.label.slice(0, 45)}…` : node.label,
            x: projected.x,
            y: projected.y,
            core: isMemoryCoreLabel(node.label),
            eligible
          };
        };
        if (focusId) {
          const focusIndex = data!.indexById.get(focusId);
          if (focusIndex !== undefined) yield* emit(focusIndex);
        }
        for (const index of data!.labelPriority) yield* emit(index);
      }
      const planned = planMemoryGraphLabels(candidates(), {
        width, height, ...budget,
        measure: label => labelContext.measureText(label).width
      });
      for (const item of planned) {
        labelContext.fillStyle = "#09111bea";
        labelContext.fillRect(item.x - 3, item.y - 11, item.width + 6, 16);
        labelContext.fillStyle = item.core ? "#fff0b0" : "#c6dfed";
        labelContext.fillText(item.label, item.x, item.y + 1);
      }
    };

    const render = () => {
      frame = 0;
      const active = rendererRef.current;
      const data = graphDataRef.current;
      if (!active || !data || contextLostRef.current) return;
      if (pendingPick) {
        const pick = pendingPick;
        pendingPick = null;
        const picked = active.pick(pick.x, pick.y, cameraRef.current, viewRef.current.scale, viewRef.current.extent, dpr);
        const nextHover = picked >= 0 ? picked : null;
        if (nextHover !== hoverIndexRef.current) {
          hoverIndexRef.current = nextHover;
          canvas.style.cursor = nextHover !== null ? "pointer" : "grab";
          applyFocus();
        }
      }
      const extent = extentOf(data.flatPositions);
      const scale = Math.min(width, height) * 0.4 / extent;
      viewRef.current = { scale, extent, dpr };
      active.render(cameraRef.current, scale, extent, dpr);
      drawLabels(scale);
      canvas.dataset.rotation = `${cameraRef.current.yaw.toFixed(3)},${cameraRef.current.pitch.toFixed(3)}`;
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(render); };
    redrawRef.current = schedule;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width; height = rect.height;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
      labelCanvas.width = Math.round(width * dpr); labelCanvas.height = Math.round(height * dpr);
      labelContext?.setTransform(dpr, 0, 0, dpr, 0, 0);
      schedule();
    };
    const local = (event: PointerEvent) => { const rect = canvas.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
    const pickNow = (x: number, y: number) => {
      const active = rendererRef.current;
      if (!active) return -1;
      return active.pick(x, y, cameraRef.current, viewRef.current.scale, viewRef.current.extent, dpr);
    };
    const down = (event: PointerEvent) => {
      canvas.focus(); canvas.setPointerCapture(event.pointerId);
      const p = local(event); pointers.set(event.pointerId, p); downX = p.x; downY = p.y; dragged = false;
      if (hoverIndexRef.current !== null) { hoverIndexRef.current = null; applyFocus(); }
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
      } else { pendingPick = p; }
      schedule();
    };
    const up = (event: PointerEvent) => {
      const p = local(event);
      if (!dragged && pointers.size === 1) { const picked = pickNow(p.x, p.y); if (picked >= 0) { const node = current.current.nodes[picked]; if (node) current.current.onSelectNode(node.id); } }
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
    const onContextLost = (event: Event) => { event.preventDefault(); setContextLost(true); };
    const onContextRestored = () => {
      const restored = MemoryGraphGLRenderer.tryCreate(canvas);
      if (!restored) {
        // Restoration failed: fall back to the Canvas 2D renderer instead of
        // showing a blank, non-interactive surface backed by a dead context.
        rendererRef.current = null;
        onUnavailable();
        return;
      }
      rendererRef.current = restored;
      if (graphDataRef.current) {
        restored.setGraph(graphDataRef.current.glNodes, graphDataRef.current.glEdges);
        restored.updatePositions(graphDataRef.current.flatPositions);
        topologyRef.current = { nodes: current.current.nodes, edges: current.current.edges, positions: current.current.positions, presentCount: current.current.coordinates.size };
        focusKeyRef.current = "";
        applyFocus();
      }
      setContextLost(false);
      schedule();
    };
    const observer = new ResizeObserver(resize); observer.observe(canvas); resize();
    canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointermove", move); canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", cancel); canvas.addEventListener("wheel", wheel, { passive: false }); canvas.addEventListener("keydown", key);
    canvas.addEventListener("webglcontextlost", onContextLost); canvas.addEventListener("webglcontextrestored", onContextRestored);
    return () => {
      observer.disconnect(); cancelAnimationFrame(frame); redrawRef.current = () => {};
      canvas.removeEventListener("pointerdown", down); canvas.removeEventListener("pointermove", move); canvas.removeEventListener("pointerup", up); canvas.removeEventListener("pointercancel", cancel); canvas.removeEventListener("wheel", wheel); canvas.removeEventListener("keydown", key);
      canvas.removeEventListener("webglcontextlost", onContextLost); canvas.removeEventListener("webglcontextrestored", onContextRestored);
      renderer.dispose();
      // A context restore may have swapped in a second renderer; dispose it
      // too instead of leaking it.
      if (rendererRef.current && rendererRef.current !== renderer) rendererRef.current.dispose();
      rendererRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <div className="memory-3d-surface" style={contextLost ? { visibility: "hidden" } : undefined}>
        <canvas ref={canvasRef} tabIndex={0} role="application" aria-label="3D memory graph. Drag or use arrow keys to rotate 360 degrees. Scroll or pinch to zoom. Click a node to open." aria-busy={loading} data-titles-visible={showTitles} data-layout-volume={volumeRatio.toFixed(4)} />
        <canvas ref={labelsRef} className="memory-3d-labels" aria-hidden="true" />
        <span className="memory-3d-hint">Drag to rotate 360° · Scroll or pinch to zoom · Click to explore</span>
      </div>
      {contextLost ? <MemoryGraph3DLegacy {...fallbackProps(props)} /> : null}
    </>
  );
}

function MemoryGraph3DLegacy({ nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode, loading, resetToken }: MemoryGraph3DProps) {
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
