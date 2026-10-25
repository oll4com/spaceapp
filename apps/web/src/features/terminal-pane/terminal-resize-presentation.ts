import type { TerminalResizeTraceListener, TerminalResizeTraceReason } from "./terminal-resize-trace.js";
interface Disposable { dispose(): void }

export interface ResizePresentationTerminal {
  modes?: { synchronizedOutputMode?: boolean };
  rows?: number;
  cols?: number;
  onWriteParsed?: (listener: () => void) => Disposable;
  onRender?: (listener: () => void) => Disposable;
}

// CLI resize output may contain a cursor-only prelude, an erase, and several
// history passes (including erases outside DEC 2026). Keep the previous
// viewport until changed content settles, with a bounded escape for silence
// or continuous output and immediate release on user interaction.
const RESIZE_SETTLE_MS = 160;
const MAX_RESIZE_HOLD_MS = 1000;
// A CLI can send cursor/query traffic, pause, then erase and rebuild history.
// Give an observed incomplete repaint a longer, still absolute, safety bound.
const MAX_INCOMPLETE_REPAINT_MS = 5000;
const INTERACTION_EVENTS = ["pointerdown", "wheel", "keydown", "beforeinput", "paste", "copy"] as const;

function paintedText(rows: Element | null): string {
  // The DOM renderer adds a trailing space for the cursor. Ignore that space
  // and empty trailing rows so cursor movement alone is not a content frame.
  return rows ? Array.from(rows.children, row => (row.textContent ?? "").trimEnd()).join("\n").trimEnd() : "";
}

function countPopulatedLines(text: string): number {
  if (!text) return 0;
  return text.split("\n").filter(line => line.trim().length > 0).length;
}

function requiredPopulatedLines(initialLines: number, terminalRows?: number): number {
  const boundedLines = typeof terminalRows === "number" && terminalRows > 0
    ? Math.min(initialLines, terminalRows)
    : initialLines;
  if (boundedLines <= 1) return boundedLines;
  return Math.min(boundedLines, Math.max(2, Math.ceil(boundedLines * 0.5)));
}

export function createTerminalResizePresentation(
  host: HTMLElement,
  getTerminal: () => ResizePresentationTerminal | null,
  isEligible: () => boolean,
  trace?: TerminalResizeTraceListener
) {
  const ownerWindow = host.ownerDocument.defaultView ?? window;
  let overlay: HTMLElement | null = null;
  let timer: number | null = null;
  let deadlineTimer: number | null = null;
  let frame: number | null = null;
  let subscriptions: Disposable[] = [];
  let outputGeneration = 0;
  let renderedGeneration = -1;
  let localFrameText = "";
  let initialPopulatedLines = 0;
  let sawEmptyFrame = false;
  let renderedContentReady = false;
  let disposed = false;

  const release = (reason: TerminalResizeTraceReason = "CANCEL") => {
    const wasHeld = overlay !== null;
    if (timer !== null) ownerWindow.clearTimeout(timer);
    if (deadlineTimer !== null) ownerWindow.clearTimeout(deadlineTimer);
    if (frame !== null) ownerWindow.cancelAnimationFrame(frame);
    timer = deadlineTimer = frame = null;
    for (const subscription of subscriptions) subscription.dispose();
    subscriptions = [];
    for (const event of INTERACTION_EVENTS) host.removeEventListener(event, onInteraction, true);
    host.ownerDocument.removeEventListener("visibilitychange", onVisibilityChange);
    overlay?.remove();
    overlay = null;
    localFrameText = "";
    initialPopulatedLines = 0;
    if (wasHeld) trace?.("HOLD_RELEASE", reason);
  };
  const onInteraction = () => release("INTERACTION");
  const onVisibilityChange = () => { if (!isEligible()) release("HIDDEN"); };
  const scheduleRelease = () => {
    if (timer !== null) ownerWindow.clearTimeout(timer);
    if (frame !== null) ownerWindow.cancelAnimationFrame(frame);
    frame = null;
    timer = ownerWindow.setTimeout(() => {
      timer = null;
      if (!isEligible()) { release("HIDDEN"); return; }
      // fit() paints locally before the remote PTY answers SIGWINCH. That
      // local render is not evidence that the CLI's redraw has finished.
      if (!renderedContentReady || outputGeneration === 0 || getTerminal()?.modes?.synchronizedOutputMode || renderedGeneration < outputGeneration) {
        scheduleRelease();
        return;
      }
      // Let the last xterm render reach the browser before removing the cover.
      frame = ownerWindow.requestAnimationFrame(() => { frame = null; release("QUIET"); });
    }, RESIZE_SETTLE_MS);
  };

  return {
    begin() {
      if (disposed || !isEligible()) { trace?.("HOLD_SKIP", "INELIGIBLE"); return; }
      if (overlay) {
        // A second geometry change needs its own output/render observation.
        // Keep the original deadline so dragging cannot freeze the viewport.
        outputGeneration = 0;
        renderedGeneration = -1;
        renderedContentReady = false;
        sawEmptyFrame = false;
        localFrameText = paintedText(host.querySelector(".xterm-screen .xterm-rows"));
        initialPopulatedLines = countPopulatedLines(localFrameText);
        scheduleRelease();
        return;
      }
      const terminal = getTerminal();
      const screen = host.querySelector<HTMLElement>(".xterm-screen");
      const rows = screen?.querySelector<HTMLElement>(".xterm-rows");
      const container = screen?.parentElement;
      if (!terminal?.onWriteParsed || !terminal.onRender || !screen || !rows || !container || !rows.childElementCount) {
        trace?.("HOLD_SKIP", "NO_SURFACE");
        return;
      }
      // Copy only the currently painted DOM rows, never the buffer/scrollback,
      // input helpers, accessibility tree or another terminal instance.
      const heldRows = rows.cloneNode(true) as HTMLElement;
      Object.assign(heldRows.style, {
        position: "absolute", left: `${screen.offsetLeft}px`, top: `${screen.offsetTop}px`
      });
      overlay = host.ownerDocument.createElement("div");
      overlay.dataset.terminalResizeFrame = "true";
      overlay.setAttribute("aria-hidden", "true");
      overlay.inert = true;
      const viewport = container.querySelector<HTMLElement>(".xterm-viewport");
      Object.assign(overlay.style, {
        position: "absolute", inset: "0", zIndex: "4", overflow: "hidden",
        pointerEvents: "none", userSelect: "none",
        background: viewport ? ownerWindow.getComputedStyle(viewport).backgroundColor : "#090b0c"
      });
      overlay.appendChild(heldRows);
      // Outside .xterm-screen: geometry/render diagnostics still observe only
      // the live renderer. xterm's instance-scoped font/color CSS still applies.
      container.appendChild(overlay);
      trace?.("HOLD_BEGIN", "NORMAL");
      outputGeneration = 0;
      renderedGeneration = -1;
      localFrameText = paintedText(rows);
      initialPopulatedLines = countPopulatedLines(localFrameText);
      sawEmptyFrame = false;
      renderedContentReady = false;
      subscriptions = [
        terminal.onWriteParsed(() => { outputGeneration += 1; scheduleRelease(); }),
        terminal.onRender(() => {
          renderedGeneration = outputGeneration;
          // Read only the painted viewport during an active resize. Keep this
          // local; never emit terminal text or hashes through diagnostics.
          const text = paintedText(rows);
          if (outputGeneration === 0) {
            localFrameText = text;
            initialPopulatedLines = countPopulatedLines(text);
          } else if (!text.trim()) {
            sawEmptyFrame = true;
            renderedContentReady = false;
          } else {
            const currentPopulatedLines = countPopulatedLines(text);
            const requiredLines = requiredPopulatedLines(initialPopulatedLines, getTerminal()?.rows);
            const hasSufficientLines = currentPopulatedLines >= requiredLines;
            renderedContentReady = hasSufficientLines && (sawEmptyFrame || text !== localFrameText);
          }
          scheduleRelease();
        })
      ];
      for (const event of INTERACTION_EVENTS) host.addEventListener(event, onInteraction, { capture: true, passive: true });
      host.ownerDocument.addEventListener("visibilitychange", onVisibilityChange);
      deadlineTimer = ownerWindow.setTimeout(() => {
        if (outputGeneration > 0) {
          deadlineTimer = ownerWindow.setTimeout(() => release("DEADLINE"), MAX_INCOMPLETE_REPAINT_MS - MAX_RESIZE_HOLD_MS);
        } else {
          release("DEADLINE");
        }
      }, MAX_RESIZE_HOLD_MS);
      scheduleRelease();
    },
    cancel: release,
    dispose() { disposed = true; release("DISPOSE"); }
  };
}
