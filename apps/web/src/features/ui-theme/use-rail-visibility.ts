import { useCallback, useEffect, useMemo, useState } from "react";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";
import { LOWER_RAIL_IDS, UPPER_RAIL_IDS } from "./use-rail-order.js";

export const LOWER_RAIL_HIDDEN_KEY = "space:room-rail-hidden:v1";
export const UPPER_RAIL_HIDDEN_KEY = "space:upper-rail-hidden:v1";

export const LOWER_RAIL_NON_HIDEABLE = new Set(["expand"]);
export const UPPER_RAIL_NON_HIDEABLE = new Set<string>();

export const LOWER_RAIL_LABELS: Record<string, string> = {
  previous: "Previous room",
  next: "Next room",
  rooms: "Rooms",
  create: "Create",
  layout: "Pane layout",
  sticky: "Sticky note",
  keyboard: "On-screen keyboard",
  music: "Music",
  "snip-tool": "Snip tool",
  "live-model": "Live voice model",
  "quick-links": "Quick Links",
  docks: "Docks",
  tools: "Tools",
  displays: "Multi-Screen Displays",
  fullscreen: "Full screen",
  expand: "Show room toolbar",
  more: "More",
  "minimized-bar": "Minimized panes",
};

export const UPPER_RAIL_LABELS: Record<string, string> = {
  "agents-dashboard": "Agents Dashboard",
  "minimized-bar": "Minimized panes",
  accounts: "Account remaining",
  "codex-reset": "Next token reset",
  cli: "CLI sessions",
  memory: "Memory",
  cpu: "CPU",
  rtt: "Connection latency",
};

export type RailVisibilityItem = {
  id: string;
  label: string;
  hideable?: boolean;
};

function uniqueIds(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function listsEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export function normalizeHiddenRailIds(
  hiddenIds: unknown,
  allowedIds: string[],
  nonHideable: Set<string> = new Set(),
): string[] {
  const allowed = new Set(allowedIds);
  const source = Array.isArray(hiddenIds)
    ? hiddenIds.filter((id): id is string => typeof id === "string")
    : [];
  return uniqueIds(source.filter((id) => allowed.has(id) && !nonHideable.has(id)));
}

export function readHiddenRailIds(storageKey: string, allowedIds: string[], nonHideable: Set<string>): string[] {
  try {
    const raw = getSpaceRuntime().platform.localStorage.getItem(storageKey);
    if (!raw) return [];
    return normalizeHiddenRailIds(JSON.parse(raw), allowedIds, nonHideable);
  } catch {
    return [];
  }
}

function writeHiddenRailIds(storageKey: string, hiddenIds: string[]) {
  try {
    const storage = getSpaceRuntime().platform.localStorage;
    if (hiddenIds.length) storage.setItem(storageKey, JSON.stringify(hiddenIds));
    else storage.removeItem(storageKey);
  } catch {
    // Session-only preference when storage is blocked.
  }
}

export function railVisibilityItems(
  ids: string[],
  labels: Record<string, string>,
  nonHideable: Set<string>,
): RailVisibilityItem[] {
  return ids.map((id) => ({
    id,
    label: labels[id] ?? id,
    hideable: !nonHideable.has(id),
  }));
}

export const LOWER_RAIL_VISIBILITY_IDS = [...LOWER_RAIL_IDS, "minimized-bar"];

export const DEFAULT_LOWER_RAIL_ITEMS = railVisibilityItems(
  LOWER_RAIL_IDS,
  LOWER_RAIL_LABELS,
  LOWER_RAIL_NON_HIDEABLE,
);

export const LOWER_RAIL_TO_ACTION_ID: Record<string, string> = {
  previous: "previous-room",
  next: "next-room",
  rooms: "surface-rooms",
  create: "create",
  layout: "pane-layout",
  sticky: "sticky-note",
  keyboard: "osk-keyboard",
  music: "vibe-music",
  "snip-tool": "snip-tool",
  "live-model": "live-model",
  "quick-links": "quick-links",
  docks: "docks",
  displays: "desktop-displays",
  fullscreen: "browser-fullscreen",
  "minimized-bar": "minimized-bar",
};

export const ACTION_TO_LOWER_RAIL_ID: Record<string, string> = {
  "previous-room": "previous",
  previous: "previous",
  "next-room": "next",
  next: "next",
  "surface-rooms": "rooms",
  rooms: "rooms",
  create: "create",
  "pane-layout": "layout",
  layout: "layout",
  "sticky-note": "sticky",
  sticky: "sticky",
  "osk-keyboard": "keyboard",
  keyboard: "keyboard",
  "vibe-music": "music",
  music: "music",
  "snip-tool": "snip-tool",
  "live-model": "live-model",
  "quick-links": "quick-links",
  docks: "docks",
  "desktop-displays": "displays",
  displays: "displays",
  "browser-fullscreen": "fullscreen",
  fullscreen: "fullscreen",
  "minimized-bar": "minimized-bar",
};

export const DEFAULT_UPPER_RAIL_ITEMS = railVisibilityItems(
  UPPER_RAIL_IDS,
  UPPER_RAIL_LABELS,
  UPPER_RAIL_NON_HIDEABLE,
);

export function useRailVisibility(
  storageKey: string,
  allowedIds: string[],
  nonHideable: Set<string> = new Set(),
) {
  const allowedKey = allowedIds.join("\0");
  const [hiddenIds, setHiddenIds] = useState(() => readHiddenRailIds(storageKey, allowedIds, nonHideable));

  useEffect(() => {
    const next = readHiddenRailIds(storageKey, allowedIds, nonHideable);
    setHiddenIds((current) => (listsEqual(current, next) ? current : next));
  }, [allowedKey, nonHideable, storageKey, allowedIds]);

  const persist = useCallback(
    (next: string[]) => {
      const normalized = normalizeHiddenRailIds(next, allowedIds, nonHideable);
      writeHiddenRailIds(storageKey, normalized);
      setHiddenIds(normalized);
    },
    [allowedIds, nonHideable, storageKey],
  );

  const hiddenSet = useMemo(() => new Set(hiddenIds), [hiddenIds]);

  const isVisible = useCallback((id: string) => !hiddenSet.has(id), [hiddenSet]);

  const hide = useCallback(
    (id: string) => {
      if (nonHideable.has(id) || !allowedIds.includes(id) || hiddenSet.has(id)) return;
      persist([...hiddenIds, id]);
    },
    [allowedIds, hiddenIds, hiddenSet, nonHideable, persist],
  );

  const show = useCallback(
    (id: string) => {
      if (!hiddenSet.has(id)) return;
      persist(hiddenIds.filter((hiddenId) => hiddenId !== id));
    },
    [hiddenIds, hiddenSet, persist],
  );

  const showAll = useCallback(() => persist([]), [persist]);

  const toggle = useCallback(
    (id: string) => {
      if (hiddenSet.has(id)) show(id);
      else hide(id);
    },
    [hiddenSet, hide, show],
  );

  return {
    hiddenIds,
    isVisible,
    hide,
    show,
    showAll,
    toggle,
  };
}

export type RailVisibilityMenuState = {
  x: number;
  y: number;
} | null;
