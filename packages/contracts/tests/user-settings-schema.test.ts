import { describe, expect, it } from "vitest";
import { defaultUserSettings, updateUserSettingsInputSchema, userSettingsSchema } from "../src/schemas.js";
import { NOUS_TURN_KINDS, nousModelMatchesProvider, nousProvider, nousSettingsWithProvider, nousLowSpendSettingsSchema, mergeNousSettings, nousSettingsInputSchema, nousSettingsSchema } from "../src/nous.js";

describe("userSettingsSchema & updateUserSettingsInputSchema", () => {
  it("uses Astra high for new choices while preserving saved Opus and inferring its provider", () => {
    const fresh = nousSettingsWithProvider(nousSettingsSchema.parse({}));
    expect(fresh.provider).toBe("codex");
    for (const kind of NOUS_TURN_KINDS) expect(fresh.models[kind]).toEqual({ model: "gpt-6-astra", effort: "high" });
    expect(fresh.lowSpend.models.inbox).toEqual({ model: "gpt-6.1-sol", effort: "medium" });
    const stored = nousSettingsSchema.parse({ models: { operator: { model: "claude-opus-5-5", effort: "xhigh" } } });
    expect(nousProvider(stored)).toBe("claude");
    expect(nousSettingsWithProvider(stored).models.operator).toEqual({ model: "claude-opus-5-5", effort: "xhigh" });
    expect(nousSettingsInputSchema.parse({ provider: "codex" })).toEqual({ provider: "codex" });
    expect(nousSettingsInputSchema.safeParse({ provider: "anything" }).success).toBe(false);
  });

  it("keeps Gemini and Claude low-spend choices on their own pools", () => {
    const gemini = nousSettingsWithProvider(nousSettingsSchema.parse({ provider: "gemini", models: { operator: { model: "gemini-4-argon", effort: "high" } } }));
    expect(gemini.models.operator).toEqual({ model: "gemini-4-argon", effort: "none" });
    expect(gemini.lowSpend.models.inbox).toEqual({ model: "gemini-3.8-flash-medium", effort: "none" });
    expect(gemini.lowSpend.criticalModels.helper).toEqual({ model: "gemini-3.8-flash-low", effort: "none" });
    const spaceWithGemini = nousSettingsWithProvider(nousSettingsSchema.parse({
      provider: "space",
      models: { operator: { model: "gemini:gemini-4-argon-high", effort: "high" } },
      lowSpend: {
        models: { inbox: { model: "gemini:gemini-4-argon-high", effort: "high" } },
        criticalModels: { inbox: { model: "gemini:gemini-4-argon-high", effort: "medium" } }
      }
    }));
    expect(spaceWithGemini.models.operator).toEqual({ model: "gemini:gemini-4-argon-high", effort: "none" });
    expect(spaceWithGemini.lowSpend.models.inbox).toEqual({ model: "gemini:gemini-4-argon-high", effort: "none" });
    expect(spaceWithGemini.lowSpend.criticalModels.inbox).toEqual({ model: "gemini:gemini-4-argon-high", effort: "none" });
    const claude = nousSettingsWithProvider(nousSettingsSchema.parse({ provider: "claude" }));
    expect(claude.lowSpend.criticalModels.inbox).toEqual({ model: "claude-haiku-5-5", effort: "medium" });
    expect(nousModelMatchesProvider("gemini-3.8-flash-high", "gemini")).toBe(true);
    expect(nousModelMatchesProvider("gpt-6-astra", "gemini")).toBe(false);
    expect(nousModelMatchesProvider("claude-opus-5-5", "claude")).toBe(true);
    expect(nousModelMatchesProvider("gpt-6-astra", "claude")).toBe(false);
  });

  it("defaults existing Nous JSON to automatic low-spend settings without a migration", () => {
    const legacy = nousSettingsSchema.parse({ enabled: true, lowTokenAutomatic: false });
    expect(legacy.lowSpend).toMatchObject({ mode: "AUTO", cheaperModel: true, minMaxAccountsWithRoom: 2, roomRemainingPercent: 10, lowBudgetRemainingPercent: 40,
      criticalBudgetRemainingPercent: 20, maxTurnsPerHour: 6, models: { inbox: { model: "claude-sonnet-5-5", effort: "medium" } },
      criticalModels: { inbox: { model: "claude-haiku-5-5", effort: "medium" }, standing: { model: "claude-haiku-5-5", effort: "medium" }, helper: { model: "claude-haiku-5-5", effort: "medium" } } });
    expect(nousSettingsInputSchema.parse({ maxTurnsPerHour: 5 })).not.toHaveProperty("lowSpend");
    // The Load target per spend mode (13/11): today's 90 in every mode until the operator sets it.
    expect(legacy.lowSpend.loadTargets).toEqual({ NORMAL: 90, LOW: 90, CRITICAL: 90 });
  });

  it("saves the Load target per spend mode, 0-100, and a lowSpend PATCH without it keeps it", () => {
    const before = nousSettingsSchema.parse({ lowSpend: { loadTargets: { NORMAL: 80, LOW: 60, CRITICAL: 0 } } });
    expect(mergeNousSettings(before, nousSettingsInputSchema.parse({ lowSpend: { maxTurnsPerHour: 3 } })).lowSpend.loadTargets).toEqual({ NORMAL: 80, LOW: 60, CRITICAL: 0 });
    expect(mergeNousSettings(before, nousSettingsInputSchema.parse({ lowSpend: { loadTargets: { NORMAL: 85, LOW: 60, CRITICAL: 0 } } })).lowSpend.loadTargets.NORMAL).toBe(85);
    expect(nousSettingsSchema.safeParse({ lowSpend: { loadTargets: { NORMAL: 101 } } }).success).toBe(false);
    expect(nousSettingsSchema.safeParse({ lowSpend: { loadTargets: { LOW: -1 } } }).success).toBe(false);
  });

  it("keeps legacy dock tabs on, saves explicit choices and never accepts a Conversation switch", () => {
    expect(nousSettingsSchema.parse({})).not.toHaveProperty("dockTabs");
    expect(nousSettingsInputSchema.parse({ maxTurnsPerHour: 5 })).not.toHaveProperty("dockTabs");
    const dockTabs = { done: false, quotas: true };
    expect(nousSettingsInputSchema.parse({ dockTabs })).toEqual({ dockTabs });
    expect(userSettingsSchema.parse({ nous: { dockTabs } }).nous?.dockTabs).toEqual(dockTabs);
    // The Nous app's appointments and signature tabs (nous_msg:b4fb6958): its Tabs switches no longer get a 422.
    const appTabs = { appointments: false, signature: true };
    expect(nousSettingsInputSchema.parse({ dockTabs: appTabs })).toEqual({ dockTabs: appTabs });
    expect(nousSettingsInputSchema.safeParse({ dockTabs: { appointments: "off" } }).success).toBe(false);
    expect(nousSettingsInputSchema.safeParse({ dockTabs: { conversation: false } }).success).toBe(false);
    expect(nousSettingsInputSchema.safeParse({ dockTabs: { done: "off" } }).success).toBe(false);
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

  it("keeps the CLI panes' right-click menu choice the web sends (terminalContextMenu)", () => {
    expect(defaultUserSettings.voice.terminalContextMenu).toBe(true);
    expect(userSettingsSchema.parse({ voice: { terminalContextMenu: false } }).voice.terminalContextMenu).toBe(false);
    expect(updateUserSettingsInputSchema.parse({ voice: { terminalContextMenu: false } }).voice).toEqual({ terminalContextMenu: false });
  });
});
