import { useCallback, useEffect, useMemo, useState } from "react";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";
import {
  Archive,
  Bell,
  Bot,
  Clipboard,
  FolderOpen,
  GitBranch,
  Images,
  Link,
  ListTodo,
  MessagesSquare,
  PanelLeft,
  Radio,
  Settings,
  Terminal,
  type LucideIcon,
  AgentFiles,
  Nous,
  Vault
} from "../ui-theme/app-icons.js";
import type { SideSurface } from "./dock-types.js";
import { saveUserSettingDebounced } from "../user-settings/user-settings-save-queue.js";
import { workspaceDockOrder } from "../ui-theme/workspace-actions.js";

export const DOCKS_HIDDEN_STORAGE_KEY = "space:docks-hidden:v1";
export const DOCKS_VISIBILITY_EVENT = "space:docks-visibility-changed";
export const DOCKS_ORDER_STORAGE_KEY = "space:docks-order:v1";
export const DOCKS_ORDER_EVENT = "space:docks-order-changed";
export const NON_HIDEABLE_DOCK_IDS = new Set<SideSurface>(["settings"]);

export interface DockItemConfig {
  id: SideSurface;
  label: string;
  description: string;
  icon: LucideIcon;
  requiresGitPlugin?: boolean;
  requiresAdmin?: boolean;
  locked?: boolean;
}

export const DOCK_DEFINITIONS: DockItemConfig[] = [
  {
    id: "rooms",
    label: "Rooms",
    description: "Choose a room or organize your workspace.",
    icon: PanelLeft
  },
  {
    id: "nous",
    label: "Nous",
    description: "The mind of SpaceApp: one conversation over every room, pane, copilot and plan.",
    icon: Nous
  },
  {
    id: "notifications",
    label: "Notifications",
    description: "New mail, questions and alerts from every pane, with read and acknowledge.",
    icon: Bell
  },
  {
    id: "room-agent",
    label: "Room Agent",
    description: "Ask an assistant to coordinate this room.",
    icon: Bot
  },
  {
    id: "shared-chat",
    label: "Council",
    description: "Several models answer one question, review each other and agree on a Top 3.",
    icon: MessagesSquare
  },
  {
    id: "media",
    label: "Media",
    description: "Images, recordings, and other media.",
    icon: Images
  },
  {
    id: "agent-files",
    label: "Agent Files",
    description: "Preview and download files created by agents.",
    icon: AgentFiles
  },
  {
    id: "clipboard",
    label: "Clipboard",
    description: "Saved text, notes, and plans.",
    icon: Clipboard
  },
  {
    id: "tasks",
    label: "Tasks",
    description: "Follow tasks and their progress.",
    icon: ListTodo
  },
  {
    id: "vault",
    label: "Vault",
    description: "Your encrypted passwords, filled for you without agents ever seeing them.",
    icon: Vault
  },
  {
    id: "links",
    label: "Links",
    description: "Bookmarks and browser connections.",
    icon: Link
  },
  {
    id: "cli",
    label: "CLI tools",
    description: "Manage coding tools and their connections.",
    icon: Terminal
  },
  {
    id: "agent-sessions",
    label: "Sessions",
    description: "Find previous work and resume sessions.",
    icon: Archive
  },
  {
    id: "source-control",
    label: "Source Control",
    description: "Open projects, review changes and sync with your repository providers. Works without a connected account.",
    icon: GitBranch
  },
  {
    id: "settings",
    label: "Settings",
    description: "Appearance, notifications, and preferences.",
    icon: Settings,
    locked: true
  },
  {
    id: "streaming",
    label: "Streaming",
    description: "Manage live broadcasts and overlays.",
    icon: Radio,
    requiresAdmin: true
  }
];

export const VALID_DOCK_IDS = new Set<string>(DOCK_DEFINITIONS.map((dock) => dock.id));

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

export function normalizeHiddenDockIds(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const valid = values.filter(
    (id): id is string => typeof id === "string" && VALID_DOCK_IDS.has(id) && !NON_HIDEABLE_DOCK_IDS.has(id as SideSurface)
  );
  return Array.from(new Set(valid));
}

export function readHiddenDockIds(customStorage?: Storage): string[] {
  try {
    const storage = getStorage(customStorage);
    if (!storage) return [];
    const raw = storage.getItem(DOCKS_HIDDEN_STORAGE_KEY);
    if (!raw) return [];
    return normalizeHiddenDockIds(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function writeHiddenDockIds(hiddenIds: string[], customStorage?: Storage): void {
  try {
    const storage = getStorage(customStorage);
    const normalized = normalizeHiddenDockIds(hiddenIds);
    if (storage) {
      if (normalized.length > 0) {
        storage.setItem(DOCKS_HIDDEN_STORAGE_KEY, JSON.stringify(normalized));
      } else {
        storage.removeItem(DOCKS_HIDDEN_STORAGE_KEY);
      }
    }
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(DOCKS_VISIBILITY_EVENT, { detail: normalized }));
    }
  } catch {
    // Ignore storage errors in restrictive environments
  }
}

export function readDockOrder(customStorage?: Storage): string[] {
  try {
    const raw = getStorage(customStorage)?.getItem(DOCKS_ORDER_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? Array.from(new Set(parsed.filter((id): id is string => typeof id === "string" && VALID_DOCK_IDS.has(id)))) : [];
  } catch {
    return [];
  }
}

export function writeDockOrder(order: string[], customStorage?: Storage): void {
  try {
    const storage = getStorage(customStorage);
    if (order.length > 0) storage?.setItem(DOCKS_ORDER_STORAGE_KEY, JSON.stringify(order));
    else storage?.removeItem(DOCKS_ORDER_STORAGE_KEY);
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(DOCKS_ORDER_EVENT));
  } catch {
    // Ignore storage errors in restrictive environments
  }
}

// Docks the operator placed come first in their order; the rest keep the Docks menu's default order.
export function dockOrderRank(order: readonly string[]): (id: string) => number {
  return (id) => {
    const saved = order.indexOf(id);
    if (saved !== -1) return saved;
    const base = workspaceDockOrder.indexOf(`surface-${id}`);
    return order.length + (base === -1 ? workspaceDockOrder.length : base);
  };
}

export function useDocksVisibility(customStorage?: Storage) {
  const [hiddenDockIds, setHiddenDockIds] = useState<string[]>(() => readHiddenDockIds(customStorage));
  const [dockOrder, setDockOrderState] = useState<string[]>(() => readDockOrder(customStorage));

  useEffect(() => {
    const handleUpdate = () => {
      setHiddenDockIds(readHiddenDockIds(customStorage));
      setDockOrderState(readDockOrder(customStorage));
    };
    if (typeof window !== "undefined") {
      window.addEventListener(DOCKS_VISIBILITY_EVENT, handleUpdate);
      window.addEventListener(DOCKS_ORDER_EVENT, handleUpdate);
      window.addEventListener("storage", handleUpdate);
      return () => {
        window.removeEventListener(DOCKS_VISIBILITY_EVENT, handleUpdate);
        window.removeEventListener(DOCKS_ORDER_EVENT, handleUpdate);
        window.removeEventListener("storage", handleUpdate);
      };
    }
  }, [customStorage]);

  const setDockOrder = useCallback(
    (order: string[]) => {
      writeDockOrder(order, customStorage);
      setDockOrderState(order);
      saveUserSettingDebounced("docksOrder", order);
    },
    [customStorage]
  );

  const hiddenSet = useMemo(() => new Set(hiddenDockIds), [hiddenDockIds]);

  const isDockHidden = useCallback((id: SideSurface) => {
    if (NON_HIDEABLE_DOCK_IDS.has(id)) return false;
    return hiddenSet.has(id);
  }, [hiddenSet]);

  const isDockVisible = useCallback((id: SideSurface) => {
    if (NON_HIDEABLE_DOCK_IDS.has(id)) return true;
    return !hiddenSet.has(id);
  }, [hiddenSet]);

  const hideDock = useCallback(
    (id: SideSurface) => {
      if (NON_HIDEABLE_DOCK_IDS.has(id) || !VALID_DOCK_IDS.has(id) || hiddenSet.has(id)) return;
      const next = [...hiddenDockIds, id];
      writeHiddenDockIds(next, customStorage);
      setHiddenDockIds(next);
      saveUserSettingDebounced("docksHidden", next);
    },
    [customStorage, hiddenDockIds, hiddenSet]
  );

  const showDock = useCallback(
    (id: SideSurface) => {
      if (!hiddenSet.has(id)) return;
      const next = hiddenDockIds.filter((hiddenId) => hiddenId !== id);
      writeHiddenDockIds(next, customStorage);
      setHiddenDockIds(next);
      saveUserSettingDebounced("docksHidden", next);
    },
    [customStorage, hiddenDockIds, hiddenSet]
  );

  const toggleDock = useCallback(
    (id: SideSurface) => {
      if (NON_HIDEABLE_DOCK_IDS.has(id)) return;
      if (hiddenSet.has(id)) {
        showDock(id);
      } else {
        hideDock(id);
      }
    },
    [hiddenSet, hideDock, showDock]
  );

  const resetDocks = useCallback(() => {
    writeHiddenDockIds([], customStorage);
    setHiddenDockIds([]);
    saveUserSettingDebounced("docksHidden", []);
    setDockOrder([]);
  }, [customStorage, setDockOrder]);

  return {
    hiddenDockIds,
    isDockHidden,
    isDockVisible,
    hideDock,
    showDock,
    toggleDock,
    resetDocks,
    dockOrder,
    setDockOrder
  };
}
