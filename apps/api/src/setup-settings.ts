import {
  SETUP_CATALOG, isLiveAudioProviderId, type LiveAudioProviderId, type SetupDraft, type SetupFeatureId, type SetupPlan,
  type UpdateUserSettingsInput, type UserSettings
} from "@space/contracts";

/** Mirrors the current Space dock, pane and widget registries. Keep these IDs under test with the UI registries. */
const dockIds = [
  "rooms", "room-agent", "shared-chat", "media", "agent-files", "clipboard", "tasks",
  "links", "cli", "agent-sessions", "source-control", "settings", "streaming"
] as const;
const paneIds = ["chat", "browser", "files", "databases", "demos", "youtube", "vnc", "live", "harness"] as const;
const widgetIds = [
  "clock", "countdown-timer", "pushup-reminder", "spaceapp-promo",
  "ai-quota", "streaming-metrics"
] as const;
const agentIds = SETUP_CATALOG.filter((feature) => feature.kind === "agent")
  .map((feature) => feature.settingsBinding?.id)
  .filter((id): id is string => typeof id === "string");

export type SetupLiveDefaults = { provider: LiveAudioProviderId; voiceModel: string; voice: string };

/**
 * The Live connection the plan's draft chose and the audio check tested (review 2026-10-21 #5). Finishing makes it the
 * normal Live default, so a new Live pane starts on the tested provider, model and voice. Null without Live in the plan
 * or when the draft is not the one the plan was made from.
 */
export function setupLiveDefaults(
  draft: SetupDraft | null | undefined, plan: Pick<SetupPlan, "draftId" | "draftRevision" | "effectiveFeatureIds">
): SetupLiveDefaults | null {
  if (!draft || draft.id !== plan.draftId || draft.revision !== plan.draftRevision || !plan.effectiveFeatureIds.includes("pane:live")) return null;
  const choice = draft.connectionChoices.find((item) => item.featureId === "pane:live");
  if (!isLiveAudioProviderId(choice?.providerId) || !choice.modelId || !choice.voiceId) return null;
  return { provider: choice.providerId, voiceModel: choice.modelId, voice: choice.voiceId };
}

export function planSetupSettings(
  effectiveFeatureIds: readonly SetupFeatureId[], current: UserSettings, live: SetupLiveDefaults | null = null
): UpdateUserSettingsInput {
  const selected = new Set(effectiveFeatureIds);
  const hiddenDocks = dockIds.filter((id) => id !== "settings" && !selected.has(`dock:${id}`));
  const hiddenPanes = paneIds.filter((id) => !selected.has(`pane:${id}`));
  const disabledAgents = agentIds.filter((id) => !selected.has(`agent:${id.slice(4)}`));
  const widgets: Record<string, unknown> = { ...current.desktopWidgets };
  for (const id of widgetIds) {
    const before = widgets[id];
    const existing = before && typeof before === "object" && !Array.isArray(before)
      ? before as Record<string, unknown> : {};
    widgets[id] = { ...existing, id, enabled: selected.has(`widget:${id}`) };
  }
  return {
    environmentPreset: "custom",
    customDocksHidden: hiddenDocks,
    customPanesHidden: hiddenPanes,
    customCliDisabled: disabledAgents,
    docksHidden: hiddenDocks,
    panesHidden: hiddenPanes,
    desktopWidgets: widgets,
    // Only the tested three; the store merges them into the saved Live settings, so every other Live preference stays.
    ...(live && effectiveFeatureIds.includes("pane:live") ? { livePane: { ...live } } : {})
  };
}

/** Propose legacy choices without changing any saved preference or inventing utility enablement. */
export function setupSelectionFromSettings(current: UserSettings): SetupFeatureId[] {
  return SETUP_CATALOG.filter((feature) => {
    if (feature.requiredForFirstSetup) return true;
    const binding = feature.settingsBinding;
    if (!binding) return false;
    if (binding.kind === "dock") return !current.docksHidden.includes(binding.id);
    if (binding.kind === "pane") return !current.panesHidden.includes(binding.id);
    if (binding.kind === "agent") return current.environmentPreset === "max" || !current.customCliDisabled.includes(binding.id);
    const widget = current.desktopWidgets?.[binding.id];
    return Boolean(widget && typeof widget === "object" && "enabled" in widget && widget.enabled === true);
  }).map((feature) => feature.id);
}
