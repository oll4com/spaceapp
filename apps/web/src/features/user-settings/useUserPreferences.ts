import { useCallback, useEffect, useState } from "react";
import type { UserSettings } from "@space/contracts";
import { api } from "../../api.js";
import { readStoredCliImagePreviewLimit, writeStoredCliImagePreviewLimit } from "../../cli-upload-settings.js";
import { readStoredSuppressNotifications, writeStoredSuppressNotifications } from "../../notifications-settings.js";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";
import { readStoredBoolean } from "../../stored-boolean.js";
import type { UiTheme } from "../../ui-theme.js";
import {
  readStoredWarmRoomConnectedPaneLimit,
  readStoredWarmRoomEnabled,
  writeStoredWarmRoomConnectedPaneLimit,
  writeStoredWarmRoomEnabled
} from "../../warm-room-settings.js";
import { roomThemes, type RoomTheme } from "../room-theme/RoomThemeMenu.js";
import { MAX_WORKSPACE_TEXT_SIZE, MIN_WORKSPACE_TEXT_SIZE } from "../workspace-text-size-picker/WorkspaceTextSizePicker.js";
import { saveUserSettingDebounced } from "./user-settings-manager.js";

// Server-synced workspace preferences. Each one keeps a browser-local copy
// (read on first render) and, for a signed-in account, a write-through copy in
// the account settings. `hydrate` applies the account copy after sign-in.

const MIN_TERMINAL_FONT_SIZE = MIN_WORKSPACE_TEXT_SIZE;
const MAX_TERMINAL_FONT_SIZE = MAX_WORKSPACE_TEXT_SIZE;
const DEFAULT_TERMINAL_FONT_SIZE = 12;
const TERMINAL_FONT_SIZE_STORAGE_KEY = "space.terminal.fontSize";
// Touch devices (phones, tablets) keep their own workspace text size; desktops share the account's.
const TOUCH_TERMINAL_FONT_SIZE_STORAGE_KEY = "space.terminal.fontSize.touch";
const SESSION_DEBUG_IDS_STORAGE_KEY = "space.showSessionDebugIds";
const CLI_DEBUG_MODE_STORAGE_KEY = "space.cliDebugMode";
const CLI_FLOATS_HIDDEN_STORAGE_KEY = "space.cliFloatsHidden";
const SPACE_SENSITIVE_DATA_MASKED_STORAGE_KEY = "space.sensitiveDataMasked";
const SIDE_SURFACE_HIDDEN_STORAGE_KEY = "space.roomsRailHidden";
const ROOM_FOCUS_MODE_STORAGE_KEY = "space.roomFocusMode";
const ROOM_TOOLBAR_HIDDEN_STORAGE_KEY = "space.roomToolbar.hidden.v1";
const ROOM_THEME_STORAGE_KEY = "space.room.theme";
const ROOM_EXTRA_EMPTY_SLOTS_STORAGE_KEY = "space:room-extra-empty-slots.v1";
const DEFAULT_WORKTREE_ENABLED_STORAGE_KEY = "space.worktree.defaultEnabled";
const PROJECT_PRESETS_STORAGE_KEY = "space:project_presets";

export type ProjectPreset = { label: string; path: string };

const DEFAULT_PROJECT_PRESETS: ProjectPreset[] = [
  { label: "space", path: "/opt/spaceapp" },
  { label: "space1", path: "/opt/spaceapp/projects/space1" },
  { label: "space2", path: "/opt/spaceapp/projects/space2" }
];

function touchDeviceTextSize(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
}

function readStoredTerminalFontSize(): number {
  if (typeof window === "undefined") return DEFAULT_TERMINAL_FONT_SIZE;
  const storage = getSpaceRuntime().platform.localStorage;
  // Until a touch device picks its own size it starts from the shared one.
  const storedValue = (touchDeviceTextSize() ? storage.getItem(TOUCH_TERMINAL_FONT_SIZE_STORAGE_KEY) : null) ?? storage.getItem(TERMINAL_FONT_SIZE_STORAGE_KEY);
  if (!storedValue) return DEFAULT_TERMINAL_FONT_SIZE;
  const stored = Number(storedValue);
  if (!Number.isFinite(stored)) return DEFAULT_TERMINAL_FONT_SIZE;
  return Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, Math.round(stored)));
}

function readStoredBooleanDefaultTrue(key: string): boolean {
  if (typeof window === "undefined") return true;
  const stored = getSpaceRuntime().platform.localStorage.getItem(key);
  return stored === null ? true : stored === "true";
}

function readStoredRoomTheme(): RoomTheme {
  if (typeof window === "undefined") return "graphite";
  const stored = getSpaceRuntime().platform.localStorage.getItem(ROOM_THEME_STORAGE_KEY);
  return roomThemes.some((theme) => theme.id === stored) ? (stored as RoomTheme) : "graphite";
}

function readStoredRoomExtraEmptySlots(): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    const raw = getSpaceRuntime().platform.localStorage.getItem(ROOM_EXTRA_EMPTY_SLOTS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === "object") {
      const clamped: Record<string, number> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "number" && Number.isFinite(v)) {
          clamped[k] = Math.max(0, Math.min(6, Math.round(v)));
        }
      }
      return clamped;
    }
    return {};
  } catch {
    return {};
  }
}

function readStoredDefaultWorktreeEnabled(): boolean {
  try {
    const stored = localStorage.getItem(DEFAULT_WORKTREE_ENABLED_STORAGE_KEY);
    if (stored !== null) return stored === "true";
  } catch {}
  return true; // Default true
}

function readStoredRoomWorktreeOverrides(): Record<string, boolean> {
  try {
    const stored: Record<string, boolean> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith("space.room.") && key.endsWith(".isolatedWorktree")) {
        const roomId = key.slice("space.room.".length, -".isolatedWorktree".length);
        stored[roomId] = localStorage.getItem(key) === "true";
      }
    }
    return stored;
  } catch {
    return {};
  }
}

function readStoredProjectPresets(): ProjectPreset[] {
  try {
    const saved = localStorage.getItem(PROJECT_PRESETS_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const filtered = parsed.filter(
          (p) =>
            p.label !== "olla" &&
            p.label !== "workspace" &&
            !p.path?.includes("/olla") &&
            !p.path?.includes("/workspace")
        );
        localStorage.setItem(PROJECT_PRESETS_STORAGE_KEY, JSON.stringify(filtered));
        return filtered.length > 0 ? filtered : DEFAULT_PROJECT_PRESETS;
      }
    }
  } catch {}
  return DEFAULT_PROJECT_PRESETS;
}

export interface UserPreferencesContext {
  /** `auth?.isAuthenticated`: write-through copies go to the account only when true. */
  isAuthenticated: boolean | undefined;
  /** Rooms-rail state from the restored dock session; falls back to the stored preference. */
  restoredDesktopOpen: boolean | undefined;
  /** The classic interface theme carries no room-theme attribute. */
  uiTheme: UiTheme;
}

export interface UserPreferences {
  suppressNotifications: boolean;
  warmRoomEnabled: boolean;
  warmConnectedPaneLimit: number;
  cliImagePreviewLimit: number;
  roomTheme: RoomTheme;
  terminalFontSize: number;
  showSessionDebugIds: boolean;
  cliDebugModeEnabled: boolean;
  cliFloatsHidden: boolean;
  maskSensitiveData: boolean;
  isRoomToolbarHidden: boolean;
  isRoomFocusMode: boolean;
  /** Rooms rail open on desktop (`roomsRailHidden` inverted). */
  isDesktopSideSurfaceOpen: boolean;
  defaultWorktreeEnabled: boolean;
  projectPresets: ProjectPreset[];
  roomExtraEmptySlots: Record<string, number>;
  /** Applies the account copy of every preference present in `settings`. Never writes back. */
  hydrate: (settings: UserSettings) => void;
  // State-only setters: the write-through effects in useUserPreferenceWriteThrough persist them.
  setTerminalFontSize: (size: number) => void;
  setRoomTheme: (theme: RoomTheme) => void;
  setCliDebugModeEnabled: (enabled: boolean) => void;
  setIsDesktopSideSurfaceOpen: (open: boolean | ((current: boolean) => boolean)) => void;
  /** Leaves focus mode without persisting (no room selected). */
  setIsRoomFocusMode: (enabled: boolean) => void;
  // Explicit choices: each writes the browser copy and, when signed in, the account copy.
  toggleCliFloats: () => void;
  toggleMaskSensitiveData: () => void;
  toggleRoomFocusMode: () => void;
  setRoomToolbarHidden: (hidden: boolean) => void;
  changeSuppressNotifications: (suppressed: boolean) => void;
  changeCliImagePreviewLimit: (limit: number) => void;
  changeWarmRoomEnabled: (enabled: boolean) => void;
  changeWarmConnectedPaneLimit: (limit: number) => void;
  changeDefaultWorktreeEnabled: (enabled: boolean) => void;
  isRoomWorktreeEnabled: (roomId: string) => boolean;
  setRoomWorktreeEnabled: (roomId: string, enabled: boolean) => void;
  /** Adds an opened project unless its path is known; a clashing label gets a numeric suffix. */
  addOpenedProjectPreset: (project: ProjectPreset) => void;
  /** Adds a named preset unless the label is already taken. */
  addNamedProjectPreset: (label: string, path: string) => void;
  updateRoomExtraEmptySlots: (roomId: string, targetOrDelta: number, isAbsolute?: boolean) => void;
}

export function useUserPreferences({ isAuthenticated, restoredDesktopOpen, uiTheme }: UserPreferencesContext): UserPreferences {
  const runtime = getSpaceRuntime();
  const [roomExtraEmptySlots, setRoomExtraEmptySlots] = useState<Record<string, number>>(() => readStoredRoomExtraEmptySlots());
  const updateRoomExtraEmptySlots = useCallback((roomId: string, targetOrDelta: number, isAbsolute = false) => {
    setRoomExtraEmptySlots((prev) => {
      const current = prev[roomId] ?? 0;
      const nextVal = Math.max(0, Math.min(6, isAbsolute ? targetOrDelta : current + targetOrDelta));
      const next = { ...prev, [roomId]: nextVal };
      try {
        runtime.platform.localStorage.setItem(ROOM_EXTRA_EMPTY_SLOTS_STORAGE_KEY, JSON.stringify(next));
      } catch {}
      if (isAuthenticated) {
        saveUserSettingDebounced("roomExtraEmptySlots", next);
      }
      return next;
    });
  }, [runtime.platform.localStorage, isAuthenticated]);
  const [isRoomFocusMode, setIsRoomFocusMode] = useState(() => readStoredBoolean(ROOM_FOCUS_MODE_STORAGE_KEY));
  const [isRoomToolbarHidden, setIsRoomToolbarHidden] = useState(() => readStoredBoolean(ROOM_TOOLBAR_HIDDEN_STORAGE_KEY));
  const [isDesktopSideSurfaceOpen, setIsDesktopSideSurfaceOpen] = useState(() => restoredDesktopOpen ?? !readStoredBoolean(SIDE_SURFACE_HIDDEN_STORAGE_KEY));
  const [terminalFontSize, setTerminalFontSize] = useState(readStoredTerminalFontSize);
  const [cliImagePreviewLimit, setCliImagePreviewLimit] = useState(readStoredCliImagePreviewLimit);
  const [warmRoomEnabled, setWarmRoomEnabled] = useState(readStoredWarmRoomEnabled);
  const [warmConnectedPaneLimit, setWarmConnectedPaneLimit] = useState(readStoredWarmRoomConnectedPaneLimit);
  const [suppressNotifications, setSuppressNotifications] = useState(readStoredSuppressNotifications);
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.setAttribute("data-suppress-notifications", String(suppressNotifications));
    if (document.body) {
      document.body.setAttribute("data-suppress-notifications", String(suppressNotifications));
    }
  }, [suppressNotifications]);
  const [showSessionDebugIds, setShowSessionDebugIds] = useState(() => readStoredBooleanDefaultTrue(SESSION_DEBUG_IDS_STORAGE_KEY));
  const [cliDebugModeEnabled, setCliDebugModeEnabled] = useState(() => readStoredBoolean(CLI_DEBUG_MODE_STORAGE_KEY));
  const [cliFloatsHidden, setCliFloatsHidden] = useState(() => readStoredBoolean(CLI_FLOATS_HIDDEN_STORAGE_KEY));
  const [maskSensitiveData, setMaskSensitiveData] = useState(() =>
    readStoredBoolean(SPACE_SENSITIVE_DATA_MASKED_STORAGE_KEY)
  );
  const [roomTheme, setRoomTheme] = useState<RoomTheme>(readStoredRoomTheme);
  useEffect(() => {
    const body = document.body;
    if (uiTheme === "classic") {
      body.removeAttribute("data-room-theme");
      return;
    }
    body.setAttribute("data-room-theme", roomTheme);
    return () => {
      if (body.getAttribute("data-room-theme") === roomTheme) {
        body.removeAttribute("data-room-theme");
      }
    };
  }, [roomTheme, uiTheme]);
  const [defaultWorktreeEnabled, setDefaultWorktreeEnabled] = useState<boolean>(readStoredDefaultWorktreeEnabled);
  const [roomWorktreeOverrides, setRoomWorktreeOverrides] = useState<Record<string, boolean>>(readStoredRoomWorktreeOverrides);
  const [projectPresets, setProjectPresets] = useState<ProjectPreset[]>(readStoredProjectPresets);

  const hydrate = useCallback((settings: UserSettings) => {
    if (typeof settings.suppressNotifications === "boolean") {
      setSuppressNotifications(settings.suppressNotifications);
    }
    if (typeof settings.warmRoomEnabled === "boolean") {
      setWarmRoomEnabled(settings.warmRoomEnabled);
    }
    if (typeof settings.warmRoomConnectedPaneLimit === "number") {
      setWarmConnectedPaneLimit(settings.warmRoomConnectedPaneLimit);
    }
    if (typeof settings.cliImagePreviewLimit === "number") {
      setCliImagePreviewLimit(settings.cliImagePreviewLimit);
    }
    if (typeof settings.roomTheme === "string" && roomThemes.some((t) => t.id === settings.roomTheme)) {
      setRoomTheme(settings.roomTheme as RoomTheme);
    }
    if (typeof settings.terminalFontSize === "number" && !touchDeviceTextSize()) {
      setTerminalFontSize(settings.terminalFontSize);
    }
    if (typeof settings.showSessionDebugIds === "boolean") {
      setShowSessionDebugIds(settings.showSessionDebugIds);
    }
    if (typeof settings.cliDebugModeEnabled === "boolean") {
      setCliDebugModeEnabled(settings.cliDebugModeEnabled);
    }
    if (typeof settings.cliFloatsHidden === "boolean") {
      setCliFloatsHidden(settings.cliFloatsHidden);
    }
    if (typeof settings.sensitiveDataMasked === "boolean") {
      setMaskSensitiveData(settings.sensitiveDataMasked);
    }
    if (typeof settings.roomToolbarHidden === "boolean") {
      setIsRoomToolbarHidden(settings.roomToolbarHidden);
    }
    if (typeof settings.roomFocusMode === "boolean") {
      setIsRoomFocusMode(settings.roomFocusMode);
    }
    if (typeof settings.roomsRailHidden === "boolean") {
      setIsDesktopSideSurfaceOpen(!settings.roomsRailHidden);
    }
    if (typeof settings.worktreeDefaultEnabled === "boolean") {
      setDefaultWorktreeEnabled(settings.worktreeDefaultEnabled);
    }
    if (settings.roomWorktreeOverrides && typeof settings.roomWorktreeOverrides === "object") {
      setRoomWorktreeOverrides(settings.roomWorktreeOverrides as Record<string, boolean>);
    }
    if (Array.isArray(settings.projectPresets)) {
      setProjectPresets(settings.projectPresets as ProjectPreset[]);
    }
    if (settings.roomExtraEmptySlots && typeof settings.roomExtraEmptySlots === "object") {
      setRoomExtraEmptySlots(settings.roomExtraEmptySlots as Record<string, number>);
    }
  }, []);

  function isRoomWorktreeEnabled(roomId: string): boolean {
    if (typeof roomWorktreeOverrides[roomId] === "boolean") {
      return roomWorktreeOverrides[roomId];
    }
    try {
      const stored = localStorage.getItem(`space.room.${roomId}.isolatedWorktree`);
      if (stored !== null) return stored === "true";
    } catch {}
    return defaultWorktreeEnabled;
  }

  function setRoomWorktreeEnabled(roomId: string, enabled: boolean) {
    try {
      localStorage.setItem(`space.room.${roomId}.isolatedWorktree`, String(enabled));
    } catch {}
    setRoomWorktreeOverrides((prev) => {
      const next = { ...prev, [roomId]: enabled };
      if (isAuthenticated) {
        saveUserSettingDebounced("roomWorktreeOverrides", next);
      }
      return next;
    });
  }

  function addOpenedProjectPreset(project: ProjectPreset) {
    setProjectPresets((prev) => {
      if (prev.some((p) => p.path === project.path)) return prev;
      let label = project.label;
      for (let index = 2; prev.some((p) => p.label.toLowerCase() === label.toLowerCase()); index++) label = `${project.label} (${index})`;
      const next = [...prev, { label, path: project.path }];
      try {
        localStorage.setItem(PROJECT_PRESETS_STORAGE_KEY, JSON.stringify(next));
      } catch {}
      if (isAuthenticated) {
        saveUserSettingDebounced("projectPresets", next);
      }
      return next;
    });
  }

  function addNamedProjectPreset(name: string, projectPath: string) {
    setProjectPresets((prev) => {
      if (prev.some((p) => p.label.toLowerCase() === name.toLowerCase())) return prev;
      const next = [...prev, { label: name, path: projectPath }];
      try {
        localStorage.setItem(PROJECT_PRESETS_STORAGE_KEY, JSON.stringify(next));
      } catch {}
      if (isAuthenticated) {
        saveUserSettingDebounced("projectPresets", next);
      }
      return next;
    });
  }

  function toggleCliFloats() {
    setCliFloatsHidden((current) => {
      const next = !current;
      try {
        runtime.platform.localStorage.setItem(CLI_FLOATS_HIDDEN_STORAGE_KEY, String(next));
      } catch {
        // Best effort only.
      }
      if (isAuthenticated) {
        saveUserSettingDebounced("cliFloatsHidden", next);
      }
      return next;
    });
  }

  function toggleMaskSensitiveData() {
    setMaskSensitiveData((current) => {
      const next = !current;
      try {
        runtime.platform.localStorage.setItem(SPACE_SENSITIVE_DATA_MASKED_STORAGE_KEY, String(next));
      } catch {
        // Best effort only.
      }
      if (isAuthenticated) {
        saveUserSettingDebounced("sensitiveDataMasked", next);
      }
      return next;
    });
  }

  function setRoomToolbarHidden(hidden: boolean) {
    try {
      runtime.platform.localStorage.setItem(ROOM_TOOLBAR_HIDDEN_STORAGE_KEY, String(hidden));
    } catch {
      // Best effort only.
    }
    if (isAuthenticated) {
      saveUserSettingDebounced("roomToolbarHidden", hidden);
    }
    setIsRoomToolbarHidden(hidden);
  }

  function toggleRoomFocusMode() {
    const nextValue = !isRoomFocusMode;
    try {
      runtime.platform.localStorage.setItem(ROOM_FOCUS_MODE_STORAGE_KEY, String(nextValue));
    } catch {
      // Best effort only.
    }
    if (isAuthenticated) {
      saveUserSettingDebounced("roomFocusMode", nextValue);
    }
    setIsRoomFocusMode(nextValue);
  }

  function changeDefaultWorktreeEnabled(enabled: boolean) {
    setDefaultWorktreeEnabled(enabled);
    try {
      localStorage.setItem(DEFAULT_WORKTREE_ENABLED_STORAGE_KEY, String(enabled));
    } catch {}
    if (isAuthenticated) {
      saveUserSettingDebounced("worktreeDefaultEnabled", enabled);
    }
  }

  return {
    suppressNotifications,
    warmRoomEnabled,
    warmConnectedPaneLimit,
    cliImagePreviewLimit,
    roomTheme,
    terminalFontSize,
    showSessionDebugIds,
    cliDebugModeEnabled,
    cliFloatsHidden,
    maskSensitiveData,
    isRoomToolbarHidden,
    isRoomFocusMode,
    isDesktopSideSurfaceOpen,
    defaultWorktreeEnabled,
    projectPresets,
    roomExtraEmptySlots,
    hydrate,
    setTerminalFontSize,
    setRoomTheme,
    setCliDebugModeEnabled,
    setIsDesktopSideSurfaceOpen,
    setIsRoomFocusMode,
    toggleCliFloats,
    toggleMaskSensitiveData,
    toggleRoomFocusMode,
    setRoomToolbarHidden,
    changeSuppressNotifications: (suppressed) => setSuppressNotifications(writeStoredSuppressNotifications(suppressed)),
    changeCliImagePreviewLimit: (limit) => setCliImagePreviewLimit(writeStoredCliImagePreviewLimit(limit)),
    // Explicit UI choices are the only warm-preference write path (2026-09-30 baseline).
    changeWarmRoomEnabled: (enabled) => setWarmRoomEnabled(writeStoredWarmRoomEnabled(enabled)),
    changeWarmConnectedPaneLimit: (limit) => setWarmConnectedPaneLimit(writeStoredWarmRoomConnectedPaneLimit(limit)),
    changeDefaultWorktreeEnabled,
    isRoomWorktreeEnabled,
    setRoomWorktreeEnabled,
    addOpenedProjectPreset,
    addNamedProjectPreset,
    updateRoomExtraEmptySlots
  };
}

type WriteThroughPreferences = Pick<
  UserPreferences,
  "terminalFontSize" | "showSessionDebugIds" | "cliDebugModeEnabled" | "isDesktopSideSurfaceOpen" | "roomTheme"
>;

/**
 * Writes the state-only preferences through to browser storage and, when signed in, to the account.
 * Kept apart from useUserPreferences so these effects run at their original place in App's effect order.
 */
export function useUserPreferenceWriteThrough(
  { terminalFontSize, showSessionDebugIds, cliDebugModeEnabled, isDesktopSideSurfaceOpen, roomTheme }: WriteThroughPreferences,
  isAuthenticated: boolean | undefined
): void {
  const runtime = getSpaceRuntime();
  useEffect(() => {
    if (touchDeviceTextSize()) {
      runtime.platform.localStorage.setItem(TOUCH_TERMINAL_FONT_SIZE_STORAGE_KEY, String(terminalFontSize));
      return;
    }
    runtime.platform.localStorage.setItem(TERMINAL_FONT_SIZE_STORAGE_KEY, String(terminalFontSize));
    if (isAuthenticated) {
      saveUserSettingDebounced("terminalFontSize", terminalFontSize);
    }
  }, [terminalFontSize, isAuthenticated]);

  useEffect(() => {
    runtime.platform.localStorage.setItem(SESSION_DEBUG_IDS_STORAGE_KEY, String(showSessionDebugIds));
    if (isAuthenticated) {
      saveUserSettingDebounced("showSessionDebugIds", showSessionDebugIds);
    }
  }, [showSessionDebugIds, isAuthenticated]);

  useEffect(() => {
    runtime.platform.localStorage.setItem(CLI_DEBUG_MODE_STORAGE_KEY, String(cliDebugModeEnabled));
    if (isAuthenticated) {
      saveUserSettingDebounced("cliDebugModeEnabled", cliDebugModeEnabled);
    }
  }, [cliDebugModeEnabled, isAuthenticated]);

  useEffect(() => {
    const hidden = !isDesktopSideSurfaceOpen;
    runtime.platform.localStorage.setItem(SIDE_SURFACE_HIDDEN_STORAGE_KEY, String(hidden));
    if (isAuthenticated) {
      saveUserSettingDebounced("roomsRailHidden", hidden);
    }
  }, [isDesktopSideSurfaceOpen, isAuthenticated]);

  useEffect(() => {
    runtime.platform.localStorage.setItem(ROOM_THEME_STORAGE_KEY, roomTheme);
    if (isAuthenticated) {
      void api.updateUserSettings({ roomTheme }).catch(() => {});
    }
  }, [roomTheme, isAuthenticated]);
}
