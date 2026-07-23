import { getSpaceRuntime } from "./runtime/SpaceRuntime.js";

export const CLI_IMAGE_PREVIEW_LIMIT_STORAGE_KEY = "space.cliUpload.maxImagePreviews";
export const DEFAULT_CLI_IMAGE_PREVIEW_LIMIT = 12;
export const MIN_CLI_IMAGE_PREVIEW_LIMIT = 1;
export const MAX_CLI_IMAGE_PREVIEW_LIMIT = 24;

export function normalizeCliImagePreviewLimit(value: unknown): number {
  if (value === null || value === undefined || value === "") return DEFAULT_CLI_IMAGE_PREVIEW_LIMIT;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_CLI_IMAGE_PREVIEW_LIMIT;
  const integer = Math.trunc(numeric);
  return Math.min(MAX_CLI_IMAGE_PREVIEW_LIMIT, Math.max(MIN_CLI_IMAGE_PREVIEW_LIMIT, integer));
}

export function readStoredCliImagePreviewLimit(): number {
  if (typeof window === "undefined") return DEFAULT_CLI_IMAGE_PREVIEW_LIMIT;
  return normalizeCliImagePreviewLimit(getSpaceRuntime().platform.localStorage.getItem(CLI_IMAGE_PREVIEW_LIMIT_STORAGE_KEY));
}
