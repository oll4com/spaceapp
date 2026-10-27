import { describe, expect, it } from "vitest";
import { defaultUserSettings, SETUP_CATALOG, SETUP_CATALOG_VERSION, type SetupFeatureId } from "@space/contracts";
import { planSetupSettings, setupLiveDefaults, setupSelectionFromSettings } from "../src/setup-settings.js";

const minimal: SetupFeatureId[] = [
  "agent:opencode", "pane:chat", "dock:rooms", "dock:tasks", "dock:agent-files", "dock:settings"
];

describe("first setup preference application", () => {
  it("proposes legacy Custom tools without restoring hidden tools or losing enabled widgets", () => {
    const current = { ...defaultUserSettings, customDocksHidden: ["media"], docksHidden: ["media"],
      customPanesHidden: ["files", "databases"], panesHidden: ["files", "databases"],
      customCliDisabled: ["cli:codex"], desktopWidgets: { clock: { enabled: true }, "countdown-timer": { enabled: false } } };
    const selected = setupSelectionFromSettings(current);
    expect(selected).toContain("agent:opencode");
    expect(selected).toContain("dock:clipboard");
    expect(selected).toContain("pane:browser");
    expect(selected).toContain("widget:clock");
    expect(selected).not.toContain("dock:media");
    expect(selected).not.toContain("pane:files");
    expect(selected).not.toContain("pane:databases");
    expect(selected).not.toContain("agent:codex");
    expect(selected).not.toContain("widget:countdown-timer");
    expect(selected).not.toContain("utility:snip");
    expect(current.customPanesHidden).toEqual(["files", "databases"]);
  });

  it("projects legacy Max visibility while preserving the saved Custom choices", () => {
    const current = { ...defaultUserSettings, environmentPreset: "max" as const,
      customDocksHidden: ["media"], customPanesHidden: ["files"], customCliDisabled: ["cli:codex"],
      docksHidden: [], panesHidden: [] };
    const selected = setupSelectionFromSettings(current);
    expect(selected).toContain("dock:media");
    expect(selected).toContain("pane:files");
    expect(selected).toContain("agent:codex");
    expect(current.environmentPreset).toBe("max");
    expect(current.customCliDisabled).toEqual(["cli:codex"]);
  });

  it("hides unselected File Manager and Databases for Everyday Minimal while keeping theme", () => {
    const current = { ...defaultUserSettings, uiTheme: "codex" as const, terminalFontSize: 18 };
    const patch = planSetupSettings(minimal, current);
    expect(patch).toMatchObject({ environmentPreset: "custom" });
    expect(patch.customPanesHidden).toContain("files");
    expect(patch.customPanesHidden).toContain("databases");
    expect(patch.customDocksHidden).not.toContain("settings");
    expect(patch.customCliDisabled).not.toContain("cli:opencode");
    expect(patch.customCliDisabled).toContain("cli:codex");
    expect(patch.desktopWidgets?.clock).toMatchObject({ enabled: false });
    expect(patch).not.toHaveProperty("uiTheme");
    expect(patch).not.toHaveProperty("warmRoomEnabled");
  });

  it("enables only explicitly selected agents even with every workspace tool selected", () => {
    const full = SETUP_CATALOG.filter((feature) => feature.kind !== "agent").map((feature) => feature.id);
    const patch = planSetupSettings([...full, "agent:opencode", "agent:codex"], defaultUserSettings);
    expect(patch.customCliDisabled).not.toContain("cli:codex");
    expect(patch.customCliDisabled).toContain("cli:claude");
    expect(patch.customPanesHidden).not.toContain("databases");
    expect(patch.customPanesHidden).not.toContain("files");
    expect(patch.desktopWidgets?.clock).toMatchObject({ enabled: true });
  });

  it("preserves existing widget positions while changing only selected enablement", () => {
    const current = {
      ...defaultUserSettings,
      desktopWidgets: { clock: { id: "clock", x: 44, y: 88, enabled: true, custom: "retained" } }
    };
    const patch = planSetupSettings(minimal, current);
    expect(patch.desktopWidgets?.clock).toEqual({ id: "clock", x: 44, y: 88, enabled: false, custom: "retained" });
  });

  // Review 2026-10-21 #5: the tested Live connection becomes the normal Live default; nothing else of Live changes.
  it("makes the tested Live provider, model and voice the Live default only when Live is in the plan", () => {
    const draft = { id: "draft:1", ownerId: "user:owner", protocolVersion: 2 as const, revision: 3, persona: "creator" as const,
      level: "balanced" as const, requestedFeatureIds: [...minimal, "pane:live" as SetupFeatureId], catalogVersion: SETUP_CATALOG_VERSION,
      connectionChoices: [{ featureId: "pane:live" as SetupFeatureId, providerId: "google", modelId: "gemini-3.8-live", voiceId: "Aoede" }],
      updatedAt: "2026-10-21T00:00:00.000Z" };
    const plan = { draftId: "draft:1", draftRevision: 3, effectiveFeatureIds: [...minimal, "pane:live" as SetupFeatureId] };
    const live = setupLiveDefaults(draft, plan);
    expect(live).toEqual({ provider: "google", voiceModel: "gemini-3.8-live", voice: "Aoede" });
    expect(planSetupSettings(plan.effectiveFeatureIds, defaultUserSettings, live).livePane)
      .toEqual({ provider: "google", voiceModel: "gemini-3.8-live", voice: "Aoede" });
    expect(planSetupSettings(minimal, defaultUserSettings, live)).not.toHaveProperty("livePane");
    expect(setupLiveDefaults(draft, { ...plan, effectiveFeatureIds: minimal })).toBeNull();
    expect(setupLiveDefaults(draft, { ...plan, draftRevision: 2 })).toBeNull();
    expect(setupLiveDefaults({ ...draft, connectionChoices: [{ featureId: "pane:live" as SetupFeatureId, providerId: "nobody",
      modelId: "x", voiceId: "y" }] }, plan)).toBeNull();
  });
});
