import type { TerminalResizeTrace } from "@space/contracts";
import type { Terminal } from "@xterm/xterm";
import { APP_DIAGNOSTICS_STATE_EVENT, getAppDiagnosticsClientState } from "../../app-diagnostics/app-diagnostics-bootstrap.js";
import { emitAppDiagnosticsPerformance } from "../../app-diagnostics/app-diagnostics-performance.js";

export type TerminalResizeTraceEvent = TerminalResizeTrace["event"];
export type TerminalResizeTraceReason = TerminalResizeTrace["reason"];
export type TerminalResizeTraceListener = (event: TerminalResizeTraceEvent, reason?: TerminalResizeTraceReason) => void;

// Event-driven, numeric-only tracing. Debug OFF installs no xterm listeners,
// timers or samplers. Debug ON samples output only for three seconds after a
// geometry event, using the existing bounded App Diagnostics transport.
export function createTerminalResizeTrace(options: {
  host: HTMLElement; roomId: string; paneId: string; instanceId: string;
  getTerminal: () => Terminal | null; isVisible: () => boolean; isMinimized: () => boolean;
}) {
  let enabled = false;
  let subscriptions: { dispose(): void }[] = [];
  let observedTerminal: Terminal | null = null;
  let started = 0;
  let until = 0;
  let sampledAt = -Infinity;
  let budgetStart = 0;
  let budget = 0;
  let parsed = 0, rendered = 0, scrolls = 0, written = 0;
  const trace: TerminalResizeTraceListener = (event, reason = "UNKNOWN") => {
    if (!enabled) return;
    const now = performance.now();
    if (event !== "OUTPUT_SAMPLE") {
      if (now > until) { started = now; parsed = rendered = scrolls = written = 0; }
      until = now + 3000;
    } else {
      if (now > until || now - sampledAt < 250) return;
      sampledAt = now;
    }
    if (now - budgetStart >= 5000) { budgetStart = now; budget = 0; }
    if (budget >= 60) return;
    budget += 1;
    const terminal = options.getTerminal();
    if (!terminal) return;
    const buffer = terminal.buffer.active;
    emitAppDiagnosticsPerformance({
      category: "PERFORMANCE", metric: "TERMINAL_GEOMETRY", phase: "SAMPLE",
      roomId: options.roomId, paneId: options.paneId, instanceId: options.instanceId,
      terminalResizeTrace: {
        version: 1, event, reason, elapsedMs: Math.min(120_000, Math.max(0, now - started)),
        cols: terminal.cols, rows: terminal.rows, baseY: buffer.baseY,
        viewportY: buffer.viewportY, cursorY: buffer.cursorY,
        synchronized: terminal.modes.synchronizedOutputMode,
        held: !!options.host.querySelector("[data-terminal-resize-frame]"),
        visible: options.isVisible(), minimized: options.isMinimized(),
        parsed, rendered, scrolls, written
      }
    });
  };
  const sync = () => {
    enabled = getAppDiagnosticsClientState().status?.isEnabled === true;
    const terminal = enabled ? options.getTerminal() : null;
    if (terminal === observedTerminal) return;
    for (const subscription of subscriptions) subscription.dispose();
    subscriptions = [];
    observedTerminal = terminal;
    if (!terminal) { until = 0; return; }
    subscriptions = [
      terminal.onWriteParsed(() => { parsed += 1; trace("OUTPUT_SAMPLE"); }),
      terminal.onRender(() => { rendered += 1; trace("OUTPUT_SAMPLE"); }),
      terminal.onScroll(() => { scrolls += 1; trace("OUTPUT_SAMPLE"); })
    ];
  };
  window.addEventListener(APP_DIAGNOSTICS_STATE_EVENT, sync);
  sync();
  return {
    trace, sync,
    wrote(length: number) { if (enabled && performance.now() <= until) written += length; },
    dispose() {
      enabled = false;
      window.removeEventListener(APP_DIAGNOSTICS_STATE_EVENT, sync);
      for (const subscription of subscriptions) subscription.dispose();
      subscriptions = [];
    }
  };
}
