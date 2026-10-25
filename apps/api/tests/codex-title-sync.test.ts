import { describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { runCodexPaneTitleSync } from "../src/app.js";

function codexFixture(store: InMemorySpaceStore, overrides: { paneTitle?: string; titleSource?: "auto" | "manual" | "ai" } = {}) {
  const room = store.createRoom({ name: "Codex Title Sync", initialPaneCount: 0 });
  const pane = store.createPane({
    roomId: room.id,
    title: overrides.paneTitle ?? "Codex CLI 1",
    mode: "TERMINAL",
    terminalRuntimeId: "cli:codex",
    cwd: "/etc"
  });
  if (overrides.titleSource && overrides.titleSource !== "auto") {
    store.updatePane(pane.id, { titleSource: overrides.titleSource });
  }
  const revision = store.createCliTaskRevision({
    revisionId: "cli_revision:codex-sync-test",
    taskId: "cli_task:codex-sync-test",
    runtimeId: "cli:codex",
    providerId: "codex",
    agentId: "codex",
    nativeTaskRef: null,
    sourceRevisionId: null,
    latestSpaceSessionId: null,
    displayTitle: pane.title,
    firstUserMessage: "first message",
    preview: "",
    cwd: "/etc",
    modelId: null,
    reasoningEffort: "medium"
  });
  const session = store.createPaneCliSession({
    sessionId: "cli_session:codex-sync-test",
    paneId: pane.id,
    roomId: room.id,
    runtimeId: "cli:codex",
    providerId: "codex",
    agentId: "codex",
    modelId: null,
    reasoningEffort: "medium",
    cwd: "/etc",
    status: "RUNNING",
    isActive: true,
    purpose: "NORMAL",
    codexThreadId: "019fe594-086a-7043-83ff-0916eef40b8d",
    cliTaskId: "cli_task:codex-sync-test",
    cliTaskRevisionId: revision.revisionId
  });
  return { room, pane, session, revision };
}

function parityHarness(nativeTitle: string) {
  return {
    getHistoryThread: vi.fn(async () => ({ title: nativeTitle })),
    renameThread: vi.fn(async (threadId: string, title: string) => ({ id: threadId, title }))
  };
}

describe("runCodexPaneTitleSync", () => {
  it("transfers the native codex thread title into an auto pane and updates the task revision display title", async () => {
    const store = new InMemorySpaceStore();
    const { pane, session, revision } = codexFixture(store);
    const parity = parityHarness("Renamed Inside Codex");
    const publish = vi.fn();

    const updated = await runCodexPaneTitleSync({
      store,
      codexParity: parity,
      eventBus: { publish },
      traceIdPrefix: "test:codex-title-sync"
    });

    expect(updated).toBe(1);
    expect((await store.getPane(pane.id)).title).toBe("Renamed Inside Codex");
    expect((await store.getPane(pane.id)).titleSource).toBe("auto");
    expect((await store.getCliTaskRevision(session.cliTaskRevisionId!))?.displayTitle).toBe("Renamed Inside Codex");
    expect(parity.renameThread).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalled();
  });

  it("keeps manual panes and reverse-renames the native thread instead", async () => {
    const store = new InMemorySpaceStore();
    const { pane, session } = codexFixture(store, { paneTitle: "User Typed Title", titleSource: "manual" });
    const parity = parityHarness("Native Title");
    const publish = vi.fn();

    const updated = await runCodexPaneTitleSync({
      store,
      codexParity: parity,
      eventBus: { publish },
      traceIdPrefix: "test:codex-title-sync"
    });

    expect(updated).toBe(1);
    expect((await store.getPane(pane.id)).title).toBe("User Typed Title");
    expect(parity.renameThread).toHaveBeenCalledWith("019fe594-086a-7043-83ff-0916eef40b8d", "User Typed Title");
    expect((await store.getCliTaskRevision(session.cliTaskRevisionId!))?.displayTitle).toBe("User Typed Title");
  });

  it("skips panes whose title already matches the native thread title", async () => {
    const store = new InMemorySpaceStore();
    const { pane } = codexFixture(store, { paneTitle: "Same Title" });
    const parity = parityHarness("Same Title");
    const publish = vi.fn();

    const updated = await runCodexPaneTitleSync({
      store,
      codexParity: parity,
      eventBus: { publish },
      traceIdPrefix: "test:codex-title-sync"
    });

    expect(updated).toBe(0);
    expect((await store.getPane(pane.id)).title).toBe("Same Title");
    expect(parity.renameThread).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("skips the codex 'Untitled' placeholder thread title", async () => {
    const store = new InMemorySpaceStore();
    const { pane } = codexFixture(store);
    const parity = parityHarness("Untitled");
    const publish = vi.fn();

    const updated = await runCodexPaneTitleSync({
      store,
      codexParity: parity,
      eventBus: { publish },
      traceIdPrefix: "test:codex-title-sync"
    });

    expect(updated).toBe(0);
    expect((await store.getPane(pane.id)).title).toBe("Codex CLI 1");
    expect(parity.renameThread).not.toHaveBeenCalled();
  });
});