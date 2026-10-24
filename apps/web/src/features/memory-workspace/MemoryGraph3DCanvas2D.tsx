import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import { memory3DVolumeRatio, projectMemoryPoint, DEFAULT_MEMORY_CAMERA, type MemoryCamera3D, type MemoryPoint3D } from "./memory-3d.js";
import { attachCameraControls } from "./memory-camera.js";
import { memory3DCanvasProps } from "./memory-3d-canvas-props.js";

/**
 * Canvas 2D renderer: the fallback when WebGL2 is unavailable, a shader fails or the context is lost.
 * It only ever receives a capped graph (2,000 nodes / 6,000 edges, see capSceneForFallback).
 */
export function MemoryGraph3DCanvas2D({ nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode, loading, resetToken, volume, cameraRef }: {
  nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[];
  positions: Map<string, MemoryAtlasPosition>; coordinates: Map<string, MemoryPoint3D>;
  showTitles: boolean; selectedNodeId: string | null; onSelectNode: (id: string) => void;
  loading: boolean; resetToken: number; volume: string; cameraRef: MutableRefObject<MemoryCamera3D>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const redrawRef = useRef<() => void>(() => {});
  const current = useRef({ nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode });
  current.current = { nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode };
  useEffect(() => { cameraRef.current = { ...DEFAULT_MEMORY_CAMERA }; redrawRef.current(); }, [resetToken, cameraRef]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    let frame = 0, width = 1, height = 1;
    let hover: string | null = null;
    let points: Array<{ id: string; x: number; y: number; z: number; radius: number }> = [];
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
    const detach = attachCameraControls({
      canvas, camera: () => cameraRef.current, hit,
      onHover: id => { hover = id; }, onSelect: id => current.current.onSelectNode(id), onChange: schedule,
      onEnter: () => { const node = current.current.nodes.find(node => node.id === current.current.selectedNodeId) ?? current.current.nodes.find(node => isMemoryCoreLabel(node.label)); if (node) current.current.onSelectNode(node.id); }
    });
    const observer = new ResizeObserver(resize); observer.observe(canvas); resize();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); redrawRef.current = () => {}; detach(); };
  }, [cameraRef]);
  useEffect(() => { redrawRef.current(); }, [nodes, edges, positions, coordinates, showTitles, selectedNodeId]);
  return <canvas ref={canvasRef} {...memory3DCanvasProps(loading, showTitles, volume)} />;
}

/** Self-contained Canvas 2D view for callers that already hold a small graph with coordinates (the feature showcase). */
export function MemoryGraph3DStatic(props: Omit<Parameters<typeof MemoryGraph3DCanvas2D>[0], "volume" | "cameraRef">) {
  const cameraRef = useRef<MemoryCamera3D>({ ...DEFAULT_MEMORY_CAMERA });
  const volume = useMemo(() => memory3DVolumeRatio([...props.coordinates.values()]).toFixed(4), [props.coordinates]);
  return <div className="memory-3d-surface"><MemoryGraph3DCanvas2D {...props} volume={volume} cameraRef={cameraRef} /><span className="memory-3d-hint">Drag to rotate 360° · Scroll or pinch to zoom · Click to explore</span></div>;
}
