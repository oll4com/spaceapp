import { describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { runGenericCliPaneTitleSync } from "../src/app.js";

function genericFixture(
  store: InMemorySpaceStore,
  overrides: { paneTitle?: string; titleSource?: "auto" | "manual" | "ai"; firstUserMessage?: string | null; runtimeId?: string } = {}
) {
  const runtimeId = overrides.runtimeId ?? "cli:deepseek";
  const room = store.createRoom({ name: "Generic Title Sync", initialPaneCount: 0 });
  const pane = store.createPane({
    roomId: room.id,
    title: overrides.paneTitle ?? "DeepSeek CLI 1",
    mode: "TERMINAL",
    terminalRuntimeId: runtimeId,
    cwd: "/etc"
  });
  if (overrides.titleSource && overrides.titleSource !== "auto") {
    store.updatePane(pane.id, { titleSource: overrides.titleSource });
  }
  const revision = store.createCliTaskRevision({
    revisionId: "cli_revision:generic-sync-test",
    taskId: "cli_task:generic-sync-test",
    runtimeId,
    providerId: "deepseek",
    agentId: "deepseek",
    nativeTaskRef: null,
    sourceRevisionId: null,
    latestSpaceSessionId: null,
    displayTitle: pane.title,
    firstUserMessage: overrides.firstUserMessage === undefined
      ? "Πρόσθεσε τη γενική συγχρονισμένη τιμή τίτλου panes"
      : overrides.firstUserMessage,
    preview: "",
    cwd: "/etc",
    modelId: null,
    reasoningEffort: "medium"
  });
  const session = store.createPaneCliSession({
    sessionId: "cli_session:generic-sync-test",
    paneId: pane.id,
    roomId: room.id,
    runtimeId,
    providerId: "deepseek",
    agentId: "deepseek",
    modelId: null,
    reasoningEffort: "medium",
    cwd: "/etc",
    status: "RUNNING",
    isActive: true,
    purpose: "NORMAL",
    cliTaskId: "cli_task:generic-sync-test",
    cliTaskRevisionId: revision.revisionId
  });
  return { room, pane, session, revision };
}

describe("runGenericCliPaneTitleSync", () => {
  it("sets an auto pane title from the task first user message and updates the revision display title", async () => {
    const store = new InMemorySpaceStore();
    const { pane, session } = genericFixture(store);
    const publish = vi.fn();

    const updated = await runGenericCliPaneTitleSync({
      store,
      eventBus: { publish },
      traceIdPrefix: "test:generic-title-sync"
    });

    expect(updated).toBe(1);
    expect((await store.getPane(pane.id)).title).toBe("Πρόσθεσε τη γενική συγχρονισμένη τιμή τίτλου panes");
    expect((await store.getPane(pane.id)).titleSource).toBe("auto");
    expect((await store.getCliTaskRevision(session.cliTaskRevisionId!))?.displayTitle).toBe(
      "Πρόσθεσε τη γενική συγχρονισμένη τιμή τίτλου panes"
    );
    expect(publish).toHaveBeenCalled();
  });

  it("falls back to a meaningful stdin transcript request when the first user message is terminal noise", async () => {
    const store = new InMemorySpaceStore();
    const { pane, session, room } = genericFixture(store, { firstUserMessage: "\u001b[<0;24;10M" });
    store.appendPaneCliTranscriptChunk({
      sessionId: session.sessionId,
      paneId: pane.id,
      roomId: room.id,
      sequence: 0,
      stream: "stdin",
      content: "Ενημέρωσε το setup του spaceapp και έλεγξε την έκδοση"
    });
    const publish = vi.fn();

    const updated = await runGenericCliPaneTitleSync({
      store,
      eventBus: { publish },
      traceIdPrefix: "test:generic-title-sync"
    });

    expect(updated).toBe(1);
    expect((await store.getPane(pane.id)).title).toBe("Ενημέρωσε το setup του spaceapp και έλεγξε την έκδοση");
  });

  it("never overwrites manual or ai-generated titles", async () => {
    for (const titleSource of ["manual", "ai"] as const) {
      const store = new InMemorySpaceStore();
      const { pane } = genericFixture(store, { paneTitle: "Κρατημένος τίτλος", titleSource });
      const publish = vi.fn();

      const updated = await runGenericCliPaneTitleSync({
        store,
        eventBus: { publish },
        traceIdPrefix: "test:generic-title-sync"
      });

      expect(updated).toBe(0);
      expect((await store.getPane(pane.id)).title).toBe("Κρατημένος τίτλος");
      expect(publish).not.toHaveBeenCalled();
    }
  });

  it("skips panes whose title already matches the candidate", async () => {
    const store = new InMemorySpaceStore();
    const { pane } = genericFixture(store, { paneTitle: "Πρόσθεσε τη γενική συγχρονισμένη τιμή τίτλου panes" });
    const publish = vi.fn();

    const updated = await runGenericCliPaneTitleSync({
      store,
      eventBus: { publish },
      traceIdPrefix: "test:generic-title-sync"
    });

    expect(updated).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it("skips sessions without a meaningful request", async () => {
    const store = new InMemorySpaceStore();
    const { pane } = genericFixture(store, { firstUserMessage: "" });
    const publish = vi.fn();

    const updated = await runGenericCliPaneTitleSync({
      store,
      eventBus: { publish },
      traceIdPrefix: "test:generic-title-sync"
    });

    expect(updated).toBe(0);
    expect((await store.getPane(pane.id)).title).toBe("DeepSeek CLI 1");
  });

  it("does not touch opencode or codex sessions", async () => {
    for (const runtimeId of ["cli:opencode", "cli:codex"]) {
      const store = new InMemorySpaceStore();
      const { pane } = genericFixture(store, { runtimeId });
      const publish = vi.fn();

      const updated = await runGenericCliPaneTitleSync({
        store,
        eventBus: { publish },
        traceIdPrefix: "test:generic-title-sync"
      });

      expect(updated).toBe(0);
      expect((await store.getPane(pane.id)).title).toBe("DeepSeek CLI 1");
    }
  });
});
