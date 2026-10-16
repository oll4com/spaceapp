import type { UpdateUserSettingsInput, UserSettings } from "@space/contracts";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";
import {
  PANES_HIDDEN_STORAGE_KEY,
  PANES_VISIBILITY_EVENT,
  writeHiddenPaneIds
} from "../pane-visibility/use-panes-visibility.js";
import {
  DOCKS_HIDDEN_STORAGE_KEY,
  DOCKS_VISIBILITY_EVENT,
  writeDockOrder,
  writeHiddenDockIds
} from "../docks/use-docks-visibility.js";
import { applyServerDateTimeSettings } from "../date-time-settings/date-time-settings.js";
import { applyServerVoiceSettings } from "../../voice-settings.js";
import { applyServerLivePaneSettings } from "../live-pane/live-pane-config.js";
import { applyServerKeyboardAutocorrectSettings } from "../keyboard-autocorrect/keyboard-autocorrect-settings.js";
import { applyServerSuppressNotifications } from "../../notifications-settings.js";
import { applyServerPromptVariablesSettings } from "../prompt-variables/prompt-variables-store.js";
import {
  applyServerWarmRoomEnabled,
  applyServerWarmRoomConnectedPaneLimit
} from "../../warm-room-settings.js";
import { applyServerCliImagePreviewLimit } from "../../cli-upload-settings.js";
import {
  readUiTheme,
  writeUiTheme,
  readModernAppearance,
  writeModernAppearance,
  readModernIconPack,
  writeModernIconPack,
  readUiBackground,
  writeUiBackground,
  writeLiquidGlassTint
} from "../../ui-theme.js";

export const WIDGETS_STATE_KEY = "space.desktop-widgets.state.v1";
export const WIDGETS_CHANGED_EVENT = "space:desktop-widgets:changed";

export const ENVIRONMENT_PRESET_STORAGE_KEY = "space:environment-preset:v1";
export const CUSTOM_DOCKS_HIDDEN_STORAGE_KEY = "space:custom-docks-hidden:v1";
export const CUSTOM_PANES_HIDDEN_STORAGE_KEY = "space:custom-panes-hidden:v1";
export const CUSTOM_WIDGETS_HIDDEN_STORAGE_KEY = "space:custom-widgets-hidden:v1";
export const CUSTOM_CLI_DISABLED_STORAGE_KEY = "space:custom-cli-disabled:v1";
export const ENVIRONMENT_PRESET_CHANGED_EVENT = "space:environment-preset-changed";

export {
  flushPendingUserSettings,
  saveUserSettingDebounced,
  saveUserSettingImmediate
} from "./user-settings-save-queue.js";

export function syncFromServer(
  settings: Partial<UserSettings>,
  customStorage?: Storage,
  userId?: string
): { themeChanged: boolean } {
  let storage: Storage | null = null;
  try {
    storage = customStorage ?? (typeof window !== "undefined" ? getSpaceRuntime().platform.localStorage : null);
  } catch {
    storage = null;
  }
  if (!storage) return { themeChanged: false };

  let themeChanged = false;

  // 1. Appearance & Theme
  if (settings.uiTheme) {
    const currentTheme = readUiTheme(storage);
    if (settings.uiTheme !== currentTheme) {
      writeUiTheme(storage, settings.uiTheme);
      themeChanged = true;
    }
  }
  if (settings.modernAppearance) {
    const currentAppearance = readModernAppearance(storage);
    if (settings.modernAppearance !== currentAppearance) {
      writeModernAppearance(storage, settings.modernAppearance);
      themeChanged = true;
    }
  }
  if (settings.modernIconPack) {
    const currentIconPack = readModernIconPack(storage);
    if (settings.modernIconPack !== currentIconPack) {
      writeModernIconPack(storage, settings.modernIconPack);
      themeChanged = true;
    }
  }
  if (settings.uiBackground) {
    const currentBg = readUiBackground(storage);
    if (settings.uiBackground !== currentBg) {
      writeUiBackground(storage, settings.uiBackground);
      themeChanged = true;
    }
  }
  // Applied live, like the zoom: no reload.
  if (typeof settings.liquidGlassTint === "number") writeLiquidGlassTint(storage, settings.liquidGlassTint);
  if (typeof settings.uiZoom === "number") {
    storage.setItem("space.ui.zoom.v1", String(settings.uiZoom));
    if (typeof document !== "undefined") {
      document.documentElement.style.zoom = `${settings.uiZoom}%`;
    }
  }
  if (typeof settings.terminalFontSize === "number") {
    storage.setItem("space.terminal.fontSize", String(settings.terminalFontSize));
  }
  if (typeof settings.showSessionDebugIds === "boolean") {
    storage.setItem("space.showSessionDebugIds", String(settings.showSessionDebugIds));
  }
  if (typeof settings.cliDebugModeEnabled === "boolean") {
    storage.setItem("space.cliDebugMode", String(settings.cliDebugModeEnabled));
  }
  if (typeof settings.cliFloatsHidden === "boolean") {
    storage.setItem("space.cliFloatsHidden", String(settings.cliFloatsHidden));
  }
  if (typeof settings.sensitiveDataMasked === "boolean") {
    storage.setItem("space.sensitiveDataMasked", String(settings.sensitiveDataMasked));
  }
  if (typeof settings.roomToolbarHidden === "boolean") {
    storage.setItem("space.roomToolbarHidden", String(settings.roomToolbarHidden));
  }
  if (typeof settings.roomFocusMode === "boolean") {
    storage.setItem("space.roomFocusMode", String(settings.roomFocusMode));
  }
  if (typeof settings.roomsRailHidden === "boolean") {
    storage.setItem("space.roomsRailHidden", String(settings.roomsRailHidden));
  }

  // 2. Docks & Panes visibility
  if (Array.isArray(settings.panesHidden)) {
    writeHiddenPaneIds(settings.panesHidden, storage);
  }
  if (Array.isArray(settings.docksHidden)) {
    writeHiddenDockIds(settings.docksHidden, storage);
  }
  if (Array.isArray(settings.docksOrder)) {
    writeDockOrder(settings.docksOrder, storage);
  }

  // 2b. Environment Preset & Custom Snapshots
  if (settings.environmentPreset) {
    storage.setItem(ENVIRONMENT_PRESET_STORAGE_KEY, settings.environmentPreset);
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent(ENVIRONMENT_PRESET_CHANGED_EVENT, { detail: { preset: settings.environmentPreset } })
      );
    }
  }
  if (Array.isArray(settings.customDocksHidden)) {
    storage.setItem(CUSTOM_DOCKS_HIDDEN_STORAGE_KEY, JSON.stringify(settings.customDocksHidden));
  }
  if (Array.isArray(settings.customPanesHidden)) {
    storage.setItem(CUSTOM_PANES_HIDDEN_STORAGE_KEY, JSON.stringify(settings.customPanesHidden));
  }
  if (Array.isArray(settings.customCliDisabled)) {
    storage.setItem(CUSTOM_CLI_DISABLED_STORAGE_KEY, JSON.stringify(settings.customCliDisabled));
  }

  // 3. Rails & Menus Order/Hidden
  if (Array.isArray(settings.upperRailOrder)) {
    storage.setItem("space:upper-rail-order:v1", JSON.stringify(settings.upperRailOrder));
  }
  if (Array.isArray(settings.upperRailHidden)) {
    storage.setItem("space:upper-rail-hidden:v1", JSON.stringify(settings.upperRailHidden));
  }
  if (Array.isArray(settings.lowerRailOrder)) {
    storage.setItem("space:room-rail-order:v1", JSON.stringify(settings.lowerRailOrder));
  }
  if (Array.isArray(settings.lowerRailHidden)) {
    storage.setItem("space:room-rail-hidden:v1", JSON.stringify(settings.lowerRailHidden));
  }
  if (Array.isArray(settings.createMenuOrder)) {
    storage.setItem("space:create-menu-top-order", JSON.stringify(settings.createMenuOrder));
  }
  if (Array.isArray(settings.workspaceQuickActions)) {
    storage.setItem("space:workspace-quick-actions:v1", JSON.stringify(settings.workspaceQuickActions));
  }

  // 4. Worktree & Presets & Room Slots
  if (typeof settings.worktreeDefaultEnabled === "boolean") {
    storage.setItem("space.worktree.defaultEnabled", String(settings.worktreeDefaultEnabled));
  }
  if (settings.roomWorktreeOverrides && typeof settings.roomWorktreeOverrides === "object") {
    for (const [roomId, enabled] of Object.entries(settings.roomWorktreeOverrides)) {
      storage.setItem(`space.room.${roomId}.isolatedWorktree`, String(enabled));
    }
  }
  if (Array.isArray(settings.projectPresets)) {
    storage.setItem("space:project_presets", JSON.stringify(settings.projectPresets));
  }
  if (settings.roomExtraEmptySlots && typeof settings.roomExtraEmptySlots === "object") {
    storage.setItem("space.room-extra-empty-slots", JSON.stringify(settings.roomExtraEmptySlots));
  }

  // 5. Desktop Widgets, Sticky Notes, Music, OSK, Account Filters
  if (settings.desktopWidgets && typeof settings.desktopWidgets === "object") {
    storage.setItem("space.desktop-widgets.state.v1", JSON.stringify(settings.desktopWidgets));
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(WIDGETS_CHANGED_EVENT, { detail: settings.desktopWidgets }));
    }
  }
  if (Array.isArray(settings.stickyNotes)) {
    storage.setItem("space.sticky-notes.windows.v1", JSON.stringify(settings.stickyNotes));
  }
  if (typeof settings.vibeMusicVolume === "number") {
    storage.setItem("space.vibeMusic.volume", String(settings.vibeMusicVolume));
  }
  if (settings.vibeMusicPlaylistLinkId !== undefined) {
    if (settings.vibeMusicPlaylistLinkId === null) {
      storage.removeItem("space:vibe-music:playlist-link");
    } else {
      storage.setItem("space:vibe-music:playlist-link", settings.vibeMusicPlaylistLinkId);
    }
  }
  if (settings.osk && typeof settings.osk === "object") {
    const osk = settings.osk as Record<string, unknown>;
    if (osk.position) storage.setItem("space.osk.position.v1", JSON.stringify(osk.position));
    if (osk.scale !== undefined) storage.setItem("space.osk.scale.v1", String(osk.scale));
    if (osk.lang !== undefined) storage.setItem("space.osk.lang.v1", String(osk.lang));
    if (osk.autocomplete !== undefined) storage.setItem("space.osk.autocomplete.v1", String(osk.autocomplete));
  }
  if (settings.accountFilters && typeof settings.accountFilters === "object") {
    const af = settings.accountFilters as Record<string, unknown>;
    if (af.provider !== undefined) storage.setItem("space:health-accounts:provider-filter", String(af.provider));
    if (af.quota !== undefined) storage.setItem("space:health-accounts:quota-filter", String(af.quota));
    if (af.pro !== undefined) storage.setItem("space:health-accounts:pro-filter", String(af.pro));
    if (af.gemini !== undefined) storage.setItem("space:health-accounts:gemini-filter", String(af.gemini));
  }

  // 6. Existing service appliers
  if (settings.dateTime) {
    applyServerDateTimeSettings(settings.dateTime, userId);
  }
  if (settings.voice) {
    applyServerVoiceSettings(settings.voice);
  }
  if (settings.livePane) {
    applyServerLivePaneSettings(settings.livePane);
  }
  if (settings.keyboardAutocorrect) {
    applyServerKeyboardAutocorrectSettings(settings.keyboardAutocorrect);
  }
  if (typeof settings.suppressNotifications === "boolean") {
    applyServerSuppressNotifications(settings.suppressNotifications);
  }
  if (typeof settings.warmRoomEnabled === "boolean") {
    applyServerWarmRoomEnabled(settings.warmRoomEnabled);
  }
  if (typeof settings.warmRoomConnectedPaneLimit === "number") {
    applyServerWarmRoomConnectedPaneLimit(settings.warmRoomConnectedPaneLimit);
  }
  if (typeof settings.cliImagePreviewLimit === "number") {
    applyServerCliImagePreviewLimit(settings.cliImagePreviewLimit);
  }
  if (
    settings.promptVariables !== undefined ||
    settings.promptVariablesEnabled !== undefined ||
    settings.promptVariablesAutoExpandOnSubmit !== undefined
  ) {
    applyServerPromptVariablesSettings({
      variables: settings.promptVariables,
      enabled: settings.promptVariablesEnabled,
      autoExpandOnSubmit: settings.promptVariablesAutoExpandOnSubmit
    });
  }

  return { themeChanged };
}

export async function seedInitialLocalSettingsToServer(
  api: { updateUserSettings: (input: UpdateUserSettingsInput) => Promise<any> },
  serverSettings: Partial<UserSettings>,
  customStorage?: Storage
): Promise<UserSettings | null> {
  let storage: Storage | null = null;
  try {
    storage = customStorage ?? (typeof window !== "undefined" ? getSpaceRuntime().platform.localStorage : null);
  } catch {
    storage = null;
  }
  if (!storage) return null;

  const patch: UpdateUserSettingsInput = {};

  // 1. panesHidden
  if (!serverSettings.panesHidden || serverSettings.panesHidden.length === 0) {
    const raw = storage.getItem(PANES_HIDDEN_STORAGE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) patch.panesHidden = parsed;
      } catch {}
    }
  }

  // 2. docksHidden
  if (!serverSettings.docksHidden || serverSettings.docksHidden.length === 0) {
    const raw = storage.getItem(DOCKS_HIDDEN_STORAGE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) patch.docksHidden = parsed;
      } catch {}
    }
  }

  // 3. terminalFontSize
  const storedFont = storage.getItem("space.terminal.fontSize");
  if (storedFont) {
    const num = Number(storedFont);
    if (!isNaN(num) && num >= 8 && num <= 48 && num !== 13 && serverSettings.terminalFontSize === 13) {
      patch.terminalFontSize = num;
    }
  }

  // 4. uiZoom
  const storedZoom = storage.getItem("space.ui.zoom.v1");
  if (storedZoom) {
    const num = Number(storedZoom);
    if (!isNaN(num) && num >= 50 && num <= 200 && num !== 100 && serverSettings.uiZoom === 100) {
      patch.uiZoom = num;
    }
  }

  // 5. desktopWidgets
  if (!serverSettings.desktopWidgets || Object.keys(serverSettings.desktopWidgets).length === 0) {
    const raw = storage.getItem("space.desktop-widgets.state.v1");
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") patch.desktopWidgets = parsed;
      } catch {}
    }
  }

  // 6. stickyNotes
  if (!serverSettings.stickyNotes || serverSettings.stickyNotes.length === 0) {
    const raw = storage.getItem("space.sticky-notes.windows.v1");
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) patch.stickyNotes = parsed;
      } catch {}
    }
  }

  // 7. projectPresets
  if (!serverSettings.projectPresets || serverSettings.projectPresets.length === 0) {
    const raw = storage.getItem("space:project_presets");
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) patch.projectPresets = parsed;
      } catch {}
    }
  }

  // 8. roomExtraEmptySlots
  if (!serverSettings.roomExtraEmptySlots || Object.keys(serverSettings.roomExtraEmptySlots).length === 0) {
    const raw = storage.getItem("space.room-extra-empty-slots");
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") patch.roomExtraEmptySlots = parsed;
      } catch {}
    }
  }

  // 9. worktreeDefaultEnabled
  const storedWorktree = storage.getItem("space.worktree.defaultEnabled");
  if (storedWorktree === "false" && serverSettings.worktreeDefaultEnabled === true) {
    patch.worktreeDefaultEnabled = false;
  }

  // 10. roomsRailHidden
  const storedRoomsRail = storage.getItem("space.roomsRailHidden");
  if (storedRoomsRail === "true" && serverSettings.roomsRailHidden === false) {
    patch.roomsRailHidden = true;
  }

  // 11. vibeMusicVolume
  const storedVolume = storage.getItem("space.vibeMusic.volume");
  if (storedVolume && serverSettings.vibeMusicVolume === undefined) {
    const num = Number(storedVolume);
    if (!isNaN(num) && num >= 0 && num <= 1) patch.vibeMusicVolume = num;
  }

  // 12. vibeMusicPlaylistLinkId
  const storedPlaylist = storage.getItem("space:vibe-music:playlist-link");
  if (storedPlaylist && serverSettings.vibeMusicPlaylistLinkId === undefined) {
    patch.vibeMusicPlaylistLinkId = storedPlaylist;
  }

  // 13. osk
  if (!serverSettings.osk) {
    const oskObj: Record<string, unknown> = {};
    const pos = storage.getItem("space.osk.position.v1");
    if (pos) { try { oskObj.position = JSON.parse(pos); } catch {} }
    const scale = storage.getItem("space.osk.scale.v1");
    if (scale) oskObj.scale = Number(scale);
    const lang = storage.getItem("space.osk.lang.v1");
    if (lang) oskObj.lang = lang;
    const ac = storage.getItem("space.osk.autocomplete.v1");
    if (ac) oskObj.autocomplete = ac === "true";
    if (Object.keys(oskObj).length > 0) patch.osk = oskObj;
  }

  // 14. accountFilters
  if (!serverSettings.accountFilters) {
    const afObj: Record<string, unknown> = {};
    const prov = storage.getItem("space:health-accounts:provider-filter");
    if (prov) afObj.provider = prov;
    const quota = storage.getItem("space:health-accounts:quota-filter");
    if (quota) afObj.quota = quota === "true";
    const pro = storage.getItem("space:health-accounts:pro-filter");
    if (pro) afObj.pro = pro === "true";
    const gemini = storage.getItem("space:health-accounts:gemini-filter");
    if (gemini) afObj.gemini = gemini === "true";
    if (Object.keys(afObj).length > 0) patch.accountFilters = afObj;
  }

  // 15. cliFloatsHidden
  const storedCliFloats = storage.getItem("space.cliFloatsHidden");
  if (storedCliFloats === "true" && serverSettings.cliFloatsHidden === false) {
    patch.cliFloatsHidden = true;
  }

  // 16. sensitiveDataMasked
  const storedMask = storage.getItem("space.sensitiveDataMasked");
  if (storedMask === "true" && serverSettings.sensitiveDataMasked === false) {
    patch.sensitiveDataMasked = true;
  }

  // 17. roomToolbarHidden
  const storedToolbar = storage.getItem("space.roomToolbarHidden");
  if (storedToolbar === "true" && serverSettings.roomToolbarHidden === false) {
    patch.roomToolbarHidden = true;
  }

  // 18. roomFocusMode
  const storedFocus = storage.getItem("space.roomFocusMode");
  if (storedFocus === "true" && serverSettings.roomFocusMode === false) {
    patch.roomFocusMode = true;
  }

  // 19. roomWorktreeOverrides
  if (!serverSettings.roomWorktreeOverrides || Object.keys(serverSettings.roomWorktreeOverrides).length === 0) {
    const overrides: Record<string, boolean> = {};
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key && key.startsWith("space.room.") && key.endsWith(".isolatedWorktree")) {
        const roomId = key.slice("space.room.".length, -".isolatedWorktree".length);
        overrides[roomId] = storage.getItem(key) === "true";
      }
    }
    if (Object.keys(overrides).length > 0) {
      patch.roomWorktreeOverrides = overrides;
    }
  }

  // 20. Rails & menus
  if (!serverSettings.upperRailOrder || serverSettings.upperRailOrder.length === 0) {
    const raw = storage.getItem("space:upper-rail-order:v1");
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) patch.upperRailOrder = parsed;
      } catch {}
    }
  }
  if (!serverSettings.upperRailHidden || serverSettings.upperRailHidden.length === 0) {
    const raw = storage.getItem("space:upper-rail-hidden:v1");
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) patch.upperRailHidden = parsed;
      } catch {}
    }
  }
  if (!serverSettings.lowerRailOrder || serverSettings.lowerRailOrder.length === 0) {
    const raw = storage.getItem("space:room-rail-order:v1");
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) patch.lowerRailOrder = parsed;
      } catch {}
    }
  }
  if (!serverSettings.lowerRailHidden || serverSettings.lowerRailHidden.length === 0) {
    const raw = storage.getItem("space:room-rail-hidden:v1");
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) patch.lowerRailHidden = parsed;
      } catch {}
    }
  }
  if (!serverSettings.createMenuOrder || serverSettings.createMenuOrder.length === 0) {
    const raw = storage.getItem("space:create-menu-top-order");
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) patch.createMenuOrder = parsed;
      } catch {}
    }
  }
  // An empty pin list is a deliberate choice, so only a missing server value is backfilled.
  if (serverSettings.workspaceQuickActions === undefined) {
    const raw = storage.getItem("space:workspace-quick-actions:v1");
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) patch.workspaceQuickActions = parsed.filter((id): id is string => typeof id === "string").slice(0, 8);
      } catch {}
    }
  }

  // 21. Environment preset & custom snapshots
  if (!serverSettings.environmentPreset) {
    const raw = storage.getItem(ENVIRONMENT_PRESET_STORAGE_KEY);
    if (raw === "custom" || raw === "max") patch.environmentPreset = raw;
  }
  if (!serverSettings.customDocksHidden || serverSettings.customDocksHidden.length === 0) {
    const raw = storage.getItem(CUSTOM_DOCKS_HIDDEN_STORAGE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) patch.customDocksHidden = parsed;
      } catch {}
    }
  }
  if (!serverSettings.customPanesHidden || serverSettings.customPanesHidden.length === 0) {
    const raw = storage.getItem(CUSTOM_PANES_HIDDEN_STORAGE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) patch.customPanesHidden = parsed;
      } catch {}
    }
  }
  if (!serverSettings.customCliDisabled || serverSettings.customCliDisabled.length === 0) {
    const raw = storage.getItem(CUSTOM_CLI_DISABLED_STORAGE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) patch.customCliDisabled = parsed;
      } catch {}
    }
  }

  if (Object.keys(patch).length > 0) {
    try {
      return await api.updateUserSettings(patch);
    } catch (err) {
      console.error("Failed to seed initial local settings to server:", err);
      return null;
    }
  }

  return null;
}
