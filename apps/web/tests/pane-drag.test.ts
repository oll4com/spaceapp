import { describe, expect, it, vi } from "vitest";
import type { Pane, Room, CliTaskHistoryItem, PaneCliSession } from "@space/contracts";
import {
  SPACE_PANE_CONTEXT_MIME,
  buildPaneTaskContextBlock,
  formatPaneContextBlock,
  paneContextDragPayload,
  readPaneContextDragPayload,
  reorderPanesByTarget,
  setPaneDragData
} from "../src/features/pane-drag/pane-drag.js";

function makePane(input: Partial<Pane> = {}): Pane {
  return {
    id: "pane:test",
    roomId: "room:test",
    title: "Codex Agent",
    mode: "TERMINAL",
    status: "IDLE",
    providerId: null,
    modelId: null,
    reasoningEffort: "medium",
    cwd: null,
    order: 0,
    columnSpan: 1,
    isMaximized: false,
    isMinimized: false,
    isClosed: false,
    split: { parentId: null, direction: null, size: null },
    terminalRuntimeId: null,
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
    ...input
  } as Pane;
}

function makeRoom(input: Partial<Room> = {}): Room {
  return {
    id: "room:test",
    name: "Test Room",
    description: null,
    kind: "WORKSPACE",
    order: 0,
    paneLayoutColumns: null,
    paneCap: 16,
    traceId: "trace:test",
    archivedAt: null,
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
    ...input
  } as Room;
}

describe("pane context drag payload", () => {
  it("builds a payload with pane identity and room metadata", () => {
    const pane = makePane({ id: "pane:x", title: 'He said "hi"', terminalRuntimeId: "cli:codex" });
    const payload = paneContextDragPayload(pane, makeRoom({ name: "Ops" }));
    expect(payload).toEqual({
      id: "pane:x",
      title: 'He said "hi"',
      mode: "TERMINAL",
      runtimeId: "cli:codex",
      roomId: "room:test",
      roomName: "Ops"
    });
  });

  it("falls back to the pane room id when no room is provided", () => {
    const pane = makePane({ id: "pane:x", terminalRuntimeId: null });
    const payload = paneContextDragPayload(pane, null);
    expect(payload.roomId).toBe("room:test");
    expect(payload.roomName).toBe("");
  });
});

describe("setPaneDragData", () => {
  it("stores the pane id on text/plain and a JSON payload on the Space MIME", () => {
    const dataTransfer = {
      effectAllowed: "uninitialized",
      setData: vi.fn()
    } as unknown as DataTransfer & { effectAllowed: string };
    setPaneDragData({ dataTransfer }, makePane(), makeRoom());

    expect(dataTransfer.effectAllowed).toBe("move");
    expect(dataTransfer.setData).toHaveBeenCalledWith("text/plain", "pane:test");
    expect(dataTransfer.setData).toHaveBeenCalledWith(
      SPACE_PANE_CONTEXT_MIME,
      expect.stringContaining('"id":"pane:test"')
    );
  });
});

describe("readPaneContextDragPayload", () => {
  function dataTransferWith(record: Record<string, string>): DataTransfer {
    return {
      getData: (mime: string) => record[mime] ?? ""
    } as unknown as DataTransfer;
  }

  it("parses a valid pane context payload", () => {
    const raw = JSON.stringify({ id: "pane:x", title: "Agent", mode: "TERMINAL", roomId: "room:test", roomName: "Ops" });
    const payload = readPaneContextDragPayload(dataTransferWith({ [SPACE_PANE_CONTEXT_MIME]: raw }));
    expect(payload).toMatchObject({ id: "pane:x", roomId: "room:test", roomName: "Ops" });
  });

  it("returns null when the payload is missing or malformed", () => {
    expect(readPaneContextDragPayload(dataTransferWith({}))).toBeNull();
    expect(readPaneContextDragPayload(dataTransferWith({ [SPACE_PANE_CONTEXT_MIME]: "not-json" }))).toBeNull();
    expect(
      readPaneContextDragPayload(dataTransferWith({ [SPACE_PANE_CONTEXT_MIME]: JSON.stringify({ id: "pane:x" }) }))
    ).toBeNull();
  });
});

describe("reorderPanesByTarget", () => {
  function panes(ids: string[]): Pane[] {
    return ids.map((id, index) => makePane({ id, order: index }));
  }

  it("replaces the target slot and cascades later panes down when dragging forward", () => {
    const [a, b, c, d, e] = panes(["pane:a", "pane:b", "pane:c", "pane:d", "pane:e"]);
    const result = reorderPanesByTarget([a!, b!, c!, d!, e!], "pane:a", "pane:d");
    expect(result.map((pane) => pane.id)).toEqual(["pane:b", "pane:c", "pane:a", "pane:d", "pane:e"]);
    expect(result.map((pane) => pane.order)).toEqual([0, 1, 2, 3, 4]);
  });

  it("replaces the target slot and cascades later panes down when dragging backward", () => {
    const [a, b, c, d, e] = panes(["pane:a", "pane:b", "pane:c", "pane:d", "pane:e"]);
    const result = reorderPanesByTarget([a!, b!, c!, d!, e!], "pane:e", "pane:b");
    expect(result.map((pane) => pane.id)).toEqual(["pane:a", "pane:e", "pane:b", "pane:c", "pane:d"]);
    expect(result.map((pane) => pane.order)).toEqual([0, 1, 2, 3, 4]);
  });

  it("is a no-op when dragging onto itself or an unknown pane", () => {
    const [a, b] = panes(["pane:a", "pane:b"]);
    const ab: Pane[] = [a!, b!];
    expect(reorderPanesByTarget(ab, "pane:a", "pane:a")).toBe(ab);
    expect(reorderPanesByTarget(ab, "pane:missing", "pane:b")).toBe(ab);
    expect(reorderPanesByTarget(ab, "pane:a", "pane:missing")).toBe(ab);
  });

  it("inserts after the target pane when position is after (e.g. bottom pane to the right of top pane)", () => {
    const [a, b, c] = panes(["pane:top", "pane:youtube", "pane:bottom"]);
    // Moving bottom pane after top pane (places it to the right of top pane in grid)
    const result = reorderPanesByTarget([a!, b!, c!], "pane:bottom", "pane:top", "after");
    expect(result.map((pane) => pane.id)).toEqual(["pane:top", "pane:bottom", "pane:youtube"]);
    expect(result.map((pane) => pane.order)).toEqual([0, 1, 2]);
  });

  it("inserts after the target pane when dragging forward", () => {
    const [a, b, c, d, e] = panes(["pane:a", "pane:b", "pane:c", "pane:d", "pane:e"]);
    const result = reorderPanesByTarget([a!, b!, c!, d!, e!], "pane:a", "pane:d", "after");
    expect(result.map((pane) => pane.id)).toEqual(["pane:b", "pane:c", "pane:d", "pane:a", "pane:e"]);
    expect(result.map((pane) => pane.order)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("formatPaneContextBlock", () => {
  it("produces a single-line block the CLI can parse", () => {
    const block = formatPaneContextBlock({
      id: "pane:x",
      title: 'He said "hi"',
      mode: "TERMINAL",
      runtimeId: "cli:codex",
      roomId: "room:test",
      roomName: "Ops"
    });
    expect(block).toContain("[Space pane]");
    expect(block).toContain("id=pane:x");
    expect(block).toContain("mode=TERMINAL/cli:codex");
    expect(block).toContain("room=Ops (room:test)");
    expect(block).toContain("title=\"He said 'hi'\"");
    expect(block).not.toContain("\n");
  });
});

describe("buildPaneTaskContextBlock", () => {
  const payload = {
    id: "pane:kimi",
    title: "Kimi Code CLI",
    mode: "TERMINAL",
    runtimeId: "cli:kimi",
    roomId: "room:test",
    roomName: "Ops"
  };
  const task: CliTaskHistoryItem = {
    id: "cli_task:x",
    taskId: "cli_task:x",
    revisionId: "cli_revision:1",
    title: "Fix toolbar system services",
    runtimeId: "cli:kimi",
    providerId: "kimi",
    providerLabel: "Kimi Code",
    modelProvider: "kimi",
    preview: "Fix toolbar_system_services detached/reap logic",
    firstUserMessage: "κανε ενα πλανο συνεχισεις αυτου του τασκ",
    cwd: "/opt/spaceapp",
    model: "kimi-k3",
    reasoningEffort: "high",
    updatedAt: "2026-08-04T12:30:00.000Z",
    recencyAt: "2026-08-04T12:30:00.000Z",
    archived: false,
    source: "space",
    threadSource: "cli:kimi",
    rolloutPath: null
  };
  const session: PaneCliSession = {
    sessionId: "cli_session:x",
    paneId: "pane:kimi",
    roomId: "room:test",
    runtimeId: "cli:kimi",
    providerId: "kimi",
    agentId: "kimi",
    modelId: "kimi-k3",
    reasoningEffort: "high",
    launchMode: "FRESH",
    purpose: "NORMAL",
    cwd: "/srv/workspace",
    codexThreadId: null,
    cliTaskId: "cli_task:x",
    cliTaskRevisionId: "rev_task:1",
    accountProfileId: null,
    status: "RUNNING",
    statusReason: null,
    exitCode: null,
    isActive: true,
    startedAt: "2026-08-04T12:15:51.000Z",
    updatedAt: "2026-08-04T12:20:00.000Z",
    endedAt: null
  };

  it("builds a security-guarded block with task and session metadata", () => {
    const block = buildPaneTaskContextBlock(payload, task, session, "opencode");
    expect(block).toContain("[SPACE_PANE_TASK_CONTEXT_BEGIN]");
    expect(block).toContain("[SPACE_PANE_TASK_CONTEXT_END]");
    expect(block).toContain("[Space pane] id=pane:kimi");
    expect(block).toContain("task=cli_task:x");
    expect(block).toContain("source=Kimi Code (cli:kimi)");
    expect(block).toContain("model=kimi-k3");
    expect(block).toContain("cwd=/opt/spaceapp");
    expect(block).toContain("session=cli_session:x status=RUNNING");
    expect(block).toContain("Request: κανε ενα πλανο");
    expect(block).toContain("Continue the task which originated in the Kimi Code CLI pane in this fresh opencode session.");
  });

  it("marks an inactive session as ended", () => {
    const block = buildPaneTaskContextBlock(
      payload,
      null,
      { ...session, isActive: false, status: "EXITED" },
      "codex"
    );
    expect(block).toContain("status=EXITED (ended)");
  });

  it("falls back to a metadata-only block when no task exists", () => {
    const block = buildPaneTaskContextBlock(payload, null, null, "codex");
    expect(block).not.toContain("cli_task:x");
    expect(block).toContain("[Space pane] id=pane:kimi");
  });
});
