// Sticky note window state, kept out of StickyNoteWindow.tsx so App.js holds only this hook and lazy-loads the windows
// (speed Phase 2 step 3, 21/11).
import { useCallback, useEffect, useState } from "react";
import type { ClipboardItem, UpdateUserSettingsInput } from "@space/contracts";
import { saveUserSettingDebounced, STICKY_NOTES_CHANGED_EVENT } from "../user-settings/user-settings-manager.js";

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
    saveUserSettingDebounced("stickyNotes", windows as unknown as UpdateUserSettingsInput["stickyNotes"]);
  } catch {
    // Storage unavailable
  }
}

export function useStickyNoteWindows() {
  const [windows, setWindows] = useState<StickyWindowState[]>(() => loadStickyWindows());

  useEffect(() => {
    const take = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (Array.isArray(detail)) setWindows(detail as StickyWindowState[]);
    };
    window.addEventListener(STICKY_NOTES_CHANGED_EVENT, take);
    return () => window.removeEventListener(STICKY_NOTES_CHANGED_EVENT, take);
  }, []);

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
