import type { UpdateUserSettingsInput } from "@space/contracts";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";

// Leaf module: feature stores (docks, panes, prompt variables) persist through
// this queue without importing the settings manager that applies server state
// back into them, which would form a dependency cycle.
let pendingPatch: UpdateUserSettingsInput = {};
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
// A cut or refused write is tried again this many times (a newer value of a key wins); otherwise the next load brought back the server's old copy.
const RETRY_DELAYS_MS = [1_000, 5_000, 20_000];
let failures = 0;

export async function flushPendingUserSettings(): Promise<void> {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  const patchToSend = { ...pendingPatch };
  pendingPatch = {};
  if (Object.keys(patchToSend).length === 0) return;
  try {
    const runtime = getSpaceRuntime();
    if (runtime?.api?.updateUserSettings) {
      await runtime.api.updateUserSettings(patchToSend);
    }
    failures = 0;
  } catch (err) {
    console.error("Failed to sync user settings to server:", err);
    const delayMs = RETRY_DELAYS_MS[failures];
    if (delayMs === undefined) {
      failures = 0;
      return;
    }
    failures += 1;
    pendingPatch = { ...patchToSend, ...pendingPatch };
    if (debounceTimer === null) {
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void flushPendingUserSettings();
      }, delayMs);
    }
  }
}

export function saveUserSettingDebounced<K extends keyof UpdateUserSettingsInput>(
  key: K,
  value: UpdateUserSettingsInput[K],
  delayMs = 250
): void {
  pendingPatch[key] = value;
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void flushPendingUserSettings();
  }, delayMs);
}

export async function saveUserSettingImmediate<K extends keyof UpdateUserSettingsInput>(
  key: K,
  value: UpdateUserSettingsInput[K]
): Promise<void> {
  pendingPatch[key] = value;
  await flushPendingUserSettings();
}
