import { cliAccountProfileRuntimeIds } from "@space/contracts";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";

/** CLIs with account profiles: their panes pick an account ("main", a named profile or the Space Gateway pool). */
export function hasCliAccountProfiles(runtimeId: string | null | undefined): boolean {
  return Boolean(runtimeId) && (cliAccountProfileRuntimeIds as readonly string[]).includes(runtimeId!);
}

// Gemini kept its first key; every other CLI uses space.cli.<cli>.account-profile.
function storageKey(runtimeId: string): string {
  return runtimeId === "cli:gemini" ? "space.gemini.lastAccountProfileId" : `space.cli.${runtimeId.replace(/^cli:/, "")}.account-profile`;
}

/** The account this device last picked for a CLI's panes ("main" when none). */
export function readLastCliAccountProfileId(runtimeId: string): string {
  try {
    return getSpaceRuntime().platform.localStorage.getItem(storageKey(runtimeId)) || "main";
  } catch {
    return "main";
  }
}

export function writeLastCliAccountProfileId(runtimeId: string, profileId: string): void {
  try {
    getSpaceRuntime().platform.localStorage.setItem(storageKey(runtimeId), profileId);
  } catch {
    // Preference storage is optional.
  }
}

// The account a pane was opened for (the Job Copilot launch); its CLI takes it once, on its first start.
const newPaneAccounts = new Map<string, { runtimeId: string; profileId: string }>();

export function rememberNewPaneAccount(paneIds: readonly string[], runtimeId: string, profileId: string): void {
  for (const paneId of paneIds) newPaneAccounts.set(paneId, { runtimeId, profileId });
}

export function takeNewPaneAccount(paneId: string, runtimeId: string): string | null {
  const entry = newPaneAccounts.get(paneId);
  newPaneAccounts.delete(paneId);
  return entry?.runtimeId === runtimeId ? entry.profileId : null;
}
