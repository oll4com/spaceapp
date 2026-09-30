import { GripVertical, Pin, X } from "../ui-theme/app-icons.js";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ClipboardItem } from "@space/contracts";
import { clipboardTextMaxCharacters } from "@space/contracts";
import { api } from "../../api.js";
import { useRailMenuDodge } from "../rail-popover.js";
import {
  clipboardCharacterCount,
  notifyClipboardUpdated
} from "./clipboard-events.js";

export type StickyNoteColor = "yellow" | "green" | "blue" | "pink" | "orange" | "purple";

export const STICKY_NOTE_COLORS: Array<{ id: StickyNoteColor; label: string; swatch: string }> = [
  { id: "yellow", label: "Yellow", swatch: "#fde047" },
  { id: "green", label: "Mint", swatch: "#86efac" },
  { id: "blue", label: "Sky", swatch: "#7dd3fc" },
  { id: "pink", label: "Rose", swatch: "#fda4af" },
  { id: "orange", label: "Amber", swatch: "#fdba74" },
  { id: "purple", label: "Lavender", swatch: "#d8b4fe" }
];

export interface StickyWindowState {
  id: string;
  text: string;
  x: number;
  y: number;
  color?: StickyNoteColor;
  itemId?: string;
  zIndex?: number;
}

const STORAGE_KEY = "space.sticky-notes.windows.v1";

function loadStickyWindows(): StickyWindowState[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StickyWindowState[]) : [];
  } catch {
    return [];
  }
}

function saveStickyWindows(windows: StickyWindowState[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(windows));
  } catch {
    // Storage unavailable
  }
}

export function useStickyNoteWindows() {
  const [windows, setWindows] = useState<StickyWindowState[]>(() => loadStickyWindows());

  const bringToFront = useCallback((id: string) => {
    setWindows((prev) => {
      const maxZ = prev.reduce((max, w) => Math.max(max, w.zIndex ?? 10), 10);
      const target = prev.find((w) => w.id === id);
      if (!target || (target.zIndex ?? 10) === maxZ) return prev;
      const next = prev.map((w) => (w.id === id ? { ...w, zIndex: maxZ + 1 } : w));
      saveStickyWindows(next);
      return next;
    });
  }, []);

  const openNew = useCallback((item?: ClipboardItem | null) => {
    setWindows((prev) => {
      // If a sticky note for this item ID is already open, focus it and bring it to front
      if (item?.id) {
        const existing = prev.find((w) => w.itemId === item.id);
        if (existing) {
          const maxZ = prev.reduce((max, w) => Math.max(max, w.zIndex ?? 10), 10);
          const next = prev.map((w) =>
            w.id === existing.id ? { ...w, text: item.text, zIndex: maxZ + 1 } : w
          );
          saveStickyWindows(next);
          return next;
        }
      }

      const maxZ = prev.reduce((max, w) => Math.max(max, w.zIndex ?? 10), 10);
      const id = `sticky-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1200;
      const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 800;
      const x = Math.min(Math.max(24, 120 + ((prev.length * 28) % 200)), viewportWidth - 320);
      const y = Math.min(Math.max(64, 100 + ((prev.length * 28) % 180)), viewportHeight - 300);

      const newWin: StickyWindowState = {
        id,
        text: item?.text ?? "",
        x,
        y,
        color: "yellow",
        itemId: item?.id,
        zIndex: maxZ + 1
      };
      const next = [...prev, newWin];
      saveStickyWindows(next);
      return next;
    });
  }, []);

  const closeWindow = useCallback((id: string) => {
    setWindows((prev) => {
      const next = prev.filter((w) => w.id !== id);
      saveStickyWindows(next);
      return next;
    });
  }, []);

  const updateWindow = useCallback((id: string, patch: Partial<StickyWindowState>) => {
    setWindows((prev) => {
      const next = prev.map((w) => (w.id === id ? { ...w, ...patch } : w));
      saveStickyWindows(next);
      return next;
    });
  }, []);

  return { windows, openNew, closeWindow, updateWindow, bringToFront };
}

interface StickyNoteWindowProps {
  id: string;
  initialText?: string;
  itemId?: string;
  color?: StickyNoteColor;
  initialX?: number;
  initialY?: number;
  zIndex?: number;
  onClose: () => void;
  onSaved?: () => void;
  onUpdateText?: (text: string) => void;
  onUpdateColor?: (color: StickyNoteColor) => void;
  onUpdatePosition?: (x: number, y: number) => void;
  onFocus?: () => void;
}

/** Floating, draggable, luminous sticky note window */
export function StickyNoteWindow({
  id: _id,
  initialText = "",
  itemId: _itemId,
  color: initialColor = "yellow",
  initialX = 120,
  initialY = 120,
  zIndex = 210,
  onClose,
  onSaved,
  onUpdateText,
  onUpdateColor,
  onUpdatePosition,
  onFocus
}: StickyNoteWindowProps) {
  const [text, setText] = useState(initialText);
  const [color, setColor] = useState<StickyNoteColor>(initialColor);
  const [pos, setPos] = useState({ x: initialX, y: initialY });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const initialTextRef = useRef(initialText);
  const dragRef = useRef<{ startX: number; startY: number; winX: number; winY: number } | null>(null);
  const windowRef = useRef<HTMLDivElement | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const charCount = clipboardCharacterCount(text);

  const dodgeShiftX = useRailMenuDodge(windowRef, {
    x: pos.x,
    y: pos.y,
    isDragging
  });

  // Keep local text updated if initialText prop changes externally (e.g. from parent sync)
  useEffect(() => {
    if (initialText !== initialTextRef.current && initialText !== text) {
      initialTextRef.current = initialText;
      setText(initialText);
    }
  }, [initialText, text]);

  const lastInitialColorRef = useRef(initialColor);
  // Keep color updated if prop changes externally
  useEffect(() => {
    if (initialColor !== lastInitialColorRef.current) {
      lastInitialColorRef.current = initialColor;
      setColor(initialColor);
    }
  }, [initialColor]);

  // Auto-save debounced when text is modified by user
  useEffect(() => {
    if (text === initialTextRef.current) return;
    if (!text.trim()) return;
    if (charCount > clipboardTextMaxCharacters) return;

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setSaved(false);

    saveTimerRef.current = setTimeout(async () => {
      setSaving(true);
      try {
        await api.createClipboardItem({ text, source: "MANUAL_NOTE" });
        initialTextRef.current = text;
        notifyClipboardUpdated();
        setSaved(true);
        onSaved?.();
        setTimeout(() => setSaved(false), 2000);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not save note.");
      } finally {
        setSaving(false);
      }
    }, 1200);

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [text, charCount, onSaved]);

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.currentTarget.value;
    setText(val);
    setError(null);
    onUpdateText?.(val);
  };

  const handleColorSelect = (newColor: StickyNoteColor) => {
    setColor(newColor);
    setShowColorPicker(false);
    onUpdateColor?.(newColor);
  };

  const onDragHandleMouseDown = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    onFocus?.();
    const currentVisualX = pos.x - dodgeShiftX;
    setIsDragging(true);
    if (dodgeShiftX > 0) {
      setPos({ x: currentVisualX, y: pos.y });
      onUpdatePosition?.(currentVisualX, pos.y);
    }
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      winX: currentVisualX,
      winY: pos.y
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      const nextX = Math.max(8, dragRef.current.winX + dx);
      const nextY = Math.max(8, dragRef.current.winY + dy);
      setPos({ x: nextX, y: nextY });
      onUpdatePosition?.(nextX, nextY);
    };

    const onMouseUp = () => {
      dragRef.current = null;
      setIsDragging(false);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, [pos, dodgeShiftX, onFocus, onUpdatePosition]);

  return (
    <div
      ref={windowRef}
      className="sticky-note-window"
      data-sticky-color={color}
      style={{
        left: pos.x,
        top: pos.y,
        zIndex,
        transform: dodgeShiftX > 0 ? `translateX(-${dodgeShiftX}px)` : undefined,
        transition: isDragging ? "none" : "transform 0.22s cubic-bezier(0.2, 0, 0, 1), box-shadow 0.2s ease, border-color 0.2s ease"
      }}
      data-space-clipboard-capture="off"
      onMouseDown={onFocus}
    >
      <div
        className="sticky-note-titlebar"
        onMouseDown={onDragHandleMouseDown}
        role="toolbar"
        aria-label="Drag sticky note"
      >
        <span className="sticky-note-drag-handle" title="Drag to move">
          <GripVertical aria-hidden="true" className="sticky-note-drag-icon" />
        </span>
        <Pin aria-hidden="true" className="sticky-note-pin-icon" />
        <span className="sticky-note-title">Sticky Note</span>

        <div className="sticky-note-status">
          {saving ? <span className="sticky-saving">Saving…</span> : null}
          {saved ? <span className="sticky-saved">✓ Saved</span> : null}
          {error ? <span className="sticky-error" title={error}>! Error</span> : null}
        </div>

        <div className="sticky-note-color-picker-wrapper">
          <button
            type="button"
            className="sticky-note-color-toggle"
            aria-label="Change sticky note color"
            title="Change sticky note color"
            onClick={(e) => {
              e.stopPropagation();
              setShowColorPicker((prev) => !prev);
            }}
          >
            <span
              className="sticky-note-color-current-dot"
              style={{ background: STICKY_NOTE_COLORS.find((c) => c.id === color)?.swatch ?? "#fde047" }}
            />
          </button>

          {showColorPicker ? (
            <div
              className="sticky-note-color-palette"
              role="menu"
              aria-label="Sticky note colors"
              onClick={(e) => e.stopPropagation()}
            >
              {STICKY_NOTE_COLORS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`sticky-note-palette-dot${color === c.id ? " is-selected" : ""}`}
                  style={{ background: c.swatch }}
                  title={c.label}
                  aria-label={c.label}
                  onClick={() => handleColorSelect(c.id)}
                />
              ))}
            </div>
          ) : null}
        </div>

        <button
          type="button"
          className="sticky-note-close"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          aria-label="Close sticky note"
          title="Close note"
        >
          <X aria-hidden="true" />
        </button>
      </div>

      <textarea
        className="sticky-note-textarea"
        value={text}
        onChange={handleTextChange}
        placeholder="Write your note… auto-saves to Clipboard"
        maxLength={clipboardTextMaxCharacters + 1}
        aria-label="Sticky note content"
        spellCheck="false"
      />

      <div className="sticky-note-footer">
        <span
          className={charCount > clipboardTextMaxCharacters ? "sticky-char-count bad" : "sticky-char-count"}
        >
          {charCount.toLocaleString()} / {clipboardTextMaxCharacters.toLocaleString()}
        </span>
      </div>
    </div>
  );
}

/** Renders all open sticky note windows as a desktop overlay layer */
export function StickyNoteLayer({
  windows,
  onClose,
  onUpdateText,
  onUpdateColor,
  onUpdatePosition,
  onBringToFront
}: {
  windows: StickyWindowState[];
  onClose: (id: string) => void;
  onUpdateText?: (id: string, text: string) => void;
  onUpdateColor?: (id: string, color: StickyNoteColor) => void;
  onUpdatePosition?: (id: string, x: number, y: number) => void;
  onBringToFront?: (id: string) => void;
}) {
  if (windows.length === 0) return null;

  return (
    <div className="sticky-note-layer" aria-label="Floating sticky notes">
      {windows.map((win) => (
        <StickyNoteWindow
          key={win.id}
          id={win.id}
          initialText={win.text}
          itemId={win.itemId}
          color={win.color}
          initialX={win.x}
          initialY={win.y}
          zIndex={win.zIndex}
          onClose={() => onClose(win.id)}
          onUpdateText={(text) => onUpdateText?.(win.id, text)}
          onUpdateColor={(color) => onUpdateColor?.(win.id, color)}
          onUpdatePosition={(x, y) => onUpdatePosition?.(win.id, x, y)}
          onFocus={() => onBringToFront?.(win.id)}
        />
      ))}
    </div>
  );
}
