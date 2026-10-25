import { beforeEach, describe, expect, it, vi } from "vitest";
import { installSpaceRuntime, type SpaceRuntime } from "../src/runtime/SpaceRuntime.js";
import {
  defaultDateTimeSettings,
  DATE_TIME_SETTINGS_STORAGE_KEY,
  DATE_TIME_SETTINGS_UPDATED_EVENT,
  readDateTimeSettings,
  writeDateTimeSettings,
  applyServerDateTimeSettings
} from "../src/features/date-time-settings/date-time-settings.js";
import {
  defaultVoiceComposerSettings,
  VOICE_SETTINGS_STORAGE_KEY,
  VOICE_SETTINGS_UPDATED_EVENT,
  readVoiceComposerSettings,
  writeVoiceComposerSettings,
  applyServerVoiceSettings
} from "../src/voice-settings.js";
import {
  defaultKeyboardAutocorrectSettings,
  KEYBOARD_AUTOCORRECT_SETTINGS_STORAGE_KEY,
  KEYBOARD_AUTOCORRECT_SETTINGS_UPDATED_EVENT,
  readKeyboardAutocorrectSettings,
  writeKeyboardAutocorrectSettings,
  applyServerKeyboardAutocorrectSettings
} from "../src/features/keyboard-autocorrect/keyboard-autocorrect-settings.js";
import {
  SUPPRESS_NOTIFICATIONS_STORAGE_KEY,
  readStoredSuppressNotifications,
  writeStoredSuppressNotifications,
  applyServerSuppressNotifications
} from "../src/notifications-settings.js";
import {
  WARM_ROOM_ENABLED_STORAGE_KEY,
  WARM_ROOM_CONNECTED_PANE_LIMIT_STORAGE_KEY,
  readStoredWarmRoomEnabled,
  writeStoredWarmRoomEnabled,
  readStoredWarmRoomConnectedPaneLimit,
  writeStoredWarmRoomConnectedPaneLimit,
  applyServerWarmRoomEnabled,
  applyServerWarmRoomConnectedPaneLimit
} from "../src/warm-room-settings.js";
import {
  applyServerLivePaneSettings,
  saveLivePaneConfig,
  loadLivePaneConfig
} from "../src/features/live-pane/live-pane-config.js";
import {
  CLI_IMAGE_PREVIEW_LIMIT_STORAGE_KEY,
  readStoredCliImagePreviewLimit,
  writeStoredCliImagePreviewLimit,
  applyServerCliImagePreviewLimit
} from "../src/cli-upload-settings.js";
import type { UpdateUserSettingsInput, UserSettings } from "@space/contracts";
import {
  syncFromServer,
  seedInitialLocalSettingsToServer,
  saveUserSettingDebounced,
  saveUserSettingImmediate
} from "../src/features/user-settings/user-settings-manager.js";

describe("User settings client persistence & server sync", () => {
  let mockUpdateUserSettings: ReturnType<typeof vi.fn>;
  let mockGetUserSettings: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    mockUpdateUserSettings = vi.fn(async (input: UpdateUserSettingsInput) => ({ ...input } as UserSettings));
    mockGetUserSettings = vi.fn(async () => ({} as UserSettings));

    const mockRuntime: Partial<SpaceRuntime> = {
      kind: "live",
      api: {
        updateUserSettings: mockUpdateUserSettings,
        userSettings: mockGetUserSettings,
      } as unknown as SpaceRuntime["api"],
      platform: {
        localStorage,
        sessionStorage,
        clipboard: null,
        userMediaSupported: false,
        peerConnectionSupported: false,
        displayMediaSupported: false,
        resolveExternalResource: () => null,
        fetch: vi.fn(),
        openLink: () => null,
        print: () => {},
        reloadPage: () => {},
        getUserMedia: vi.fn(),
        createPeerConnection: vi.fn(),
        getDisplayMedia: vi.fn(),
        createAudio: () => document.createElement("audio")
      }
    };
    installSpaceRuntime(mockRuntime as SpaceRuntime);
  });

  it("syncs date & time settings to server and updates local cache", async () => {
    writeDateTimeSettings({ timeZone: "Europe/Athens", timeFormat: "12h" });

    expect(mockUpdateUserSettings).toHaveBeenCalledWith({
      dateTime: { timeZone: "Europe/Athens", timeFormat: "12h" }
    });

    const stored = readDateTimeSettings();
    expect(stored.timeZone).toBe("Europe/Athens");
    expect(stored.timeFormat).toBe("12h");
  });

  it("applies server date & time settings to local cache and dispatches event", () => {
    const listener = vi.fn();
    window.addEventListener(DATE_TIME_SETTINGS_UPDATED_EVENT, listener);

    applyServerDateTimeSettings({ timeZone: "Asia/Tokyo", timeFormat: "24h" });

    const stored = readDateTimeSettings();
    expect(stored.timeZone).toBe("Asia/Tokyo");
    expect(stored.timeFormat).toBe("24h");
    expect(listener).toHaveBeenCalled();

    window.removeEventListener(DATE_TIME_SETTINGS_UPDATED_EVENT, listener);
  });

  it("syncs voice composer settings to server and updates local cache", () => {
    writeVoiceComposerSettings({
      ...defaultVoiceComposerSettings,
      model: "gemini-3.8-live",
      voice: "Fenrir"
    });

    expect(mockUpdateUserSettings).toHaveBeenCalledWith({
      voice: expect.objectContaining({
        model: "gemini-3.8-live",
        voice: "Fenrir"
      })
    });
  });

  it("applies server voice composer settings to local cache and dispatches event", () => {
    const listener = vi.fn();
    window.addEventListener(VOICE_SETTINGS_UPDATED_EVENT, listener);

    applyServerVoiceSettings({
      ...defaultVoiceComposerSettings,
      model: "gemini-3.8-live",
      voice: "Kore"
    });

    const stored = readVoiceComposerSettings();
    expect(stored.voice).toBe("Kore");
    expect(listener).toHaveBeenCalled();

    window.removeEventListener(VOICE_SETTINGS_UPDATED_EVENT, listener);
  });

  it("syncs keyboard autocorrect settings to server and updates local cache", () => {
    writeKeyboardAutocorrectSettings({
      ...defaultKeyboardAutocorrectSettings,
      soundEnabled: false
    });

    expect(mockUpdateUserSettings).toHaveBeenCalledWith({
      keyboardAutocorrect: expect.objectContaining({
        soundEnabled: false
      })
    });
  });

  it("applies server keyboard autocorrect settings to local cache and dispatches event", () => {
    const listener = vi.fn();
    window.addEventListener(KEYBOARD_AUTOCORRECT_SETTINGS_UPDATED_EVENT, listener);

    applyServerKeyboardAutocorrectSettings({
      ...defaultKeyboardAutocorrectSettings,
      enabled: false
    });

    const stored = readKeyboardAutocorrectSettings();
    expect(stored.enabled).toBe(false);
    expect(listener).toHaveBeenCalled();

    window.removeEventListener(KEYBOARD_AUTOCORRECT_SETTINGS_UPDATED_EVENT, listener);
  });

  it("syncs notification suppression to server and applies server state", () => {
    writeStoredSuppressNotifications(true);
    expect(mockUpdateUserSettings).toHaveBeenCalledWith({ suppressNotifications: true });
    expect(readStoredSuppressNotifications()).toBe(true);

    applyServerSuppressNotifications(false);
    expect(readStoredSuppressNotifications()).toBe(false);
  });

  it("syncs warm room settings to server and applies server state", () => {
    writeStoredWarmRoomEnabled(false);
    expect(mockUpdateUserSettings).toHaveBeenCalledWith({ warmRoomEnabled: false });
    expect(readStoredWarmRoomEnabled()).toBe(false);

    writeStoredWarmRoomConnectedPaneLimit(48);
    expect(mockUpdateUserSettings).toHaveBeenCalledWith({ warmRoomConnectedPaneLimit: 48 });
    expect(readStoredWarmRoomConnectedPaneLimit()).toBe(48);

    applyServerWarmRoomEnabled(true);
    expect(readStoredWarmRoomEnabled()).toBe(true);

    applyServerWarmRoomConnectedPaneLimit(96);
    expect(readStoredWarmRoomConnectedPaneLimit()).toBe(96);
  });

  it("syncs cli image preview limit to server and applies server state", () => {
    writeStoredCliImagePreviewLimit(8);
    expect(mockUpdateUserSettings).toHaveBeenCalledWith({ cliImagePreviewLimit: 8 });
    expect(readStoredCliImagePreviewLimit()).toBe(8);

    applyServerCliImagePreviewLimit(16);
    expect(readStoredCliImagePreviewLimit()).toBe(16);
  });

  it("syncs live pane settings to server user settings and applies server state", async () => {
    vi.useFakeTimers();
    try {
      saveLivePaneConfig("pane_test_1", {
        provider: "openai",
        voiceModel: "gpt-live-1",
        voice: "coral",
        language: "el"
      }, true);

      vi.advanceTimersByTime(500);

      expect(mockUpdateUserSettings).toHaveBeenCalledWith(expect.objectContaining({
        livePane: expect.objectContaining({
          provider: "openai",
          voiceModel: "gpt-live-1",
          voice: "coral",
          language: "el"
        }),
        voice: expect.objectContaining({
          provider: "openai",
          model: "gpt-live-1",
          voice: "coral",
          language: "el"
        })
      }));

      applyServerLivePaneSettings({
        voiceModel: "gpt-live-1-mini",
        voice: "sage"
      });

      const loaded = loadLivePaneConfig("pane_new");
      expect(loaded.voiceModel).toBe("gpt-live-1-mini");
      expect(loaded.voice).toBe("sage");
    } finally {
      vi.useRealTimers();
    }
  });

  describe("user-settings-manager: syncFromServer & seedInitialLocalSettingsToServer", () => {
    it("applies server settings to localStorage via syncFromServer", () => {
      const serverSettings: Partial<UserSettings> = {
        panesHidden: ["chat", "browser"],
        docksHidden: ["media", "clipboard"],
        uiZoom: 125,
        terminalFontSize: 16,
        showSessionDebugIds: false,
        cliDebugModeEnabled: true,
        cliFloatsHidden: true,
        sensitiveDataMasked: true,
        roomToolbarHidden: true,
        roomFocusMode: true,
        roomsRailHidden: true,
        worktreeDefaultEnabled: false,
        roomWorktreeOverrides: { room1: false, room2: true },
        projectPresets: [{ label: "test", path: "/opt/spaceapp/projects/test" }],
        roomExtraEmptySlots: { room1: 2 },
        desktopWidgets: { widget1: { x: 10, y: 20 } },
        stickyNotes: [{ id: "n1", text: "hello" }],
        vibeMusicVolume: 0.75,
        vibeMusicPlaylistLinkId: "link-123",
        osk: { scale: 1.2, lang: "el" },
        accountFilters: { provider: "anthropic", quota: true }
      };

      const result = syncFromServer(serverSettings, localStorage, "user-test");
      expect(result.themeChanged).toBe(false);

      expect(JSON.parse(localStorage.getItem("space:panes-hidden:v1")!)).toEqual(["chat", "browser"]);
      expect(JSON.parse(localStorage.getItem("space:docks-hidden:v1")!)).toEqual(["media", "clipboard"]);
      expect(localStorage.getItem("space.ui.zoom.v1")).toBe("125");
      expect(localStorage.getItem("space.terminal.fontSize")).toBe("16");
      expect(localStorage.getItem("space.showSessionDebugIds")).toBe("false");
      expect(localStorage.getItem("space.cliDebugMode")).toBe("true");
      expect(localStorage.getItem("space.cliFloatsHidden")).toBe("true");
      expect(localStorage.getItem("space.sensitiveDataMasked")).toBe("true");
      expect(localStorage.getItem("space.roomToolbarHidden")).toBe("true");
      expect(localStorage.getItem("space.roomFocusMode")).toBe("true");
      expect(localStorage.getItem("space.roomsRailHidden")).toBe("true");
      expect(localStorage.getItem("space.worktree.defaultEnabled")).toBe("false");
      expect(localStorage.getItem("space.room.room1.isolatedWorktree")).toBe("false");
      expect(localStorage.getItem("space.room.room2.isolatedWorktree")).toBe("true");
      expect(JSON.parse(localStorage.getItem("space:project_presets")!)).toEqual([
        { label: "test", path: "/opt/spaceapp/projects/test" }
      ]);
      expect(JSON.parse(localStorage.getItem("space.room-extra-empty-slots")!)).toEqual({ room1: 2 });
      expect(JSON.parse(localStorage.getItem("space.desktop-widgets.state.v1")!)).toEqual({
        widget1: { x: 10, y: 20 }
      });
      expect(JSON.parse(localStorage.getItem("space.sticky-notes.windows.v1")!)).toEqual([
        { id: "n1", text: "hello" }
      ]);
      expect(localStorage.getItem("space.vibeMusic.volume")).toBe("0.75");
      expect(localStorage.getItem("space:vibe-music:playlist-link")).toBe("link-123");
      expect(localStorage.getItem("space.osk.scale.v1")).toBe("1.2");
      expect(localStorage.getItem("space.osk.lang.v1")).toBe("el");
      expect(localStorage.getItem("space:health-accounts:provider-filter")).toBe("anthropic");
      expect(localStorage.getItem("space:health-accounts:quota-filter")).toBe("true");
    });

    it("seeds initial local browser settings to server when server has defaults", async () => {
      localStorage.setItem("space:panes-hidden:v1", JSON.stringify(["chat"]));
      localStorage.setItem("space:docks-hidden:v1", JSON.stringify(["media"]));
      localStorage.setItem("space.terminal.fontSize", "18");
      localStorage.setItem("space.ui.zoom.v1", "120");
      localStorage.setItem("space.worktree.defaultEnabled", "false");
      localStorage.setItem("space.roomsRailHidden", "true");
      localStorage.setItem("space.room.custom-room.isolatedWorktree", "false");
      localStorage.setItem("space:project_presets", JSON.stringify([{ label: "seeded", path: "/opt/spaceapp/projects/seeded" }]));
      localStorage.setItem("space.vibeMusic.volume", "0.5");

      const serverSettingsWithDefaults: Partial<UserSettings> = {
        panesHidden: [],
        docksHidden: [],
        terminalFontSize: 13,
        uiZoom: 100,
        worktreeDefaultEnabled: true,
        roomsRailHidden: false,
        cliFloatsHidden: false,
        sensitiveDataMasked: false,
        roomToolbarHidden: false,
        roomFocusMode: false
      };

      const result = await seedInitialLocalSettingsToServer(
        { updateUserSettings: mockUpdateUserSettings as any },
        serverSettingsWithDefaults,
        localStorage
      );

      expect(mockUpdateUserSettings).toHaveBeenCalledWith(expect.objectContaining({
        panesHidden: ["chat"],
        docksHidden: ["media"],
        terminalFontSize: 18,
        uiZoom: 120,
        worktreeDefaultEnabled: false,
        roomsRailHidden: true,
        roomWorktreeOverrides: { "custom-room": false },
        projectPresets: [{ label: "seeded", path: "/opt/spaceapp/projects/seeded" }],
        vibeMusicVolume: 0.5
      }));
      expect(result).toBeDefined();
    });

    it("applies the account's Liquid Glass tint live, without a theme reload", () => {
      const result = syncFromServer({ liquidGlassTint: 20 }, localStorage, "user-test");
      expect(result.themeChanged).toBe(false);
      expect(localStorage.getItem("space.liquidGlass.tint.v1")).toBe("20");
      expect(document.documentElement.style.getPropertyValue("--lg-tint")).toBe("20");
    });

    it("syncs Workspace Quick access pins, keeping an empty list as a deliberate choice", async () => {
      syncFromServer({ workspaceQuickActions: ["surface-media", "pane-layout"] }, localStorage, "user-test");
      expect(JSON.parse(localStorage.getItem("space:workspace-quick-actions:v1")!)).toEqual(["surface-media", "pane-layout"]);
      syncFromServer({ workspaceQuickActions: [] }, localStorage, "user-test");
      expect(JSON.parse(localStorage.getItem("space:workspace-quick-actions:v1")!)).toEqual([]);

      await seedInitialLocalSettingsToServer({ updateUserSettings: mockUpdateUserSettings as any }, {}, localStorage);
      expect(mockUpdateUserSettings).toHaveBeenCalledWith(expect.objectContaining({ workspaceQuickActions: [] }));
      mockUpdateUserSettings.mockClear();
      await seedInitialLocalSettingsToServer({ updateUserSettings: mockUpdateUserSettings as any }, { workspaceQuickActions: ["help"] }, localStorage);
      expect(mockUpdateUserSettings.mock.calls.some(([input]) => "workspaceQuickActions" in (input as object))).toBe(false);
    });

    it("does not overwrite server custom values during local seeding", async () => {
      // Client has 18, but server already has custom 15 (not the default 13)
      localStorage.setItem("space.terminal.fontSize", "18");
      localStorage.setItem("space.panesHidden", JSON.stringify(["client-pane"]));

      const serverSettingsWithExistingCustom: Partial<UserSettings> = {
        terminalFontSize: 15,
        panesHidden: ["server-pane"]
      };

      await seedInitialLocalSettingsToServer(
        { updateUserSettings: mockUpdateUserSettings as any },
        serverSettingsWithExistingCustom,
        localStorage
      );

      // Should not include terminalFontSize or panesHidden since server already has custom data
      expect(mockUpdateUserSettings).not.toHaveBeenCalled();
    });

    it("debounces and flushes user setting updates to the server", async () => {
      vi.useFakeTimers();
      try {
        saveUserSettingDebounced("terminalFontSize", 15, 100);
        saveUserSettingDebounced("showSessionDebugIds", true, 100);

        // Before timer expires, updateUserSettings is not called yet
        expect(mockUpdateUserSettings).not.toHaveBeenCalled();

        vi.advanceTimersByTime(150);
        await Promise.resolve();

        expect(mockUpdateUserSettings).toHaveBeenCalledWith({
          terminalFontSize: 15,
          showSessionDebugIds: true
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("immediately flushes user setting update via saveUserSettingImmediate", async () => {
      await saveUserSettingImmediate("cliDebugModeEnabled", true);

      expect(mockUpdateUserSettings).toHaveBeenCalledWith({
        cliDebugModeEnabled: true
      });
    });
  });
});
