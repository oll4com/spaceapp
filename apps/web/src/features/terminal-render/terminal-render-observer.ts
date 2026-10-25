import type { TerminalRenderGeometry, TerminalRenderObservation } from "@space/contracts";

const generations = new WeakMap<Element, string>();
const empty = (roomId: string, paneId: string, observedAt: number): TerminalRenderObservation => ({
  schemaVersion: 1, roomId, paneId, observedAt, surfaceGeneration: null, sessionId: null, runtimeId: null,
  renderer: "UNKNOWN", visibility: "UNMOUNTED", verdict: "INCONCLUSIVE", reasons: ["UNMOUNTED"],
  geometry: null, transportSequence: null, parserSequence: null, renderSequence: null, sampleDurationMs: 0
});
const number = (value: string | undefined) => Math.min(10000, Math.max(0, Number(value) || 0));
const sameGeometry = (a: TerminalRenderGeometry, b: TerminalRenderGeometry) =>
  a.cols === b.cols && a.rows === b.rows && Math.abs(a.hostWidth - b.hostWidth) < 1 &&
  Math.abs(a.hostHeight - b.hostHeight) < 1 && Math.abs(a.screenWidth - b.screenWidth) < 1 &&
  Math.abs(a.screenHeight - b.screenHeight) < 1;

export function classifyTerminalRender(sample: TerminalRenderObservation, previous?: TerminalRenderObservation): TerminalRenderObservation {
  if (sample.visibility !== "VISIBLE") return { ...sample, verdict: sample.visibility === "UNMOUNTED" ? "INCONCLUSIVE" : "NOT_APPLICABLE", reasons: [sample.visibility] };
  const reasons: TerminalRenderObservation["reasons"] = ["STREAM_COUNTERS_UNAVAILABLE", "SESSION_ID_UNAVAILABLE"];
  if (!sample.geometry || !sample.geometry.cols || !sample.geometry.rows || !sample.geometry.screenWidth || !sample.geometry.screenHeight) return { ...sample, verdict: "INCONCLUSIVE", reasons: [...reasons, "GEOMETRY_UNAVAILABLE"] };
  if (sample.renderer === "UNKNOWN") return { ...sample, verdict: "INCONCLUSIVE", reasons: [...reasons, "RENDERER_UNKNOWN"] };
  const g = sample.geometry;
  const clipped = g.clippedWidth > Math.max(2, g.cellWidth ?? 2) || g.clippedHeight > Math.max(2, g.cellHeight ?? 2);
  const persistent = clipped && previous?.surfaceGeneration === sample.surfaceGeneration &&
    previous.visibility === "VISIBLE" && previous.reasons.includes("GRID_CLIPPED") && previous.geometry &&
    sample.observedAt - previous.observedAt >= 250 && sample.observedAt - previous.observedAt <= 5000 && sameGeometry(g, previous.geometry);
  // HEALTHY means observed geometry only, never a claim of end-to-end stream/glyph integrity.
  return { ...sample, verdict: clipped ? persistent ? "FAULT" : "SUSPECTED" : "HEALTHY",
    reasons: [...reasons, ...(clipped ? ["GRID_CLIPPED" as const, ...(persistent ? ["GRID_CLIPPED_PERSISTENT" as const] : [])] : ["GEOMETRY_CONSISTENT" as const])] };
}

/** Read only: no terminal APIs, text, pixels, timers, observers, or recovery calls. */
export function observeTerminalRender(roomId: string, paneId: string, previous?: TerminalRenderObservation, root: Document = document): TerminalRenderObservation {
  const start = performance.now();
  let sample = empty(roomId, paneId, Date.now());
  const pane = [...root.querySelectorAll<HTMLElement>('.pane-card[data-pane-mode="TERMINAL"][data-space-pane-id]')]
    .find(e => e.dataset.spaceRoomId === roomId && e.dataset.spacePaneId === paneId);
  if (pane && (pane.classList.contains("is-minimized") || pane.dataset.minimized === "true")) {
    return { ...sample, visibility: "MINIMIZED", verdict: "NOT_APPLICABLE", reasons: ["MINIMIZED"], sampleDurationMs: Math.max(0, performance.now()-start) };
  }
  const host = pane?.querySelector<HTMLElement>(".terminal-xterm");
  const screen = host?.querySelector<HTMLElement>(".xterm-screen");
  if (!pane || !host || !screen) return sample;
  if (!generations.has(host)) generations.set(host, `surface:${crypto.randomUUID()}`);
  sample.surfaceGeneration = generations.get(host)!;
  const layer = pane.closest<HTMLElement>("[data-room-runtime-id]");
  const style = getComputedStyle(pane);
  sample.visibility = pane.classList.contains("is-minimized") || pane.dataset.minimized === "true" ? "MINIMIZED" :
    root.visibilityState === "hidden" || (layer && layer.dataset.presentationState !== "displayed") ||
    style.display === "none" || style.visibility === "hidden" || !host.getClientRects().length ? "HIDDEN" : "VISIBLE";
  if (sample.visibility === "VISIBLE") {
    const dom = screen.querySelector<HTMLElement>(".xterm-rows");
    // A canvas alone cannot distinguish canvas/WebGL; do not create a context to find out.
    sample.renderer = dom && dom.childElementCount > 0 ? "DOM" : "UNKNOWN";
    const hr = host.getBoundingClientRect(), sr = screen.getBoundingClientRect();
    const hs = getComputedStyle(host), ss = getComputedStyle(screen);
    const scaleX = host.offsetWidth > 0 ? hr.width / host.offsetWidth : 1;
    const scaleY = host.offsetHeight > 0 ? hr.height / host.offsetHeight : 1;
    const contentWidth = Math.max(0, host.clientWidth - parseFloat(hs.paddingLeft || "0") - parseFloat(hs.paddingRight || "0")) * scaleX;
    const contentHeight = Math.max(0, host.clientHeight - parseFloat(hs.paddingTop || "0") - parseFloat(hs.paddingBottom || "0")) * scaleY;
    const cols = number(host.dataset.terminalCols), rows = number(host.dataset.terminalRows);
    const row = dom?.firstElementChild?.getBoundingClientRect();
    const cellWidth = cols > 0 && parseFloat(ss.width) > 0 ? parseFloat(ss.width) * scaleX / cols : null;
    const cellHeight = row?.height || (rows > 0 ? sr.height / rows : null);
    const expectedWidth = cols * (cellWidth ?? 0), expectedHeight = rows * (cellHeight ?? 0);
    sample.geometry = { hostWidth: contentWidth, hostHeight: contentHeight, screenWidth: sr.width, screenHeight: sr.height,
      cols, rows, cellWidth, cellHeight, domRows: dom?.childElementCount ?? null,
      dpr: Math.min(16, window.devicePixelRatio || 1), zoom: Math.min(16, scaleX || 1),
      coverageRatio: contentWidth * contentHeight > 0 ? Math.min(100, sr.width * sr.height / (contentWidth * contentHeight)) : null,
      clippedWidth: Math.max(0, expectedWidth - Math.min(contentWidth, sr.width)),
      clippedHeight: Math.max(0, expectedHeight - Math.min(contentHeight, sr.height), dom ? (rows - dom.childElementCount) * (cellHeight ?? 0) : 0) };
  }
  sample = classifyTerminalRender(sample, previous);
  sample.sampleDurationMs = Math.max(0, performance.now() - start);
  return sample;
}
