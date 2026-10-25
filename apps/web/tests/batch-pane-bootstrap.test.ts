import { describe, expect, it, vi } from "vitest";
import { createTerminalBootstrapBarrier } from "../src/features/terminal-pane/TerminalPane.js";
import { resolvePaneGridPlacements } from "../src/App.js";

describe("TerminalBootstrapBarrier with batch creation", () => {
  it("filters out optimistic pane IDs from expected barrier participants", async () => {
    // If optimistic IDs are passed along with real IDs, the barrier must only wait for real IDs
    const barrier = createTerminalBootstrapBarrier([
      "pane:real-1",
      "pane:optimistic-xyz-0",
      "pane:optimistic-xyz-1"
    ]);

    const participant1 = barrier.join("pane:real-1");
    // Arriving for real-1 should release the barrier immediately because optimistic IDs were excluded
    let released = false;
    participant1.arrive().then(() => {
      released = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(released).toBe(true);
  });

  it("releases when all real siblings in a batch arrive", async () => {
    const barrier = createTerminalBootstrapBarrier([
      "pane:batch-1",
      "pane:batch-2",
      "pane:batch-3",
      "pane:batch-4"
    ]);

    const p1 = barrier.join("pane:batch-1");
    const p2 = barrier.join("pane:batch-2");
    const p3 = barrier.join("pane:batch-3");
    const p4 = barrier.join("pane:batch-4");

    let released = false;
    const p1Arrive = p1.arrive().then(() => {
      released = true;
    });

    await Promise.resolve();
    expect(released).toBe(false);

    const p2Arrive = p2.arrive();
    const p3Arrive = p3.arrive();
    const p4Arrive = p4.arrive();

    await Promise.all([p1Arrive, p2Arrive, p3Arrive, p4Arrive]);
    expect(released).toBe(true);
  });

  it("auto-releases on safety timeout if an expected pane crashes or never arrives", async () => {
    vi.useFakeTimers();
    try {
      const barrier = createTerminalBootstrapBarrier([
        "pane:batch-1",
        "pane:crashed-sibling"
      ]);

      const p1 = barrier.join("pane:batch-1");
      let released = false;
      p1.arrive().then(() => {
        released = true;
      });

      await Promise.resolve();
      expect(released).toBe(false);

      // Fast-forward past the 6000ms safety watchdog
      vi.advanceTimersByTime(6100);
      await Promise.resolve();
      await Promise.resolve();
      expect(released).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Optimistic pane placement ordering", () => {
  it("places optimistic pane at the end of the grid when existing panes have high order numbers", () => {
    const existingPanes: any[] = [
      {
        id: "pane:andy",
        roomId: "room:1",
        title: "Andy",
        titleSource: "auto",
        mode: "TERMINAL",
        status: "IDLE",
        providerId: null,
        modelId: null,
        terminalRuntimeId: "cli:codex",
        reasoningEffort: "medium",
        cwd: "/opt/spaceapp",
        order: 17,
        columnSpan: 1,
        isMaximized: false,
        isMinimized: false,
        isClosed: false,
        split: { parentId: null, direction: null, size: null },
        categoryColor: null,
        vncTarget: null,
        createdAt: "2026-10-06T02:56:26.243Z",
        updatedAt: "2026-10-06T02:56:26.243Z"
      },
      {
        id: "pane:bob",
        roomId: "room:1",
        title: "Bob",
        titleSource: "auto",
        mode: "TERMINAL",
        status: "IDLE",
        providerId: null,
        modelId: null,
        terminalRuntimeId: "cli:gemini",
        reasoningEffort: "medium",
        cwd: "/opt/spaceapp",
        order: 18,
        columnSpan: 1,
        isMaximized: false,
        isMinimized: false,
        isClosed: false,
        split: { parentId: null, direction: null, size: null },
        categoryColor: null,
        vncTarget: null,
        createdAt: "2026-10-06T02:56:26.409Z",
        updatedAt: "2026-10-06T02:56:26.409Z"
      }
    ];

    const baseOrder = existingPanes.reduce((max, p) => Math.max(max, p.order), -1) + 1;
    expect(baseOrder).toBe(19);

    const optimisticPane: any = {
      id: "pane:optimistic-test-0",
      roomId: "room:1",
      title: "Gemini CLI",
      titleSource: "auto",
      mode: "TERMINAL",
      status: "IDLE",
      providerId: null,
      modelId: null,
      terminalRuntimeId: "cli:gemini",
      reasoningEffort: "medium",
      cwd: "/opt/spaceapp",
      order: baseOrder,
      columnSpan: 1,
      isMaximized: false,
      isMinimized: false,
      isClosed: false,
      split: { parentId: null, direction: null, size: null },
      categoryColor: null,
      vncTarget: null,
      createdAt: "2026-10-06T04:16:24.000Z",
      updatedAt: "2026-10-06T04:16:24.000Z"
    };

    const placements = resolvePaneGridPlacements([...existingPanes, optimisticPane], 3, new Map());
    expect(placements.get("pane:andy")?.columnStart).toBe(1);
    expect(placements.get("pane:bob")?.columnStart).toBe(2);
    expect(placements.get("pane:optimistic-test-0")?.columnStart).toBe(3);
  });
});

