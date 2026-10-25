import type { Event as SpaceEvent } from "@space/contracts";
import { describe, expect, it } from "vitest";
import {
  acknowledgePaneCompletion,
  applyPaneCompletionEvents,
  createPaneCompletionLifecycleState,
  hydratePaneCompletionRoom,
  hydratePaneCompletionReplay,
  pendingPaneCompletionEventId
} from "../src/pane-completion-lifecycle.js";

function lifecycleEvent(input: {
  id: string;
  paneId?: string;
  type: "TURN_STARTED" | "TURN_COMPLETED" | "TURN_FAILED";
  runId: string;
  createdAt: string;
}): SpaceEvent {
  return {
    id: input.id,
    roomId: "room:test",
    paneId: input.paneId ?? "pane:test",
    turnId: null,
    workflowId: null,
    traceId: `trace:${input.id}`,
    type: input.type,
    message: input.type,
    payload: { runId: input.runId },
    createdAt: input.createdAt
  };
}

describe("pane completion lifecycle", () => {
  it("treats historical completions as a baseline and keeps END hidden for a newer running run", () => {
    const state = hydratePaneCompletionRoom(createPaneCompletionLifecycleState(), "room:test", [
      lifecycleEvent({ id: "completed:old", type: "TURN_COMPLETED", runId: "old", createdAt: "2026-08-10T06:00:01.000Z" }),
      lifecycleEvent({ id: "started:old", type: "TURN_STARTED", runId: "old", createdAt: "2026-08-10T06:00:00.000Z" }),
      lifecycleEvent({ id: "started:new", type: "TURN_STARTED", runId: "new", createdAt: "2026-08-10T06:00:02.000Z" })
    ]);

    expect(pendingPaneCompletionEventId(state, "pane:test")).toBeNull();
    expect(state.panes["pane:test"]?.activeRunKey).toBe("run:new");
  });

  it("shows one END only for the matching successful completion", () => {
    let state = hydratePaneCompletionRoom(createPaneCompletionLifecycleState(), "room:test", []);
    state = applyPaneCompletionEvents(state, [
      lifecycleEvent({ id: "started:new", type: "TURN_STARTED", runId: "new", createdAt: "2026-08-10T06:00:02.000Z" })
    ]);
    state = applyPaneCompletionEvents(state, [
      lifecycleEvent({ id: "completed:stale", type: "TURN_COMPLETED", runId: "old", createdAt: "2026-08-10T06:00:03.000Z" }),
      lifecycleEvent({ id: "completed:new", type: "TURN_COMPLETED", runId: "new", createdAt: "2026-08-10T06:00:04.000Z" })
    ]);

    expect(pendingPaneCompletionEventId(state, "pane:test")).toBe("completed:new");
    expect(applyPaneCompletionEvents(state, [
      lifecycleEvent({ id: "completed:new", type: "TURN_COMPLETED", runId: "new", createdAt: "2026-08-10T06:00:04.000Z" })
    ])).toBe(state);
  });

  it("acknowledges the current completion without acknowledging a future run", () => {
    let state = hydratePaneCompletionRoom(createPaneCompletionLifecycleState(), "room:test", []);
    state = applyPaneCompletionEvents(state, [
      lifecycleEvent({ id: "started:one", type: "TURN_STARTED", runId: "one", createdAt: "2026-08-10T06:00:00.000Z" }),
      lifecycleEvent({ id: "completed:one", type: "TURN_COMPLETED", runId: "one", createdAt: "2026-08-10T06:00:01.000Z" })
    ]);
    state = acknowledgePaneCompletion(state, "pane:test");
    expect(pendingPaneCompletionEventId(state, "pane:test")).toBeNull();

    state = applyPaneCompletionEvents(state, [
      lifecycleEvent({ id: "started:two", type: "TURN_STARTED", runId: "two", createdAt: "2026-08-10T06:00:02.000Z" }),
      lifecycleEvent({ id: "completed:two", type: "TURN_COMPLETED", runId: "two", createdAt: "2026-08-10T06:00:03.000Z" })
    ]);
    expect(pendingPaneCompletionEventId(state, "pane:test")).toBe("completed:two");
  });

  it("never shows END for failed, aborted-style, stale, or uncorrelated events", () => {
    let state = hydratePaneCompletionRoom(createPaneCompletionLifecycleState(), "room:test", []);
    state = applyPaneCompletionEvents(state, [
      lifecycleEvent({ id: "started:failed", type: "TURN_STARTED", runId: "failed", createdAt: "2026-08-10T06:00:00.000Z" }),
      lifecycleEvent({ id: "failed", type: "TURN_FAILED", runId: "failed", createdAt: "2026-08-10T06:00:01.000Z" }),
      lifecycleEvent({ id: "completed:unknown", type: "TURN_COMPLETED", runId: "unknown", createdAt: "2026-08-10T06:00:02.000Z" })
    ]);
    expect(pendingPaneCompletionEventId(state, "pane:test")).toBeNull();
  });

  it("tracks independent pane types with the same provider-neutral state machine", () => {
    let state = hydratePaneCompletionRoom(createPaneCompletionLifecycleState(), "room:test", []);
    state = applyPaneCompletionEvents(state, [
      lifecycleEvent({ id: "started:chat", paneId: "pane:chat", type: "TURN_STARTED", runId: "chat", createdAt: "2026-08-10T06:00:00.000Z" }),
      lifecycleEvent({ id: "started:claude", paneId: "pane:claude", type: "TURN_STARTED", runId: "claude", createdAt: "2026-08-10T06:00:00.500Z" }),
      lifecycleEvent({ id: "completed:chat", paneId: "pane:chat", type: "TURN_COMPLETED", runId: "chat", createdAt: "2026-08-10T06:00:01.000Z" }),
      lifecycleEvent({ id: "completed:claude", paneId: "pane:claude", type: "TURN_COMPLETED", runId: "claude", createdAt: "2026-08-10T06:00:01.500Z" })
    ]);

    expect(pendingPaneCompletionEventId(state, "pane:chat")).toBe("completed:chat");
    expect(pendingPaneCompletionEventId(state, "pane:claude")).toBe("completed:claude");
  });

  it("preserves an immediate live start when initial history hydrates afterward", () => {
    let state = applyPaneCompletionEvents(createPaneCompletionLifecycleState(), [
      lifecycleEvent({ id: "started:live", type: "TURN_STARTED", runId: "live", createdAt: "2026-08-10T06:00:02.000Z" })
    ]);
    state = hydratePaneCompletionRoom(state, "room:test", [
      lifecycleEvent({ id: "started:history", type: "TURN_STARTED", runId: "history", createdAt: "2026-08-10T06:00:00.000Z" }),
      lifecycleEvent({ id: "completed:history", type: "TURN_COMPLETED", runId: "history", createdAt: "2026-08-10T06:00:01.000Z" })
    ]);

    expect(state.panes["pane:test"]?.activeRunKey).toBe("run:live");
    expect(pendingPaneCompletionEventId(state, "pane:test")).toBeNull();
  });

  it("treats the initial SSE replay as historical after room metadata hydrated first", () => {
    let state = hydratePaneCompletionRoom(createPaneCompletionLifecycleState(), "room:test", []);
    state = hydratePaneCompletionReplay(state, "room:test", [
      lifecycleEvent({ id: "started:history", type: "TURN_STARTED", runId: "history", createdAt: "2026-08-10T06:00:00.000Z" }),
      lifecycleEvent({ id: "completed:history", type: "TURN_COMPLETED", runId: "history", createdAt: "2026-08-10T06:00:01.000Z" })
    ]);

    expect(pendingPaneCompletionEventId(state, "pane:test")).toBeNull();

    state = applyPaneCompletionEvents(state, [
      lifecycleEvent({ id: "started:live", type: "TURN_STARTED", runId: "live", createdAt: "2026-08-10T06:00:02.000Z" }),
      lifecycleEvent({ id: "completed:live", type: "TURN_COMPLETED", runId: "live", createdAt: "2026-08-10T06:00:03.000Z" })
    ]);
    expect(pendingPaneCompletionEventId(state, "pane:test")).toBe("completed:live");
  });

  it("keeps a delayed completion hidden when its run started in the reload baseline", () => {
    let state = hydratePaneCompletionRoom(createPaneCompletionLifecycleState(), "room:test", [
      lifecycleEvent({
        id: "started:before-reload",
        type: "TURN_STARTED",
        runId: "before-reload",
        createdAt: "2026-08-10T06:00:00.000Z"
      })
    ]);

    expect(state.panes["pane:test"]?.activeRunKey).toBe("run:before-reload");
    expect(state.panes["pane:test"]?.activeRunAllowsCompletion).toBe(false);

    state = applyPaneCompletionEvents(state, [
      lifecycleEvent({
        id: "completed:after-reload",
        type: "TURN_COMPLETED",
        runId: "before-reload",
        createdAt: "2026-08-10T06:00:02.000Z"
      })
    ]);

    expect(pendingPaneCompletionEventId(state, "pane:test")).toBeNull();
    expect(state.panes["pane:test"]?.latestCompletionEventId).toBe("completed:after-reload");

    state = applyPaneCompletionEvents(state, [
      lifecycleEvent({
        id: "started:live",
        type: "TURN_STARTED",
        runId: "live",
        createdAt: "2026-08-10T06:00:03.000Z"
      }),
      lifecycleEvent({
        id: "completed:live",
        type: "TURN_COMPLETED",
        runId: "live",
        createdAt: "2026-08-10T06:00:04.000Z"
      })
    ]);

    expect(pendingPaneCompletionEventId(state, "pane:test")).toBe("completed:live");
  });
});
