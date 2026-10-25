import { useEffect, useRef } from "react";

/** Poll presentation data without queueing overlapping requests on slow links. */
export function usePanePolling(
  poll: (signal: AbortSignal) => Promise<unknown>,
  intervalMs: number,
  enabled = true,
  immediate = true,
  resetKey?: string,
): void {
  const pollRef = useRef(poll);
  pollRef.current = poll;
  const inFlight = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const controller = new AbortController();
    let timer: number | undefined;
    const schedule = () => {
      if (!disposed) timer = window.setTimeout(() => void tick(), intervalMs);
    };
    const tick = async () => {
      if (disposed) return;
      if (inFlight.current || document.visibilityState === "hidden") {
        schedule();
        return;
      }
      inFlight.current = true;
      try {
        await pollRef.current(controller.signal);
      } catch {
        // The consumer owns error presentation; the next settled tick retries.
      } finally {
        inFlight.current = false;
        schedule();
      }
    };
    const visible = () => {
      if (document.visibilityState !== "visible" || inFlight.current) return;
      window.clearTimeout(timer);
      void tick();
    };
    if (immediate) void tick();
    else schedule();
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      controller.abort();
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [enabled, intervalMs, immediate, resetKey]);
}
