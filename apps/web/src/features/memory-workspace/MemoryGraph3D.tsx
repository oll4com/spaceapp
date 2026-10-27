import { useEffect, useMemo, useRef, useState } from "react";
import { MemoryGraph3DCanvas } from "./MemoryGraph3DCanvas.js";
import { MemoryWebGLRenderer, supportsMemoryWebGL2 } from "./memory-webgl.js";
import {
  memoryLabelCandidates,
  selectMemoryLabels,
} from "./memory-3d-labels.js";
import {
  DEFAULT_MEMORY_CAMERA,
  memory3DVolumeRatio,
  type MemoryCamera3D,
} from "./memory-3d.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
type Props = Parameters<typeof MemoryGraph3DCanvas>[0] & {
  onRendererAvailable?: (available: boolean) => void;
};

/** Retain the WebGL canvas on context loss so its restoration event can recover the full graph. */
export function MemoryGraph3D(props: Props) {
  const [supported] = useState(supportsMemoryWebGL2);
  const [available, setAvailable] = useState(supported);
  const canvasRef = useRef<HTMLCanvasElement>(null),
    labelsRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef<MemoryCamera3D>({ ...DEFAULT_MEMORY_CAMERA });
  const redrawRef = useRef<() => void>(() => {}),
    refreshRef = useRef<() => void>(() => {});
  const current = useRef(props);
  current.current = props;
  const volumeRatio = useMemo(
    () => memory3DVolumeRatio([...props.coordinates.values()]),
    [props.coordinates],
  );
  const capped = useMemo(() => {
    const nodes = props.nodes.slice(0, 2000),
      ids = new Set(nodes.map((n) => n.id));
    return {
      nodes,
      edges: props.edges
        .filter((e) => ids.has(e.source) && ids.has(e.target))
        .slice(0, 6000),
    };
  }, [props.nodes, props.edges]);
  const { onRendererAvailable } = props;
  useEffect(() => {
    onRendererAvailable?.(available);
  }, [available, onRendererAvailable]);
  useEffect(() => {
    cameraRef.current = { ...DEFAULT_MEMORY_CAMERA };
    redrawRef.current();
  }, [props.resetToken]);
  useEffect(() => {
    const canvas = canvasRef.current,
      labels = labelsRef.current;
    if (!canvas || !labels || !supported) return;
    const context = labels.getContext("2d");
    if (!context) {
      setAvailable(false);
      return;
    }
    let renderer: MemoryWebGLRenderer | null = null;
    let frame = 0,
      width = 1,
      height = 1,
      hover: string | null = null;
    let candidates = memoryLabelCandidates(current.current.nodes),
      byId = new Map(current.current.nodes.map((n) => [n.id, n]));
    const pointers = new Map<number, { x: number; y: number }>();
    let dragged = false,
      downX = 0,
      downY = 0;
    const render = () => {
      frame = 0;
      if (!renderer || renderer.gl.isContextLost()) return;
      const { coordinates, showTitles, selectedNodeId } = current.current,
        focus = hover ?? selectedNodeId;
      renderer.setFocus(focus);
      const scale = renderer.draw(cameraRef.current);
      context.clearRect(0, 0, width, height);
      context.font = "11px system-ui, sans-serif";
      if (showTitles)
        for (const label of selectMemoryLabels(
          candidates,
          focus ? byId.get(focus) : undefined,
          coordinates,
          cameraRef.current,
          scale,
          width,
          height,
          (text) => context.measureText(text).width,
        )) {
          context.fillStyle = "#09111bea";
          context.fillRect(label.x - 3, label.y - 11, label.width + 6, 16);
          context.fillStyle = label.core ? "#fff0b0" : "#c6dfed";
          context.fillText(label.label, label.x, label.y + 1);
        }
      canvas.dataset.rotation = `${cameraRef.current.yaw.toFixed(3)},${cameraRef.current.pitch.toFixed(3)}`;
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(render);
    };
    redrawRef.current = schedule;
    const refresh = () => {
      if (!renderer || renderer.gl.isContextLost()) return;
      const { nodes, edges, coordinates, positions } = current.current;
      void renderer
        .setScene(nodes, edges, coordinates, positions)
        .then((committed) => {
          if (committed) {
            canvas.dataset.sceneNodeCount = String(nodes.length);
            schedule();
          }
        })
        .catch(() => setAvailable(false));
      candidates = memoryLabelCandidates(nodes);
      byId = new Map(nodes.map((n) => [n.id, n]));
      schedule();
    };
    refreshRef.current = refresh;
    const resize = () => {
      const rect = canvas.parentElement!.getBoundingClientRect();
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      const dpr = Math.min(devicePixelRatio || 1, 2);
      labels.width = Math.round(width * dpr);
      labels.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      renderer?.resize(width, height, dpr);
      schedule();
    };
    const initialize = () => {
      renderer?.destroy();
      renderer = null;
      try {
        renderer = new MemoryWebGLRenderer(canvas);
        resize();
        refresh();
        setAvailable(true);
      } catch {
        renderer?.destroy();
        renderer = null;
        setAvailable(false);
      }
    };
    const lost = (event: Event) => {
      event.preventDefault();
      setAvailable(false);
      cancelAnimationFrame(frame);
      frame = 0;
      context.clearRect(0, 0, width, height);
    };
    const restored = () => initialize();
    const hit = (x: number, y: number) => {
      if (!renderer || renderer.gl.isContextLost()) return null;
      return renderer.pick(x, y, cameraRef.current);
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
      const p = local(event),
        previous = pointers.get(event.pointerId);
      if (previous) {
        if (Math.hypot(p.x - downX, p.y - downY) > 4) dragged = true;
        if (pointers.size === 2) {
          const other = [...pointers].find(
            ([id]) => id !== event.pointerId,
          )![1];
          const before = Math.hypot(previous.x - other.x, previous.y - other.y),
            after = Math.hypot(p.x - other.x, p.y - other.y);
          if (before > 1)
            cameraRef.current.zoom = Math.max(
              0.35,
              Math.min(5, (cameraRef.current.zoom * after) / before),
            );
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
      if (canvas.hasPointerCapture(event.pointerId))
        canvas.releasePointerCapture(event.pointerId);
    };
    const cancel = (event: PointerEvent) => {
      pointers.delete(event.pointerId);
      dragged = true;
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      cameraRef.current.zoom = Math.max(
        0.35,
        Math.min(5, cameraRef.current.zoom * Math.exp(-event.deltaY * 0.001)),
      );
      schedule();
    };
    const key = (event: KeyboardEvent) => {
      if (
        ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
      ) {
        event.preventDefault();
        cameraRef.current.yaw +=
          event.key === "ArrowLeft"
            ? -0.15
            : event.key === "ArrowRight"
              ? 0.15
              : 0;
        cameraRef.current.pitch +=
          event.key === "ArrowUp"
            ? -0.15
            : event.key === "ArrowDown"
              ? 0.15
              : 0;
        schedule();
      } else if (["+", "=", "-"].includes(event.key)) {
        event.preventDefault();
        cameraRef.current.zoom = Math.max(
          0.35,
          Math.min(
            5,
            cameraRef.current.zoom * (event.key === "-" ? 0.85 : 1.15),
          ),
        );
        schedule();
      } else if (event.key === "Enter") {
        const node =
          current.current.nodes.find(
            (node) => node.id === current.current.selectedNodeId,
          ) ??
          current.current.nodes.find((node) => isMemoryCoreLabel(node.label));
        if (node) current.current.onSelectNode(node.id);
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas.parentElement!);
    canvas.addEventListener("webglcontextlost", lost);
    canvas.addEventListener("webglcontextrestored", restored);
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", cancel);
    canvas.addEventListener("wheel", wheel, { passive: false });
    canvas.addEventListener("keydown", key);
    initialize();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      renderer?.destroy();
      redrawRef.current = () => {};
      refreshRef.current = () => {};
      canvas.removeEventListener("webglcontextlost", lost);
      canvas.removeEventListener("webglcontextrestored", restored);
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", cancel);
      canvas.removeEventListener("wheel", wheel);
      canvas.removeEventListener("keydown", key);
    };
  }, [supported]);
  useEffect(() => {
    refreshRef.current();
  }, [props.nodes, props.edges, props.positions, props.coordinates]);
  useEffect(() => {
    redrawRef.current();
  }, [props.showTitles, props.selectedNodeId]);
  return (
    <>
      {supported ? (
        <div
          className="memory-3d-surface"
          style={
            available
              ? undefined
              : {
                  visibility: "hidden",
                  position: "absolute",
                  pointerEvents: "none",
                }
          }
          aria-hidden={!available}
        >
          <canvas
            ref={canvasRef}
            tabIndex={available ? 0 : -1}
            role="application"
            aria-label="3D memory graph. Drag or use arrow keys to rotate 360 degrees. Scroll, pinch or use plus/minus to zoom. Click a node to open."
            aria-busy={props.loading}
            data-renderer="webgl2"
            data-titles-visible={props.showTitles}
            data-layout-volume={volumeRatio.toFixed(4)}
          />
          <canvas
            ref={labelsRef}
            aria-hidden="true"
            style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
          />
          <span className="memory-3d-hint">
            Drag to rotate 360° · Scroll or pinch to zoom · Click to explore
          </span>
        </div>
      ) : null}
      {!available ? <MemoryGraph3DCanvas {...props} {...capped} /> : null}
    </>
  );
}
