import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { DockButton } from "../dock-kit/DockKit.js";
import { Eraser } from "../ui-theme/app-icons.js";
import "./sign-dialog.css";

/** A drawn signature is about 3.5 times as wide as tall until one is drawn. */
export const DEFAULT_RATIO = 0.3;

/** The signature pad: pointer strokes (touch, pen, mouse) on a transparent canvas, exported cropped to the ink. */
export function SignaturePad({ onChange }: { onChange: (png: string | null, ratio: number) => void }) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const last = useRef<{ x: number; y: number } | null>(null);
  const box = useRef<{ minX: number; minY: number; maxX: number; maxY: number } | null>(null);

  useEffect(() => {
    const element = canvas.current!;
    const ratio = window.devicePixelRatio || 1;
    element.width = Math.round(element.clientWidth * ratio);
    element.height = Math.round(element.clientHeight * ratio);
  }, []);

  const point = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const scale = event.currentTarget.width / rect.width;
    return { x: (event.clientX - rect.left) * scale, y: (event.clientY - rect.top) * scale };
  };
  const ink = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const context = canvas.current!.getContext("2d")!;
    context.strokeStyle = "#0b1f4d";
    context.lineWidth = 2.6 * (window.devicePixelRatio || 1);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
    const pad = context.lineWidth;
    const current = box.current ?? { minX: to.x, minY: to.y, maxX: to.x, maxY: to.y };
    box.current = { minX: Math.min(current.minX, from.x - pad, to.x - pad), minY: Math.min(current.minY, from.y - pad, to.y - pad),
      maxX: Math.max(current.maxX, from.x + pad, to.x + pad), maxY: Math.max(current.maxY, from.y + pad, to.y + pad) };
  };
  const finish = () => {
    last.current = null;
    const bounds = box.current;
    if (!bounds) return;
    const element = canvas.current!;
    const x = Math.max(0, Math.floor(bounds.minX)), y = Math.max(0, Math.floor(bounds.minY));
    const width = Math.min(element.width, Math.ceil(bounds.maxX)) - x, height = Math.min(element.height, Math.ceil(bounds.maxY)) - y;
    if (width < 4 || height < 4) return;
    const cropped = document.createElement("canvas");
    cropped.width = width;
    cropped.height = height;
    cropped.getContext("2d")!.drawImage(element, x, y, width, height, 0, 0, width, height);
    onChange(cropped.toDataURL("image/png"), height / width);
  };
  const clear = () => {
    const element = canvas.current!;
    element.getContext("2d")!.clearRect(0, 0, element.width, element.height);
    box.current = null;
    onChange(null, DEFAULT_RATIO);
  };

  return (
    <div className="sign-pad">
      <canvas
        ref={canvas}
        className="sign-pad-canvas"
        aria-label="Signature pad: sign with your finger, a pen or the mouse"
        onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); last.current = point(event); ink(last.current, last.current); }}
        onPointerMove={(event) => { if (!last.current) return; const next = point(event); ink(last.current, next); last.current = next; }}
        onPointerUp={finish}
        onPointerCancel={finish}
      />
      <span className="sign-pad-line" aria-hidden="true" />
      <DockButton icon={Eraser} onClick={clear}>Clear</DockButton>
    </div>
  );
}
