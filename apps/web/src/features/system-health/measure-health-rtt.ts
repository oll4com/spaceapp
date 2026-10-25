import { api } from "../../api.js";
import { getSpaceRuntimeKind } from "../../runtime/SpaceRuntime.js";

/**
 * Measures the true network round-trip time (RTT) between browser and Space server.
 * Uses the browser's PerformanceResourceTiming API (responseStart - requestStart)
 * to eliminate HTTP/2 stream queueing, main-thread blocking, and client-side scheduling delays.
 * Falls back gracefully to wall-clock measurement if Resource Timing is unavailable.
 */
export async function measureHealthRtt(ping?: () => Promise<unknown>): Promise<number | null> {
  if (getSpaceRuntimeKind() === "demo") return 42;

  const startedAt = performance.now();
  if (ping) {
    await ping();
  } else {
    await api.healthPing();
  }
  const wallClockMs = Math.max(0, Math.round(performance.now() - startedAt));

  if (typeof performance !== "undefined") {
    try {
      const pingUrl = typeof window !== "undefined" && window.location
        ? new URL("/healthz", window.location.href).href
        : "/healthz";
      let entries: PerformanceResourceTiming[] = [];
      if (typeof performance.getEntriesByName === "function") {
        entries = performance.getEntriesByName(pingUrl) as PerformanceResourceTiming[];
      }
      if (entries.length === 0 && typeof performance.getEntriesByType === "function") {
        const allResources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
        entries = allResources.filter((e) => e.name && e.name.includes("/healthz"));
      }
      if (entries.length > 0) {
        const latest = entries[entries.length - 1];
        if (latest && latest.responseStart > 0 && latest.requestStart > 0) {
          const wireRtt = Math.round(latest.responseStart - latest.requestStart);
          if (wireRtt > 0 && wireRtt <= wallClockMs + 5) {
            if (typeof performance.clearResourceTimings === "function" && entries.length > 8) {
              performance.clearResourceTimings();
            }
            return wireRtt;
          }
        }
      }
    } catch {
      // Fallback to wallClockMs
    }
  }

  return wallClockMs;
}
