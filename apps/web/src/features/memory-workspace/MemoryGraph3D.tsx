import { useEffect, useMemo, useRef } from "react";
import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import {
  DEFAULT_MEMORY_CAMERA,
  memory3DVolumeRatio,
  projectMemoryPoint,
  type MemoryCamera3D,
  type MemoryPoint3D
} from "./memory-3d.js";
import { WebGL2MemoryGraphRenderer } from "./memory-graph-webgl.js";

const MAX_OVERLAY_TITLES = 70;
const CANVAS_2D_NODE_CAP = 2000;

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
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
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
    const overlayCanvas = overlayCanvasRef.current;

    let frame = 0;
    let width = 1;
    let height = 1;
    let hover: string | null = null;
    const pointers = new Map<number, { x: number; y: number }>();
    let dragged = false;
    let downX = 0;
    let downY = 0;

    // WebGL2 Renderer instance & state
    let webglRenderer: WebGL2MemoryGraphRenderer | null = null;
    let isContextLost = false;
    let fallback2DContext: CanvasRenderingContext2D | null = null;
    let overlayContext: CanvasRenderingContext2D | null = null;

    // Track points for 2D fallback hit-testing
    let points2D: Array<{ id: string; x: number; y: number; z: number; radius: number }> = [];

    const isWebGL2Available = typeof window !== "undefined" && typeof WebGL2RenderingContext !== "undefined";

    if (isWebGL2Available) {
      try {
        webglRenderer = new WebGL2MemoryGraphRenderer(canvas);
        if (overlayCanvas) {
          overlayContext = overlayCanvas.getContext("2d");
        }
      } catch {
        webglRenderer = null;
      }
    }

    if (!webglRenderer) {
      fallback2DContext = canvas.getContext("2d");
    }

    canvas.dataset.rotation = `${cameraRef.current.yaw.toFixed(3)},${cameraRef.current.pitch.toFixed(3)}`;
    const updateGraphData = () => {
      const { nodes, edges, positions, coordinates, selectedNodeId } = current.current;
      if (webglRenderer && !isContextLost) {
        webglRenderer.setGraph(nodes, edges, positions, coordinates);
        webglRenderer.setFocus(hover ?? selectedNodeId);
      }
    };

    // Initial graph upload
    updateGraphData();

    // 2D Fallback renderer (with 2,000 node cap)
    const render2DFallback = (ctx: CanvasRenderingContext2D) => {
      const { nodes, edges, positions, coordinates, showTitles, selectedNodeId } = current.current;
      ctx.clearRect(0, 0, width, height);

      let nodesToDraw = nodes;
      let edgesToDraw = edges;
      const focus = hover ?? selectedNodeId;

      if (nodes.length > CANVAS_2D_NODE_CAP) {
        const allowed = new Set<string>();
        if (focus) allowed.add(focus);
        for (const n of nodes) {
          if (isMemoryCoreLabel(n.label)) allowed.add(n.id);
        }
        for (const n of nodes) {
          if (allowed.size >= 1000) break;
          if (n.type === "SOURCE") allowed.add(n.id);
        }
        for (const n of nodes) {
          if (allowed.size >= CANVAS_2D_NODE_CAP) break;
          allowed.add(n.id);
        }
        nodesToDraw = nodes.filter(n => allowed.has(n.id));
        edgesToDraw = edges.filter(e => allowed.has(e.source) && allowed.has(e.target));
      }

      const extent = Math.max(60, ...[...coordinates.values()].map(p => Math.hypot(p.x, p.y, p.z)));
      const scale = Math.min(width, height) * 0.4 / extent;
      const projected = new Map(nodesToDraw.flatMap(node => {
        const p = coordinates.get(node.id);
        return p ? [[node.id, projectMemoryPoint(p, cameraRef.current, scale, width, height)] as const] : [];
      }));

      const neighbors = new Set<string>();
      if (focus) {
        for (const edge of edgesToDraw) {
          if (edge.source === focus) neighbors.add(edge.target);
          if (edge.target === focus) neighbors.add(edge.source);
        }
      }

      ctx.lineWidth = 0.55;
      for (const edge of edgesToDraw) {
        const a = projected.get(edge.source);
        const b = projected.get(edge.target);
        if (!a || !b) continue;
        const incident = edge.source === focus || edge.target === focus;
        ctx.strokeStyle = incident ? "#98dafa" : focus ? "#14202b" : edge.type === "DERIVED_FROM" ? "#385068" : "#203343";
        ctx.lineWidth = incident ? 1.15 : 0.55;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }

      points2D = [];
      const ordered = nodesToDraw.filter(node => projected.has(node.id)).sort((a, b) => projected.get(b.id)!.z - projected.get(a.id)!.z);
      const labelBoxes: Array<{ x: number; y: number; w: number }> = [];

      for (const node of ordered) {
        const p = projected.get(node.id)!;
        const highlighted = node.id === focus;
        const root = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
        const radius = Math.max(1, (root ? 10 : node.type === "SOURCE" ? 4.6 : 2.1) * p.perspective * Math.sqrt(cameraRef.current.zoom)) * (highlighted ? 1.5 : 1);
        points2D.push({ id: node.id, ...p, radius });
        ctx.globalAlpha = focus && !highlighted && !neighbors.has(node.id) ? 0.2 : Math.max(0.4, Math.min(1, p.perspective));
        ctx.fillStyle = highlighted ? "#ffffff" : positions.get(node.id)?.color ?? "#7395ad";
        if (root || highlighted) {
          ctx.shadowColor = ctx.fillStyle;
          ctx.shadowBlur = 13;
        }
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }
      ctx.globalAlpha = 1;

      if (showTitles) {
        const labeled = [...ordered].sort((a, b) =>
          Number(b.id === focus) - Number(a.id === focus) ||
          Number(isMemoryCoreLabel(b.label)) - Number(isMemoryCoreLabel(a.label)) ||
          Number(b.type === "SOURCE") - Number(a.type === "SOURCE")
        );
        ctx.font = "11px system-ui, sans-serif";
        for (const node of labeled) {
          if (labelBoxes.length >= MAX_OVERLAY_TITLES) break;
          if (node.type !== "SOURCE" && node.id !== focus && cameraRef.current.zoom < 1.6) continue;
          const p = projected.get(node.id)!;
          const label = node.label.length > 48 ? `${node.label.slice(0, 45)}…` : node.label;
          const x = p.x + 9;
          const y = p.y;
          const w = ctx.measureText(label).width;
          if (x + w > width || y < 14 || y > height - 5 || labelBoxes.some(box => Math.abs(box.y - y) < 16 && x < box.x + box.w + 5 && x + w + 5 > box.x)) continue;
          labelBoxes.push({ x, y, w });
          ctx.fillStyle = "#09111bea";
          ctx.fillRect(x - 3, y - 11, w + 6, 16);
          ctx.fillStyle = isMemoryCoreLabel(node.label) ? "#fff0b0" : "#c6dfed";
          ctx.fillText(label, x, y + 1);
        }
      }
    };

    // Bounded LOD 2D Overlay for Titles
    const renderOverlayTitles = (ctx: CanvasRenderingContext2D, extent: number, scale: number) => {
      ctx.clearRect(0, 0, width, height);
      const { nodes, coordinates, showTitles, selectedNodeId } = current.current;
      if (!showTitles || nodes.length === 0) return;

      const focus = hover ?? selectedNodeId;
      const labelBoxes: Array<{ x: number; y: number; w: number }> = [];

      // Collect candidates: focus first, core roots, sources, and if zoomed in other records
      const candidates: MemoryGraphNode[] = [];
      let focusNode: MemoryGraphNode | undefined;

      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i]!;
        if (node.id === focus) {
          focusNode = node;
          continue;
        }
        const isCore = isMemoryCoreLabel(node.label);
        const isSource = node.type === "SOURCE";
        if (isCore || isSource || (cameraRef.current.zoom >= 1.6 && candidates.length < 120)) {
          candidates.push(node);
          if (candidates.length >= 150) break;
        }
      }

      candidates.sort((a, b) => {
        const aCore = isMemoryCoreLabel(a.label) ? 1 : 0;
        const bCore = isMemoryCoreLabel(b.label) ? 1 : 0;
        if (aCore !== bCore) return bCore - aCore;
        const aSource = a.type === "SOURCE" ? 1 : 0;
        const bSource = b.type === "SOURCE" ? 1 : 0;
        return bSource - aSource;
      });

      if (focusNode) candidates.unshift(focusNode);

      ctx.font = "11px system-ui, sans-serif";
      for (const node of candidates) {
        if (labelBoxes.length >= MAX_OVERLAY_TITLES) break;
        const coord = coordinates.get(node.id);
        if (!coord) continue;

        const p = projectMemoryPoint(coord, cameraRef.current, scale, width, height);
        const label = node.label.length > 48 ? `${node.label.slice(0, 45)}…` : node.label;
        const x = p.x + 9;
        const y = p.y;
        const w = ctx.measureText(label).width;

        if (x + w > width || y < 14 || y > height - 5) continue;
        if (labelBoxes.some(box => Math.abs(box.y - y) < 16 && x < box.x + box.w + 5 && x + w + 5 > box.x)) continue;

        labelBoxes.push({ x, y, w });
        ctx.fillStyle = "#09111bea";
        ctx.fillRect(x - 3, y - 11, w + 6, 16);
        ctx.fillStyle = isMemoryCoreLabel(node.label) ? "#fff0b0" : "#c6dfed";
        ctx.fillText(label, x, y + 1);
      }
    };

    const render = () => {
      frame = 0;
      const { coordinates, selectedNodeId } = current.current;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const extent = Math.max(60, ...[...coordinates.values()].map(p => Math.hypot(p.x, p.y, p.z)));
      const scale = Math.min(width, height) * 0.4 / extent;

      if (webglRenderer && !isContextLost) {
        webglRenderer.setFocus(hover ?? selectedNodeId);
        webglRenderer.render(cameraRef.current, scale, extent, width, height, dpr);
        if (overlayContext) {
          renderOverlayTitles(overlayContext, extent, scale);
        }
      } else if (fallback2DContext) {
        render2DFallback(fallback2DContext);
      } else if (overlayContext) {
        render2DFallback(overlayContext);
      }

      canvas.dataset.rotation = `${cameraRef.current.yaw.toFixed(3)},${cameraRef.current.pitch.toFixed(3)}`;
    };

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(render);
    };
    redrawRef.current = () => {
      updateGraphData();
      schedule();
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);

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

    const hit = (x: number, y: number): string | null => {
      if (webglRenderer && !isContextLost) {
        const { coordinates } = current.current;
        const extent = Math.max(60, ...[...coordinates.values()].map(p => Math.hypot(p.x, p.y, p.z)));
        const scale = Math.min(width, height) * 0.4 / extent;
        return webglRenderer.pick(x, y, cameraRef.current, scale, extent, width, height);
      }
      return [...points2D].reverse().find(p => Math.hypot(p.x - x, p.y - y) < Math.max(7, p.radius + 3))?.id ?? null;
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
            cameraRef.current.zoom = Math.max(0.35, Math.min(5, cameraRef.current.zoom * after / before));
          }
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
      if (canvas.hasPointerCapture(event.pointerId)) {
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
      schedule();
    };

    const key = (event: KeyboardEvent) => {
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        cameraRef.current.yaw += event.key === "ArrowLeft" ? -0.15 : event.key === "ArrowRight" ? 0.15 : 0;
        cameraRef.current.pitch += event.key === "ArrowUp" ? -0.15 : event.key === "ArrowDown" ? 0.15 : 0;
        canvas.dataset.rotation = `${cameraRef.current.yaw.toFixed(3)},${cameraRef.current.pitch.toFixed(3)}`;
        schedule();
      } else if (event.key === "Enter") {
        const node =
          current.current.nodes.find(node => node.id === current.current.selectedNodeId) ??
          current.current.nodes.find(node => isMemoryCoreLabel(node.label));
        if (node) current.current.onSelectNode(node.id);
      }
    };

    const handleContextLost = (event: Event) => {
      event.preventDefault();
      isContextLost = true;
      if (webglRenderer) {
        webglRenderer.destroy();
        webglRenderer = null;
      }
      schedule();
    };

    const handleContextRestored = () => {
      isContextLost = false;
      try {
        webglRenderer = new WebGL2MemoryGraphRenderer(canvas);
        updateGraphData();
      } catch {
        webglRenderer = null;
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
    canvas.addEventListener("webglcontextlost", handleContextLost);
    canvas.addEventListener("webglcontextrestored", handleContextRestored);

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
      if (webglRenderer) {
        webglRenderer.destroy();
        webglRenderer = null;
      }
    };
  }, []);

  useEffect(() => {
    redrawRef.current();
  }, [nodes, edges, positions, coordinates, showTitles, selectedNodeId]);

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
        data-rotation={`${cameraRef.current.yaw.toFixed(3)},${cameraRef.current.pitch.toFixed(3)}`}
      />
      <canvas
        ref={overlayCanvasRef}
        aria-hidden="true"
        tabIndex={-1}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none"
        }}
      />
      <span className="memory-3d-hint">Drag to rotate 360° · Scroll or pinch to zoom · Click to explore</span>
    </div>
  );
}
