import { api } from "../../api.js";
import { getSpaceRuntimeKind } from "../../runtime/SpaceRuntime.js";

let sample = 0;

/**
 * Measures the true network round-trip time (RTT) between browser and Space server.
 * Uses the browser's PerformanceResourceTiming API (responseStart - requestStart) of this ping's own entry
 * to eliminate HTTP/2 stream queueing, main-thread blocking, and client-side scheduling delays.
 * Falls back to wall-clock measurement only if Resource Timing recorded no entry for this ping.
 */
export async function measureHealthRtt(ping?: (path: string) => Promise<unknown>): Promise<number | null> {
  if (getSpaceRuntimeKind() === "demo") return 42;

  // 14/11: the latest /healthz entry by name could be an older ping's, and a full buffer (250, ~1 min of polling) recorded none; nothing else reads resource entries.
  const path = `/healthz?rtt=${++sample}`;
  if (typeof performance.clearResourceTimings === "function") performance.clearResourceTimings();
  const startedAt = performance.now();
  if (ping) {
    await ping(path);
  } else {
    await api.healthPing(path);
  }
  const wallClockMs = Math.max(0, Math.round(performance.now() - startedAt));

  try {
    const pingUrl = typeof window !== "undefined" && window.location ? new URL(path, window.location.href).href : path;
    const entries = typeof performance.getEntriesByName === "function"
      ? performance.getEntriesByName(pingUrl) as PerformanceResourceTiming[]
      : [];
    const own = entries.at(-1);
    if (own && own.responseStart > 0 && own.requestStart > 0) {
      const wireRtt = Math.round(own.responseStart - own.requestStart);
      if (wireRtt >= 0 && wireRtt <= wallClockMs + 5) return wireRtt;
    }
  } catch {
    // Fallback to wallClockMs
  }

  return wallClockMs;
}
