/**
 * Ends browser viewer sockets whose Browser Host stream died with its process (CORE-001). A frame or audio stream is a
 * subscription inside one Browser Host process; when that process restarts, the API's host client reconnects for its
 * next request but the old subscription never sends again and no end signal reaches the viewer, so the pane showed its
 * last frame forever. One shared poll of the host's health (it never waits on the host's queues) runs while any viewer
 * is open: a new host identity (pid and start time) or two failed reads in a row end the viewers, and the page's
 * existing reconnect takes a fresh ticket and stream from the live host.
 */
import { recordRecoveryEvent } from "./api-metrics.js";

export interface BrowserStreamHostIdentity {
  hostPid: number;
  startedAt: string;
}

export type BrowserStreamHostEnd = "restarted" | "unavailable";

export interface BrowserStreamHostWatch {
  /** Registers an open viewer; returns the unregister function. `onEnd` runs at most once. */
  watch(onEnd: (reason: BrowserStreamHostEnd) => void): () => void;
  size(): number;
}

interface Watcher {
  /** Checks started before this number may predate the viewer's stream and never set its identity. */
  registeredAtCheck: number;
  identity: string | null;
  onEnd(reason: BrowserStreamHostEnd): void;
}

export function createBrowserStreamHostWatch(options: {
  health: () => Promise<BrowserStreamHostIdentity>;
  intervalMs: number;
  failuresBeforeEnd?: number;
}): BrowserStreamHostWatch {
  const failuresBeforeEnd = Math.max(1, options.failuresBeforeEnd ?? 2);
  const watchers = new Set<Watcher>();
  let checksStarted = 0;
  let checking = false;
  let rerun = false;
  let failures = 0;
  let timer: NodeJS.Timeout | null = null;

  const end = (watcher: Watcher, reason: BrowserStreamHostEnd) => {
    if (!watchers.delete(watcher)) return;
    try { watcher.onEnd(reason); } catch { /* one viewer's close must not stop the others */ }
  };

  const schedule = (delayMs: number) => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!watchers.size) return;
    timer = setTimeout(() => { timer = null; void check(); }, delayMs);
    timer.unref?.();
  };

  async function check(): Promise<void> {
    if (checking) { rerun = true; return; }
    if (!watchers.size) return;
    checking = true;
    const checkNumber = ++checksStarted;
    try {
      const health = await options.health();
      failures = 0;
      const identity = `${health.hostPid}:${health.startedAt}`;
      let restarted = false;
      for (const watcher of [...watchers]) {
        if (watcher.identity === null) {
          if (checkNumber > watcher.registeredAtCheck) watcher.identity = identity;
        } else if (watcher.identity !== identity) {
          end(watcher, "restarted");
          restarted = true;
        }
      }
      // One recovery per host restart, not per viewer: the pages reconnect to the new host.
      if (restarted) recordRecoveryEvent("browser_stream_host", "SCHEDULED");
    } catch {
      failures += 1;
      if (failures >= failuresBeforeEnd) {
        failures = 0;
        if (watchers.size) recordRecoveryEvent("browser_stream_host", "FAILED");
        for (const watcher of [...watchers]) end(watcher, "unavailable");
      }
    } finally {
      checking = false;
    }
    if (rerun) { rerun = false; schedule(0); } else schedule(options.intervalMs);
  }

  return {
    watch(onEnd) {
      const watcher: Watcher = { registeredAtCheck: checksStarted, identity: null, onEnd };
      watchers.add(watcher);
      // Learn the identity of the host that serves this stream right away instead of one interval later.
      if (checking) rerun = true;
      else schedule(0);
      return () => {
        watchers.delete(watcher);
        if (!watchers.size && timer) { clearTimeout(timer); timer = null; }
      };
    },
    size: () => watchers.size
  };
}
