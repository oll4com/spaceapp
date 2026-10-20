import { stat, statfs } from "node:fs/promises";
import { storageReadinessSchema, type StorageReadiness } from "@space/contracts";

// Launch storage check shared by installed and checkout-local source instances.
const storageMinimumRecommendedFreeBytes = 20 * 1024 * 1024 * 1024;

function usedPercent(sizeBytes: number, availableBytes: number): number {
  if (sizeBytes <= 0) return 0;
  return Math.round(((sizeBytes - availableBytes) / sizeBytes) * 1000) / 10;
}

async function collectStorageMount(targetPath: string) {
  const [fsStats, pathStats] = await Promise.all([statfs(targetPath), stat(targetPath)]);
  const sizeBytes = fsStats.blocks * fsStats.bsize;
  const availableBytes = fsStats.bavail * fsStats.bsize;
  return {
    path: targetPath,
    deviceId: String(pathStats.dev),
    sizeBytes,
    availableBytes,
    usedPercent: usedPercent(sizeBytes, availableBytes)
  };
}

/**
 * Evaluate storage readiness at the configured installation root, including source checkouts.
 * Default to the installed location for callers without a configured root.
 */
export async function collectStorageReadiness(installRoot = "/opt/spaceapp"): Promise<StorageReadiness> {
  const [root, app] = await Promise.all([collectStorageMount("/"), collectStorageMount(installRoot)]);
  const dedicatedAppVolume = root.deviceId !== app.deviceId;
  const freeSpaceBlocked = app.availableBytes < storageMinimumRecommendedFreeBytes;
  const rootWarn = root.usedPercent >= 80;
  const status = !dedicatedAppVolume || freeSpaceBlocked ? "BLOCKED" : rootWarn ? "WARN" : "VERIFIED";
  const statusReason = !dedicatedAppVolume
    ? "Dedicated application volume is not detected; production/browser-heavy launch requires isolated dedicated app storage with at least 20GB free."
    : freeSpaceBlocked
      ? "Dedicated application volume exists but available space is below the 20GB minimum recommendation."
      : rootWarn
        ? "Root filesystem is above the 80% warning threshold."
        : "Storage readiness meets the current Space launch thresholds.";

  return storageReadinessSchema.parse({
    id: "space-storage",
    status,
    statusReason,
    root,
    app,
    dedicatedAppVolume,
    minimumRecommendedFreeBytes: storageMinimumRecommendedFreeBytes,
    checkedAt: new Date().toISOString()
  });
}
