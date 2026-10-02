import { useEffect, useMemo, useRef } from "react";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import { DEFAULT_MEMORY_CAMERA, memory3DVolumeRatio, projectMemoryPoint, type MemoryCamera3D, type MemoryPoint3D } from "./memory-3d.js";

export function MemoryGraph3D({ nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode, loading, resetToken }: {
  nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[];
  positions: Map<string, MemoryAtlasPosition>; coordinates: Map<string, MemoryPoint3D>;
  showTitles: boolean; selectedNodeId: string | null; onSelectNode: (id: string) => void;
  loading: boolean; resetToken: number;
}) {
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
        const root = node.type === "SOURCE" && node.label === "gemini.md";
        const radius = Math.max(1, (root ? 10 : node.type === "SOURCE" ? 4.6 : 2.1) * p.perspective * Math.sqrt(cameraRef.current.zoom)) * (highlighted ? 1.5 : 1);
        points.push({ id: node.id, ...p, radius });
        context.globalAlpha = focus && !highlighted && !neighbors.has(node.id) ? 0.2 : Math.max(0.4, Math.min(1, p.perspective));
        context.fillStyle = highlighted ? "#ffffff" : positions.get(node.id)?.color ?? "#7395ad";
        if (root || highlighted) { context.shadowColor = context.fillStyle; context.shadowBlur = 13; }
        context.beginPath(); context.arc(p.x, p.y, radius, 0, Math.PI * 2); context.fill(); context.shadowBlur = 0;
      }
      context.globalAlpha = 1;
      if (showTitles) {
        const labeled = [...ordered].sort((a, b) => Number(b.id === focus) - Number(a.id === focus) || Number(b.label === "gemini.md") - Number(a.label === "gemini.md") || Number(b.type === "SOURCE") - Number(a.type === "SOURCE"));
        context.font = "11px system-ui, sans-serif";
        for (const node of labeled) {
          if (node.type !== "SOURCE" && node.id !== focus && cameraRef.current.zoom < 1.6) continue;
          const p = projected.get(node.id)!;
          const label = node.label.length > 48 ? `${node.label.slice(0, 45)}…` : node.label;
          const x = p.x + 9, y = p.y, w = context.measureText(label).width;
          if (x + w > width || y < 14 || y > height - 5 || labelBoxes.some(box => Math.abs(box.y - y) < 16 && x < box.x + box.w + 5 && x + w + 5 > box.x)) continue;
          labelBoxes.push({ x, y, w });
          context.fillStyle = "#09111bea"; context.fillRect(x - 3, y - 11, w + 6, 16);
          context.fillStyle = node.label === "gemini.md" ? "#fff0b0" : "#c6dfed"; context.fillText(label, x, y + 1);
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
      } else if (event.key === "Enter") { const node = current.current.nodes.find(node => node.id === current.current.selectedNodeId) ?? current.current.nodes.find(node => node.label === "gemini.md"); if (node) current.current.onSelectNode(node.id); }
    };
    const observer = new ResizeObserver(resize); observer.observe(canvas); resize();
    canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointermove", move); canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", cancel); canvas.addEventListener("wheel", wheel, { passive: false }); canvas.addEventListener("keydown", key);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); redrawRef.current = () => {}; canvas.removeEventListener("pointerdown", down); canvas.removeEventListener("pointermove", move); canvas.removeEventListener("pointerup", up); canvas.removeEventListener("pointercancel", cancel); canvas.removeEventListener("wheel", wheel); canvas.removeEventListener("keydown", key); };
  }, []);
  useEffect(() => { redrawRef.current(); }, [nodes, edges, positions, coordinates, showTitles, selectedNodeId]);
  return <div className="memory-3d-surface"><canvas ref={canvasRef} tabIndex={0} role="application" aria-label="3D memory graph. Drag or use arrow keys to rotate 360 degrees. Scroll or pinch to zoom. Click a node to open." aria-busy={loading} data-titles-visible={showTitles} data-layout-volume={volumeRatio.toFixed(4)} /><span className="memory-3d-hint">Drag to rotate 360° · Scroll or pinch to zoom · Click to explore</span></div>;
}
