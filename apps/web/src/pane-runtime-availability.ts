import type { CliRuntimeSettingsResponse, Pane, Room } from "@space/contracts";

/** Why the API would reject updates to this pane (its runtime is switched off in Settings), or null. */
export function paneRuntimeBlockedReason(pane: Pane, settings: CliRuntimeSettingsResponse | null): string | null {
  if (!settings) return null;
  if (pane.mode === "HARNESS") {
    const harness = settings.harness;
    return harness && (!harness.enabled || harness.effectiveMode === "BLOCKED") ? "Enable DeepSeek Harness in Settings" : null;
  }
  if (pane.mode !== "TERMINAL") return null;
  const runtimeId = pane.terminalRuntimeId ?? "cli:codex";
  if (settings.settings.find((entry) => entry.runtimeId === runtimeId)?.enabled !== false) return null;
  const name = settings.runtimes.find((runtime) => runtime.id === runtimeId)?.displayName ?? runtimeId;
  return `Enable ${name} in Settings`;
}

export function roomPaneLimit(room: Room | null | undefined): number {
  return Math.min(16, room?.paneCap ?? 16);
}
