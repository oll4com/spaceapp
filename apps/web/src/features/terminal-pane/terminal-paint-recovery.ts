import type { Terminal } from "@xterm/xterm";
import { emitAppDiagnosticsPerformance } from "../../app-diagnostics/app-diagnostics-performance.js";
import {
  edgeLeakShouldEmit,
  scanTerminalEdgeLeak
} from "./terminal-edge-leak-detector.js";

const PAINT_SETTLE_MS = 250;

// Compare presentation with the public buffer, never with a transcript replay.
// A valid grid can still have lost DOM rows after a renderer invalidation; the
// next cursor-only update does not necessarily repaint the missing rows.
export function terminalPaintIsStale(terminal: Terminal, host: HTMLElement): boolean {
  const rows = host.querySelector(".xterm-rows");
  if (!rows || terminal.modes.synchronizedOutputMode) return false;
  const buffer = terminal.buffer.active;
  for (let y = 0; y < terminal.rows; y += 1) {
    const line = buffer.getLine(buffer.viewportY + y);
    if (!line) continue;
    const rendered = (rows.children[y]?.textContent ?? "").replace(/\s/g, "");
    const expected = line.translateToString(true).replace(/\s/g, "");
    if (rendered === expected) continue;
    // Concealed cells deliberately render as spaces. Wide-cell continuations
    // contain no text; getChars also preserves combined Unicode characters.
    let visibleText = "";
    for (let x = 0; x < Math.min(line.length, terminal.cols); x += 1) {
      const cell = line.getCell(x);
      if (cell && !cell.isInvisible()) visibleText += cell.getChars();
    }
    if (rendered !== visibleText.replace(/\s/g, "")) return true;
  }
  return false;
}

export function watchTerminalPaint(
  terminal: Terminal,
  host: HTMLElement,
  isVisible: () => boolean,
  identities?: { roomId?: string; paneId?: string }
): { dispose: () => void } {
  const document = host.ownerDocument;
  const ownerWindow = document.defaultView!;
  let disposed = false;
  let timer: number | null = null;
  let lastEdgeLeakEmitAt: number | null = null;
  const eligible = () => !disposed && isVisible() && host.isConnected && document.visibilityState !== "hidden";
  const recordEdgeLeak = () => {
    let counters = null;
    try {
      counters = scanTerminalEdgeLeak(terminal, host);
    } catch {
      counters = null;
    }
    if (!counters) return;
    try {
      host.dataset.terminalEdgeLeakFragRows = String(counters.fragRows);
      host.dataset.terminalEdgeLeakOverflowPx = String(counters.overflowPx);
      host.dataset.terminalEdgeLeakViewportY = String(counters.viewportY);
      host.dataset.terminalEdgeLeakStaleDom = counters.staleDom ? "1" : "0";
    } catch {
      // Dataset telemetry is best-effort; never interrupt the paint loop.
    }
    const now = Date.now();
    if (!edgeLeakShouldEmit(counters, lastEdgeLeakEmitAt, now)) return;
    lastEdgeLeakEmitAt = now;
    try {
      emitAppDiagnosticsPerformance({
        category: "PERFORMANCE",
        metric: "TERMINAL_EDGE_LEAK",
        phase: "EDGE_SAMPLE",
        roomId: identities?.roomId,
        paneId: identities?.paneId,
        cols: terminal.cols,
        rows: terminal.rows,
        scannedRows: counters.scannedRows,
        fragRows: counters.fragRows,
        wideRows: counters.wideRows,
        ambiguousRows: counters.ambiguousRows,
        ambiguousCells: counters.ambiguousCells,
        overflowPx: counters.overflowPx,
        viewportY: counters.viewportY,
        staleDom: counters.staleDom
      });
    } catch {
      // Diagnostics emission is best-effort; never interrupt the paint loop.
    }
  };
  const check = () => {
    timer = null;
    if (!eligible() || ownerWindow.getComputedStyle(host).visibility === "hidden") return;
    const bounds = host.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    if (terminalPaintIsStale(terminal, host)) terminal.refresh(0, terminal.rows - 1);
    recordEdgeLeak();
  };
  const schedule = () => {
    if (timer !== null || !eligible()) return;
    // Let xterm's own animation-frame render finish first. Coalesce bursts;
    // healthy terminals incur no extra refresh and idle panes have no poller.
    timer = ownerWindow.setTimeout(check, PAINT_SETTLE_MS);
  };
  const subscriptions = [terminal.onWriteParsed(schedule), terminal.onRender(schedule), terminal.onScroll(schedule)];
  ownerWindow.addEventListener("focus", schedule);
  ownerWindow.addEventListener("pageshow", schedule);
  document.addEventListener("visibilitychange", schedule);
  schedule();
  return {
    dispose() {
      disposed = true;
      if (timer !== null) ownerWindow.clearTimeout(timer);
      subscriptions.forEach((subscription) => subscription.dispose());
      ownerWindow.removeEventListener("focus", schedule);
      ownerWindow.removeEventListener("pageshow", schedule);
      document.removeEventListener("visibilitychange", schedule);
    }
  };
}
