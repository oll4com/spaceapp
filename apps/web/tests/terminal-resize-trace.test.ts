import { afterEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { appDiagnosticsTechnicalEventSchema } from "@space/contracts";
const state = vi.hoisted(() => ({ enabled: false }));
vi.mock("../src/app-diagnostics/app-diagnostics-bootstrap.js", () => ({
  APP_DIAGNOSTICS_STATE_EVENT: "space:app-diagnostics-state",
  getAppDiagnosticsClientState: () => ({ status: { isEnabled: state.enabled } })
}));
import { createTerminalResizeTrace } from "../src/features/terminal-pane/terminal-resize-trace.js";
import { APP_DIAGNOSTICS_PERFORMANCE_EVENT } from "../src/app-diagnostics/app-diagnostics-performance.js";

function fixture() {
  const listeners = new Set<() => void>();
  const subscribe = (fn: () => void) => { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; };
  const terminal = {
    cols: 80, rows: 24, buffer: { active: { baseY: 500, viewportY: 80, cursorY: 23 } },
    modes: { synchronizedOutputMode: false }, onWriteParsed: subscribe, onRender: subscribe, onScroll: subscribe
  } as unknown as Terminal;
  const host = document.createElement("div");
  const events: unknown[] = [];
  const capture = (event: Event) => events.push((event as CustomEvent).detail);
  window.addEventListener(APP_DIAGNOSTICS_PERFORMANCE_EVENT, capture);
  const trace = createTerminalResizeTrace({ host, roomId: "room:trace-test", paneId: "pane:trace-test",
    instanceId: "term-instance:trace-test", getTerminal: () => terminal, isVisible: () => true, isMinimized: () => false });
  return { host, listeners, events, trace, dispose: () => {
    trace.dispose(); window.removeEventListener(APP_DIAGNOSTICS_PERFORMANCE_EVENT, capture);
  } };
}

afterEach(() => { state.enabled = false; vi.useRealTimers(); });
describe("terminal resize debug trace", () => {
  it("has no xterm subscriptions, reads or timers with Debug OFF", () => {
    vi.useFakeTimers();
    const f = fixture();
    const read = vi.spyOn(f.host, "querySelector");
    f.trace.trace("FIT_BEFORE"); f.trace.wrote(100);
    expect(f.listeners.size).toBe(0);
    expect(f.events).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    f.dispose();
  });
  it("reports bounded numeric state through the existing contract and detaches on Debug OFF", () => {
    const f = fixture();
    state.enabled = true;
    window.dispatchEvent(new Event("space:app-diagnostics-state"));
    expect(f.listeners.size).toBe(3);
    f.trace.trace("FIT_BEFORE", "LAYOUT_EFFECT");
    f.trace.wrote(123);
    f.listeners.forEach(fn => fn());
    for (const detail of f.events) {
      expect(appDiagnosticsTechnicalEventSchema.safeParse({ ...(detail as object), sequence: 1,
        occurredAt: "2026-10-05T03:30:00.000Z" }).success).toBe(true);
    }
    expect(f.events[0]).toMatchObject({ terminalResizeTrace: {
      event: "FIT_BEFORE", reason: "LAYOUT_EFFECT", baseY: 500, viewportY: 80, version: 1
    } });
    const count = f.events.length;
    state.enabled = false;
    window.dispatchEvent(new Event("space:app-diagnostics-state"));
    f.trace.trace("FIT_AFTER");
    expect(f.listeners.size).toBe(0);
    expect(f.events).toHaveLength(count);
    f.dispose();
  });
  it("bounds bursts without an idle sampler and removes all listeners on disposal", () => {
    vi.useFakeTimers(); state.enabled = true;
    const f = fixture();
    for (let n = 0; n < 1000; n += 1) f.trace.trace("REFIT_REQUEST", "OBSERVER");
    expect(f.events.length).toBeLessThanOrEqual(60);
    const count = f.events.length;
    vi.advanceTimersByTime(10_000);
    f.listeners.forEach(fn => fn());
    expect(f.events).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
    f.dispose(); expect(f.listeners.size).toBe(0);
  });
});
