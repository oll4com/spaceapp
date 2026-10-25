import { statfs, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { DiskStats } from "@space/contracts";
import { WORKSPACE_ROOT } from "./files-service.js";

export const CACHE_DIR = path.join(process.env.SPACE_VAR_DIR || "/opt/spaceapp/var", "cache");
export const FILES_CACHE_FILE = path.join(CACHE_DIR, "files-disk-cache.json");

export interface FilesCacheData {
  disk: DiskStats;
  lastUpdated: string;
}

let memoryCache: FilesCacheData | null = null;
let isRefreshing = false;

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

export async function calculateDiskStats(targetPath: string = WORKSPACE_ROOT): Promise<DiskStats> {
  const stats = await statfs(targetPath);
  const totalBytes = Number(stats.blocks) * Number(stats.bsize);
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  const usedPercent = totalBytes > 0 ? Math.min(100, Math.round((usedBytes / totalBytes) * 100)) : 0;

  return {
    totalBytes,
    usedBytes,
    freeBytes,
    usedPercent,
    totalFormatted: formatBytes(totalBytes),
    usedFormatted: formatBytes(usedBytes),
    freeFormatted: formatBytes(freeBytes),
    updatedAt: new Date().toISOString()
  };
}

export async function refreshDiskCache(): Promise<FilesCacheData> {
  if (isRefreshing && memoryCache) {
    return memoryCache;
  }
  isRefreshing = true;
  try {
    const disk = await calculateDiskStats(WORKSPACE_ROOT);

    const cacheData: FilesCacheData = {
      disk,
      lastUpdated: new Date().toISOString()
    };

    memoryCache = cacheData;

    try {
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(FILES_CACHE_FILE, JSON.stringify(cacheData, null, 2), "utf-8");
    } catch {
      // Ignore disk write failure, memoryCache is populated
    }

    return cacheData;
  } finally {
    isRefreshing = false;
  }
}

export const refreshDiskAndFolderCache = refreshDiskCache;

export async function loadCachedData(): Promise<FilesCacheData | null> {
  if (memoryCache) return memoryCache;
  try {
    const raw = await readFile(FILES_CACHE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as FilesCacheData;
    if (parsed && parsed.disk && parsed.lastUpdated) {
      memoryCache = parsed;
      return parsed;
    }
  } catch {
    // Cache file missing or invalid
  }
  return null;
}

export async function getDiskUsageAndCache(): Promise<FilesCacheData> {
  const cached = await loadCachedData();
  if (cached) {
    return cached;
  }
  return refreshDiskCache();
}

export function initFilesCache() {
  void loadCachedData();
}
