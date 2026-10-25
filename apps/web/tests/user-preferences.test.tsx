import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserSettings } from "@space/contracts";

const updateUserSettings = vi.hoisted(() => vi.fn(async (_input: unknown) => ({})));
const saveUserSettingDebounced = vi.hoisted(() => vi.fn());
vi.mock("../src/api.js", () => ({ api: { updateUserSettings } }));
vi.mock("../src/features/user-settings/user-settings-manager.js", () => ({ saveUserSettingDebounced }));

import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
import { roomThemes, type RoomTheme } from "../src/features/room-theme/RoomThemeMenu.js";
import {
  useUserPreferenceWriteThrough,
  useUserPreferences,
  type UserPreferences,
  type UserPreferencesContext
} from "../src/features/user-settings/useUserPreferences.js";

type HydratedState = Pick<
  UserPreferences,
  | "suppressNotifications" | "warmRoomEnabled" | "warmConnectedPaneLimit" | "cliImagePreviewLimit" | "roomTheme"
  | "terminalFontSize" | "showSessionDebugIds" | "cliDebugModeEnabled" | "cliFloatsHidden" | "maskSensitiveData"
  | "isRoomToolbarHidden" | "isRoomFocusMode" | "isDesktopSideSurfaceOpen" | "defaultWorktreeEnabled"
  | "projectPresets" | "roomExtraEmptySlots"
> & { roomWorktreeOverrides: Record<string, boolean> };

function snapshot(preferences: UserPreferences, roomIds: string[]): HydratedState {
  const roomWorktreeOverrides: Record<string, boolean> = {};
  for (const roomId of roomIds) roomWorktreeOverrides[roomId] = preferences.isRoomWorktreeEnabled(roomId);
  return {
    suppressNotifications: preferences.suppressNotifications,
    warmRoomEnabled: preferences.warmRoomEnabled,
    warmConnectedPaneLimit: preferences.warmConnectedPaneLimit,
    cliImagePreviewLimit: preferences.cliImagePreviewLimit,
    roomTheme: preferences.roomTheme,
    terminalFontSize: preferences.terminalFontSize,
    showSessionDebugIds: preferences.showSessionDebugIds,
    cliDebugModeEnabled: preferences.cliDebugModeEnabled,
    cliFloatsHidden: preferences.cliFloatsHidden,
    maskSensitiveData: preferences.maskSensitiveData,
    isRoomToolbarHidden: preferences.isRoomToolbarHidden,
    isRoomFocusMode: preferences.isRoomFocusMode,
    isDesktopSideSurfaceOpen: preferences.isDesktopSideSurfaceOpen,
    defaultWorktreeEnabled: preferences.defaultWorktreeEnabled,
    projectPresets: preferences.projectPresets,
    roomExtraEmptySlots: preferences.roomExtraEmptySlots,
    roomWorktreeOverrides
  };
}

// Verbatim copy of the block App.tsx ran twice (refresh() on `me.settings`, handleLogin on
// `nextAuth.settings`) before the controller owned these preferences, applied to plain setters.
function legacyHydrate(settings: UserSettings, state: HydratedState & { overrides: Record<string, boolean> | null }) {
  const me = { settings };
  const setSuppressNotifications = (value: boolean) => { state.suppressNotifications = value; };
  const setWarmRoomEnabled = (value: boolean) => { state.warmRoomEnabled = value; };
  const setWarmConnectedPaneLimit = (value: number) => { state.warmConnectedPaneLimit = value; };
  const setCliImagePreviewLimit = (value: number) => { state.cliImagePreviewLimit = value; };
  const setRoomTheme = (value: RoomTheme) => { state.roomTheme = value; };
  const setTerminalFontSize = (value: number) => { state.terminalFontSize = value; };
  const setShowSessionDebugIds = (value: boolean) => { state.showSessionDebugIds = value; };
  const setCliDebugModeEnabled = (value: boolean) => { state.cliDebugModeEnabled = value; };
  const setCliFloatsHidden = (value: boolean) => { state.cliFloatsHidden = value; };
  const setMaskSensitiveData = (value: boolean) => { state.maskSensitiveData = value; };
  const setIsRoomToolbarHidden = (value: boolean) => { state.isRoomToolbarHidden = value; };
  const setIsRoomFocusMode = (value: boolean) => { state.isRoomFocusMode = value; };
  const setIsDesktopSideSurfaceOpen = (value: boolean) => { state.isDesktopSideSurfaceOpen = value; };
  const setDefaultWorktreeEnabled = (value: boolean) => { state.defaultWorktreeEnabled = value; };
  const setRoomWorktreeOverrides = (value: Record<string, boolean>) => { state.overrides = value; };
  const setProjectPresets = (value: { label: string; path: string }[]) => { state.projectPresets = value; };
  const setRoomExtraEmptySlots = (value: Record<string, number>) => { state.roomExtraEmptySlots = value; };
  if (typeof me.settings.suppressNotifications === "boolean") {
    setSuppressNotifications(me.settings.suppressNotifications);
  }
  if (typeof me.settings.warmRoomEnabled === "boolean") {
    setWarmRoomEnabled(me.settings.warmRoomEnabled);
  }
  if (typeof me.settings.warmRoomConnectedPaneLimit === "number") {
    setWarmConnectedPaneLimit(me.settings.warmRoomConnectedPaneLimit);
  }
  if (typeof me.settings.cliImagePreviewLimit === "number") {
    setCliImagePreviewLimit(me.settings.cliImagePreviewLimit);
  }
  if (typeof me.settings.roomTheme === "string" && roomThemes.some((t) => t.id === me.settings?.roomTheme)) {
    setRoomTheme(me.settings.roomTheme as RoomTheme);
  }
  if (typeof me.settings.terminalFontSize === "number") {
    setTerminalFontSize(me.settings.terminalFontSize);
  }
  if (typeof me.settings.showSessionDebugIds === "boolean") {
    setShowSessionDebugIds(me.settings.showSessionDebugIds);
  }
  if (typeof me.settings.cliDebugModeEnabled === "boolean") {
    setCliDebugModeEnabled(me.settings.cliDebugModeEnabled);
  }
  if (typeof me.settings.cliFloatsHidden === "boolean") {
    setCliFloatsHidden(me.settings.cliFloatsHidden);
  }
  if (typeof me.settings.sensitiveDataMasked === "boolean") {
    setMaskSensitiveData(me.settings.sensitiveDataMasked);
  }
  if (typeof me.settings.roomToolbarHidden === "boolean") {
    setIsRoomToolbarHidden(me.settings.roomToolbarHidden);
  }
  if (typeof me.settings.roomFocusMode === "boolean") {
    setIsRoomFocusMode(me.settings.roomFocusMode);
  }
  if (typeof me.settings.roomsRailHidden === "boolean") {
    setIsDesktopSideSurfaceOpen(!me.settings.roomsRailHidden);
  }
  if (typeof me.settings.worktreeDefaultEnabled === "boolean") {
    setDefaultWorktreeEnabled(me.settings.worktreeDefaultEnabled);
  }
  if (me.settings.roomWorktreeOverrides && typeof me.settings.roomWorktreeOverrides === "object") {
    setRoomWorktreeOverrides(me.settings.roomWorktreeOverrides as Record<string, boolean>);
  }
  if (Array.isArray(me.settings.projectPresets)) {
    setProjectPresets(me.settings.projectPresets as { label: string; path: string }[]);
  }
  if (me.settings.roomExtraEmptySlots && typeof me.settings.roomExtraEmptySlots === "object") {
    setRoomExtraEmptySlots(me.settings.roomExtraEmptySlots as Record<string, number>);
  }
}

const context: UserPreferencesContext = { isAuthenticated: true, restoredDesktopOpen: undefined, uiTheme: "modern" };
const ROOM_IDS = ["room:a", "room:b", "room:c"];

const representativeSettings: Array<[string, UserSettings]> = [
  ["empty settings", {} as UserSettings],
  ["every preference", {
    suppressNotifications: true,
    warmRoomEnabled: false,
    warmRoomConnectedPaneLimit: 48,
    cliImagePreviewLimit: 7,
    roomTheme: roomThemes[1]!.id,
    terminalFontSize: 15,
    showSessionDebugIds: false,
    cliDebugModeEnabled: true,
    cliFloatsHidden: true,
    sensitiveDataMasked: true,
    roomToolbarHidden: true,
    roomFocusMode: true,
    roomsRailHidden: true,
    worktreeDefaultEnabled: false,
    roomWorktreeOverrides: { "room:a": true, "room:b": false },
    projectPresets: [{ label: "alpha", path: "/opt/spaceapp/projects/alpha" }],
    roomExtraEmptySlots: { "room:a": 2 }
  } as unknown as UserSettings],
  ["partial with falsy values", {
    suppressNotifications: false,
    warmRoomEnabled: true,
    roomsRailHidden: false,
    roomToolbarHidden: false,
    terminalFontSize: 0,
    projectPresets: []
  } as unknown as UserSettings],
  ["wrong types and an unknown theme", {
    suppressNotifications: "true",
    warmRoomEnabled: 1,
    warmRoomConnectedPaneLimit: "96",
    cliImagePreviewLimit: null,
    roomTheme: "no-such-theme",
    terminalFontSize: "14",
    roomFocusMode: "yes",
    roomWorktreeOverrides: "room:a",
    projectPresets: { label: "x" },
    roomExtraEmptySlots: 3
  } as unknown as UserSettings]
];

describe("useUserPreferences", () => {
  beforeEach(() => {
    installSpaceRuntime(liveRuntime);
    window.localStorage.clear();
    updateUserSettings.mockReset().mockResolvedValue({});
    saveUserSettingDebounced.mockReset();
  });
  afterEach(() => cleanup());

  it.each(representativeSettings)("hydrate matches the former App blocks for %s", (_label, settings) => {
    const { result } = renderHook(() => useUserPreferences(context));
    const initial = snapshot(result.current, ROOM_IDS);
    const legacy = { ...initial, overrides: null as Record<string, boolean> | null };
    legacyHydrate(settings, legacy);

    act(() => result.current.hydrate(settings));

    const { overrides, ...expected } = legacy;
    // A replaced override map wins over browser storage and the default for the rooms it names.
    for (const roomId of ROOM_IDS) {
      if (overrides && typeof overrides[roomId] === "boolean") expected.roomWorktreeOverrides[roomId] = overrides[roomId]!;
      else expected.roomWorktreeOverrides[roomId] = expected.defaultWorktreeEnabled;
    }
    expect(snapshot(result.current, ROOM_IDS)).toEqual(expected);
  });

  it("hydrate never writes preferences back to the account or browser storage", () => {
    const { result } = renderHook(() => useUserPreferences(context));
    const before = { ...window.localStorage };
    act(() => result.current.hydrate(representativeSettings[1]![1]));
    expect(saveUserSettingDebounced).not.toHaveBeenCalled();
    expect(updateUserSettings).not.toHaveBeenCalled();
    expect({ ...window.localStorage }).toEqual(before);
  });

  it("reads the browser copies on first render", () => {
    window.localStorage.setItem("space.terminal.fontSize", "99");
    window.localStorage.setItem("space.cliFloatsHidden", "true");
    window.localStorage.setItem("space.showSessionDebugIds", "false");
    window.localStorage.setItem("space.roomsRailHidden", "true");
    window.localStorage.setItem("space.room.theme", "not-a-theme");
    window.localStorage.setItem("space:room-extra-empty-slots.v1", JSON.stringify({ "room:a": 9.6, "room:b": "x" }));
    window.localStorage.setItem("space:project_presets", JSON.stringify([{ label: "olla", path: "/srv/olla" }, { label: "keep", path: "/srv/keep" }]));
    const { result } = renderHook(() => useUserPreferences(context));
    expect(result.current.terminalFontSize).toBeLessThan(99);
    expect(result.current.cliFloatsHidden).toBe(true);
    expect(result.current.showSessionDebugIds).toBe(false);
    expect(result.current.isDesktopSideSurfaceOpen).toBe(false);
    expect(result.current.roomTheme).toBe("graphite");
    expect(result.current.roomExtraEmptySlots).toEqual({ "room:a": 6 });
    expect(result.current.projectPresets).toEqual([{ label: "keep", path: "/srv/keep" }]);
    expect(window.localStorage.getItem("space:project_presets")).toBe(JSON.stringify([{ label: "keep", path: "/srv/keep" }]));
  });

  it("prefers the restored dock session for the rooms rail", () => {
    window.localStorage.setItem("space.roomsRailHidden", "true");
    const { result } = renderHook(() => useUserPreferences({ ...context, restoredDesktopOpen: true }));
    expect(result.current.isDesktopSideSurfaceOpen).toBe(true);
  });

  it("persists explicit choices locally and to the account only when signed in", () => {
    const { result, rerender } = renderHook((props: UserPreferencesContext) => useUserPreferences(props), {
      initialProps: { ...context, isAuthenticated: false }
    });
    act(() => result.current.toggleCliFloats());
    expect(result.current.cliFloatsHidden).toBe(true);
    expect(window.localStorage.getItem("space.cliFloatsHidden")).toBe("true");
    expect(saveUserSettingDebounced).not.toHaveBeenCalled();

    rerender({ ...context, isAuthenticated: true });
    act(() => result.current.toggleMaskSensitiveData());
    act(() => result.current.setRoomToolbarHidden(true));
    act(() => result.current.toggleRoomFocusMode());
    act(() => result.current.changeDefaultWorktreeEnabled(false));
    expect(window.localStorage.getItem("space.sensitiveDataMasked")).toBe("true");
    expect(window.localStorage.getItem("space.roomToolbar.hidden.v1")).toBe("true");
    expect(window.localStorage.getItem("space.roomFocusMode")).toBe("true");
    expect(window.localStorage.getItem("space.worktree.defaultEnabled")).toBe("false");
    expect(saveUserSettingDebounced.mock.calls).toEqual([
      ["sensitiveDataMasked", true],
      ["roomToolbarHidden", true],
      ["roomFocusMode", true],
      ["worktreeDefaultEnabled", false]
    ]);
    expect(result.current.isRoomToolbarHidden).toBe(true);
    expect(result.current.isRoomFocusMode).toBe(true);
    expect(result.current.defaultWorktreeEnabled).toBe(false);
  });

  it("clamps empty slots, resolves worktree overrides and de-duplicates presets", () => {
    const { result } = renderHook(() => useUserPreferences(context));
    act(() => result.current.updateRoomExtraEmptySlots("room:a", 4));
    act(() => result.current.updateRoomExtraEmptySlots("room:a", 5));
    expect(result.current.roomExtraEmptySlots).toEqual({ "room:a": 6 });
    act(() => result.current.updateRoomExtraEmptySlots("room:a", -3, true));
    expect(result.current.roomExtraEmptySlots).toEqual({ "room:a": 0 });

    expect(result.current.isRoomWorktreeEnabled("room:b")).toBe(true);
    window.localStorage.setItem("space.room.room:c.isolatedWorktree", "false");
    expect(result.current.isRoomWorktreeEnabled("room:c")).toBe(false);
    act(() => result.current.setRoomWorktreeEnabled("room:b", false));
    expect(result.current.isRoomWorktreeEnabled("room:b")).toBe(false);
    expect(window.localStorage.getItem("space.room.room:b.isolatedWorktree")).toBe("false");

    act(() => result.current.addNamedProjectPreset("Space", "/srv/other"));
    expect(result.current.projectPresets.filter((preset) => preset.label.toLowerCase() === "space")).toHaveLength(1);
    act(() => result.current.addOpenedProjectPreset({ label: "space", path: "/srv/new" }));
    expect(result.current.projectPresets.at(-1)).toEqual({ label: "space (2)", path: "/srv/new" });
    act(() => result.current.addOpenedProjectPreset({ label: "again", path: "/srv/new" }));
    expect(result.current.projectPresets.filter((preset) => preset.path === "/srv/new")).toHaveLength(1);
  });

  it("warm preference choices go through the explicit write path only", () => {
    const { result } = renderHook(() => useUserPreferences(context));
    act(() => result.current.changeWarmRoomEnabled(false));
    act(() => result.current.changeWarmConnectedPaneLimit(48));
    expect(result.current.warmRoomEnabled).toBe(false);
    expect(result.current.warmConnectedPaneLimit).toBe(48);
    expect(updateUserSettings).toHaveBeenCalledWith({ warmRoomEnabled: false });
    expect(updateUserSettings).toHaveBeenCalledWith({ warmRoomConnectedPaneLimit: 48 });
  });

  it("mirrors suppression and the room theme on the document", () => {
    const { result, rerender } = renderHook((props: UserPreferencesContext) => useUserPreferences(props), { initialProps: context });
    act(() => result.current.changeSuppressNotifications(true));
    expect(document.documentElement.getAttribute("data-suppress-notifications")).toBe("true");
    act(() => result.current.setRoomTheme(roomThemes[2]!.id));
    expect(document.body.getAttribute("data-room-theme")).toBe(roomThemes[2]!.id);
    rerender({ ...context, uiTheme: "classic" });
    expect(document.body.hasAttribute("data-room-theme")).toBe(false);
  });
});

describe("useUserPreferenceWriteThrough", () => {
  beforeEach(() => {
    installSpaceRuntime(liveRuntime);
    window.localStorage.clear();
    updateUserSettings.mockReset().mockResolvedValue({});
    saveUserSettingDebounced.mockReset();
  });
  afterEach(() => cleanup());

  it("writes the browser copies on mount and the account copies once signed in", () => {
    const values = { terminalFontSize: 14, showSessionDebugIds: false, cliDebugModeEnabled: true, isDesktopSideSurfaceOpen: false, roomTheme: "graphite" as RoomTheme };
    const { rerender } = renderHook(({ authenticated }: { authenticated: boolean | undefined }) =>
      useUserPreferenceWriteThrough(values, authenticated), { initialProps: { authenticated: undefined as boolean | undefined } });
    expect(window.localStorage.getItem("space.terminal.fontSize")).toBe("14");
    expect(window.localStorage.getItem("space.showSessionDebugIds")).toBe("false");
    expect(window.localStorage.getItem("space.cliDebugMode")).toBe("true");
    expect(window.localStorage.getItem("space.roomsRailHidden")).toBe("true");
    expect(window.localStorage.getItem("space.room.theme")).toBe("graphite");
    expect(saveUserSettingDebounced).not.toHaveBeenCalled();
    expect(updateUserSettings).not.toHaveBeenCalled();

    rerender({ authenticated: true });
    expect(saveUserSettingDebounced.mock.calls).toEqual([
      ["terminalFontSize", 14],
      ["showSessionDebugIds", false],
      ["cliDebugModeEnabled", true],
      ["roomsRailHidden", true]
    ]);
    expect(updateUserSettings).toHaveBeenCalledWith({ roomTheme: "graphite" });
  });

  it("a touch device keeps its own text size: never sent to the account, never replaced by the account's", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(pointer: coarse)", media: query }) as MediaQueryList);
    try {
      window.localStorage.setItem("space.terminal.fontSize", "15");
      const values = { terminalFontSize: 10, showSessionDebugIds: false, cliDebugModeEnabled: false, isDesktopSideSurfaceOpen: true, roomTheme: "graphite" as RoomTheme };
      renderHook(() => useUserPreferenceWriteThrough(values, true));
      expect(window.localStorage.getItem("space.terminal.fontSize.touch")).toBe("10");
      expect(window.localStorage.getItem("space.terminal.fontSize")).toBe("15");
      expect(saveUserSettingDebounced.mock.calls.map(([key]) => key)).not.toContain("terminalFontSize");
      const { result } = renderHook(() => useUserPreferences(context));
      expect(result.current.terminalFontSize).toBe(10);
      act(() => result.current.hydrate({ terminalFontSize: 18 } as never));
      expect(result.current.terminalFontSize).toBe(10);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
