import { api } from "../../api.js";
import type { AppVersionStatus } from "../../live-api.js";

export const APP_VERSION_POLL_INTERVAL_MS = 5 * 60 * 1000;

export function isUpdateAvailable(status: AppVersionStatus | null): boolean {
  return Boolean(status?.updateAvailable);
}

export function versionLabel(status: AppVersionStatus | null): string {
  return status?.appRelease ?? "…";
}

export async function fetchAppVersion(): Promise<AppVersionStatus | null> {
  try {
    return await api.appVersion();
  } catch {
    return null;
  }
}