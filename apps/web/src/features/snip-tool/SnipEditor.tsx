import React, { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { clamp, drawMarks, fitRect, selection, textSize, type Mark, type Point, type Rect, type ShapeKind, type SnipFrame } from "./snip-image.js";
import {
  ArrowUpRight, Copy, Crop, Download, EyeOff, Highlighter, Loader2, Maximize2, Monitor, PenLine, Redo2, RefreshCw,
  Send, Square, Type, Undo2, X, type LucideIcon
} from "../ui-theme/app-icons.js";

export type SnipTool = "crop" | ShapeKind | "pen" | "text";
export interface SnipEdit { crop: Rect; marks: Mark[] }
export interface SnipDestinationOption { value: string; label: string }
export type SnipBusy = "capture" | "send" | "export" | null;

export interface SnipEditorProps {
  frame: SnipFrame;
  initialCrop: Rect;
  busy: SnipBusy;
  notice: string;
  alert?: string | null;
  destinations: SnipDestinationOption[];
  destination: string;
  onDestinationChange: (value: string) => void;
  primaryLabel: string;
  primaryDisabled: boolean;
  allowChangeSource: boolean;
  trapFocus: boolean;
  onPrimary: (edit: SnipEdit) => void;
  onCopy: (edit: SnipEdit) => void;
  onSave: (edit: SnipEdit) => void;
  onRetake: () => void;
  onChangeSource: () => void;
  onClose: () => void;
}

const TOOLS: { id: SnipTool; label: string; key: string; Icon: LucideIcon }[] = [
  { id: "crop", label: "Crop", key: "c", Icon: Crop },
  { id: "arrow", label: "Arrow", key: "a", Icon: ArrowUpRight },
  { id: "rect", label: "Rectangle", key: "r", Icon: Square },
  { id: "pen", label: "Pen", key: "p", Icon: PenLine },
  { id: "highlight", label: "Highlight", key: "h", Icon: Highlighter },
  { id: "text", label: "Text", key: "t", Icon: Type },
  { id: "redact", label: "Hide area", key: "b", Icon: EyeOff }
];
const COLORS = [
  { value: "#ef4444", label: "Red" },
  { value: "#f59e0b", label: "Amber" },
  { value: "#22c55e", label: "Green" },
  { value: "#38bdf8", label: "Blue" },
  { value: "#ffffff", label: "White" }
];
const SIZES = [
  { value: 0.6, label: "Thin", short: "S" },
  { value: 1, label: "Medium", short: "M" },
  { value: 1.8, label: "Thick", short: "L" }
];
const STYLE_STORAGE_KEY = "space.snip-tool.editor-style.v1";
const HISTORY_LIMIT = 80;

type ResizeHandle = "nw" | "ne" | "sw" | "se" | "n" | "s" | "e" | "w";
type Gesture =
  | { kind: "crop" | "move" | "resize"; pointerId: number; start: Point; base: SnipEdit; handle?: ResizeHandle }
  | { kind: "draw"; pointerId: number; start: Point; mark: Mark };

type History = { past: SnipEdit[]; present: SnipEdit; future: SnipEdit[] };
type HistoryAction =
  | { type: "preview"; edit: SnipEdit }
  | { type: "commit"; edit: SnipEdit; previous?: SnipEdit }
  | { type: "apply"; fn: (edit: SnipEdit) => SnipEdit }
  | { type: "undo" }
  | { type: "redo" };
function history(state: History, action: HistoryAction): History {
  switch (action.type) {
    case "preview": return { ...state, present: action.edit };
    case "commit": return { past: [...state.past.slice(-(HISTORY_LIMIT - 1)), action.previous ?? state.present], present: action.edit, future: [] };
    case "apply": return history(state, { type: "commit", edit: action.fn(state.present) });
    case "undo":
      if (!state.past.length) return state;
      return { past: state.past.slice(0, -1), present: state.past[state.past.length - 1]!, future: [state.present, ...state.future].slice(0, HISTORY_LIMIT) };
    case "redo":
      if (!state.future.length) return state;
      return { past: [...state.past.slice(-(HISTORY_LIMIT - 1)), state.present], present: state.future[0]!, future: state.future.slice(1) };
  }
}

function loadStyle(): { tool: SnipTool; color: string; size: number } {
  const fallback = { tool: "crop" as SnipTool, color: COLORS[0]!.value, size: 1 };
  try {
    const raw = JSON.parse(localStorage.getItem(STYLE_STORAGE_KEY) || "null");
    if (!raw || typeof raw !== "object") return fallback;
    return {
      tool: "crop",
      color: COLORS.some(c => c.value === raw.color) ? raw.color : fallback.color,
      size: SIZES.some(s => s.value === raw.size) ? raw.size : fallback.size
    };
  } catch {
    return fallback;
  }
}

function computeCrop(kind: "crop" | "move" | "resize", handle: ResizeHandle | undefined, start: Point, current: Point, base: Rect, width: number, height: number): Rect {
  if (kind === "crop") return fitRect(selection(start, current), width, height);
  const dx = current.x - start.x, dy = current.y - start.y;
  if (kind === "move") return fitRect({ ...base, x: base.x + dx, y: base.y + dy }, width, height);
  const h = handle || "se";
  let { x, y, width: w, height: hgt } = base;
  if (h.includes("e")) w = clamp(base.width + dx, 1, width - base.x);
  if (h.includes("s")) hgt = clamp(base.height + dy, 1, height - base.y);
  if (h.includes("w")) { const nx = clamp(base.x + dx, 0, base.x + base.width - 1); w = base.width - (nx - base.x); x = nx; }
  if (h.includes("n")) { const ny = clamp(base.y + dy, 0, base.y + base.height - 1); hgt = base.height - (ny - base.y); y = ny; }
  return fitRect({ x, y, width: w, height: hgt }, width, height);
}

const isEditable = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

export function SnipEditor(props: SnipEditorProps) {
  const { frame, busy, notice, alert, destinations, destination, primaryLabel, primaryDisabled, allowChangeSource, trapFocus } = props;
  const [{ past, present: edit, future }, dispatch] = useReducer(history, undefined, () => ({
    past: [], future: [], present: { crop: fitRect(props.initialCrop, frame.width, frame.height), marks: [] }
  }));
  const [style] = useState(loadStyle);
  const [tool, setTool] = useState<SnipTool>(style.tool);
  const [color, setColor] = useState(style.color);
  const [size, setSize] = useState(style.size);
  const [inlineText, setInlineText] = useState<{ pos: Point; text: string } | null>(null);
  const [fieldDrafts, setFieldDrafts] = useState<Partial<Record<keyof Rect, string>>>({});
  const [view, setView] = useState<{ w: number; h: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null), wrapRef = useRef<HTMLDivElement>(null), stageRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null), draftRef = useRef<HTMLCanvasElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const draftFrame = useRef(0);
  const editRef = useRef(edit); editRef.current = edit;
  const inlineTextRef = useRef(inlineText); inlineTextRef.current = inlineText;
  const disabled = Boolean(busy);

  useEffect(() => {
    try { localStorage.setItem(STYLE_STORAGE_KEY, JSON.stringify({ color, size })); } catch {}
  }, [color, size]);

  // Fit the stage to the available space without upscaling beyond the frame's own pixels.
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const fit = () => {
      const box = wrap.getBoundingClientRect();
      const styles = getComputedStyle(wrap);
      const w = box.width - (parseFloat(styles.paddingLeft) || 0) - (parseFloat(styles.paddingRight) || 0);
      const h = box.height - (parseFloat(styles.paddingTop) || 0) - (parseFloat(styles.paddingBottom) || 0);
      if (w <= 0 || h <= 0) { setView(null); return; }
      const scale = Math.min(w / frame.width, h / frame.height, 1);
      const next = { w: Math.max(1, Math.floor(frame.width * scale)), h: Math.max(1, Math.floor(frame.height * scale)) };
      setView(prev => prev && prev.w === next.w && prev.h === next.h ? prev : next);
    };
    fit();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(fit) : null;
    observer?.observe(wrap);
    window.addEventListener("resize", fit);
    return () => { observer?.disconnect(); window.removeEventListener("resize", fit); };
  }, [frame]);

  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const canvasWidth = view ? Math.min(frame.width, Math.round(view.w * dpr)) : frame.width;
  const canvasHeight = view ? Math.min(frame.height, Math.round(view.h * dpr)) : frame.height;
  const scale = canvasWidth / frame.width;

  // Base layer: the frame plus committed marks, rendered at display resolution (not full capture size).
  useEffect(() => {
    const canvas = baseRef.current, ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.setTransform?.(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    if ("imageSmoothingQuality" in ctx) ctx.imageSmoothingQuality = "high";
    ctx.drawImage(frame.source, 0, 0, canvasWidth, canvasHeight);
    if (edit.marks.length) {
      ctx.setTransform?.(scale, 0, 0, scale, 0, 0);
      drawMarks(ctx, edit.marks, frame.width);
      ctx.setTransform?.(1, 0, 0, 1, 0, 0);
    }
  }, [frame, edit.marks, canvasWidth, canvasHeight, scale]);

  const paintDraft = useCallback(() => {
    draftFrame.current = 0;
    const canvas = draftRef.current, ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.setTransform?.(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const g = gesture.current;
    if (g?.kind !== "draw") return;
    ctx.setTransform?.(scale, 0, 0, scale, 0, 0);
    drawMarks(ctx, [g.mark], frame.width);
  }, [frame.width, scale]);
  const scheduleDraft = () => {
    if (draftFrame.current) return;
    draftFrame.current = typeof requestAnimationFrame === "function" ? requestAnimationFrame(paintDraft) : (paintDraft(), 0);
  };
  useEffect(() => () => { if (draftFrame.current && typeof cancelAnimationFrame === "function") cancelAnimationFrame(draftFrame.current); }, []);

  const preview = (next: SnipEdit) => dispatch({ type: "preview", edit: next });
  const commit = (next: SnipEdit, previous?: SnipEdit) => dispatch({ type: "commit", edit: next, previous });
  const addMark = (mark: Mark) => dispatch({ type: "apply", fn: current => ({ ...current, marks: [...current.marks, mark] }) });
  const undo = useCallback(() => dispatch({ type: "undo" }), []);
  const redo = useCallback(() => dispatch({ type: "redo" }), []);

  const point = (event: { clientX: number; clientY: number }): Point => {
    const bounds = stageRef.current?.getBoundingClientRect();
    const bw = bounds && bounds.width > 0 ? bounds.width : (window.innerWidth || 800);
    const bh = bounds && bounds.height > 0 ? bounds.height : (window.innerHeight || 600);
    return {
      x: clamp(Math.round(((event.clientX - (bounds?.left ?? 0)) * frame.width) / bw), 0, frame.width),
      y: clamp(Math.round(((event.clientY - (bounds?.top ?? 0)) * frame.height) / bh), 0, frame.height)
    };
  };

  /** Places pending inline text, returning the edit as it will be after that commit. */
  const commitInlineText = (): SnipEdit => {
    const current = inlineTextRef.current;
    inlineTextRef.current = null;
    setInlineText(null);
    if (!current?.text.trim()) return editRef.current;
    const mark: Mark = { kind: "text", start: current.pos, text: current.text.trim(), color, size };
    addMark(mark);
    return { ...editRef.current, marks: [...editRef.current.marks, mark] };
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || gesture.current || event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest(".snip-inline-text-popup")) return;
    event.preventDefault();
    stageRef.current?.focus({ preventScroll: true });
    const p = point(event);
    if (tool === "text") {
      commitInlineText();
      setInlineText({ pos: p, text: "" });
      return;
    }
    if (tool === "crop") {
      const resize = target.closest<HTMLElement>("[data-resize]")?.dataset.resize as ResizeHandle | undefined;
      const kind = resize ? "resize" : target.closest("[data-move]") ? "move" : "crop";
      gesture.current = { kind, pointerId: event.pointerId, start: p, base: editRef.current, handle: resize };
    } else {
      const mark: Mark = tool === "pen" ? { kind: "pen", points: [p], color, size } : { kind: tool, start: p, end: p, color, size };
      gesture.current = { kind: "draw", pointerId: event.pointerId, start: p, mark };
      scheduleDraft();
    }
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch {}
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.pointerId !== event.pointerId) return;
    const p = point(event);
    if (g.kind === "draw") {
      if (g.mark.kind === "pen") {
        const last = g.mark.points[g.mark.points.length - 1]!;
        if (Math.hypot(p.x - last.x, p.y - last.y) >= Math.max(1, frame.width / 1200)) g.mark.points.push(p);
      } else if (g.mark.kind !== "text") {
        g.mark = { ...g.mark, end: p };
      }
      scheduleDraft();
      return;
    }
    preview({ ...g.base, crop: computeCrop(g.kind, g.handle, g.start, p, g.base.crop, frame.width, frame.height) });
  };
  const finishGesture = (event: React.PointerEvent<HTMLDivElement>, cancel: boolean) => {
    const g = gesture.current;
    if (!g || g.pointerId !== event.pointerId) return;
    if (!cancel) onPointerMove(event);
    gesture.current = null;
    try { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); } catch {}
    if (g.kind === "draw") {
      scheduleDraft();
      const mark = g.mark;
      const tiny = mark.kind !== "pen" && mark.kind !== "text" && Math.hypot(mark.end.x - mark.start.x, mark.end.y - mark.start.y) < 3;
      if (!cancel && !tiny) addMark(mark);
      return;
    }
    const p = point(event);
    if (cancel || Math.hypot(p.x - g.start.x, p.y - g.start.y) < 2) preview(g.base);
    else commit({ ...g.base, crop: computeCrop(g.kind, g.handle, g.start, p, g.base.crop, frame.width, frame.height) }, g.base);
  };
  const onLostPointerCapture = () => {
    const g = gesture.current;
    if (!g) return;
    gesture.current = null;
    if (g.kind === "draw") scheduleDraft();
    else preview(g.base);
  };

  const selectTool = (next: SnipTool) => { setTool(next); if (next !== "text") commitInlineText(); };
  const resetCrop = () => dispatch({ type: "apply", fn: current => ({ ...current, crop: { x: 0, y: 0, width: frame.width, height: frame.height } }) });
  const primary = () => { if (!disabled && !primaryDisabled) props.onPrimary(commitInlineText()); };
  const copy = () => { if (!disabled) props.onCopy(commitInlineText()); };
  const save = () => { if (!disabled) props.onSave(commitInlineText()); };

  // Modal keyboard map; the latest handlers are read through a ref so the listener is attached once.
  const keys = useRef<(event: KeyboardEvent) => void>(() => {});
  keys.current = (event: KeyboardEvent) => {
    const mod = event.ctrlKey || event.metaKey;
    const stop = () => { event.preventDefault(); event.stopImmediatePropagation(); };
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest(".snip-inline-text-popup")) return;
    if (event.key === "Escape") {
      stop();
      if (isEditable(target) && target !== stageRef.current) { target!.blur(); return; }
      props.onClose();
      return;
    }
    if (event.key === "Tab" && trapFocus) {
      const items = Array.from(rootRef.current?.querySelectorAll<HTMLElement>(':is(button, select, input, [tabindex="0"]):not(:disabled)') ?? []);
      const first = items[0], last = items[items.length - 1];
      if (!items.length) { stop(); return; }
      if (event.shiftKey && (document.activeElement === first || !rootRef.current?.contains(document.activeElement))) { stop(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !rootRef.current?.contains(document.activeElement))) { stop(); first?.focus(); }
      return;
    }
    if (isEditable(target)) return;
    if (mod && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) { stop(); undo(); }
      else if ((key === "z" && event.shiftKey) || key === "y") { stop(); redo(); }
      else if (key === "c" && !window.getSelection()?.toString()) { stop(); copy(); }
      else if (key === "s") { stop(); save(); }
      return;
    }
    if (event.altKey) return;
    if (event.key === "Enter" && !(target instanceof HTMLButtonElement)) {
      stop();
      primary();
      return;
    }
    const match = TOOLS.find(t => t.key === event.key.toLowerCase());
    if (match && !event.shiftKey) { stop(); selectTool(match.id); }
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keys.current(event);
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, []);
  useEffect(() => { stageRef.current?.focus({ preventScroll: true }); }, []);

  const onStageKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const step = event.altKey ? 10 : 1;
    const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
    const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
    dispatch({ type: "apply", fn: current => {
      const r = current.crop;
      return {
        ...current,
        crop: fitRect(event.shiftKey
          ? { ...r, width: clamp(r.width + dx, 1, frame.width - r.x), height: clamp(r.height + dy, 1, frame.height - r.y) }
          : { ...r, x: r.x + dx, y: r.y + dy }, frame.width, frame.height)
      };
    } });
  };

  const crop = edit.crop;
  const cropStyle = {
    left: `${crop.x / frame.width * 100}%`, top: `${crop.y / frame.height * 100}%`,
    width: `${crop.width / frame.width * 100}%`, height: `${crop.height / frame.height * 100}%`
  };
  const isFullCrop = crop.x === 0 && crop.y === 0 && crop.width === frame.width && crop.height === frame.height;
  const displayScale = view ? view.w / frame.width : 1;
  const status = busy === "send" ? "Sending image…" : busy === "export" ? "Preparing image…" : busy === "capture" ? "Waiting for capture…"
    : notice || (tool === "crop" ? "Drag to crop · Arrow keys nudge, Shift+Arrow resizes" : tool === "text" ? "Click on the image to type" : tool === "redact" ? "Drag to cover an area with a solid block" : "Drag on the image to draw");
  const stop = (event: React.KeyboardEvent) => { if (event.key !== "Tab") event.stopPropagation(); };

  return (
    <div className={`snip-tool-overlay snip-editor snip-ui${tool !== "crop" ? " snip-drawing-tool" : ""}`} ref={rootRef} role="dialog" aria-modal={trapFocus ? true : undefined}
      aria-label="Edit snip" aria-busy={disabled} data-snip-tool="true" onKeyDown={stop}>
      <div className="snip-editor-bar">
        <div className="snip-editor-group" role="toolbar" aria-label="Image tools">
          {TOOLS.map(({ id, label, key, Icon }) => (
            <button key={id} type="button" className="snip-icon-btn" aria-pressed={tool === id} aria-label={label}
              title={`${label} (${key.toUpperCase()})`} disabled={disabled} onClick={() => selectTool(id)}>
              <Icon aria-hidden="true" />
            </button>
          ))}
        </div>
        <span className="snip-divider" aria-hidden="true" />
        <div className="snip-editor-group snip-swatches" role="radiogroup" aria-label="Annotation color">
          {COLORS.map(c => (
            <button key={c.value} type="button" role="radio" className="snip-swatch" aria-checked={color === c.value} aria-label={c.label}
              title={c.label} disabled={disabled} style={{ "--snip-swatch": c.value } as React.CSSProperties} onClick={() => setColor(c.value)} />
          ))}
        </div>
        <div className="snip-editor-group snip-sizes" role="radiogroup" aria-label="Stroke size">
          {SIZES.map(s => (
            <button key={s.value} type="button" role="radio" className="snip-size" aria-checked={size === s.value} aria-label={s.label}
              title={s.label} disabled={disabled} onClick={() => setSize(s.value)}>{s.short}</button>
          ))}
        </div>
        <span className="snip-divider" aria-hidden="true" />
        <div className="snip-editor-group">
          <button type="button" className="snip-icon-btn" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={disabled || !past.length} onClick={undo}><Undo2 aria-hidden="true" /></button>
          <button type="button" className="snip-icon-btn" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={disabled || !future.length} onClick={redo}><Redo2 aria-hidden="true" /></button>
        </div>
        <span className="snip-editor-spacer" />
        <button type="button" className="snip-icon-btn" aria-label="Discard and close editor" title="Discard (Esc)" onClick={props.onClose}><X aria-hidden="true" /></button>
      </div>

      <div className="snip-editor-canvas" ref={wrapRef}>
        <div className="snip-image-stage" ref={stageRef} tabIndex={0} role="group"
          aria-label="Image preview. Drag to edit. Arrow keys move crop; Shift and arrows resize it."
          style={view ? { width: `${view.w}px`, height: `${view.h}px` } : { aspectRatio: `${frame.width} / ${frame.height}`, width: "100%" }}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={e => finishGesture(e, false)}
          onPointerCancel={e => finishGesture(e, true)} onLostPointerCapture={onLostPointerCapture} onKeyDown={onStageKeyDown}>
          <canvas ref={baseRef} width={canvasWidth} height={canvasHeight} aria-label="Captured image" />
          <canvas ref={draftRef} className="snip-draft-layer" width={canvasWidth} height={canvasHeight} aria-hidden="true" />
          <div className={`snip-crop-box${tool === "crop" ? " is-active" : ""}${isFullCrop ? " is-full" : ""}`} style={cropStyle}>
            {/* A full-image crop has no outside to drag from, so dragging inside it starts a new crop. */}
            <div className="snip-crop-inner" data-move={isFullCrop ? undefined : "true"} title={isFullCrop ? undefined : "Drag to move crop area"} />
            {(["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const).map(h => <span key={h} data-resize={h} className={`snip-handle snip-handle-${h}`} />)}
            <span className="snip-crop-badge">{Math.round(crop.width)} × {Math.round(crop.height)}</span>
          </div>
          {inlineText && (
            <div className="snip-inline-text-popup" style={{ left: `${inlineText.pos.x / frame.width * 100}%`, top: `${inlineText.pos.y / frame.height * 100}%` }}>
              <input autoFocus className="snip-inline-text-input" value={inlineText.text} maxLength={200} placeholder="Type text & press Enter"
                style={{ color, fontSize: `${clamp(textSize(frame.width, size) * displayScale, 13, 40)}px` }}
                onChange={e => setInlineText({ ...inlineText, text: e.target.value })}
                onKeyDown={e => {
                  e.stopPropagation();
                  if (e.key === "Enter") { e.preventDefault(); commitInlineText(); }
                  else if (e.key === "Escape") { e.preventDefault(); setInlineText(null); stageRef.current?.focus(); }
                }} />
            </div>
          )}
        </div>
      </div>

      <div className="snip-editor-foot">
        <div className="snip-crop-fields" aria-label="Crop dimensions">
          {(["x", "y", "width", "height"] as const).map(key => (
            <label key={key}>
              <span>{key === "width" ? "W" : key === "height" ? "H" : key.toUpperCase()}</span>
              <input type="number" inputMode="numeric" aria-label={`Crop ${key}`} min={key === "x" || key === "y" ? 0 : 1}
                max={key === "x" || key === "width" ? frame.width : frame.height} value={fieldDrafts[key] ?? crop[key]} disabled={disabled}
                onChange={e => {
                  const raw = e.target.value;
                  const num = parseInt(raw, 10);
                  if (raw === "" || !Number.isFinite(num)) { setFieldDrafts(prev => ({ ...prev, [key]: raw })); return; }
                  setFieldDrafts(prev => ({ ...prev, [key]: undefined }));
                  dispatch({ type: "apply", fn: current => ({ ...current, crop: fitRect({ ...current.crop, [key]: num }, frame.width, frame.height) }) });
                }}
                onBlur={() => setFieldDrafts(prev => ({ ...prev, [key]: undefined }))} />
            </label>
          ))}
          <button type="button" className="snip-text-btn" disabled={disabled || isFullCrop} onClick={resetCrop} title="Reset crop to the full image">
            <Maximize2 aria-hidden="true" /><span>Full image</span>
          </button>
        </div>
        <p className="snip-status" role="status">{status}</p>
        <div className="snip-actions">
          <button type="button" className="snip-text-btn" disabled={disabled} onClick={props.onRetake} title="Discard and snip again"><RefreshCw aria-hidden="true" /><span>Retake</span></button>
          {allowChangeSource && <button type="button" className="snip-text-btn" disabled={disabled} onClick={props.onChangeSource} title="Pick another screen, window or tab"><Monitor aria-hidden="true" /><span>Change source</span></button>}
          <button type="button" className="snip-text-btn" disabled={disabled} onClick={copy} title="Copy image (Ctrl+C)"><Copy aria-hidden="true" /><span>Copy image</span></button>
          <button type="button" className="snip-text-btn" disabled={disabled} onClick={save} title="Save image as PNG (Ctrl+S)"><Download aria-hidden="true" /><span>Save image</span></button>
          <select className="snip-select" aria-label="Capture destination" value={destination} disabled={disabled} onChange={e => props.onDestinationChange(e.target.value)}>
            {destinations.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
          </select>
          <button type="button" className="snip-primary" disabled={disabled || primaryDisabled} onClick={primary} title={`${primaryLabel} (Enter)`}>
            {busy === "send" || busy === "export" ? <Loader2 className="snip-spin" aria-hidden="true" /> : destination === "__clipboard__" ? <Copy aria-hidden="true" /> : <Send aria-hidden="true" />}
            <span>{primaryLabel}</span>
          </button>
        </div>
        {alert && <p className="snip-alert" role="alert">{alert}</p>}
      </div>
    </div>
  );
}
