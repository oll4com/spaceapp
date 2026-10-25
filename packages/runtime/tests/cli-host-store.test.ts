import { splitCliHostTranscriptContent, createPaneCliTranscriptChunkInputSchema } from "@space/contracts";
import { describe, expect, it } from "vitest";
import { InMemorySpaceStore, SpaceConflictError } from "../src/index.js";

function createCliFixture() {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "CLI host", initialPaneCount: 0 }, "trace:cli-host");
  const firstPane = store.createPane({ roomId: room.id, title: "CLI 1", mode: "TERMINAL", cwd: "/etc" }, "trace:cli-host");
  const secondPane = store.createPane({ roomId: room.id, title: "CLI 2", mode: "TERMINAL", cwd: "/etc" }, "trace:cli-host");
  const firstSession = store.createPaneCliSession({
    sessionId: "cli_session:host-alpha",
    paneId: firstPane.id,
    roomId: room.id,
    runtimeId: "cli:codex",
    providerId: "codex",
    agentId: "codex",
    modelId: null,
    reasoningEffort: "high",
    cwd: "/etc",
    codexThreadId: null,
    status: "RUNNING",
    isActive: true
  });
  const secondSession = store.createPaneCliSession({
    sessionId: "cli_session:host-beta",
    paneId: secondPane.id,
    roomId: room.id,
    runtimeId: "cli:codex",
    providerId: "codex",
    agentId: "codex",
    modelId: null,
    reasoningEffort: "high",
    cwd: "/etc",
    codexThreadId: null,
    status: "RUNNING",
    isActive: true
  });
  return { store, room, firstPane, secondPane, firstSession, secondSession };
}

describe("CLI host persistence", () => {
  it("stores a replayed host output sequence exactly once", () => {
    const { store, room, firstPane, firstSession } = createCliFixture();
    const input = {
      sessionId: firstSession.sessionId,
      paneId: firstPane.id,
      roomId: room.id,
      generationId: "019f4e26-28e1-7cb8-8e82-5fe14f793741",
      outputSequence: 0,
      stream: "stdout" as const,
      content: "same host output"
    };

    const first = store.appendPaneCliHostOutputChunk(input, "trace:host-output");
    const replay = store.appendPaneCliHostOutputChunk(input, "trace:host-output-replay");

    expect(replay.chunkId).toBe(first.chunkId);
    expect(store.listPaneCliTranscriptChunks(firstSession.sessionId)).toHaveLength(1);
    expect(store.getPaneCliHostOutputCursor(firstSession.sessionId, input.generationId)).toBe(0);
  });

  it.each([40000, 14000, 24000])("splits oversized output and deduplicates batch of size %i", (size) => {
    const content = size === 40000 ? "x".repeat(size) : size === 24000 ? "漢".repeat(size) : "α😀漢".repeat(size);
    const { store, room, firstPane, firstSession } = createCliFixture();
    const input = {
      sessionId: firstSession.sessionId, paneId: firstPane.id, roomId: room.id,
      generationId: "019f4e26-28e1-7cb8-8e82-5fe14f793741",
      outputSequence: 7, stream: "stdout" as const, content
    };
    const final = store.appendPaneCliHostOutputChunk(input);
    const rows = store.listPaneCliTranscriptChunks(firstSession.sessionId);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.map(row => row.content).join("")).toBe(content);
    expect(rows.every(row => row.content.length <= 32768 && row.byteLength <= 65536)).toBe(true);
    expect(rows.slice(0, -1).every(row => row.hostOutputSequence === null)).toBe(true);
    expect(rows.at(-1)?.hostOutputSequence).toBe(7);
    expect(store.appendPaneCliHostOutputChunk(input).chunkId).toBe(final.chunkId);
    expect(store.listPaneCliTranscriptChunks(firstSession.sessionId)).toEqual(rows);
    expect(store.getPaneCliHostOutputCursor(firstSession.sessionId, input.generationId)).toBe(7);
  });

  it("keeps redaction markers and surrogate pairs valid at row boundaries", () => {
    for (let offset = 15987; offset < 16002; offset++) {
      const content = " ".repeat(offset) + "token:[REDACTED] 😀" + " ".repeat(40000);
      const chunks = splitCliHostTranscriptContent(content);
      expect(chunks.join("")).toBe(content);
      for (const chunk of chunks) {
        expect(() => createPaneCliTranscriptChunkInputSchema.parse({
          sessionId: "cli_session:test", paneId: "pane:test", roomId: "room:test",
          sequence: 0, stream: "stdout", content: chunk, byteLength: Buffer.byteLength(chunk)
        })).not.toThrow();
      }
    }
  });

  it("rejects silent cross-pane thread claims but allows explicit history transfer", () => {
    const { store, firstSession, secondSession, secondPane } = createCliFixture();
    const threadId = "019f4e26-6780-778a-9acd-c72c780a634a";
    const forkedThreadId = "019f4e27-6780-778a-9acd-c72c780a634b";

    const initial = store.claimPaneCliCodexThread(firstSession.sessionId, threadId, "AUTO", "trace:auto-claim");
    expect(initial).toMatchObject({ cliSessionId: firstSession.sessionId, source: "AUTO" });
    store.updatePaneCliSession(firstSession.sessionId, { status: "EXITED", isActive: false });

    expect(() =>
      store.claimPaneCliCodexThread(secondSession.sessionId, threadId, "AUTO", "trace:silent-cross-pane")
    ).toThrow(SpaceConflictError);

    const transferred = store.claimPaneCliCodexThread(
      secondSession.sessionId,
      threadId,
      "HISTORY_TRANSFER",
      "trace:history-transfer"
    );
    expect(transferred).toMatchObject({
      threadId,
      cliSessionId: secondSession.sessionId,
      paneId: secondPane.id,
      source: "HISTORY_TRANSFER"
    });
    expect(store.getPaneCliSession(firstSession.sessionId)?.codexThreadId).toBeNull();
    expect(store.getPaneCliSession(secondSession.sessionId)?.codexThreadId).toBe(threadId);

    const rebound = store.claimPaneCliCodexThread(
      secondSession.sessionId,
      forkedThreadId,
      "AUTO",
      "trace:fork-auto-bind"
    );
    expect(rebound).toMatchObject({
      threadId: forkedThreadId,
      cliSessionId: secondSession.sessionId,
      source: "AUTO"
    });
    expect(store.getPaneCliSession(secondSession.sessionId)?.codexThreadId).toBe(forkedThreadId);
    expect(store.getPaneCliCodexThreadOwnership(threadId)).toBeNull();
  });
});
