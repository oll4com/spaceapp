import { useEffect, useMemo, useRef, useState } from "react";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import { DEFAULT_MEMORY_CAMERA, memory3DVolumeRatio, projectMemoryPoint, type MemoryCamera3D, type MemoryPoint3D } from "./memory-3d.js";
import { createWebGL2GraphRenderer, encodePickingColor, type WebGL2GraphRenderer } from "./memory-graph-webgl.js";

/**
 * Parses a hex color string (#rgb or #rrggbb) into normalized RGBA floats [0-1].
 *
 * @param hex - Color in hex format.
 * @param alpha - Optional alpha value (default: 1.0).
 * @returns Tuple of [r, g, b, a] in 0-1 range.
 */
function parseHexColor(hex: string, alpha = 1.0): [number, number, number, number] {
  if (hex.startsWith("#")) {
    const clean = hex.slice(1);
    if (clean.length === 3) {
      const c0 = clean[0] ?? "0";
      const c1 = clean[1] ?? "0";
      const c2 = clean[2] ?? "0";
      const r = parseInt(c0 + c0, 16) / 255;
      const g = parseInt(c1 + c1, 16) / 255;
      const b = parseInt(c2 + c2, 16) / 255;
      return [r, g, b, alpha];
    }
    if (clean.length >= 6) {
      const r = parseInt(clean.slice(0, 2), 16) / 255;
      const g = parseInt(clean.slice(2, 4), 16) / 255;
      const b = parseInt(clean.slice(4, 6), 16) / 255;
      return [r, g, b, alpha];
    }
  }
  return [0.45, 0.58, 0.68, alpha];
}

/**
 * Interactive 3D memory graph visualizer supporting up to 50,000 nodes using WebGL2,
 * with hardware depth testing, GPU color-indexed picking, and Canvas 2D fallback.
 */
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
  const [useFallback2D, setUseFallback2D] = useState(false);

  const current = useRef({ nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode });
  current.current = { nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode };

  useEffect(() => {
    cameraRef.current = { ...DEFAULT_MEMORY_CAMERA };
    redrawRef.current();
  }, [resetToken]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const overlay = overlayCanvasRef.current;
    if (!canvas || !overlay) return;

    let width = 1, height = 1;
    let frame = 0;
    let hoverId: string | null = null;
    const pointers = new Map<number, { x: number; y: number }>();
    let dragged = false, downX = 0, downY = 0;

    let webglRenderer: WebGL2GraphRenderer | null = null;
    let nodePointsBuf = new Float32Array(0);
    let nodeColorsBuf = new Float32Array(0);
    let nodeRadiiBuf = new Float32Array(0);
    let pickingIdsBuf = new Float32Array(0);
    let edgePointsBuf = new Float32Array(0);
    let edgeColorsBuf = new Float32Array(0);

    let activeNodes: MemoryGraphNode[] = [];
    let canvas2dPoints: Array<{ id: string; x: number; y: number; z: number; radius: number }> = [];

    let isContextLost = false;

    function initRenderer() {
      if (webglRenderer) {
        webglRenderer.destroy();
        webglRenderer = null;
      }
      try {
        webglRenderer = createWebGL2GraphRenderer(canvas as HTMLCanvasElement);
        if (!webglRenderer) {
          console.warn("WebGL2 unsupported, falling back to Canvas 2D");
          setUseFallback2D(true);
        } else {
          setUseFallback2D(false);
          isContextLost = false;
        }
      } catch (err) {
        console.warn("WebGL2 initialization failed, falling back to Canvas 2D:", err);
        setUseFallback2D(true);
      }
    }
    if (!useFallback2D) {
      initRenderer();
    }

    const handleContextLost = (e: Event) => {
      e.preventDefault();
      console.warn("WebGL2 context lost. Rendering fallback on overlay canvas.");
      isContextLost = true;
      if (webglRenderer) {
        webglRenderer.destroy();
        webglRenderer = null;
      }
      schedule();
    };

    const handleContextRestored = () => {
      console.log("WebGL2 context restored. Reinitializing WebGL2 renderer.");
      isContextLost = false;
      initRenderer();
      schedule();
    };

    canvas.addEventListener("webglcontextlost", handleContextLost);
    canvas.addEventListener("webglcontextrestored", handleContextRestored);

    const render = () => {
      frame = 0;
      const { nodes, edges, positions, coordinates, showTitles, selectedNodeId } = current.current;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const focus = hoverId ?? selectedNodeId;

      canvas.dataset.rotation = `${cameraRef.current.yaw.toFixed(3)},${cameraRef.current.pitch.toFixed(3)}`;

      // Filter nodes that have coordinates
      activeNodes = nodes.filter(n => coordinates.has(n.id));
      const nodeCount = activeNodes.length;

      const extent = Math.max(60, ...[...coordinates.values()].map(p => Math.hypot(p.x, p.y, p.z)));
      const scale = (Math.min(width, height) * 0.4) / extent;

      const neighbors = new Set<string>();
      if (focus) {
        for (const edge of edges) {
          if (edge.source === focus) neighbors.add(edge.target);
          if (edge.target === focus) neighbors.add(edge.source);
        }
      }

      if (webglRenderer && !isContextLost && !useFallback2D) {
        // --- WebGL2 Rendering Path ---
        if (nodePointsBuf.length < nodeCount * 3) {
          nodePointsBuf = new Float32Array(Math.max(nodeCount * 3, 3000));
          nodeColorsBuf = new Float32Array(Math.max(nodeCount * 4, 4000));
          nodeRadiiBuf = new Float32Array(Math.max(nodeCount, 1000));
          pickingIdsBuf = new Float32Array(Math.max(nodeCount * 3, 3000));
        }

        for (let i = 0; i < nodeCount; i++) {
          const node = activeNodes[i]!;
          const p = coordinates.get(node.id)!;
          nodePointsBuf[i * 3] = p.x;
          nodePointsBuf[i * 3 + 1] = p.y;
          nodePointsBuf[i * 3 + 2] = p.z;

          const highlighted = node.id === focus;
          const root = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
          const baseRadius = (root ? 10 : node.type === "SOURCE" ? 4.6 : 2.1) * (highlighted ? 1.5 : 1);
          nodeRadiiBuf[i] = baseRadius;

          const colorHex = highlighted ? "#ffffff" : positions.get(node.id)?.color ?? "#7395ad";
          const isDimmed = focus && !highlighted && !neighbors.has(node.id);
          const alpha = isDimmed ? 0.2 : 0.85;
          const [r, g, b, a] = parseHexColor(colorHex, alpha);
          nodeColorsBuf[i * 4] = r;
          nodeColorsBuf[i * 4 + 1] = g;
          nodeColorsBuf[i * 4 + 2] = b;
          nodeColorsBuf[i * 4 + 3] = a;

          // Picking ID (i + 1 encoded into RGB bytes)
          const [pr, pg, pb] = encodePickingColor(i);
          pickingIdsBuf[i * 3] = pr / 255;
          pickingIdsBuf[i * 3 + 1] = pg / 255;
          pickingIdsBuf[i * 3 + 2] = pb / 255;
        }

        // Edge buffers
        const validEdges: MemoryGraphEdge[] = [];
        for (const edge of edges) {
          if (coordinates.has(edge.source) && coordinates.has(edge.target)) {
            validEdges.push(edge);
          }
        }
        const edgeVertexCount = validEdges.length * 2;
        if (edgePointsBuf.length < edgeVertexCount * 3) {
          edgePointsBuf = new Float32Array(Math.max(edgeVertexCount * 3, 6000));
          edgeColorsBuf = new Float32Array(Math.max(edgeVertexCount * 4, 8000));
        }

        for (let i = 0; i < validEdges.length; i++) {
          const edge = validEdges[i]!;
          const pA = coordinates.get(edge.source)!;
          const pB = coordinates.get(edge.target)!;

          const v0 = i * 2;
          const v1 = i * 2 + 1;

          edgePointsBuf[v0 * 3] = pA.x;
          edgePointsBuf[v0 * 3 + 1] = pA.y;
          edgePointsBuf[v0 * 3 + 2] = pA.z;

          edgePointsBuf[v1 * 3] = pB.x;
          edgePointsBuf[v1 * 3 + 1] = pB.y;
          edgePointsBuf[v1 * 3 + 2] = pB.z;

          const incident = edge.source === focus || edge.target === focus;
          const edgeHex = incident ? "#98dafa" : focus ? "#14202b" : edge.type === "DERIVED_FROM" ? "#385068" : "#203343";
          const [er, eg, eb, ea] = parseHexColor(edgeHex, incident ? 0.95 : 0.6);

          edgeColorsBuf[v0 * 4] = er;
          edgeColorsBuf[v0 * 4 + 1] = eg;
          edgeColorsBuf[v0 * 4 + 2] = eb;
          edgeColorsBuf[v0 * 4 + 3] = ea;

          edgeColorsBuf[v1 * 4] = er;
          edgeColorsBuf[v1 * 4 + 1] = eg;
          edgeColorsBuf[v1 * 4 + 2] = eb;
          edgeColorsBuf[v1 * 4 + 3] = ea;
        }

        webglRenderer.render({
          camera: cameraRef.current,
          extent,
          width,
          height,
          dpr,
          nodePoints: nodePointsBuf,
          nodeColors: nodeColorsBuf,
          nodeRadii: nodeRadiiBuf,
          pickingIds: pickingIdsBuf,
          nodeCount,
          edgePoints: edgePointsBuf,
          edgeColors: edgeColorsBuf,
          edgeVertexCount
        });
      } else {
        // --- Canvas 2D Fallback Path (capped at 2000 nodes) ---
        const ctx = useFallback2D ? (canvas as HTMLCanvasElement).getContext("2d") : (overlay as HTMLCanvasElement).getContext("2d");
        if (ctx) {
          ctx.clearRect(0, 0, width, height);
          const drawNodes = activeNodes.slice(0, 2000);
          const projected = new Map(drawNodes.flatMap(node => {
            const p = coordinates.get(node.id);
            return p ? [[node.id, projectMemoryPoint(p, cameraRef.current, scale, width, height)] as const] : [];
          }));
          ctx.lineWidth = 0.55;
          for (const edge of edges) {
            const a = projected.get(edge.source), b = projected.get(edge.target);
            if (!a || !b) continue;
            const incident = edge.source === focus || edge.target === focus;
            ctx.strokeStyle = incident ? "#98dafa" : focus ? "#14202b" : edge.type === "DERIVED_FROM" ? "#385068" : "#203343";
            ctx.lineWidth = incident ? 1.15 : 0.55;
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          }
          canvas2dPoints = [];
          const ordered = drawNodes.filter(node => projected.has(node.id)).sort((a, b) => projected.get(b.id)!.z - projected.get(a.id)!.z);
          for (const node of ordered) {
            const p = projected.get(node.id)!;
            const highlighted = node.id === focus;
            const root = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
            const radius = Math.max(1, (root ? 10 : node.type === "SOURCE" ? 4.6 : 2.1) * p.perspective * Math.sqrt(cameraRef.current.zoom)) * (highlighted ? 1.5 : 1);
            canvas2dPoints.push({ id: node.id, ...p, radius });
            ctx.globalAlpha = focus && !highlighted && !neighbors.has(node.id) ? 0.2 : Math.max(0.4, Math.min(1, p.perspective));
            ctx.fillStyle = highlighted ? "#ffffff" : positions.get(node.id)?.color ?? "#7395ad";
            if (root || highlighted) { ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 13; }
            ctx.beginPath(); ctx.arc(p.x, p.y, radius, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
          }
          ctx.globalAlpha = 1;
        }
      }

      // --- Overlay 2D Canvas: Bounded Label Rendering with Level-of-Detail (LOD) ---
      const oCtx = overlay.getContext("2d");
      if (oCtx) {
        oCtx.clearRect(0, 0, width, height);
        if (showTitles && activeNodes.length > 0) {
          // Select bounded candidates for labels: focus, core sources, and visible sources
          const candidates: MemoryGraphNode[] = [];
          const focusNode = activeNodes.find(n => n.id === focus);
          if (focusNode) candidates.push(focusNode);

          for (const node of activeNodes) {
            if (candidates.length >= 40) break;
            if (node.id === focus) continue;
            if (node.type === "SOURCE" && isMemoryCoreLabel(node.label)) {
              candidates.push(node);
            }
          }

          if (candidates.length < 40) {
            for (const node of activeNodes) {
              if (candidates.length >= 40) break;
              if (node.id === focus || (node.type === "SOURCE" && isMemoryCoreLabel(node.label))) continue;
              if (node.type === "SOURCE" || cameraRef.current.zoom >= 1.6) {
                candidates.push(node);
              }
            }
          }

          // Sort candidates: focus first, core labels second, sources third
          candidates.sort((a, b) =>
            Number(b.id === focus) - Number(a.id === focus) ||
            Number(isMemoryCoreLabel(b.label)) - Number(isMemoryCoreLabel(a.label)) ||
            Number(b.type === "SOURCE") - Number(a.type === "SOURCE")
          );

          oCtx.font = "11px system-ui, sans-serif";
          const labelBoxes: Array<{ x: number; y: number; w: number }> = [];
          let renderedLabelCount = 0;

          for (const node of candidates) {
            if (renderedLabelCount >= 25) break;
            const p3 = coordinates.get(node.id);
            if (!p3) continue;
            const p = projectMemoryPoint(p3, cameraRef.current, scale, width, height);
            if (p.x < 0 || p.x > width || p.y < 0 || p.y > height) continue;

            const label = node.label.length > 48 ? `${node.label.slice(0, 45)}…` : node.label;
            const x = p.x + 9, y = p.y, w = oCtx.measureText(label).width;
            if (x + w > width || y < 14 || y > height - 5 || labelBoxes.some(box => Math.abs(box.y - y) < 16 && x < box.x + box.w + 5 && x + w + 5 > box.x)) {
              continue;
            }

            labelBoxes.push({ x, y, w });
            renderedLabelCount++;
            oCtx.fillStyle = "#09111bea";
            oCtx.fillRect(x - 3, y - 11, w + 6, 16);
            oCtx.fillStyle = isMemoryCoreLabel(node.label) ? "#fff0b0" : "#c6dfed";
            oCtx.fillText(label, x, y + 1);
          }
        }
      }
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

      overlay.width = Math.round(width * dpr);
      overlay.height = Math.round(height * dpr);
      const oCtx = overlay.getContext("2d");
      if (oCtx) oCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

      if (useFallback2D) {
        const ctx = canvas.getContext("2d");
        if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      schedule();
    };

    // Fast picking: uses GPU picking on WebGL2 (< 1 ms), falls back to 2D scan on fallback
    const hit = (x: number, y: number): string | null => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (webglRenderer && !isContextLost && !useFallback2D) {
        const idx = webglRenderer.pick(x, y, width, height, dpr);
        return idx >= 0 && idx < activeNodes.length ? activeNodes[idx]!.id : null;
      }
      return [...canvas2dPoints].reverse().find(p => Math.hypot(p.x - x, p.y - y) < Math.max(7, p.radius + 3))?.id ?? null;
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
      hoverId = null;
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
        hoverId = hit(p.x, p.y);
        canvas.style.cursor = hoverId ? "pointer" : "grab";
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
        const node = current.current.nodes.find(node => node.id === current.current.selectedNodeId) ?? current.current.nodes.find(node => isMemoryCoreLabel(node.label));
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
      canvas.removeEventListener("webglcontextlost", handleContextLost);
      canvas.removeEventListener("webglcontextrestored", handleContextRestored);
      if (webglRenderer) {
        webglRenderer.destroy();
        webglRenderer = null;
      }
    };
  }, [useFallback2D]);

  useEffect(() => {
    redrawRef.current();
  }, [nodes, edges, positions, coordinates, showTitles, selectedNodeId]);

  return (
    <div className="memory-3d-surface" style={{ position: "relative" }}>
      <canvas
        key={useFallback2D ? "canvas-2d" : "canvas-webgl"}
        ref={canvasRef}
        tabIndex={0}
        role="application"
        aria-label="3D memory graph. Drag or use arrow keys to rotate 360 degrees. Scroll or pinch to zoom. Click a node to open."
        aria-busy={loading}
        data-titles-visible={showTitles}
        data-layout-volume={volumeRatio.toFixed(4)}
        style={{ display: "block", width: "100%", height: "100%" }}
      />
      <canvas
        ref={overlayCanvasRef}
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
