import { useEffect, useMemo, useRef, useState } from "react";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import { DEFAULT_MEMORY_CAMERA, memory3DVolumeRatio, projectMemoryPoint, type MemoryCamera3D, type MemoryPoint3D } from "./memory-3d.js";
import { MemoryWebGLRenderer } from "./memory-webgl.js";
import { MemorySpatialIndex, type ProjectedNodePoint } from "./memory-picking.js";
import { selectBoundedLabels } from "./memory-labels.js";

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
  const labelsCanvasRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef<MemoryCamera3D>({ ...DEFAULT_MEMORY_CAMERA });
  const redrawRef = useRef<() => void>(() => {});
  const [useFallback, setUseFallback] = useState(false);

  const current = useRef({
    nodes,
    edges,
    positions,
    coordinates,
    showTitles,
    selectedNodeId,
    onSelectNode
  });
  current.current = {
    nodes,
    edges,
    positions,
    coordinates,
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
    const labelsCanvas = labelsCanvasRef.current;
    if (!canvas || !labelsCanvas) return;

    let frame = 0;
    let width = 1;
    let height = 1;
    let hover: string | null = null;
    const spatialIndex = new MemorySpatialIndex();
    let currentProjectedPoints: ProjectedNodePoint[] = [];

    // Probe WebGL2 context
    let gl: WebGL2RenderingContext | null = null;
    let renderer: MemoryWebGLRenderer | null = null;

    try {
      gl = canvas.getContext("webgl2", {
        alpha: true,
        antialias: true,
        depth: true,
        preserveDrawingBuffer: false
      });
      if (gl) {
        renderer = new MemoryWebGLRenderer(gl);
      }
    } catch {
      gl = null;
      renderer = null;
    }

    if (!gl || !renderer) {
      setUseFallback(true);
    }

    const labelsCtx = labelsCanvas.getContext("2d");

    const pointers = new Map<number, { x: number; y: number }>();
    let dragged = false;
    let downX = 0;
    let downY = 0;

    // Frame-time measurement ring buffer
    const frameTimes: number[] = [];
    let lastFrameTimestamp = 0;

    const render = (timestamp: number = performance.now()) => {
      frame = 0;
      if (lastFrameTimestamp > 0) {
        const delta = timestamp - lastFrameTimestamp;
        if (delta < 200) {
          frameTimes.push(delta);
          if (frameTimes.length > 60) frameTimes.shift();
        }
      }
      lastFrameTimestamp = timestamp;

      const { nodes, edges, positions, coordinates, showTitles, selectedNodeId } = current.current;
      const focus = hover ?? selectedNodeId;

      // Calculate spatial bounds and camera scale with loop to avoid stack overflow at 50k nodes
      let extent = 60;
      for (const p of coordinates.values()) {
        const d = Math.hypot(p.x, p.y, p.z);
        if (d > extent) extent = d;
      }
      const scale = Math.min(width, height) * 0.4 / extent;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);

      if (renderer && gl && !gl.isContextLost() && !useFallback) {
        // --- WebGL2 Rendering Path (scales to 50k nodes / 150k edges at 60fps) ---
        currentProjectedPoints = renderer.render(
          nodes,
          edges,
          positions,
          coordinates,
          cameraRef.current,
          scale,
          width,
          height,
          dpr,
          focus
        );

        // Build Spatial Index for sub-4ms O(1) picking
        spatialIndex.build(currentProjectedPoints, width, height, 32);

        // Render Bounded Labels (Level-of-Detail)
        if (labelsCtx) {
          labelsCtx.clearRect(0, 0, width, height);
          if (showTitles && nodes.length > 0) {
            labelsCtx.font = "11px system-ui, sans-serif";
            const projectedMap = new Map(currentProjectedPoints.map(p => [p.id, p]));
            const placedLabels = selectBoundedLabels(
              nodes,
              projectedMap,
              focus,
              cameraRef.current.zoom,
              width,
              height,
              label => ({ width: labelsCtx.measureText(label).width }),
              120, // max evaluated
              50   // max drawn
            );

            for (const item of placedLabels) {
              labelsCtx.fillStyle = "#09111bea";
              labelsCtx.fillRect(item.x - 3, item.y - 11, item.w + 6, 16);
              labelsCtx.fillStyle = item.isCore ? "#fff0b0" : "#c6dfed";
              labelsCtx.fillText(item.label, item.x, item.y + 1);
            }
          }
        }
      } else if (labelsCtx) {
        // --- Canvas 2D Fallback Path (capped at 2,000 nodes, rendered onto dedicated 2D overlay) ---
        const activeNodes = nodes.length > 2000 ? nodes.slice(0, 2000) : nodes;
        const activeNodeIds = new Set(activeNodes.map(n => n.id));
        const activeEdges = edges.filter(e => activeNodeIds.has(e.source) && activeNodeIds.has(e.target)).slice(0, 6000);

        labelsCtx.clearRect(0, 0, width, height);
        const projected = new Map(activeNodes.flatMap(node => {
          const p = coordinates.get(node.id);
          return p ? [[node.id, projectMemoryPoint(p, cameraRef.current, scale, width, height)] as const] : [];
        }));

        const neighbors = new Set<string>();
        if (focus) {
          for (const edge of activeEdges) {
            if (edge.source === focus) neighbors.add(edge.target);
            if (edge.target === focus) neighbors.add(edge.source);
          }
        }

        labelsCtx.lineWidth = 0.55;
        for (const edge of activeEdges) {
          const a = projected.get(edge.source), b = projected.get(edge.target);
          if (!a || !b) continue;
          const incident = edge.source === focus || edge.target === focus;
          labelsCtx.strokeStyle = incident ? "#98dafa" : focus ? "#14202b" : edge.type === "DERIVED_FROM" ? "#385068" : "#203343";
          labelsCtx.lineWidth = incident ? 1.15 : 0.55;
          labelsCtx.beginPath();
          labelsCtx.moveTo(a.x, a.y);
          labelsCtx.lineTo(b.x, b.y);
          labelsCtx.stroke();
        }

        const fallbackPoints: ProjectedNodePoint[] = [];
        // Draw farthest nodes first so foreground nodes render on top in 2D
        const ordered = activeNodes.filter(node => projected.has(node.id)).sort((a, b) => projected.get(b.id)!.z - projected.get(a.id)!.z);
        const labelBoxes: Array<{ x: number; y: number; w: number }> = [];

        for (const node of ordered) {
          const p = projected.get(node.id)!;
          const highlighted = node.id === focus;
          const root = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
          const radius = Math.max(1, (root ? 10 : node.type === "SOURCE" ? 4.6 : 2.1) * p.perspective * Math.sqrt(cameraRef.current.zoom)) * (highlighted ? 1.5 : 1);
          fallbackPoints.push({ id: node.id, ...p, radius });
          labelsCtx.globalAlpha = focus && !highlighted && !neighbors.has(node.id) ? 0.2 : Math.max(0.4, Math.min(1, p.perspective));
          labelsCtx.fillStyle = highlighted ? "#ffffff" : positions.get(node.id)?.color ?? "#7395ad";
          if (root || highlighted) { labelsCtx.shadowColor = labelsCtx.fillStyle; labelsCtx.shadowBlur = 13; }
          labelsCtx.beginPath();
          labelsCtx.arc(p.x, p.y, radius, 0, Math.PI * 2);
          labelsCtx.fill();
          labelsCtx.shadowBlur = 0;
        }
        labelsCtx.globalAlpha = 1;

        if (showTitles) {
          const labeled = [...ordered].sort((a, b) => Number(b.id === focus) - Number(a.id === focus) || Number(isMemoryCoreLabel(b.label)) - Number(isMemoryCoreLabel(a.label)) || Number(b.type === "SOURCE") - Number(a.type === "SOURCE"));
          labelsCtx.font = "11px system-ui, sans-serif";
          for (const node of labeled) {
            if (node.type !== "SOURCE" && node.id !== focus && cameraRef.current.zoom < 1.6) continue;
            const p = projected.get(node.id)!;
            const label = node.label.length > 48 ? `${node.label.slice(0, 45)}…` : node.label;
            const x = p.x + 9, y = p.y, w = labelsCtx.measureText(label).width;
            if (x + w > width || y < 14 || y > height - 5 || labelBoxes.some(box => Math.abs(box.y - y) < 16 && x < box.x + box.w + 5 && x + w + 5 > box.x)) continue;
            labelBoxes.push({ x, y, w });
            labelsCtx.fillStyle = "#09111bea";
            labelsCtx.fillRect(x - 3, y - 11, w + 6, 16);
            labelsCtx.fillStyle = isMemoryCoreLabel(node.label) ? "#fff0b0" : "#c6dfed";
            labelsCtx.fillText(label, x, y + 1);
          }
        }

        currentProjectedPoints = fallbackPoints;
        spatialIndex.build(fallbackPoints, width, height, 32);
      }

      // Preserve accessibility and test data attributes
      canvas.dataset.rotation = `${cameraRef.current.yaw.toFixed(3)},${cameraRef.current.pitch.toFixed(3)}`;
      if (frameTimes.length > 10) {
        const sorted = [...frameTimes].sort((a, b) => a - b);
        const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
        canvas.dataset.p95FrameTime = p95.toFixed(2);
      }
    };

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(render);
    };
    redrawRef.current = schedule;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);

      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);

      labelsCanvas.width = Math.round(width * dpr);
      labelsCanvas.height = Math.round(height * dpr);
      if (labelsCtx) {
        labelsCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      schedule();
    };

    const hit = (x: number, y: number): string | null => {
      return spatialIndex.pick(x, y);
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
      cameraRef.current.zoom = Math.max(
        0.35,
        Math.min(5, cameraRef.current.zoom * Math.exp(-event.deltaY * 0.001))
      );
      schedule();
    };

    const key = (event: KeyboardEvent) => {
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        cameraRef.current.yaw += event.key === "ArrowLeft" ? -0.15 : event.key === "ArrowRight" ? 0.15 : 0;
        cameraRef.current.pitch += event.key === "ArrowUp" ? -0.15 : event.key === "ArrowDown" ? 0.15 : 0;
        schedule();
      } else if (event.key === "Enter") {
        const node = current.current.nodes.find(node => node.id === current.current.selectedNodeId) ??
          current.current.nodes.find(node => isMemoryCoreLabel(node.label));
        if (node) current.current.onSelectNode(node.id);
      }
    };

    // WebGL Context Loss & Restoration Handling
    const handleContextLost = (event: Event) => {
      event.preventDefault();
      setUseFallback(true);
      renderer?.destroy();
      renderer = null;
      gl = null;
      schedule();
    };

    const handleContextRestored = () => {
      try {
        gl = canvas.getContext("webgl2", {
          alpha: true,
          antialias: true,
          depth: true
        });
        if (gl) {
          renderer = new MemoryWebGLRenderer(gl);
          setUseFallback(false);
        }
      } catch {
        setUseFallback(true);
      }
      schedule();
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    canvas.addEventListener("webglcontextlost", handleContextLost);
    canvas.addEventListener("webglcontextrestored", handleContextRestored);
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
      renderer?.destroy();
      canvas.removeEventListener("webglcontextlost", handleContextLost);
      canvas.removeEventListener("webglcontextrestored", handleContextRestored);
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", cancel);
      canvas.removeEventListener("wheel", wheel);
      canvas.removeEventListener("keydown", key);
    };
  }, []);

  useEffect(() => {
    redrawRef.current();
  }, [nodes, edges, positions, coordinates, showTitles, selectedNodeId]);

  return (
    <div className="memory-3d-surface" style={{ position: "relative", width: "100%", height: "100%" }}>
      <canvas
        ref={canvasRef}
        tabIndex={0}
        role="application"
        aria-label="3D memory graph. Drag or use arrow keys to rotate 360 degrees. Scroll or pinch to zoom. Click a node to open."
        aria-busy={loading}
        data-titles-visible={showTitles}
        data-layout-volume={volumeRatio.toFixed(4)}
        style={{ width: "100%", height: "100%", display: "block" }}
      />
      <canvas
        ref={labelsCanvasRef}
        aria-hidden="true"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none"
        }}
      />
      <span className="memory-3d-hint">Drag to rotate 360° · Scroll or pinch to zoom · Click to explore</span>
    </div>
  );
}
