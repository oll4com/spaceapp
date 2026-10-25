import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTerminalOutputCoordinator,
  recordTerminalStressXtermWrite,
  resetTerminalOutputBudgetForTests,
  TERMINAL_HIDDEN_PANE_BUFFER_LIMIT_BYTES,
  TERMINAL_HIDDEN_TOTAL_BUFFER_LIMIT_BYTES,
  type TerminalOutputPressure
} from "../src/features/terminal-pane/terminal-output-coordinator.js";

describe("terminal output coordinator", () => {
  afterEach(() => {
    resetTerminalOutputBudgetForTests();
    delete (window as Window & { __spaceActiveAgentStressProof?: unknown }).__spaceActiveAgentStressProof;
  });

  it("bounds hidden output below the replay size that missed the warm-switch budget", () => {
    expect(TERMINAL_HIDDEN_PANE_BUFFER_LIMIT_BYTES).toBe(128 * 1024);
    expect(TERMINAL_HIDDEN_TOTAL_BUFFER_LIMIT_BYTES).toBe(1024 * 1024);
  });

  it("performs zero writes while hidden and flushes replay and live output in exact order", async () => {
    let visible = false;
    const writes: string[] = [];
    const coordinator = createTerminalOutputCoordinator({
      roomId: "room:hidden",
      paneId: "pane:hidden",
      isWritable: () => visible,
      write: async (data) => {
        writes.push(data);
      }
    });

    await coordinator.enqueue("replay-1");
    await coordinator.enqueue("replay-2");
    await coordinator.enqueue("live-1");
    expect(writes).toEqual([]);
    expect(coordinator.snapshot()).toMatchObject({ bufferedEvents: 3 });

    visible = true;
    await coordinator.reveal();
    expect(writes).toEqual(["replay-1replay-2live-1"]);
    expect(coordinator.snapshot()).toMatchObject({ bufferedBytes: 0, bufferedEvents: 0 });
  });

  it("writes only tagged initial replay through headless PREFILL and buffers later live output", async () => {
    let visible = false;
    let prefill = true;
    const writes: Array<{ data: string; mode: string }> = [];
    const coordinator = createTerminalOutputCoordinator({
      roomId: "room:prefill",
      paneId: "pane:prefill",
      isWritable: () => visible,
      isPrefillWritable: () => prefill,
      write: (data, done, mode) => {
        writes.push({ data, mode });
        done();
      }
    });

    await coordinator.enqueue("replay-1", undefined, "PREFILL");
    await coordinator.enqueue("replay-2", undefined, "PREFILL");
    prefill = false;
    await coordinator.enqueue("live-after-status");

    expect(writes).toEqual([
      { data: "replay-1", mode: "PREFILL" },
      { data: "replay-2", mode: "PREFILL" }
    ]);
    expect(coordinator.snapshot()).toMatchObject({
      bufferedEvents: 1,
      pendingPrefillBytes: 0,
      pendingPrefillEvents: 0
    });

    visible = true;
    await coordinator.reveal();
    expect(writes.at(-1)).toEqual({ data: "live-after-status", mode: "VISIBLE" });
  });

  it("reports PREFILL readiness when the final asynchronous write callback drains", async () => {
    let completePrefill: () => void = () => {
      throw new Error("PREFILL callback was not registered.");
    };
    const onPrefillDrained = vi.fn();
    const onPendingPrefillChange = vi.fn();
    const coordinator = createTerminalOutputCoordinator({
      roomId: "room:deferred-prefill",
      paneId: "pane:deferred-prefill",
      isWritable: () => false,
      isPrefillWritable: () => true,
      write: (_data, done) => {
        completePrefill = done;
      },
      onPrefillDrained,
      onPendingPrefillChange
    });

    const prefill = coordinator.enqueue("deferred-replay", undefined, "PREFILL");
    expect(coordinator.snapshot()).toMatchObject({
      pendingPrefillBytes: 15,
      pendingPrefillEvents: 1
    });
    expect(onPrefillDrained).not.toHaveBeenCalled();
    expect(onPendingPrefillChange).toHaveBeenLastCalledWith({
      pendingPrefillBytes: 15,
      pendingPrefillEvents: 1
    });

    completePrefill();
    await prefill;

    expect(onPrefillDrained).toHaveBeenCalledTimes(1);
    expect(onPendingPrefillChange).toHaveBeenLastCalledWith({
      pendingPrefillBytes: 0,
      pendingPrefillEvents: 0
    });
    expect(coordinator.snapshot()).toMatchObject({
      pendingPrefillBytes: 0,
      pendingPrefillEvents: 0
    });

    await coordinator.enqueue("live-buffered");
    expect(onPrefillDrained).toHaveBeenCalledTimes(1);
  });

  it("does not prefill while the browser tab is hidden and reveals the exact stream visibly", async () => {
    let visible = false;
    let tabAllowsPrefill = false;
    const writes: Array<{ data: string; mode: string }> = [];
    const coordinator = createTerminalOutputCoordinator({
      roomId: "room:hidden-tab",
      paneId: "pane:hidden-tab",
      isWritable: () => visible,
      isPrefillWritable: () => tabAllowsPrefill,
      write: (data, done, mode) => {
        writes.push({ data, mode });
        done();
      }
    });

    await coordinator.enqueue("replay-hidden-tab", undefined, "PREFILL");
    await coordinator.enqueue("live-hidden-tab");
    expect(writes).toEqual([]);
    expect(coordinator.snapshot()).toMatchObject({
      pendingPrefillBytes: 17,
      pendingPrefillEvents: 1
    });

    tabAllowsPrefill = false;
    visible = true;
    await coordinator.reveal();
    expect(writes).toEqual([
      { data: "replay-hidden-tablive-hidden-tab", mode: "VISIBLE" }
    ]);
    expect(coordinator.snapshot()).toMatchObject({
      bufferedEvents: 0,
      pendingPrefillBytes: 0,
      pendingPrefillEvents: 0
    });
  });

  it("coalesces a two-mebibyte hidden backlog into at most two ordered reveal writes", async () => {
    let visible = false;
    const writes: string[] = [];
    const events = Array.from(
      { length: 200 },
      (_, index) => `${String(index).padStart(3, "0")}:${"x".repeat(9_744)}`
    );
    const coordinator = createTerminalOutputCoordinator({
      roomId: "room:large-existing",
      paneId: "pane:large-existing",
      isWritable: () => visible,
      write: async (data) => {
        writes.push(data);
      }
    });

    for (const event of events) await coordinator.enqueue(event);
    expect(writes).toEqual([]);

    visible = true;
    await coordinator.reveal();

    expect(writes.length).toBeLessThanOrEqual(2);
    expect(writes.join("")).toBe(events.join(""));
    expect(coordinator.snapshot()).toMatchObject({
      bufferedBytes: 0,
      bufferedEvents: 0,
      writtenEvents: 200
    });
  });

  it("starts output queued after a deferred replay as soon as that replay callback completes", async () => {
    const writes: string[] = [];
    let completeReplay: () => void = () => {
      throw new Error("Replay callback was not registered.");
    };
    const coordinator = createTerminalOutputCoordinator({
      roomId: "room:active",
      paneId: "pane:active",
      isWritable: () => true,
      write: (data, done) => {
        writes.push(data);
        if (data === "replay") completeReplay = done;
        else done();
      }
    });
    const replay = coordinator.enqueue("replay");
    const status = coordinator.enqueue("status");
    expect(writes).toEqual(["replay"]);
    completeReplay();
    await Promise.all([replay, status]);
    expect(writes).toEqual(["replay", "status"]);
  });

  it("reports deterministic pane and global pressure without exposing output text", async () => {
    const pressure = vi.fn();
    const dispatchEvent = vi.spyOn(window, "dispatchEvent");
    const first = createTerminalOutputCoordinator({
      roomId: "room:old",
      paneId: "pane:old",
      isWritable: () => false,
      write: async () => undefined,
      perPaneLimitBytes: 5,
      totalLimitBytes: 9,
      onPressure: pressure
    });
    const second = createTerminalOutputCoordinator({
      roomId: "room:new",
      paneId: "pane:new",
      isWritable: () => false,
      write: async () => undefined,
      perPaneLimitBytes: 5,
      totalLimitBytes: 9,
      onPressure: pressure
    });

    await first.enqueue("123456");
    await second.enqueue("abcdef");
    expect(pressure).toHaveBeenCalledTimes(2);
    expect(pressure.mock.calls[0]?.[0]).toEqual({
      roomId: "room:old",
      paneId: "pane:old",
      bufferedBytes: 6,
      bufferedEvents: 1,
      totalBufferedBytes: 6,
      reason: "PANE_LIMIT"
    });
    expect(pressure.mock.calls[1]?.[0]).toMatchObject({
      roomId: "room:new",
      paneId: "pane:new",
      totalBufferedBytes: 12,
      reason: "TOTAL_LIMIT"
    });
    const performanceMetrics = dispatchEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "space:app-diagnostics-performance")
      .map((event) => (event as CustomEvent).detail);
    expect(performanceMetrics).toEqual([
      expect.objectContaining({
        category: "PERFORMANCE",
        metric: "TERMINAL_OUTPUT_PRESSURE",
        roomId: "room:old",
        paneId: "pane:old",
        phase: "PANE_LIMIT",
        bufferedBytes: 6,
        bufferedEvents: 1,
        totalBufferedBytes: 6,
        writtenBytes: 0,
        writtenEvents: 0
      }),
      expect.objectContaining({
        category: "PERFORMANCE",
        metric: "TERMINAL_OUTPUT_PRESSURE",
        roomId: "room:new",
        paneId: "pane:new",
        phase: "TOTAL_LIMIT",
        totalBufferedBytes: 12
      })
    ]);
    expect(JSON.stringify(pressure.mock.calls)).not.toContain("abcdef");
    expect(JSON.stringify(performanceMetrics)).not.toContain("abcdef");
  });

  it("releases global buffered bytes when a cold-evicted pane is disposed", async () => {
    const pressure = vi.fn();
    const first = createTerminalOutputCoordinator({
      roomId: "room:old",
      paneId: "pane:old",
      isWritable: () => false,
      write: async () => undefined,
      totalLimitBytes: 8,
      onPressure: pressure
    });
    const second = createTerminalOutputCoordinator({
      roomId: "room:new",
      paneId: "pane:new",
      isWritable: () => false,
      write: async () => undefined,
      totalLimitBytes: 8,
      onPressure: pressure
    });
    await first.enqueue("12345");
    first.dispose();
    await second.enqueue("67890");
    expect(pressure).not.toHaveBeenCalled();
  });

  it("never writes while hidden and requests deterministic warm-room eviction at pressure", async () => {
    let visible = false;
    const writes: Array<{ data: string; mode: string | undefined }> = [];
    const pressure = vi.fn();
    const coordinator = createTerminalOutputCoordinator({
      roomId: "room:warm",
      paneId: "pane:warm",
      isWritable: () => visible,
      write: async (data, _done, mode) => {
        writes.push({ data, mode });
      },
      perPaneLimitBytes: 10,
      totalLimitBytes: 100,
      onPressure: pressure
    });

    await coordinator.enqueue("123456");
    expect(writes).toEqual([]);
    await coordinator.enqueue("abcdef");

    expect(writes).toEqual([]);
    expect(pressure).toHaveBeenCalledTimes(1);
    expect(pressure).toHaveBeenCalledWith({
      roomId: "room:warm",
      paneId: "pane:warm",
      bufferedBytes: 12,
      bufferedEvents: 2,
      totalBufferedBytes: 12,
      reason: "PANE_LIMIT"
    });
    expect(coordinator.snapshot()).toMatchObject({
      bufferedBytes: 12,
      bufferedEvents: 2,
      writtenBytes: 0,
      writtenEvents: 0
    });

    await coordinator.enqueue("later");
    expect(writes).toEqual([]);
    visible = true;
    await coordinator.reveal();
    expect(writes).toEqual([
      { data: "123456abcdeflater", mode: "VISIBLE" }
    ]);
  });

  it("reasserts unresolved hidden pressure when the controller attaches after the first report", async () => {
    let pressureListener: ((pressure: TerminalOutputPressure) => void) | null = null;
    const latePressure = vi.fn();
    const coordinator = createTerminalOutputCoordinator({
      roomId: "room:persisted-warm",
      paneId: "pane:persisted-warm",
      isWritable: () => false,
      write: async () => undefined,
      perPaneLimitBytes: 10,
      totalLimitBytes: 100,
      onPressure: (pressure) => pressureListener?.(pressure)
    });

    await coordinator.enqueue("123456abcdef");
    pressureListener = latePressure;
    await coordinator.maintainPressure();

    expect(latePressure).toHaveBeenCalledTimes(1);
    expect(latePressure).toHaveBeenCalledWith({
      roomId: "room:persisted-warm",
      paneId: "pane:persisted-warm",
      bufferedBytes: 12,
      bufferedEvents: 1,
      totalBufferedBytes: 12,
      reason: "PANE_LIMIT"
    });
    expect(coordinator.snapshot()).toMatchObject({
      bufferedBytes: 12,
      bufferedEvents: 1,
      writtenBytes: 0,
      writtenEvents: 0
    });
  });

  it("does not reassert total pressure after the global threshold was already reported", async () => {
    const pressure = vi.fn();
    const coordinator = createTerminalOutputCoordinator({
      roomId: "room:total-pressure",
      paneId: "pane:total-pressure",
      isWritable: () => false,
      write: async () => undefined,
      perPaneLimitBytes: 100,
      totalLimitBytes: 5,
      onPressure: pressure
    });

    await coordinator.enqueue("123456");
    await coordinator.maintainPressure();

    expect(pressure).toHaveBeenCalledTimes(1);
    expect(pressure).toHaveBeenCalledWith(expect.objectContaining({
      reason: "TOTAL_LIMIT",
      totalBufferedBytes: 6
    }));
  });

  it("reports one total-pressure crossing across multiple pane coordinators", async () => {
    const pressure = vi.fn();
    const first = createTerminalOutputCoordinator({
      roomId: "room:multi-pane-total",
      paneId: "pane:first",
      isWritable: () => false,
      write: async () => undefined,
      perPaneLimitBytes: 100,
      totalLimitBytes: 5,
      onPressure: pressure
    });
    const second = createTerminalOutputCoordinator({
      roomId: "room:multi-pane-total",
      paneId: "pane:second",
      isWritable: () => false,
      write: async () => undefined,
      perPaneLimitBytes: 100,
      totalLimitBytes: 5,
      onPressure: pressure
    });

    await first.enqueue("123456");
    await second.enqueue("789");
    await first.maintainPressure();
    await second.maintainPressure();

    expect(pressure).toHaveBeenCalledTimes(1);
    expect(pressure).toHaveBeenCalledWith(expect.objectContaining({
      reason: "TOTAL_LIMIT",
      totalBufferedBytes: 6
    }));

    first.dispose();
    second.dispose();
    const nextCrossing = createTerminalOutputCoordinator({
      roomId: "room:next-total-crossing",
      paneId: "pane:next",
      isWritable: () => false,
      write: async () => undefined,
      perPaneLimitBytes: 100,
      totalLimitBytes: 5,
      onPressure: pressure
    });
    await nextCrossing.enqueue("abcdef");

    expect(pressure).toHaveBeenCalledTimes(2);
    expect(pressure).toHaveBeenLastCalledWith(expect.objectContaining({
      roomId: "room:next-total-crossing",
      reason: "TOTAL_LIMIT",
      totalBufferedBytes: 6
    }));
  });

  it("reports numeric-only stress proof counters and detects no hidden xterm writes", async () => {
    const counters = {
      version: 1,
      bufferedEvents: 0,
      bufferedBytes: 0,
      xtermWriteEvents: 0,
      xtermWriteBytes: 0,
      hiddenXtermWriteEvents: 0,
      hiddenXtermWriteBytes: 0,
      prefillXtermWriteEvents: 0,
      prefillXtermWriteBytes: 0,
      maintenanceXtermWriteEvents: 0,
      maintenanceXtermWriteBytes: 0,
      panes: {}
    };
    (window as Window & { __spaceActiveAgentStressProof?: typeof counters }).__spaceActiveAgentStressProof = counters;
    let visible = false;
    const coordinator = createTerminalOutputCoordinator({
      roomId: "room:stress",
      paneId: "pane:stress",
      isWritable: () => visible,
      write: (data, done) => {
        recordTerminalStressXtermWrite("room:stress", "pane:stress", data, !visible, "VISIBLE");
        done();
      }
    });

    await coordinator.enqueue("hidden output");
    expect(counters).toMatchObject({
      bufferedEvents: 1,
      bufferedBytes: 13,
      xtermWriteEvents: 0,
      hiddenXtermWriteEvents: 0
    });

    visible = true;
    await coordinator.reveal();
    expect(counters).toEqual({
      version: 1,
      bufferedEvents: 1,
      bufferedBytes: 13,
      xtermWriteEvents: 1,
      xtermWriteBytes: 13,
      hiddenXtermWriteEvents: 0,
      hiddenXtermWriteBytes: 0,
      prefillXtermWriteEvents: 0,
      prefillXtermWriteBytes: 0,
      maintenanceXtermWriteEvents: 0,
      maintenanceXtermWriteBytes: 0,
      panes: {
        "room:stress\u0000pane:stress": {
          roomId: "room:stress",
          paneId: "pane:stress",
          bufferedEvents: 1,
          bufferedBytes: 13,
          xtermWriteEvents: 1,
          xtermWriteBytes: 13,
          hiddenXtermWriteEvents: 0,
          hiddenXtermWriteBytes: 0,
          prefillXtermWriteEvents: 0,
          prefillXtermWriteBytes: 0,
          maintenanceXtermWriteEvents: 0,
          maintenanceXtermWriteBytes: 0
        }
      }
    });
    expect(JSON.stringify(counters)).not.toContain("hidden output");
  });
});
