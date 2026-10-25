import { getSpaceRuntime } from "./runtime/SpaceRuntime.js";

/** A browser-local on/off flag stored as "true"; anything else (or no window) is off. */
export function readStoredBoolean(key: string): boolean {
  if (typeof window === "undefined") return false;
  return getSpaceRuntime().platform.localStorage.getItem(key) === "true";
}
