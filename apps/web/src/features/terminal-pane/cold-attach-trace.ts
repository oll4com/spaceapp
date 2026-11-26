// PERF-004 (Warm, Nous-approved 22/11): cold-attach stage marks. Only BENCHMARK_ROOM_SWITCH's cold-leg document sets this key;
// it is read once per document, so every other page (and the warm leg after its reload) pays one false check per call.
export const COLD_ATTACH_TRACE_KEY = "space.coldAttachTrace.v1";
export const COLD_ATTACH_MARK_PREFIX = "space-cold-attach:";

let enabled: boolean | null = null;

export function markColdAttach(stage: string, paneId?: string): void {
  if (enabled === null) {
    try { enabled = window.sessionStorage.getItem(COLD_ATTACH_TRACE_KEY) === "1"; } catch { enabled = false; }
  }
  if (enabled) performance.mark(COLD_ATTACH_MARK_PREFIX + stage, { detail: paneId ?? null });
}
