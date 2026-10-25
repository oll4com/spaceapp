import { useCallback, useEffect, useMemo, useState } from "react";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";
import {
  ALL_DESKTOP_WIDGET_IDS,
  toggleDesktopWidget
} from "./widget-storage.js";
import type { DesktopWidgetId } from "./types.js";

export const WIDGETS_HIDDEN_STORAGE_KEY = "space:widgets-hidden:v1";
export const WIDGETS_VISIBILITY_EVENT = "space:widgets-visibility-changed";

const VALID_WIDGET_IDS = new Set<DesktopWidgetId>(ALL_DESKTOP_WIDGET_IDS);

function getStorage(customStorage?: Storage): Storage | null {
  if (customStorage) return customStorage;
  try {
    return getSpaceRuntime().platform.localStorage;
  } catch {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
    return null;
  }
}

export function normalizeHiddenWidgetIds(values: unknown): DesktopWidgetId[] {
  if (!Array.isArray(values)) return [];
  const valid = values.filter(
    (id): id is DesktopWidgetId => typeof id === "string" && VALID_WIDGET_IDS.has(id as DesktopWidgetId)
  );
  return Array.from(new Set(valid));
}

export function readHiddenWidgetIds(customStorage?: Storage): DesktopWidgetId[] {
  try {
    const storage = getStorage(customStorage);
    if (!storage) return [];
    const raw = storage.getItem(WIDGETS_HIDDEN_STORAGE_KEY);
    if (!raw) return [];
    return normalizeHiddenWidgetIds(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function writeHiddenWidgetIds(hiddenIds: DesktopWidgetId[], customStorage?: Storage): void {
  try {
    const storage = getStorage(customStorage);
    const normalized = normalizeHiddenWidgetIds(hiddenIds);
    if (storage) {
      if (normalized.length > 0) {
        storage.setItem(WIDGETS_HIDDEN_STORAGE_KEY, JSON.stringify(normalized));
      } else {
        storage.removeItem(WIDGETS_HIDDEN_STORAGE_KEY);
      }
    }
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(WIDGETS_VISIBILITY_EVENT, { detail: normalized }));
    }
  } catch {
    // Ignore storage errors in restrictive environments
  }
}

export function useWidgetsVisibility(customStorage?: Storage) {
  const [hiddenWidgetIds, setHiddenWidgetIds] = useState<DesktopWidgetId[]>(() =>
    readHiddenWidgetIds(customStorage)
  );

  useEffect(() => {
    const handleUpdate = () => {
      setHiddenWidgetIds(readHiddenWidgetIds(customStorage));
    };
    if (typeof window !== "undefined") {
      window.addEventListener(WIDGETS_VISIBILITY_EVENT, handleUpdate);
      window.addEventListener("storage", handleUpdate);
      return () => {
        window.removeEventListener(WIDGETS_VISIBILITY_EVENT, handleUpdate);
        window.removeEventListener("storage", handleUpdate);
      };
    }
  }, [customStorage]);

  const hiddenSet = useMemo(() => new Set(hiddenWidgetIds), [hiddenWidgetIds]);

  const isWidgetHidden = useCallback(
    (id: DesktopWidgetId) => {
      return hiddenSet.has(id);
    },
    [hiddenSet]
  );

  const isWidgetVisible = useCallback(
    (id: DesktopWidgetId) => {
      return !hiddenSet.has(id);
    },
    [hiddenSet]
  );

  const hideWidget = useCallback(
    (id: DesktopWidgetId) => {
      if (!VALID_WIDGET_IDS.has(id)) return;
      if (hiddenSet.has(id)) return;
      const next = [...hiddenWidgetIds, id];
      writeHiddenWidgetIds(next, customStorage);
      setHiddenWidgetIds(next);
      // When a widget is hidden, close it immediately if floating
      toggleDesktopWidget(id, false);
    },
    [customStorage, hiddenWidgetIds, hiddenSet]
  );

  const showWidget = useCallback(
    (id: DesktopWidgetId) => {
      if (!VALID_WIDGET_IDS.has(id)) return;
      if (!hiddenSet.has(id)) return;
      const next = hiddenWidgetIds.filter((hiddenId) => hiddenId !== id);
      writeHiddenWidgetIds(next, customStorage);
      setHiddenWidgetIds(next);
    },
    [customStorage, hiddenWidgetIds, hiddenSet]
  );

  const resetWidgets = useCallback(() => {
    writeHiddenWidgetIds([], customStorage);
    setHiddenWidgetIds([]);
  }, [customStorage]);

  return {
    hiddenWidgetIds,
    isWidgetHidden,
    isWidgetVisible,
    hideWidget,
    showWidget,
    resetWidgets
  };
}
