import { stat, statfs } from "node:fs/promises";
import { storageReadinessSchema, type StorageReadiness } from "@space/contracts";

// The launch storage check of /readyz (moved out of the composition root): a dedicated /opt/spaceapp volume with 20 GB free.
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

export async function collectStorageReadiness(): Promise<StorageReadiness> {
  const [root, app] = await Promise.all([collectStorageMount("/"), collectStorageMount("/opt/spaceapp")]);
  const dedicatedAppVolume = root.deviceId !== app.deviceId;
  const freeSpaceBlocked = app.availableBytes < storageMinimumRecommendedFreeBytes;
  const rootWarn = root.usedPercent >= 80;
  const status = !dedicatedAppVolume || freeSpaceBlocked ? "BLOCKED" : rootWarn ? "WARN" : "VERIFIED";
  const statusReason = !dedicatedAppVolume
    ? "Dedicated /opt/spaceapp volume is not detected; production/browser-heavy launch requires isolated dedicated app storage with at least 20GB free."
    : freeSpaceBlocked
      ? "Dedicated /opt/spaceapp volume exists but available space is below the 20GB minimum recommendation."
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
