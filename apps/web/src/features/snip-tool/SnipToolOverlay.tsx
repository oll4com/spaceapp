import { useWorkspaceSurface } from "../ui-theme/WorkspaceSurface.js";
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { assertCaptureAllowed, captureSnipFrame, checkAbort, hasNativeCapture, releaseSnipSession, type SnipCaptureSession } from "./snip-capture.js";
import { captureDomFrame, prepareDomCapture, SnipDomUnsupportedError } from "./snip-dom-capture.js";
import { clamp, cropFrame, exportSnip, fitRect, frameFromBlob, selection, type Point, type Rect, type SnipFrame } from "./snip-image.js";
import { SnipEditor, type SnipBusy, type SnipDestinationOption, type SnipEdit } from "./SnipEditor.js";
import {
  Check, ChevronDown, CircleAlert, Clipboard, Crop, GripVertical, ImagePlus, Images, Loader2, Lock, Monitor, Pencil, Timer, Unlock, X
} from "../ui-theme/app-icons.js";
import {
  DOCK_MARGIN_RIGHT, getRailTopBoundary, loadSnipRailDock, placeSnipOnRail, saveSnipRailDock, SNIP_RAIL_CHANGED_EVENT, type SnipRailDock
} from "../desktop-widgets/widget-storage.js";
import "./snip-tool.css";

export interface SnipTargetPane { id: string; title: string; mode: string; paneName?: string | null }
export interface SnipToolOverlayProps {
  isOpen: boolean; onClose: () => void; isMobile?: boolean;
  roomId?: string; activePaneId?: string | null; activePaneTitle?: string | null; activePaneMode?: string | null;
  activePaneName?: string | null;
  availablePanes?: SnipTargetPane[]; onSelectTargetPane?: (paneId: string) => void;
  onCapture: (file: File, targetPaneId?: string | null, roomId?: string, signal?: AbortSignal) => Promise<void>;
  /** "toolbar" and "overlay" are accepted for compatibility and open the compact capsule. */
  initialMode?: "float" | "overlay" | "toolbar" | "capturing";
  autoCloseOnCapture?: boolean;
  defaultTargetLocked?: boolean;
  defaultClipboardMode?: boolean;
}

type Phase = "idle" | "selecting" | "editing";
type Toast = { id: number; tone: "ok" | "error"; text: string; editable?: boolean };
type Destination = { clipboard: boolean; hold: boolean; targetId: string | null; roomId?: string; label: string };

const POSITIONS_STORAGE_KEY = "space.snip-tool.positions.v1";
const CLIPBOARD_MODE_STORAGE_KEY = "space.snip-tool.clipboard-mode.v1";
const EDIT_FIRST_STORAGE_KEY = "space.snip-tool.edit-first.v1";
const SCREEN_SHARE_STORAGE_KEY = "space.snip-tool.screen-share.v1";
const CLIPBOARD_VALUE = "__clipboard__";
const EDGE = 8;
const MIN_SELECTION = 15;
const DELAY_SECONDS = 3;

function readFlag(key: string): boolean {
  try { return localStorage.getItem(key) === "true"; } catch { return false; }
}
function writeFlag(key: string, value: boolean) {
  try { localStorage.setItem(key, String(value)); } catch {}
}
function loadSavedFloat(): Point | null {
  try {
    const saved = JSON.parse(localStorage.getItem(POSITIONS_STORAGE_KEY) || "{}")?.float;
    return saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) ? saved : null;
  } catch {
    return null;
  }
}
function saveFloat(float: Point | null) {
  try {
    const current = JSON.parse(localStorage.getItem(POSITIONS_STORAGE_KEY) || "{}");
    if (float) current.float = float; else delete current.float;
    localStorage.setItem(POSITIONS_STORAGE_KEY, JSON.stringify(current));
  } catch {}
}
function clampToViewport(pos: Point, size: { width: number; height: number }): Point {
  const vw = window.innerWidth || 800, vh = window.innerHeight || 600;
  return { x: clamp(pos.x, EDGE, Math.max(EDGE, vw - size.width - EDGE)), y: clamp(pos.y, EDGE, Math.max(EDGE, vh - size.height - EDGE)) };
}
/** Top-right, clear of the right-hand rail, where the eye expects floating tools. */
function defaultFloat(size: { width: number; height: number }): Point {
  return clampToViewport({ x: (window.innerWidth || 800) - size.width - 64, y: 72 }, size);
}

/** The desktop widgets' docking rule: the pointer, or the dragged item's right edge, reaches the right rail. */
function nearRail(clientX: number, clientY: number, right: number): boolean {
  const vw = window.innerWidth || 800;
  return (clientX >= vw - 100 || right >= vw - 20) && clientY >= getRailTopBoundary() - 20;
}

async function copyBlobToClipboard(blobOrPromise: Blob | Promise<Blob>, signal?: AbortSignal): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    if (blobOrPromise instanceof Promise) void blobOrPromise.catch(() => {});
    throw new Error("Image copying is unavailable in this browser. Use Save image instead.");
  }
  try {
    // A pending blob keeps the user activation alive in browsers that require it.
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blobOrPromise })]);
  } catch {
    const blob = await blobOrPromise;
    if (signal) checkAbort(signal);
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  }
  if (signal) checkAbort(signal);
}

const isCliMode = (mode?: string | null) => mode === "TERMINAL" || mode === "CHAT";
const paneLabel = (pane: SnipTargetPane) => pane.paneName || pane.title || pane.mode;
const MODE_TAGS: Record<string, string> = { TERMINAL: "CLI", CHAT: "Chat", BROWSER: "Browser" };

interface CaptureLayerProps {
  layerRef: React.RefObject<HTMLDivElement | null>;
  busy: boolean;
  destinationLabel: string;
  status: string | null;
  onSelect: (rect: Rect) => void;
  onCancel: () => void;
}

/**
 * Full-screen selection surface: a light dim, crosshair guides and the selection box, nothing else.
 * Drag feedback is written to the DOM directly, so moving never re-renders React.
 */
function CaptureLayer({ layerRef, busy, destinationLabel, status, onSelect, onCancel }: CaptureLayerProps) {
  const box = useRef<HTMLDivElement>(null), dims = useRef<HTMLSpanElement>(null);
  const guideX = useRef<HTMLDivElement>(null), guideY = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; start: Point } | null>(null);
  const [dragging, setDragging] = useState(false);
  const pt = (event: React.PointerEvent): Point => ({ x: clamp(event.clientX, 0, window.innerWidth), y: clamp(event.clientY, 0, window.innerHeight) });
  const paint = (r: Rect) => {
    const el = box.current;
    if (!el) return;
    el.style.left = `${r.x}px`; el.style.top = `${r.y}px`; el.style.width = `${r.width}px`; el.style.height = `${r.height}px`;
    if (dims.current) dims.current.textContent = `${Math.round(r.width)} × ${Math.round(r.height)}`;
  };
  const guides = (p: Point) => {
    if (guideX.current) guideX.current.style.transform = `translateY(${p.y}px)`;
    if (guideY.current) guideY.current.style.transform = `translateX(${p.x}px)`;
  };
  const down = (event: React.PointerEvent<HTMLDivElement>) => {
    if (busy || drag.current || event.button !== 0) return;
    event.preventDefault();
    const start = pt(event);
    drag.current = { pointerId: event.pointerId, start };
    setDragging(true);
    paint(selection(start, start));
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch {}
  };
  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    const p = pt(event);
    guides(p);
    const g = drag.current;
    if (g && g.pointerId === event.pointerId) paint(selection(g.start, p));
  };
  const end = (event: React.PointerEvent<HTMLDivElement>, cancel: boolean) => {
    const g = drag.current;
    if (!g || g.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    try { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); } catch {}
    const r = selection(g.start, pt(event));
    if (!cancel && r.width >= MIN_SELECTION && r.height >= MIN_SELECTION) onSelect(r);
    else onCancel();
  };
  return (
    <div className={`snip-tool-overlay snip-direct snip-layer snip-ui${dragging ? " is-dragging" : ""}${busy ? " is-capturing" : ""}`} ref={layerRef} role="dialog" aria-modal="true"
      aria-label="Snip selection" aria-busy={busy} data-snip-tool="true"
      onPointerDown={down} onPointerMove={move} onPointerUp={e => end(e, false)} onPointerCancel={e => end(e, true)}
      onLostPointerCapture={() => { if (drag.current) { drag.current = null; setDragging(false); } }}>
      <div className="snip-guide snip-guide-x" ref={guideX} aria-hidden="true" />
      <div className="snip-guide snip-guide-y" ref={guideY} aria-hidden="true" />
      <div className="snip-selection-box" ref={box} hidden={!dragging}><span className="snip-selection-dimensions" ref={dims} /></div>
      <span className="snip-sr-only" role="status">
        {status ?? `Snip to ${destinationLabel}. Drag to select an area. Enter captures the full screen, Escape cancels.`}
      </span>
    </div>
  );
}

export function SnipToolOverlay(props: SnipToolOverlayProps) {
  const embedded = useWorkspaceSurface();
  const {
    isOpen, onClose, roomId, activePaneId, activePaneTitle, activePaneMode, activePaneName,
    availablePanes, onSelectTargetPane, onCapture, initialMode = "float", autoCloseOnCapture = false, defaultClipboardMode
  } = props;
  const [phase, setPhase] = useState<Phase>(initialMode === "capturing" ? "selecting" : "idle");
  const [busy, setBusy] = useState<SnipBusy>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [notice, setNotice] = useState("");
  const [editor, setEditor] = useState<{ frame: SnipFrame; crop: Rect; key: number } | null>(null);
  const [targetId, setTargetId] = useState<string | null>(activePaneId ?? null);
  const [isLocked, setIsLocked] = useState(Boolean(props.defaultTargetLocked));
  const [copyToClipboard, setCopyToClipboard] = useState(() => defaultClipboardMode ?? readFlag(CLIPBOARD_MODE_STORAGE_KEY));
  const [editFirst, setEditFirst] = useState(() => readFlag(EDIT_FIRST_STORAGE_KEY));
  const [useScreenShare, setUseScreenShare] = useState(() => readFlag(SCREEN_SHARE_STORAGE_KEY));
  const [menuOpen, setMenuOpen] = useState(false);
  // Hold snips (clipboard mode only): snips stay in memory until one paste delivers them all.
  const [holdSnips, setHoldSnips] = useState(false);
  const held = useRef<Blob[]>([]);
  const [heldCount, setHeldCount] = useState(0);
  const pendingPaste = useRef<{ paneId: string | null } | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [pos, setPos] = useState<Point>(() => loadSavedFloat() ?? defaultFloat({ width: 300, height: 44 }));
  const [pulse, setPulse] = useState(1);
  const [captureRoomId, setCaptureRoomId] = useState(roomId);
  const capsuleRef = useRef<HTMLDivElement>(null), layerRef = useRef<HTMLDivElement>(null), fileRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null), menuButtonRef = useRef<HTMLButtonElement>(null);
  const session = useRef<SnipCaptureSession>({ stream: null, video: null, handle: `space-snip-${crypto.randomUUID()}` });
  const operation = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const lastShot = useRef<{ frame: SnipFrame; crop: Rect } | null>(null);
  const editorFrame = useRef<SnipFrame | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const floatDragCleanup = useRef<(() => void) | null>(null);
  const onCloseRef = useRef(onClose); onCloseRef.current = onClose;
  const phaseRef = useRef(phase); phaseRef.current = phase;
  const floating = !embedded;
  const canDock = floating && !props.isMobile;
  const [railDock, setRailDock] = useState<SnipRailDock | null>(() => canDock ? loadSnipRailDock() : null);
  const [railDrag, setRailDrag] = useState<{ x: number | null; y: number } | null>(null);
  const [dockPreview, setDockPreview] = useState(false);
  const railDragMoved = useRef(false);
  const docked = canDock && Boolean(railDock);

  const panes = availablePanes ?? (activePaneId ? [{ id: activePaneId, title: activePaneName || activePaneTitle || activePaneId, mode: activePaneMode || "", paneName: activePaneName ?? null }] : []);
  const isCliPane = useCallback((paneId: string | null | undefined, paneMode?: string | null) => {
    if (!paneId) return false;
    if (isCliMode(paneMode)) return true;
    return isCliMode(availablePanes?.find(p => p.id === paneId)?.mode);
  }, [availablePanes]);
  const targetPane = panes.find(p => p.id === targetId);
  const missingTarget = Boolean(targetId && !targetPane);
  const targetDisplay = targetPane ? paneLabel(targetPane) : targetId ? "Unavailable pane" : "Media Dock";
  const destinationLabel = copyToClipboard ? "Clipboard" : targetDisplay;
  const snipLabel = copyToClipboard ? "Snip: Clipboard" : `Snip: ${targetDisplay}`;

  // ---- frame lifetime: frames are released once neither the editor nor the "Edit" toast needs them.
  const releaseFrame = (frame: SnipFrame | null | undefined) => {
    if (!frame || frame === editorFrame.current || frame === lastShot.current?.frame) return;
    frame.close?.();
  };
  const setLastShot = (shot: { frame: SnipFrame; crop: Rect } | null) => {
    const previous = lastShot.current?.frame;
    lastShot.current = shot;
    if (previous !== shot?.frame) releaseFrame(previous);
  };

  const showToast = useCallback((tone: Toast["tone"], text: string, editable = false) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ id: Date.now(), tone, text, editable });
    setPulse(value => value + 1);
    toastTimer.current = setTimeout(() => {
      setToast(null);
      if (editable) setLastShot(null);
    }, tone === "error" || editable ? 6000 : 2600);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = useCallback(() => {
    operation.current?.abort();
    releaseSnipSession(session.current);
    onCloseRef.current();
  }, []);

  const restoreFocus = () => {
    const target = returnFocus.current;
    returnFocus.current = null;
    const active = document.activeElement as HTMLElement | null;
    const lost = !active || active === document.body || Boolean(active.closest?.(".snip-ui"));
    if (lost && target?.isConnected) target.focus({ preventScroll: true });
  };
  const rememberFocus = () => {
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body && !active.closest?.(".snip-ui")) returnFocus.current = active;
  };

  const goIdle = () => {
    if (autoCloseOnCapture) { close(); return; }
    setPhase("idle");
    setMenuOpen(false);
    if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(restoreFocus); else restoreFocus();
  };

  const closeEditor = () => {
    const frame = editorFrame.current;
    editorFrame.current = null;
    setEditor(null);
    releaseFrame(frame);
  };

  /** Opens the editor on just the snipped region, like a native snipping tool; the full frame is released. */
  const openRegionEditor = (frame: SnipFrame, crop: Rect, message = "") => {
    const region = cropFrame(frame, crop);
    if (region === frame) { openEditor(frame, crop, message); return; }
    openEditor(region, { x: 0, y: 0, width: region.width, height: region.height }, message);
    releaseFrame(frame);
  };

  const openEditor = (frame: SnipFrame, crop: Rect, message = "") => {
    if (editorFrame.current && editorFrame.current !== frame) {
      const previous = editorFrame.current;
      editorFrame.current = null;
      releaseFrame(previous);
    }
    editorFrame.current = frame;
    setEditor({ frame, crop, key: Date.now() });
    setNotice(message);
    setMenuOpen(false);
    setToast(null);
    setPhase("editing");
  };

  // ---- target tracking
  useEffect(() => { setCaptureRoomId(roomId); }, [roomId]);
  useEffect(() => {
    if (isLocked || !activePaneId || phase === "editing") return;
    if (isCliPane(activePaneId, activePaneMode)) setTargetId(activePaneId);
  }, [isLocked, activePaneId, activePaneMode, isCliPane, phase]);
  useEffect(() => {
    if (phase === "editing" || !targetId || panes.some(p => p.id === targetId)) return;
    setIsLocked(false);
    setTargetId(activePaneId && isCliPane(activePaneId, activePaneMode) ? activePaneId : null);
  }, [panes, targetId, phase, activePaneId, activePaneMode, isCliPane]);

  const applyDestination = (value: string) => {
    if (value === CLIPBOARD_VALUE) {
      setCopyToClipboard(true); writeFlag(CLIPBOARD_MODE_STORAGE_KEY, true);
      return;
    }
    setCopyToClipboard(false); writeFlag(CLIPBOARD_MODE_STORAGE_KEY, false);
    const next = value || null;
    setTargetId(next);
    // An explicit choice should not be overridden by the next pane focus change.
    setIsLocked(true);
    if (next) onSelectTargetPane?.(next);
  };
  const toggleClipboardMode = () => {
    setCopyToClipboard(prev => { writeFlag(CLIPBOARD_MODE_STORAGE_KEY, !prev); return !prev; });
  };
  const toggleHoldSnips = () => {
    if (holdSnips) { held.current = []; setHeldCount(0); }
    setHoldSnips(!holdSnips);
  };
  const toggleScreenShare = () => {
    setUseScreenShare(prev => { writeFlag(SCREEN_SHARE_STORAGE_KEY, !prev); if (prev) releaseSnipSession(session.current); return !prev; });
  };
  const toggleEditFirst = () => {
    setEditFirst(prev => { writeFlag(EDIT_FIRST_STORAGE_KEY, !prev); return !prev; });
  };
  const toggleTargetLock = () => {
    setIsLocked(prev => {
      if (prev && activePaneId && isCliPane(activePaneId, activePaneMode)) setTargetId(activePaneId);
      return !prev;
    });
  };

  // ---- capture & delivery
  const destinationSnapshot = (): Destination => ({ clipboard: copyToClipboard, hold: holdSnips && copyToClipboard, targetId, roomId: captureRoomId, label: destinationLabel });

  const deliver = async (frame: SnipFrame, edit: SnipEdit, dest: Destination, signal: AbortSignal, alsoCopy: boolean): Promise<string> => {
    const png = exportSnip(frame, edit.crop, edit.marks).then(blob => { checkAbort(signal); return blob; });
    if (dest.clipboard) {
      setBusy("export");
      if (dest.hold) {
        held.current.push(await png);
        setHeldCount(held.current.length);
        return `Held ${held.current.length} snip${held.current.length === 1 ? "" : "s"}. Ctrl+V pastes them all.`;
      }
      await copyBlobToClipboard(png, signal);
      return "Copied to clipboard. Paste with Ctrl+V.";
    }
    setBusy("send");
    const blob = await png;
    checkAbort(signal);
    if (alsoCopy) {
      try { if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") void navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]).catch(() => {}); } catch {}
    }
    await onCapture(new File([blob], `space-snip-${Date.now()}.png`, { type: "image/png" }), dest.targetId, dest.roomId, signal);
    checkAbort(signal);
    return dest.targetId ? `Sent to ${dest.label}.` : "Saved to Media Dock.";
  };

  const begin = () => {
    const controller = new AbortController();
    operation.current = controller;
    return controller;
  };
  const finish = (controller: AbortController) => {
    if (operation.current === controller) { operation.current = null; if (mounted.current) setBusy(null); }
  };
  const failed = (error: unknown, signal: AbortSignal) => !mounted.current || signal.aborted ? null
    : (error as Error).name === "NotAllowedError" ? "Capture cancelled. Snip again to choose a source." : (error as Error).message || "The operation failed. Please retry.";

  const capture = async (selected?: Rect, forceEdit = false, forceShare = false) => {
    const hideEl = phaseRef.current === "selecting" ? layerRef.current : capsuleRef.current;
    if (operation.current || !hideEl) return;
    const dest = destinationSnapshot();
    if (!dest.clipboard && missingTarget) return;
    if (phaseRef.current === "idle") rememberFocus();
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const controller = begin();
    setBusy("capture"); setToast(null); setMenuOpen(false);
    let shot: { frame: SnipFrame; crop: Rect } | null = null;
    let sharedFor = "";
    try {
      assertCaptureAllowed();
      // SpaceApp redraws its own page: no permission prompt, nothing to hide, no video frame to wait for.
      if (!forceShare && !useScreenShare && !hasNativeCapture()) {
        try {
          const frame = await captureDomFrame({ region: selected ?? { x: 0, y: 0, width: viewport.width, height: viewport.height }, signal: controller.signal });
          shot = { frame, crop: { x: 0, y: 0, width: frame.width, height: frame.height } };
        } catch (error) {
          if (!(error instanceof SnipDomUnsupportedError)) throw error;
          sharedFor = error.reason;
        }
      }
      if (shot) {
        checkAbort(controller.signal);
        if (forceEdit || editFirst) {
          const editable = shot;
          shot = null;
          openEditor(editable.frame, editable.crop);
          return;
        }
        const message = await deliver(shot.frame, { crop: shot.crop, marks: [] }, dest, controller.signal, false);
        // A held snip offers no Edit: editing it would hold a second copy.
        if (!dest.hold) { setLastShot(shot); shot = null; }
        goIdle();
        if (!autoCloseOnCapture) showToast("ok", message, !dest.hold);
        return;
      }
      let aligned = false;
      const frame = await captureSnipFrame(hideEl, controller.signal, { session: session.current, onSource: value => { aligned = value; } });
      const crop = selected && aligned ? fitRect({
        x: selected.x * frame.width / viewport.width, y: selected.y * frame.height / viewport.height,
        width: selected.width * frame.width / viewport.width, height: selected.height * frame.height / viewport.height
      }, frame.width, frame.height) : { x: 0, y: 0, width: frame.width, height: frame.height };
      shot = { frame, crop };
      checkAbort(controller.signal);
      if (selected && !aligned) {
        openEditor(frame, crop, "A different source was selected. Drag to choose your area in this preview.");
        shot = null;
        return;
      }
      if (forceEdit || editFirst) {
        shot = null;
        openRegionEditor(frame, crop);
        return;
      }
      const message = await deliver(frame, { crop, marks: [] }, dest, controller.signal, false);
      if (!dest.hold) { setLastShot(shot); shot = null; }
      goIdle();
      if (!autoCloseOnCapture) showToast("ok", sharedFor ? `${message} Screen sharing was used for ${sharedFor}.` : message, !dest.hold);
    } catch (error) {
      const message = failed(error, controller.signal);
      if (message) {
        if (phaseRef.current === "selecting") goIdle();
        // Keep a captured-but-undelivered snip so "Edit" can retry it from the editor.
        if (shot) { setLastShot(shot); shot = null; }
        showToast("error", message, Boolean(lastShot.current));
      }
    } finally {
      if (shot) shot.frame.close?.();
      finish(controller);
    }
  };

  const output = async (action: "send" | "copy" | "download", edit: SnipEdit) => {
    const frame = editorFrame.current;
    const dest = destinationSnapshot();
    const effective = action === "send" && dest.clipboard ? "copy" : action;
    if (!frame || operation.current || (effective === "send" && missingTarget)) return;
    const controller = begin();
    setNotice("");
    try {
      let message: string;
      if (effective === "download") {
        setBusy("export");
        const blob = await exportSnip(frame, edit.crop, edit.marks);
        checkAbort(controller.signal);
        const url = URL.createObjectURL(blob), anchor = document.createElement("a");
        anchor.href = url; anchor.download = `space-snip-${Date.now()}.png`; anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        message = "Image download started.";
      } else {
        // "Copy image" always copies; only the primary action holds.
        message = await deliver(frame, edit, effective === "copy" ? { ...dest, clipboard: true, hold: dest.hold && action === "send" } : dest, controller.signal, effective === "send");
      }
      closeEditor();
      goIdle();
      if (!autoCloseOnCapture) showToast("ok", message);
    } catch (error) {
      const message = failed(error, controller.signal);
      if (message) setNotice(message);
    } finally {
      finish(controller);
    }
  };

  /** Delivers every held snip in order, forgetting each one once it is delivered. */
  const pasteHeld = async (paneId: string | null, label: string) => {
    const controller = begin();
    setBusy("send"); setToast(null); setMenuOpen(false);
    let count = 0;
    try {
      while (held.current.length) {
        await onCapture(new File([held.current[0]!], `space-snip-${Date.now()}-${count + 1}.png`, { type: "image/png" }), paneId, captureRoomId, controller.signal);
        checkAbort(controller.signal);
        held.current.shift();
        count += 1;
        setHeldCount(held.current.length);
      }
      showToast("ok", paneId ? `Pasted ${count} snip${count === 1 ? "" : "s"} into ${label}.` : `Saved ${count} snip${count === 1 ? "" : "s"} to Media Dock.`);
    } catch (error) {
      const message = failed(error, controller.signal);
      if (message) showToast("error", message);
    } finally {
      finish(controller);
    }
  };

  /** Ctrl+V for the target pane: a clipboard image goes the way a snip does, text through the CLI pane's own paste. */
  const pasteClipboard = async () => {
    if (operation.current || missingTarget) return;
    if (handlers.current.pasteHeldInto(null)) return;
    const dest = destinationSnapshot(), label = targetDisplay, cli = isCliPane(targetId, targetPane?.mode);
    const controller = begin();
    setBusy("send"); setToast(null); setMenuOpen(false);
    try {
      if (!navigator.clipboard?.read) throw new Error("This browser cannot read the clipboard. Click the pane and press Ctrl+V.");
      // image/png is the only image type the async clipboard exposes.
      const item = (await navigator.clipboard.read()).find(entry => entry.types.includes("image/png"));
      checkAbort(controller.signal);
      if (item) {
        const blob = await item.getType("image/png");
        checkAbort(controller.signal);
        await onCapture(new File([blob], `space-paste-${Date.now()}.png`, { type: "image/png" }), dest.targetId, dest.roomId, controller.signal);
        checkAbort(controller.signal);
        showToast("ok", dest.targetId ? `Pasted into ${label}.` : "Saved to Media Dock.");
      } else if (cli) {
        window.dispatchEvent(new CustomEvent("space:terminal-pane-action", { detail: { paneId: dest.targetId, action: "paste" } }));
      } else {
        showToast("error", "The clipboard holds no image.");
      }
    } catch (error) {
      const message = failed(error, controller.signal);
      if (message) showToast("error", (error as Error).name === "NotAllowedError" ? "The browser did not allow reading the clipboard. Click the pane and press Ctrl+V." : message);
    } finally {
      finish(controller);
    }
  };

  const startSelecting = () => {
    if (operation.current) return;
    rememberFocus();
    setMenuOpen(false);
    setToast(null);
    setPhase("selecting");
  };
  const stopCountdown = () => {
    if (countdownTimer.current) clearInterval(countdownTimer.current);
    countdownTimer.current = null;
    setCountdown(null);
  };
  /** Full-screen capture after a short delay, so menus and hover states can be opened first. A second click cancels. */
  const toggleDelayedCapture = () => {
    if (countdownTimer.current) { stopCountdown(); return; }
    let left = DELAY_SECONDS;
    setCountdown(left);
    countdownTimer.current = setInterval(() => {
      left -= 1;
      if (left > 0) { setCountdown(left); return; }
      stopCountdown();
      // Through handlers so the capture uses the destination chosen during the countdown.
      handlers.current.fullScreen();
    }, 1000);
  };
  const cancelSelecting = () => {
    operation.current?.abort();
    goIdle();
  };
  const editLast = () => {
    const shot = lastShot.current;
    if (!shot) return;
    if (toastTimer.current) clearTimeout(toastTimer.current);
    lastShot.current = null;
    rememberFocus();
    openRegionEditor(shot.frame, shot.crop);
  };
  const openImageFile = async (file: File | null | undefined) => {
    if (!file || operation.current) return;
    if (!file.type.startsWith("image/")) { showToast("error", "Choose an image file to edit."); return; }
    try {
      const frame = await frameFromBlob(file);
      if (!mounted.current) { frame.close?.(); return; }
      rememberFocus();
      openEditor(frame, { x: 0, y: 0, width: frame.width, height: frame.height }, "Image opened. Edit, then send or save.");
    } catch (error) {
      showToast("error", (error as Error).message || "The image could not be opened.");
    }
  };

  // ---- lifecycle & keyboard
  const handlers = useRef({ trigger: () => {}, cancelSelecting, fullScreen: () => {}, pasteHeldInto: (_paneId: string | null): boolean => false });
  handlers.current = {
    trigger: () => {
      if (operation.current) return;
      if (phaseRef.current === "idle") startSelecting();
      else if (phaseRef.current === "selecting") cancelSelecting();
    },
    cancelSelecting,
    fullScreen: () => { void capture(); },
    pasteHeldInto: paneId => {
      if (!copyToClipboard || (paneId ? !isCliPane(paneId) : missingTarget)) return false;
      // A snip still being taken (timer, selection, capture, editor) joins the paste once it lands.
      if (holdSnips && (countdownTimer.current || phaseRef.current !== "idle" || operation.current)) { pendingPaste.current = { paneId }; return true; }
      if (!held.current.length || operation.current || phaseRef.current !== "idle") return false;
      const pane = paneId ? panes.find(p => p.id === paneId) : null;
      void pasteHeld(paneId ?? targetId, paneId ? (pane ? paneLabel(pane) : "the pane") : targetDisplay);
      return true;
    }
  };

  useEffect(() => {
    if (phase !== "idle" || busy || countdown !== null || !pendingPaste.current) return;
    const { paneId } = pendingPaste.current;
    pendingPaste.current = null;
    handlers.current.pasteHeldInto(paneId);
  }, [phase, busy, countdown]);

  useEffect(() => {
    if (!isOpen) return;
    setPhase(initialMode === "capturing" ? "selecting" : "idle");
    if (initialMode === "capturing") rememberFocus();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialMode]);

  useEffect(() => {
    if (!isOpen || hasNativeCapture()) return;
    // Compile the page's stylesheets while idle so the first snip is as fast as the rest.
    const idle = (window as any).requestIdleCallback as ((cb: () => void, opts?: { timeout: number }) => number) | undefined;
    const handle = idle ? idle(() => { try { prepareDomCapture(); } catch {} }, { timeout: 1500 }) : window.setTimeout(() => { try { prepareDomCapture(); } catch {} }, 200);
    return () => { if (idle) (window as any).cancelIdleCallback?.(handle); else window.clearTimeout(handle); };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    mounted.current = true;
    document.body.setAttribute("data-snip-tool-active", "true");
    let lastTrigger = 0;
    const trigger = () => {
      const now = Date.now();
      if (now - lastTrigger < 350) return;
      lastTrigger = now;
      handlers.current.trigger();
    };
    // PrintScreen itself is owned by the app shell, which forwards it as space:snip-tool:trigger.
    // Only the modal selection phase claims keys; the idle capsule never intercepts Tab or Escape.
    const keyboard = (event: KeyboardEvent) => {
      if (phaseRef.current !== "selecting") return;
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); handlers.current.cancelSelecting(); }
      else if (event.key === "Enter" && !(event.target instanceof HTMLButtonElement)) { event.preventDefault(); event.stopImmediatePropagation(); handlers.current.fullScreen(); }
    };
    // A paste into a CLI pane delivers every held snip there, before the pane reads the system clipboard. Focus left
    // outside the panes (a dock or the page, after snipping it) pastes into the snip target like the capsule's Ctrl+V.
    const pasteHeldSnips = (event: KeyboardEvent | ClipboardEvent) => {
      if (event instanceof KeyboardEvent && (event.altKey || event.shiftKey || !(event.ctrlKey || event.metaKey) || (event.code !== "KeyV" && event.key.toLowerCase() !== "v"))) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      const paneId = target?.closest("[data-space-pane-id]")?.getAttribute("data-space-pane-id") ?? null;
      // Text fields outside the panes keep their own paste.
      if (!paneId && (target?.closest("input, textarea, select") || target?.isContentEditable)) return;
      if (handlers.current.pasteHeldInto(paneId)) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    window.addEventListener("keydown", keyboard, true);
    window.addEventListener("keydown", pasteHeldSnips, true);
    window.addEventListener("paste", pasteHeldSnips, true);
    window.addEventListener("space:snip-tool:trigger", trigger);
    return () => {
      mounted.current = false;
      document.body.removeAttribute("data-snip-tool-active");
      operation.current?.abort();
      operation.current = null;
      releaseSnipSession(session.current);
      window.removeEventListener("keydown", keyboard, true);
      window.removeEventListener("keydown", pasteHeldSnips, true);
      window.removeEventListener("paste", pasteHeldSnips, true);
      window.removeEventListener("space:snip-tool:trigger", trigger);
      if (toastTimer.current) clearTimeout(toastTimer.current);
      stopCountdown();
      lastShot.current?.frame.close?.(); lastShot.current = null;
      editorFrame.current?.close?.(); editorFrame.current = null;
    };
  }, [isOpen]);

  // ---- floating position
  useLayoutEffect(() => {
    if (!floating || docked || phase !== "idle") return;
    const el = capsuleRef.current;
    if (!el) return;
    const fit = () => {
      const size = { width: el.offsetWidth || 300, height: el.offsetHeight || 44 };
      setPos(prev => { const next = clampToViewport(prev, size); return next.x === prev.x && next.y === prev.y ? prev : next; });
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [floating, docked, phase, snipLabel]);

  /**
   * The drag follows the pointer on the window, like the desktop widgets: the capsule is only ~70px tall,
   * so an ordinary flick leaves it before any move lands on it, and the drag must not depend on that.
   */
  const onCapsulePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!floating || event.button !== 0 || (event.target as HTMLElement).closest("button, input, .snip-menu, .snip-toast")) return;
    event.preventDefault();
    floatDragCleanup.current?.();
    const el = event.currentTarget, pointerId = event.pointerId;
    const drag = { startX: event.clientX, startY: event.clientY, origin: pos, latest: pos, moved: false, toRail: false };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) > 4) {
        drag.moved = true;
        // Captured only once it is a drag, so a click or double-click on the grip keeps its own target.
        try { el.setPointerCapture(pointerId); } catch {}
      }
      if (!drag.moved) return;
      drag.latest = clampToViewport({ x: drag.origin.x + dx, y: drag.origin.y + dy }, { width: el.offsetWidth || 300, height: el.offsetHeight || 44 });
      drag.toRail = canDock && nearRail(e.clientX, e.clientY, drag.latest.x + (el.offsetWidth || 300));
      setPos(drag.latest);
      setDockPreview(drag.toRail);
    };
    const end = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      cleanup();
      setDockPreview(false);
      if (!drag.moved) return;
      if (drag.toRail) dockToRail(drag.latest.y); else saveFloat(drag.latest);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      try { if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId); } catch {}
      if (floatDragCleanup.current === cleanup) floatDragCleanup.current = null;
    };
    floatDragCleanup.current = cleanup;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };
  useEffect(() => () => floatDragCleanup.current?.(), []);

  // ---- right rail dock: the rail column is shared with the docked desktop widgets
  useEffect(() => {
    if (!canDock) return;
    const sync = () => setRailDock(loadSnipRailDock());
    sync();
    window.addEventListener(SNIP_RAIL_CHANGED_EVENT, sync);
    return () => window.removeEventListener(SNIP_RAIL_CHANGED_EVENT, sync);
  }, [canDock]);
  /** On the rail a snip goes to the clipboard by default; the editor can still pick another destination. */
  const dockToRail = (y: number) => {
    setRailDock(placeSnipOnRail(y));
    setCopyToClipboard(true); writeFlag(CLIPBOARD_MODE_STORAGE_KEY, true);
    setMenuOpen(false);
  };
  const undock = (at: Point) => {
    saveSnipRailDock(null);
    setRailDock(null);
    const next = clampToViewport(at, { width: 300, height: 44 });
    setPos(next); saveFloat(next);
  };
  /** Drag along the rail to move the card, or pull it off the rail to float the capsule again. */
  const onRailCardPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !railDock || (event.target as HTMLElement).closest(".snip-toast")) return;
    floatDragCleanup.current?.();
    railDragMoved.current = false;
    const el = event.currentTarget, pointerId = event.pointerId;
    const drag = { startX: event.clientX, startY: event.clientY, origin: railDock.y, moved: false, onRail: true, y: railDock.y, at: { x: 0, y: 0 } };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) > 4) {
        drag.moved = true;
        try { el.setPointerCapture(pointerId); } catch {}
      }
      if (!drag.moved) return;
      drag.onRail = nearRail(e.clientX, e.clientY, (window.innerWidth || 800) - DOCK_MARGIN_RIGHT + dx);
      drag.y = clamp(drag.origin + dy, getRailTopBoundary(), (window.innerHeight || 600) - 70);
      drag.at = { x: e.clientX - 24, y: e.clientY - 20 };
      setRailDrag(drag.onRail ? { x: null, y: drag.y } : drag.at);
    };
    const end = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      cleanup();
      setRailDrag(null);
      if (!drag.moved) return;
      // Swallows only the click this release produces, never a later one.
      railDragMoved.current = true;
      window.setTimeout(() => { railDragMoved.current = false; }, 0);
      if (drag.onRail) setRailDock(placeSnipOnRail(drag.y)); else undock(drag.at);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      try { if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId); } catch {}
      if (floatDragCleanup.current === cleanup) floatDragCleanup.current = null;
    };
    floatDragCleanup.current = cleanup;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };
  const resetPosition = () => {
    const el = capsuleRef.current;
    saveFloat(null);
    setPos(defaultFloat({ width: el?.offsetWidth || 300, height: el?.offsetHeight || 44 }));
    setPulse(value => value + 1);
  };

  // ---- destination menu
  useEffect(() => {
    if (!menuOpen) return;
    const outside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !menuButtonRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"], [role^="menuitem"]')?.focus({ preventScroll: true });
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [menuOpen]);
  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []);
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setMenuOpen(false); menuButtonRef.current?.focus(); }
    else if (event.key === "ArrowDown") { event.preventDefault(); items[(index + 1) % items.length]?.focus(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); items[(index - 1 + items.length) % items.length]?.focus(); }
    else if (event.key === "Tab") setMenuOpen(false);
  };
  const pickDestination = (value: string) => { applyDestination(value); setMenuOpen(false); };

  if (!isOpen) return null;

  const destinationValue = copyToClipboard ? CLIPBOARD_VALUE : targetId ?? "";
  const destinationOptions: SnipDestinationOption[] = [
    { value: CLIPBOARD_VALUE, label: "Clipboard" },
    { value: "", label: "Media Dock" },
    ...(missingTarget ? [{ value: targetId!, label: "Unavailable pane" }] : []),
    ...panes.map(p => ({ value: p.id, label: paneLabel(p) }))
  ];
  const busyAny = Boolean(busy);
  const holding = copyToClipboard && heldCount > 0;
  const menuUp = floating && pos.y > (window.innerHeight || 600) - 300;

  const toastNode = toast && (
    <div key={toast.id} className={`snip-toast is-${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"}>
      {toast.tone === "error" ? <CircleAlert aria-hidden="true" /> : <Check aria-hidden="true" />}
      <span className="snip-toast-text">{toast.text}</span>
      {toast.editable && lastShot.current && <button type="button" className="snip-toast-action" onClick={editLast} title="Annotate or re-crop this snip"><Pencil aria-hidden="true" />Edit</button>}
    </div>
  );

  const railCard = docked && railDock && (
    <div ref={capsuleRef}
      className={`snip-rail-card snip-ui${railDrag ? " is-dragging" : ""}${railDrag && railDrag.x !== null ? " is-undocking" : ""}${busyAny ? " is-busy" : ""}`}
      data-snip-tool="true" role="region" aria-label="Snip Tool"
      style={railDrag && railDrag.x !== null ? { left: `${railDrag.x}px`, top: `${railDrag.y}px`, right: "auto" } : { top: `${railDrag?.y ?? railDock.y}px` }}
      onPointerDown={onRailCardPointerDown}
      // Like the capsule, the card never pulls keyboard focus away from the pane the user is typing in.
      onMouseDown={e => e.preventDefault()}
      onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } }}>
      <button type="button" className="snip-rail-snip" disabled={busyAny} aria-label={snipLabel}
        onClick={() => { if (!railDragMoved.current) startSelecting(); }}
        title={`${copyToClipboard ? "Snip an area to the clipboard" : `Snip an area for ${targetDisplay}`} (PrtScn). Drag along the rail to move, pull left to undock.`}>
        {busyAny ? <Loader2 className="snip-spin" aria-hidden="true" /> : <Crop aria-hidden="true" />}
        <span className="snip-rail-verb">Snip</span>
        <span className="snip-rail-target">{destinationLabel}</span>
      </button>
      {toastNode}
    </div>
  );

  const capsule = (
    <div ref={capsuleRef}
      className={`snip-tool-float-icon snip-capsule snip-ui${embedded ? " is-inline" : ""}${menuUp ? " is-near-bottom" : ""}${busyAny ? " is-busy" : ""}${dockPreview ? " is-dock-preview" : ""}`}
      data-snip-tool="true" role="region" aria-label="Snip Tool"
      style={floating ? { left: `${pos.x}px`, top: `${pos.y}px` } : undefined}
      onPointerDown={onCapsulePointerDown}
      // Clicking the capsule must not pull keyboard focus away from the pane the user is typing in.
      onMouseDown={e => { if ((e.target as HTMLElement).closest("button")) e.preventDefault(); }}
      onKeyDown={e => { if (e.key === "Escape" && !menuOpen) { e.preventDefault(); e.stopPropagation(); close(); } }}
      onDragOver={e => { if (e.dataTransfer?.types?.includes("Files")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } }}
      onDrop={e => { const file = e.dataTransfer?.files?.[0]; if (file) { e.preventDefault(); void openImageFile(file); } }}>
      {floating && <span key={pulse} className="snip-capsule-ring" aria-hidden="true" />}
      {floating && (
        <span className="snip-capsule-grip" title={canDock ? "Drag to move or onto the right rail to dock · Double-click to reset position" : "Drag to move · Double-click to reset position"} onDoubleClick={resetPosition}>
          <GripVertical aria-hidden="true" />
        </span>
      )}
      <div className="snip-capsule-rows">
      <div className="snip-capsule-row">
      <div className="snip-split">
        <button type="button" className="snip-capsule-snip" onClick={startSelecting} disabled={busyAny} aria-label={snipLabel}
          title={copyToClipboard ? "Snip an area to the clipboard (PrtScn)" : `Snip an area for ${targetDisplay}${isLocked ? " (locked)" : ""} (PrtScn)`}>
          {busyAny ? <Loader2 className="snip-spin" aria-hidden="true" /> : <Crop aria-hidden="true" />}
          <span className="snip-capsule-label"><span className="snip-capsule-verb">Snip</span><span className="snip-capsule-target">{destinationLabel}</span></span>
        </button>
        <button type="button" ref={menuButtonRef} className="snip-capsule-menu-btn" aria-label="Choose destination" title="Choose where snips go"
          aria-haspopup="menu" aria-expanded={menuOpen} disabled={busyAny} onClick={() => setMenuOpen(open => !open)}>
          <ChevronDown aria-hidden="true" />
        </button>
      </div>
      <button type="button" className="snip-icon-btn snip-close-btn" onClick={close} aria-label="Close Snip Tool" title="Close Snip Tool">
        <X aria-hidden="true" />
      </button>
      </div>
      <div className="snip-capsule-row">
      <button type="button" className="snip-icon-btn" onClick={() => void capture()} disabled={busyAny || (!copyToClipboard && missingTarget)}
        aria-label={copyToClipboard ? "Capture full screen to clipboard" : `Capture full screen for ${targetDisplay}`}
        title={copyToClipboard ? "Capture the full screen to the clipboard" : `Capture the full screen for ${targetDisplay}`}>
        <Monitor aria-hidden="true" />
      </button>
      <button type="button" className={`snip-icon-btn${countdown ? " is-active" : ""}`} onClick={toggleDelayedCapture}
        disabled={busyAny || (!copyToClipboard && missingTarget)} aria-pressed={countdown !== null}
        aria-label={countdown ? `Cancel delayed capture (${countdown})` : `Capture in ${DELAY_SECONDS} seconds`}
        title={countdown ? "Click to cancel the delayed capture" : `Capture the full screen in ${DELAY_SECONDS} seconds`}>
        {countdown ? <span className="snip-countdown" aria-hidden="true">{countdown}</span> : <Timer aria-hidden="true" />}
      </button>
      <button type="button" className={`snip-icon-btn${editFirst ? " is-active" : ""}`} onClick={toggleEditFirst} disabled={busyAny}
        aria-label="Edit before send" aria-pressed={editFirst}
        title={editFirst ? "Edit before send is on: snips open in the editor first" : "Edit before send is off: snips are sent at once"}>
        <Pencil aria-hidden="true" />
      </button>
      <button type="button" className={`snip-icon-btn${copyToClipboard ? " is-active" : ""}`} onClick={toggleClipboardMode} disabled={busyAny}
        aria-label={copyToClipboard ? "Disable clipboard mode" : "Enable clipboard mode"} aria-pressed={copyToClipboard}
        title={copyToClipboard ? "Clipboard mode is on: snips are copied for Ctrl+V" : "Clipboard mode is off: snips go to the target"}>
        <Clipboard aria-hidden="true" />
      </button>
      {copyToClipboard && (
        <button type="button" className="snip-icon-btn" onClick={toggleHoldSnips} disabled={busyAny} aria-pressed={holdSnips}
          aria-label={heldCount ? `Hold snips (${heldCount} held)` : "Hold snips"}
          title={holdSnips ? `Holding snips: ${heldCount} held. Ctrl+V pastes them all. Click to stop and clear them.` : "Hold snips: keep every snip and full-screen capture, then paste them all at once with Ctrl+V"}>
          {heldCount ? <span className="snip-countdown" aria-hidden="true">{heldCount}</span> : <Images aria-hidden="true" />}
        </button>
      )}
      <button type="button" className="snip-icon-btn" onClick={() => void pasteClipboard()} disabled={busyAny || missingTarget}
        aria-label={holding ? `Paste ${heldCount} held snips into ${targetDisplay}` : `Paste the clipboard into ${targetDisplay}`}
        title={holding ? `Paste ${heldCount} held snips into ${targetDisplay} (Ctrl+V)` : `Paste the clipboard into ${targetDisplay} (Ctrl+V)`}>
        <span className="snip-keycap" aria-hidden="true">Ctrl<b>V</b></span>
      </button>
      <button type="button" className={`snip-icon-btn${isLocked ? " is-locked" : ""}`} onClick={toggleTargetLock} disabled={busyAny}
        aria-label={isLocked ? `Unlock target pane (locked to ${targetDisplay})` : `Lock target pane to ${targetDisplay}`} aria-pressed={isLocked}
        title={isLocked ? `Target locked to ${targetDisplay}. Click to follow the focused CLI pane.` : `Following the focused CLI pane. Click to lock to ${targetDisplay}.`}>
        {isLocked ? <Lock aria-hidden="true" /> : <Unlock aria-hidden="true" />}
      </button>
      </div>
      </div>
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={e => { void openImageFile(e.target.files?.[0]); e.target.value = ""; }} />

      {menuOpen && (
        <div className="snip-menu" role="menu" aria-label="Snip destination" ref={menuRef} onKeyDown={onMenuKeyDown}>
          <div className="snip-menu-label">Send snips to</div>
          {destinationOptions.map(option => {
            const pane = panes.find(p => p.id === option.value);
            const checked = option.value === destinationValue;
            return (
              <button key={option.value || "media-dock"} type="button" role="menuitemradio" aria-checked={checked} className="snip-menu-item"
                onClick={() => pickDestination(option.value)}>
                <span className="snip-menu-check" aria-hidden="true">{checked ? <Check /> : null}</span>
                <span className="snip-menu-text">{option.label}</span>
                {pane && <span className="snip-menu-tag">{pane.id === activePaneId ? "Focused" : MODE_TAGS[pane.mode] ?? ""}</span>}
              </button>
            );
          })}
          <div className="snip-menu-sep" role="separator" />
          {!hasNativeCapture() && (
            <button type="button" role="menuitemcheckbox" aria-checked={useScreenShare} className="snip-menu-item" onClick={toggleScreenShare}
              title="Captures exact screen pixels, including embedded pages. The browser asks for permission.">
              <span className="snip-menu-check" aria-hidden="true">{useScreenShare ? <Check /> : null}</span>
              <span className="snip-menu-text">Use screen sharing</span>
            </button>
          )}
          <button type="button" role="menuitem" className="snip-menu-item" onClick={() => { setMenuOpen(false); fileRef.current?.click(); }}>
            <span className="snip-menu-check" aria-hidden="true"><ImagePlus /></span>
            <span className="snip-menu-text">Open image to edit…</span>
          </button>
        </div>
      )}
      {toastNode}
    </div>
  );

  const portalTarget = typeof document !== "undefined" ? document.body : null;
  const layerStatus = busy === "capture" ? "Capturing…" : busy ? "Sending image…" : null;

  return (
    <>
      {(phase === "idle" || embedded) && (railCard || capsule)}
      {embedded && <p className="snip-inline-hint">Drag to snip any area, or capture the full screen. Turn on <strong>Edit before send</strong> to annotate first. PrtScn works anywhere.</p>}
      {phase === "selecting" && portalTarget && createPortal(
        <CaptureLayer layerRef={layerRef} busy={busyAny} destinationLabel={destinationLabel} status={layerStatus}
          onSelect={rect => void capture(rect)} onCancel={cancelSelecting} />,
        portalTarget
      )}
      {phase === "editing" && editor && portalTarget && createPortal(
        <SnipEditor key={editor.key} frame={editor.frame} initialCrop={editor.crop} busy={busy} notice={notice}
          alert={missingTarget && !copyToClipboard ? "The selected pane is no longer available. Choose another pane or Media Dock." : null}
          destinations={destinationOptions} destination={destinationValue} onDestinationChange={applyDestination}
          primaryLabel={copyToClipboard ? (holdSnips ? "Hold for paste" : "Copy to clipboard") : targetId ? `Send to ${targetDisplay}` : "Save to Media Dock"}
          primaryDisabled={!copyToClipboard && missingTarget} allowChangeSource={!hasNativeCapture()} trapFocus={!embedded}
          onPrimary={edit => void output("send", edit)} onCopy={edit => void output("copy", edit)} onSave={edit => void output("download", edit)}
          onRetake={() => { operation.current?.abort(); closeEditor(); setPhase("selecting"); }}
          onChangeSource={() => { operation.current?.abort(); releaseSnipSession(session.current); closeEditor(); setPhase("idle"); setTimeout(() => void capture(undefined, true, true), 0); }}
          onClose={() => { operation.current?.abort(); closeEditor(); goIdle(); }} />,
        portalTarget
      )}
    </>
  );
}
