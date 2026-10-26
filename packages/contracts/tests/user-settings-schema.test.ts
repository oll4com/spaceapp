import { describe, expect, it } from "vitest";
import { defaultUserSettings, updateUserSettingsInputSchema, userSettingsSchema } from "../src/schemas.js";
import { nousLowSpendSettingsSchema, nousSettingsInputSchema, nousSettingsSchema } from "../src/nous.js";

describe("userSettingsSchema & updateUserSettingsInputSchema", () => {
  it("defaults existing Nous JSON to automatic low-spend settings without a migration", () => {
    const legacy = nousSettingsSchema.parse({ enabled: true, lowTokenAutomatic: false });
    expect(legacy.lowSpend).toMatchObject({ mode: "AUTO", cheaperModel: true, minMaxAccountsWithRoom: 2, roomRemainingPercent: 10, lowBudgetRemainingPercent: 40,
      criticalBudgetRemainingPercent: 20, maxTurnsPerHour: 6, models: { inbox: { model: "claude-sonnet-5-5", effort: "medium" } },
      criticalModels: { inbox: { model: "claude-haiku-5-5", effort: "medium" }, standing: { model: "claude-haiku-5-5", effort: "medium" }, helper: { model: "claude-haiku-5-5", effort: "medium" } } });
    expect(nousSettingsInputSchema.parse({ maxTurnsPerHour: 5 })).not.toHaveProperty("lowSpend");
  });

  it("preserves an explicit cheaper-model opt-out without patching the configured models", () => {
    const lowSpend = nousLowSpendSettingsSchema.parse({ cheaperModel: false });
    const patch = nousSettingsInputSchema.parse({ lowSpend });
    expect(patch.lowSpend?.cheaperModel).toBe(false);
    expect(patch).not.toHaveProperty("models");
    expect(userSettingsSchema.parse({ nous: patch }).nous?.lowSpend.cheaperModel).toBe(false);
  });

  it("round-trips low-spend settings independently of normal models and rejects inverted thresholds", () => {
    for (const mode of ["AUTO", "ON", "OFF"] as const) {
      const lowSpend = nousLowSpendSettingsSchema.parse({ mode, maxTurnsPerHour: 4 });
      expect(nousSettingsInputSchema.parse({ lowSpend })).toEqual({ lowSpend });
      expect(userSettingsSchema.parse({ nous: { lowSpend } }).nous?.lowSpend).toEqual(lowSpend);
    }
    expect(nousLowSpendSettingsSchema.safeParse({ lowBudgetRemainingPercent: 10, criticalBudgetRemainingPercent: 20 }).success).toBe(false);
    expect(nousLowSpendSettingsSchema.safeParse({ roomRemainingPercent: 0 }).success).toBe(false);
  });

  it("round-trips CRITICAL models per kind and accepts only low or medium effort", () => {
    const lowSpend = nousLowSpendSettingsSchema.parse({ criticalModels: {
      inbox: { model: "claude-sonnet-5-5", effort: "low" }, standing: { model: "claude-fable-5-1", effort: "medium" }, helper: { model: "claude-opus-5-5", effort: "low" }
    } });
    const patch = nousSettingsInputSchema.parse({ lowSpend });
    expect(patch).toEqual({ lowSpend });
    expect(patch).not.toHaveProperty("models");
    expect(userSettingsSchema.parse({ nous: patch }).nous?.lowSpend.criticalModels).toEqual(lowSpend.criticalModels);
    for (const effort of ["high", "xhigh", "max"]) expect(nousLowSpendSettingsSchema.safeParse({ criticalModels: { inbox: { effort } } }).success).toBe(false);
    expect(nousLowSpendSettingsSchema.parse({ criticalModels: { inbox: { effort: "low" } } }).criticalModels.inbox).toEqual({ model: "claude-haiku-5-5", effort: "low" });
  });
  it("defaults have expected per-user cloud sync values", () => {
    expect(defaultUserSettings.docksHidden).toEqual([]);
    expect(defaultUserSettings.panesHidden).toEqual([]);
    expect(defaultUserSettings.roomsRailHidden).toBe(false);
    expect(defaultUserSettings.worktreeDefaultEnabled).toBe(true);
    expect(defaultUserSettings.uiZoom).toBe(100);
    expect(defaultUserSettings.upperRailOrder).toBeUndefined();
    expect(defaultUserSettings.upperRailHidden).toBeUndefined();
    expect(defaultUserSettings.lowerRailOrder).toBeUndefined();
    expect(defaultUserSettings.lowerRailHidden).toBeUndefined();
    expect(defaultUserSettings.createMenuOrder).toBeUndefined();
    expect(defaultUserSettings.roomExtraEmptySlots).toBeUndefined();
    expect(defaultUserSettings.roomWorktreeOverrides).toBeUndefined();
    expect(defaultUserSettings.projectPresets).toBeUndefined();
    expect(defaultUserSettings.stickyNotes).toBeUndefined();
    expect(defaultUserSettings.vibeMusicVolume).toBeUndefined();
    expect(defaultUserSettings.vibeMusicPlaylistLinkId).toBeUndefined();
    expect(defaultUserSettings.osk).toBeUndefined();
    expect(defaultUserSettings.accountFilters).toBeUndefined();
    expect(defaultUserSettings.promptVariables).toEqual([]);
    expect(defaultUserSettings.promptVariablesEnabled).toBe(true);
    expect(defaultUserSettings.promptVariablesAutoExpandOnSubmit).toBe(true);
  });

  it("accepts the Liquid Glass theme and its Glass Planet background", () => {
    const settings = userSettingsSchema.parse({ uiTheme: "liquid-glass", uiBackground: "liquid-glass" });
    expect([settings.uiTheme, settings.uiBackground]).toEqual(["liquid-glass", "liquid-glass"]);
    expect(updateUserSettingsInputSchema.parse({ uiTheme: "liquid-glass", uiBackground: "liquid-glass" })).toEqual({ uiTheme: "liquid-glass", uiBackground: "liquid-glass" });
  });

  it("accepts the Jarvis and Aira themes and their backgrounds", () => {
    for (const id of ["jarvis", "aira"] as const) {
      const settings = userSettingsSchema.parse({ uiTheme: id, uiBackground: id });
      expect([settings.uiTheme, settings.uiBackground]).toEqual([id, id]);
      expect(updateUserSettingsInputSchema.parse({ uiTheme: id, uiBackground: id })).toEqual({ uiTheme: id, uiBackground: id });
    }
  });

  it("keeps the Liquid Glass tint between ultra clear (0) and fully tinted (100), 50 by default", () => {
    expect(defaultUserSettings.liquidGlassTint).toBe(50);
    expect(updateUserSettingsInputSchema.parse({ liquidGlassTint: 0 }).liquidGlassTint).toBe(0);
    expect(updateUserSettingsInputSchema.parse({ liquidGlassTint: 100 }).liquidGlassTint).toBe(100);
    for (const tint of [-1, 101, 12.5]) expect(() => updateUserSettingsInputSchema.parse({ liquidGlassTint: tint })).toThrow();
  });

  it("validates full custom user settings object with all per-user fields", () => {
    const custom = {
      uiTheme: "codex",
      modernAppearance: "dark",
      modernIconPack: "material-rounded",
      uiBackground: "none",
      roomTheme: "ocean",
      terminalFontSize: 16,
      uiZoom: 125,
      showSessionDebugIds: true,
      cliDebugModeEnabled: true,
      cliFloatsHidden: true,
      sensitiveDataMasked: false,
      roomToolbarHidden: true,
      roomFocusMode: true,
      roomsRailHidden: true,
      docksHidden: ["tasks", "streaming"],
      panesHidden: ["vnc", "demos"],
      upperRailOrder: ["accounts", "memory"],
      upperRailHidden: ["cli"],
      lowerRailOrder: ["rooms", "create"],
      lowerRailHidden: ["sticky"],
      createMenuOrder: ["add-chat", "add-browser"],
      roomExtraEmptySlots: { "room-1": 2, "room-2": 4 },
      worktreeDefaultEnabled: false,
      roomWorktreeOverrides: { "room-1": true, "room-2": false },
      projectPresets: [{ label: "My Project", path: "/opt/spaceapp/projects/my-project" }],
      stickyNotes: [{ id: "sticky-1", text: "Test note", x: 100, y: 150, color: "yellow" }],
      vibeMusicVolume: 0.75,
      vibeMusicPlaylistLinkId: "link-123",
      desktopWidgets: { clock: { enabled: true, x: 50, y: 50 } },
      osk: { scale: 1.2, lang: "el" },
      accountFilters: { provider: "antigravity", quota: true }
    };

    const parsed = userSettingsSchema.parse(custom);
    expect(parsed.uiTheme).toBe("codex");
    expect(parsed.modernAppearance).toBe("dark");
    expect(parsed.uiZoom).toBe(125);
    expect(parsed.docksHidden).toEqual(["tasks", "streaming"]);
    expect(parsed.panesHidden).toEqual(["vnc", "demos"]);
    expect(parsed.roomsRailHidden).toBe(true);
    expect(parsed.worktreeDefaultEnabled).toBe(false);
    expect(parsed.roomExtraEmptySlots).toEqual({ "room-1": 2, "room-2": 4 });
    expect(parsed.roomWorktreeOverrides).toEqual({ "room-1": true, "room-2": false });
    expect(parsed.projectPresets).toEqual([{ label: "My Project", path: "/opt/spaceapp/projects/my-project" }]);
    expect(parsed.vibeMusicVolume).toBe(0.75);
    expect(parsed.vibeMusicPlaylistLinkId).toBe("link-123");
    expect(parsed.accountFilters).toEqual({ provider: "antigravity", quota: true });
  });

  it("validates partial updates in updateUserSettingsInputSchema", () => {
    const input = {
      uiZoom: 110,
      docksHidden: ["media"],
      panesHidden: ["chat"],
      vibeMusicVolume: 0.5,
      vibeMusicPlaylistLinkId: null,
      roomsRailHidden: true,
      worktreeDefaultEnabled: true,
      projectPresets: [{ label: "SpaceApp", path: "/opt/spaceapp" }],
      accountFilters: { gemini: true }
    };

    const parsed = updateUserSettingsInputSchema.parse(input);
    expect(parsed.uiZoom).toBe(110);
    expect(parsed.docksHidden).toEqual(["media"]);
    expect(parsed.vibeMusicPlaylistLinkId).toBeNull();
  });

  it("syncs Workspace Quick access pins and rejects oversized lists", () => {
    expect(defaultUserSettings.workspaceQuickActions).toBeUndefined();
    expect(userSettingsSchema.parse({ workspaceQuickActions: [] }).workspaceQuickActions).toEqual([]);
    expect(updateUserSettingsInputSchema.parse({ workspaceQuickActions: ["pane-layout", "surface-media"] }).workspaceQuickActions)
      .toEqual(["pane-layout", "surface-media"]);
    expect(() => updateUserSettingsInputSchema.parse({ workspaceQuickActions: Array.from({ length: 9 }, (_, i) => `a${i}`) })).toThrow();
  });

  it("validates promptVariables in userSettingsSchema and updateUserSettingsInputSchema", () => {
    const validVar = {
      id: "pv_thai",
      name: "pc_thai",
      label: "Thai Office PC",
      value: "Computer with IP 192.168.10.50 accessed via router RT-01",
      description: "Main development workstation in Thailand",
      category: "Network"
    };

    const update = updateUserSettingsInputSchema.parse({
      promptVariables: [validVar],
      promptVariablesEnabled: true,
      promptVariablesAutoExpandOnSubmit: false
    });
    expect(update.promptVariables).toHaveLength(1);
    expect(update.promptVariables?.[0]?.name).toBe("pc_thai");
    expect(update.promptVariablesAutoExpandOnSubmit).toBe(false);

    // Reject variable names with invalid characters (e.g. spaces)
    expect(() =>
      updateUserSettingsInputSchema.parse({
        promptVariables: [{ ...validVar, name: "invalid name with spaces" }]
      })
    ).toThrow();
  });

  it("syncs hidden CLI shortcuts with an empty default and rejects malformed ids", () => {
    expect(defaultUserSettings.voice.terminalHiddenShortcuts).toEqual([]);
    expect(userSettingsSchema.parse({ voice: { terminalTurnControl: false } }).voice.terminalHiddenShortcuts).toEqual([]);
    expect(updateUserSettingsInputSchema.parse({ voice: { terminalHiddenShortcuts: ["clear", "plan_progress"] } }).voice?.terminalHiddenShortcuts)
      .toEqual(["clear", "plan_progress"]);
    expect(() => updateUserSettingsInputSchema.parse({ voice: { terminalHiddenShortcuts: ["Bad Id"] } })).toThrow();
    expect(() => updateUserSettingsInputSchema.parse({ voice: { terminalHiddenShortcuts: Array.from({ length: 65 }, () => "clear") } })).toThrow();
  });
});
