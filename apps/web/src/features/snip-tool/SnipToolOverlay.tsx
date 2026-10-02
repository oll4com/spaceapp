import { useWorkspaceSurface } from "../ui-theme/WorkspaceSurface.js";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { captureSnip, checkAbort, releaseSnipSession, type SnipCaptureSession } from "./snip-capture.js";
import { clamp, drawMarks, exportSnip, fitRect, selection, type Mark, type Point, type Rect } from "./snip-image.js";
import "./snip-tool.css";

export interface SnipTargetPane { id: string; title: string; mode: string }
export interface SnipToolOverlayProps {
  isOpen: boolean; onClose: () => void; isMobile?: boolean;
  roomId?: string; activePaneId?: string | null; activePaneTitle?: string | null; activePaneMode?: string | null;
  availablePanes?: SnipTargetPane[]; onSelectTargetPane?: (paneId: string) => void;
  onCapture: (file: File, targetPaneId?: string | null, roomId?: string, signal?: AbortSignal) => Promise<void>;
}
type Tool = "crop" | "move" | "arrow" | "text" | "redact";
type Edit = { crop: Rect; marks: Mark[] };
type ResizeHandle = "nw" | "ne" | "sw" | "se" | "n" | "s" | "e" | "w";
type Gesture = {
  pointerId: number;
  start: Point;
  current: Point;
  edit: Edit;
  tool: Tool | "resize";
  handle?: ResizeHandle;
};

function computeCrop(
  tool: Tool | "resize",
  handle: ResizeHandle | undefined,
  start: Point,
  current: Point,
  baseCrop: Rect,
  imageWidth: number,
  imageHeight: number
): Rect {
  if (tool === "crop") {
    return fitRect(selection(start, current), imageWidth, imageHeight);
  }
  const dx = current.x - start.x;
  const dy = current.y - start.y;
  if (tool === "move") {
    return fitRect({ ...baseCrop, x: baseCrop.x + dx, y: baseCrop.y + dy }, imageWidth, imageHeight);
  }
  const h = handle || "se";
  let { x, y, width: w, height: hgt } = baseCrop;
  if (h.includes("e")) w = clamp(baseCrop.width + dx, 1, imageWidth - baseCrop.x);
  if (h.includes("s")) hgt = clamp(baseCrop.height + dy, 1, imageHeight - baseCrop.y);
  if (h.includes("w")) {
    const nextX = clamp(baseCrop.x + dx, 0, baseCrop.x + baseCrop.width - 1);
    w = baseCrop.width - (nextX - baseCrop.x);
    x = nextX;
  }
  if (h.includes("n")) {
    const nextY = clamp(baseCrop.y + dy, 0, baseCrop.y + baseCrop.height - 1);
    hgt = baseCrop.height - (nextY - baseCrop.y);
    y = nextY;
  }
  return fitRect({ x, y, width: w, height: hgt }, imageWidth, imageHeight);
}

export function SnipToolOverlay(props: SnipToolOverlayProps) {
  const embedded = useWorkspaceSurface();
  const { isOpen, onClose, roomId, activePaneId, activePaneTitle, activePaneMode, availablePanes, onSelectTargetPane, onCapture } = props;
  const [captureRoomId] = useState(roomId);
  const onCloseRef = useRef(onClose); onCloseRef.current = onClose;
  const [targetId, setTargetId] = useState<string | null>(activePaneId ?? null);
  const [editFirst, setEditFirst] = useState(false);
  const [region, setRegion] = useState<Rect | null>(null);
  const directGesture = useRef<{ pointerId: number; start: Point } | null>(null);
  const captureSession = useRef<SnipCaptureSession>({ stream: null, video: null, handle: `space-snip-${crypto.randomUUID()}` });
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [edit, setEdit] = useState<Edit>({ crop: { x: 0, y: 0, width: 1, height: 1 }, marks: [] });
  const [undo, setUndo] = useState<Edit[]>([]);
  const [tool, setTool] = useState<Tool>("crop");
  const [text, setText] = useState("");
  const [inlineText, setInlineText] = useState<{ pos: Point; text: string } | null>(null);
  const [fieldDrafts, setFieldDrafts] = useState<{ x?: string; y?: string; width?: string; height?: string }>({});
  const [busy, setBusy] = useState<"capture" | "send" | "export" | null>(null);
  const [notice, setNotice] = useState("");
  const [count, setCount] = useState(0);
  const overlay = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const cropBoxRef = useRef<HTMLDivElement>(null);
  const textInputRef = useRef<HTMLInputElement>(null);
  const operation = useRef<AbortController | null>(null);
  const mounted = useRef(false), urlRef = useRef<string | null>(null);
  const gesture = useRef<Gesture | null>(null), editRef = useRef(edit);
  editRef.current = edit;
  const panes = availablePanes ?? (activePaneId ? [{ id: activePaneId, title: activePaneTitle || activePaneId, mode: activePaneMode || "" }] : []);
  const missingTarget = Boolean(targetId && !panes.some(p => p.id === targetId));
  const close = useCallback(() => { operation.current?.abort(); releaseSnipSession(captureSession.current); onCloseRef.current(); }, []);

  const changeTarget = (newId: string | null) => {
    setTargetId(newId);
    if (newId && onSelectTargetPane) onSelectTargetPane(newId);
  };

  useEffect(() => {
    if (tool === "text") {
      setTimeout(() => textInputRef.current?.focus(), 50);
    }
  }, [tool]);

  useEffect(() => {
    if (!isOpen) return;
    mounted.current = true;
    const previous = document.activeElement as HTMLElement | null;
    overlay.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (inlineText) {
          setInlineText(null);
          return;
        }
        close();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !event.shiftKey) {
        if (undo.length > 0) {
          event.preventDefault();
          setEdit(undo[undo.length - 1]!);
          setUndo(undo.slice(0, -1));
          return;
        }
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
        const targetTag = (event.target as HTMLElement)?.tagName;
        if (image && !["INPUT", "TEXTAREA"].includes(targetTag)) {
          event.preventDefault();
          void output("copy");
          return;
        }
      }
      if (event.key === "Tab" && !embedded) {
        const items = Array.from(overlay.current?.querySelectorAll<HTMLElement>(':is(button, select, input, [tabindex="0"]):not(:disabled)') ?? []);
        const first = items[0], last = items[items.length - 1];
        if (!items.length) { event.preventDefault(); return; }
        if (event.shiftKey && (document.activeElement === first || !overlay.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !overlay.current?.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener("keydown", keyboard, true);
    return () => {
      mounted.current = false; operation.current?.abort(); operation.current = null; releaseSnipSession(captureSession.current);
      window.removeEventListener("keydown", keyboard, true);
      if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
      if (previous?.isConnected) previous.focus();
    };
  }, [isOpen, close, embedded, undo, image, inlineText]);

  useEffect(() => {
    if (!image || !canvas.current) return;
    const ctx = canvas.current.getContext("2d"); if (!ctx) return;
    ctx.clearRect(0, 0, image.naturalWidth, image.naturalHeight);
    ctx.drawImage(image, 0, 0); drawMarks(ctx, edit.marks, image.naturalWidth);
  }, [image, edit.marks]);

  const fail = (error: unknown, signal: AbortSignal) => {
    if (!mounted.current || signal.aborted) return;
    const e = error as Error;
    setNotice(e.name === "NotAllowedError" ? "Capture cancelled. Select a source to try again." : e.message || "The operation failed. Please retry.");
  };
  const finish = (controller: AbortController) => {
    if (operation.current === controller) { operation.current = null; if (mounted.current) setBusy(null); }
  };
  const backToSelection = () => {
    gesture.current = null; setImage(null); setImageUrl(null); setRegion(null); setInlineText(null);
    if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
  };
  const capture = async (selected?: Rect) => {
    if (operation.current || !overlay.current || missingTarget) return;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const controller = new AbortController(); operation.current = controller; setBusy("capture"); setNotice("");
    let nextUrl: string | null = null;
    try {
      let aligned = false;
      const blob = await captureSnip(overlay.current, controller.signal, { session: captureSession.current, onSource: value => { aligned = value; } });
      checkAbort(controller.signal);
      nextUrl = URL.createObjectURL(blob);
      const nextImage = new Image(); nextImage.src = nextUrl;
      await nextImage.decode(); checkAbort(controller.signal);
      const crop = selected && aligned ? fitRect({ x: selected.x * nextImage.naturalWidth / viewport.width, y: selected.y * nextImage.naturalHeight / viewport.height, width: selected.width * nextImage.naturalWidth / viewport.width, height: selected.height * nextImage.naturalHeight / viewport.height }, nextImage.naturalWidth, nextImage.naturalHeight) : { x: 0, y: 0, width: nextImage.naturalWidth, height: nextImage.naturalHeight };
      if (editFirst || (selected && !aligned)) {
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = nextUrl; setImageUrl(nextUrl); nextUrl = null;
        setImage(nextImage); setEdit({ crop, marks: [] }); setRegion(null);
        setUndo([]); setTool("crop"); setInlineText(null);
        setNotice(selected && !aligned ? "A different source was selected. Drag to choose your area in this preview." : "Preview ready. Edit, then send or save.");
      } else {
        setBusy("send");
        const png = await exportSnip(nextImage, crop, []); checkAbort(controller.signal);
        await onCapture(new File([png], `space-snip-${Date.now()}.png`, { type: "image/png" }), targetId, captureRoomId, controller.signal);
        checkAbort(controller.signal); setCount(value => value + 1);
        backToSelection(); setNotice(targetId ? "Image sent to the selected pane." : "Image saved to Media Dock.");
      }
    } catch (error) { fail(error, controller.signal); }
    finally { if (nextUrl) URL.revokeObjectURL(nextUrl); finish(controller); }
  };
  const update = (next: Edit) => { setUndo(items => [...items.slice(-49), editRef.current]); setEdit(next); };
  const output = async (action: "send" | "copy" | "download") => {
    if (!image || operation.current || (action === "send" && missingTarget)) return;
    const controller = new AbortController(); operation.current = controller; setBusy(action === "send" ? "send" : "export"); setNotice("");
    try {
      const png = exportSnip(image, editRef.current.crop, editRef.current.marks).then(blob => { checkAbort(controller.signal); return blob; });
      if (action === "copy") {
        if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
          void png.catch(() => {});
          throw new Error("Image copying is unavailable in this browser. Use Save image instead.");
        }
        let copied = false;
        try {
          const item = new ClipboardItem({ "image/png": png });
          await navigator.clipboard.write([item]);
          copied = true;
        } catch {
          const blob = await png;
          checkAbort(controller.signal);
          const item = new ClipboardItem({ "image/png": blob });
          await navigator.clipboard.write([item]);
          copied = true;
        }
        if (copied) {
          checkAbort(controller.signal);
          setNotice("Image copied.");
        }
      } else {
        const blob = await png; checkAbort(controller.signal);
        const file = new File([blob], `space-snip-${Date.now()}.png`, { type: "image/png" });
        if (action === "send") {
          await onCapture(file, targetId, captureRoomId, controller.signal); checkAbort(controller.signal);
          setCount(value => value + 1); setNotice(targetId ? "Image sent to the selected pane." : "Image saved to Media Dock.");
        } else {
          const url = URL.createObjectURL(file), anchor = document.createElement("a");
          anchor.href = url; anchor.download = file.name; anchor.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          setNotice("Image download started.");
        }
      }
    } catch (error) { fail(error, controller.signal); }
    finally { finish(controller); }
  };
  const point = (event: React.PointerEvent): Point => {
    const bounds = canvas.current?.getBoundingClientRect();
    const bw = bounds && bounds.width > 0 ? bounds.width : (window.innerWidth || 800);
    const bh = bounds && bounds.height > 0 ? bounds.height : (window.innerHeight || 600);
    const bLeft = bounds?.left ?? 0;
    const bTop = bounds?.top ?? 0;
    const iw = image?.naturalWidth || 800;
    const ih = image?.naturalHeight || 600;
    return {
      x: clamp(Math.round(((event.clientX - bLeft) * iw) / bw), 0, iw),
      y: clamp(Math.round(((event.clientY - bTop) * ih) / bh), 0, ih)
    };
  };
  const down = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!image || busy || gesture.current || event.button !== 0) return;
    event.preventDefault(); event.currentTarget.focus();
    const p = point(event);
    const targetEl = event.target as HTMLElement;
    const resizeEl = targetEl.closest<HTMLElement>("[data-resize]");
    const moveEl = targetEl.closest<HTMLElement>("[data-move]");

    if (tool === "text" && !resizeEl) {
      if (text.trim()) {
        update({ ...edit, marks: [...edit.marks, { kind: "text", start: p, text: text.trim() }] });
        setText("");
        setNotice("Text placed.");
        return;
      }
      setInlineText({ pos: p, text: "" });
      return;
    }

    let gestureTool: Tool | "resize" = tool;
    let handle: ResizeHandle | undefined = undefined;

    if (resizeEl) {
      gestureTool = "resize";
      const h = resizeEl.getAttribute("data-resize");
      handle = (h === "true" || !h ? "se" : h) as ResizeHandle;
    } else if (moveEl || tool === "move") {
      gestureTool = "move";
    }

    gesture.current = { pointerId: event.pointerId, start: p, current: p, edit, tool: gestureTool, handle };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current; if (!g || g.pointerId !== event.pointerId || !image) return;
    const p = point(event); g.current = p;
    let next = g.edit;
    if (g.tool === "crop" || g.tool === "move" || g.tool === "resize") {
      next = { ...next, crop: computeCrop(g.tool, g.handle, g.start, p, g.edit.crop, image.naturalWidth, image.naturalHeight) };
    } else if (g.tool === "arrow" || g.tool === "redact") {
      next = { ...next, marks: [...next.marks, { kind: g.tool, start: g.start, end: p }] };
    }
    setEdit(next);
  };
  const end = (event: React.PointerEvent<HTMLDivElement>, cancel = false) => {
    const g = gesture.current; if (!g || g.pointerId !== event.pointerId) return;
    if (!cancel) move(event);
    if (cancel || Math.hypot(point(event).x - g.start.x, point(event).y - g.start.y) < 2) setEdit(g.edit);
    else setUndo(items => [...items.slice(-49), g.edit]);
    gesture.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const directPoint = (event: React.PointerEvent): Point => ({ x: clamp(event.clientX, 0, window.innerWidth), y: clamp(event.clientY, 0, window.innerHeight) });
  const directDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (image || busy || operation.current || directGesture.current || event.button !== 0 || (event.target as HTMLElement).closest("button, select, input, label, .snip-tool-hud")) return;
    event.preventDefault();
    const start = directPoint(event); directGesture.current = { pointerId: event.pointerId, start };
    setRegion(selection(start, start)); event.currentTarget.setPointerCapture(event.pointerId);
  };
  const directMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const g = directGesture.current;
    if (g?.pointerId === event.pointerId) setRegion(selection(g.start, directPoint(event)));
  };
  const directEnd = (event: React.PointerEvent<HTMLDivElement>, cancel = false) => {
    const g = directGesture.current; if (!g || g.pointerId !== event.pointerId) return;
    directGesture.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const r = selection(g.start, directPoint(event)); setRegion(null);
    if (!cancel && r.width >= 15 && r.height >= 15) void capture(r);
  };
  const commitInlineText = () => {
    if (inlineText && inlineText.text.trim()) {
      update({ ...edit, marks: [...edit.marks, { kind: "text", start: inlineText.pos, text: inlineText.text.trim() }] });
      setNotice("Text placed.");
    }
    setInlineText(null);
  };
  const changeSource = async () => {
    releaseSnipSession(captureSession.current);
    backToSelection();
    void capture();
  };
  const cropStyle = image ? { left: `${edit.crop.x / image.naturalWidth * 100}%`, top: `${edit.crop.y / image.naturalHeight * 100}%`, width: `${edit.crop.width / image.naturalWidth * 100}%`, height: `${edit.crop.height / image.naturalHeight * 100}%` } : {};
  const isDrawingTool = tool === "arrow" || tool === "text" || tool === "redact";

  if (!isOpen) return null;
  return <div className={`snip-tool-overlay${image ? "" : " snip-direct"}${isDrawingTool ? " snip-drawing-tool" : ""}`} ref={overlay}
    onPointerDown={directDown} onPointerMove={directMove} onPointerUp={e => directEnd(e)} onPointerCancel={e => directEnd(e, true)} onLostPointerCapture={() => { if (directGesture.current) { directGesture.current = null; setRegion(null); } }} onKeyDown={e => { if (!embedded || e.key !== "Tab") e.stopPropagation(); }} role="dialog" aria-busy={Boolean(busy)} aria-modal={embedded ? undefined : true} aria-labelledby="snip-title">
    <div className="snip-tool-hud">
      <strong id="snip-title">Snip Tool</strong>
      <label>Target <select aria-label="Capture destination" value={targetId ?? ""} disabled={Boolean(busy)} onChange={e => changeTarget(e.target.value || null)}>
        <option value="">Media Dock</option>
        {missingTarget && <option value={targetId!}>Unavailable pane</option>}
        {panes.map(p => <option value={p.id} key={p.id}>{p.title || p.mode}</option>)}
      </select></label>
      {!image && <>
        <button disabled={Boolean(busy) || missingTarget} onClick={() => void capture()}>Full Screen</button>
        <label><input type="checkbox" checked={editFirst} disabled={Boolean(busy)} onChange={e => setEditFirst(e.target.checked)} />Edit before send</label>
      </>}
      <span aria-live="polite">{count} captured</span>
      <button onClick={close} aria-label="Close Snip Tool">Done</button>
    </div>
    {!image ? <>
      {region && <div className="snip-selection-box" style={{ left: region.x, top: region.y, width: region.width, height: region.height }}><span className="snip-selection-dimensions">{Math.round(region.width)} × {Math.round(region.height)}</span></div>}
    </> : <>
      <div className="snip-edit-tools" role="toolbar" aria-label="Image tools">
        {(["crop", "move", "arrow", "text", "redact"] as const).map(t => <button key={t} aria-pressed={tool === t} disabled={Boolean(busy)} onClick={() => { setTool(t); setInlineText(null); }}>{ { crop: "Crop", move: "Move crop", arrow: "Arrow", text: "Text", redact: "Hide area" }[t]}</button>)}
        <button disabled={Boolean(busy) || !undo.length} onClick={() => { setEdit(undo[undo.length - 1]!); setUndo(undo.slice(0, -1)); }}>Undo</button>
        <button disabled={Boolean(busy)} onClick={() => update({ ...edit, crop: { x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight } })}>Full image</button>
        {tool === "text" && <input ref={textInputRef} aria-label="Annotation text" value={text} maxLength={200} onChange={e => setText(e.target.value)} placeholder="Text to place on image" disabled={Boolean(busy)} />}
      </div>
      <div className="snip-preview-scroll">
        <div className="snip-image-stage" style={{ aspectRatio: `${image.naturalWidth} / ${image.naturalHeight}`, maxWidth: `min(100%, ${image.naturalWidth}px, calc(68dvh * ${image.naturalWidth / image.naturalHeight}))` }} tabIndex={0} role="group" aria-label="Image preview. Drag to edit. Arrow keys move crop; Shift and arrows resize it."
          onPointerDown={down} onPointerMove={move} onPointerUp={e => end(e)} onPointerCancel={e => end(e, true)} onLostPointerCapture={() => { if (gesture.current) { setEdit(gesture.current.edit); gesture.current = null; } }}
          onKeyDown={e => {
            if (busy || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
            e.preventDefault(); e.stopPropagation();
            const dx = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0, dy = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
            const r = edit.crop;
            update({ ...edit, crop: fitRect(e.shiftKey ? { ...r, width: clamp(r.width + dx, 1, image.naturalWidth - r.x), height: clamp(r.height + dy, 1, image.naturalHeight - r.y) } : { ...r, x: r.x + dx, y: r.y + dy }, image.naturalWidth, image.naturalHeight) });
          }}>
          <canvas ref={canvas} width={image.naturalWidth} height={image.naturalHeight} aria-label="Captured image" />
          <div className={`snip-crop-box${!isDrawingTool ? " is-active" : ""}`} ref={cropBoxRef} style={cropStyle}>
            <div className="snip-crop-inner" data-move="true" title="Drag to move crop area" />
            <span data-resize="se" className="snip-resize snip-handle-se" title="Drag to resize crop" />
            <span data-resize="nw" className="snip-handle snip-handle-nw" title="Drag to resize crop" />
            <span data-resize="ne" className="snip-handle snip-handle-ne" title="Drag to resize crop" />
            <span data-resize="sw" className="snip-handle snip-handle-sw" title="Drag to resize crop" />
            <span data-resize="n" className="snip-handle snip-handle-n" title="Drag to resize crop" />
            <span data-resize="s" className="snip-handle snip-handle-s" title="Drag to resize crop" />
            <span data-resize="w" className="snip-handle snip-handle-w" title="Drag to resize crop" />
            <span data-resize="e" className="snip-handle snip-handle-e" title="Drag to resize crop" />
            <div className="snip-crop-badge">{Math.round(edit.crop.width)} × {Math.round(edit.crop.height)}</div>
          </div>
          {inlineText && <div className="snip-inline-text-popup" style={{ left: `${inlineText.pos.x / image.naturalWidth * 100}%`, top: `${inlineText.pos.y / image.naturalHeight * 100}%` }}>
            <input autoFocus className="snip-inline-text-input" value={inlineText.text} placeholder="Type text & press Enter" onChange={e => setInlineText({ ...inlineText, text: e.target.value })} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); commitInlineText(); } else if (e.key === "Escape") { e.preventDefault(); setInlineText(null); } }} />
            <button type="button" className="snip-inline-text-btn" onClick={commitInlineText}>✓</button>
            <button type="button" className="snip-inline-text-btn" onClick={() => setInlineText(null)}>✕</button>
          </div>}
        </div>
      </div>
      <div className="snip-crop-fields" aria-label="Crop dimensions">
        {(["x", "y", "width", "height"] as const).map(key => <label key={key}>{key}<input type="number" aria-label={`Crop ${key}`} min={key === "x" || key === "y" ? 0 : 1} max={key === "x" || key === "width" ? image.naturalWidth : image.naturalHeight} value={fieldDrafts[key] ?? edit.crop[key]} disabled={Boolean(busy)} onChange={e => { const raw = e.target.value; if (raw === "") { setFieldDrafts(prev => ({ ...prev, [key]: "" })); return; } const num = parseInt(raw, 10); if (Number.isFinite(num)) { setFieldDrafts(prev => ({ ...prev, [key]: undefined })); update({ ...edit, crop: fitRect({ ...edit.crop, [key]: num }, image.naturalWidth, image.naturalHeight) }); } else { setFieldDrafts(prev => ({ ...prev, [key]: raw })); } }} onBlur={() => setFieldDrafts(prev => ({ ...prev, [key]: undefined }))} /></label>)}
        <span>px</span>
      </div>
      <div className="snip-actions">
        <button disabled={Boolean(busy)} onClick={backToSelection}>Back to selection</button>
        <button disabled={Boolean(busy)} onClick={() => void changeSource()}>Change source</button>
        <button disabled={Boolean(busy)} onClick={() => void output("copy")}>Copy image</button>
        <button disabled={Boolean(busy)} onClick={() => void output("download")}>Save image</button>
        <button className="snip-primary" disabled={Boolean(busy) || missingTarget} onClick={() => void output("send")}>{targetId ? "Send to pane" : "Save to Media Dock"}</button>
      </div>
    </>}
    {missingTarget && <p role="alert">The selected pane is no longer available. Choose another pane or Media Dock.</p>}
    <p className="snip-status" role="status">{busy === "capture" ? "Waiting for capture… Press Escape to cancel." : busy === "send" ? "Sending image…" : busy === "export" ? "Preparing image…" : notice || (imageUrl ? "Drag to crop. Use Hide area for solid, permanent redaction in the exported image." : "Drag to select an area. Release to capture. Press Escape to close.")}</p>
  </div>;
}
