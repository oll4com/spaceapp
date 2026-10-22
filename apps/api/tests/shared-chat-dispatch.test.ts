import { cliToggleRuntimeIds } from "@space/contracts";
import { describe, expect, it } from "vitest";
import { InMemorySpaceStore, makeSpaceId } from "@space/runtime";
import {
  buildSharedChatDispatchPrompt,
  parseSharedChatMentions,
  pickSharedChatDispatchTarget,
  resolveSharedChatDispatchRuntimeIds
} from "../src/shared-chat-dispatch.js";

function createIdleDeepseekPane(store: InMemorySpaceStore, title: string) {
  const room = store.createRoom({ name: "Shared chat dispatch", initialPaneCount: 0 });
  const pane = store.createPane({
    roomId: room.id,
    title,
    mode: "TERMINAL",
    terminalRuntimeId: "cli:deepseek"
  });
  return { room, pane };
}

function createRunningSession(store: InMemorySpaceStore, roomId: string, paneId: string, runtimeId: string, updatedAt: string) {
  const sessionId = makeSpaceId("cli_session");
  store.createPaneCliSession({
    sessionId,
    paneId,
    roomId,
    runtimeId,
    providerId: runtimeId.slice("cli:".length),
    agentId: runtimeId.slice("cli:".length),
    modelId: null,
    reasoningEffort: "none",
    launchMode: "FRESH",
    purpose: "NORMAL",
    cwd: null,
    codexThreadId: null,
    cliTaskId: null,
    cliTaskRevisionId: null,
    accountProfileId: null,
    status: "RUNNING",
    statusReason: null,
    exitCode: null,
    isActive: true,
    startedAt: "2026-08-15T08:00:00.000Z",
    updatedAt,
    endedAt: null
  });
  return sessionId;
}

describe("parseSharedChatMentions", () => {
  it("returns no mentions for plain messages", () => {
    expect(parseSharedChatMentions("κάνε μου μια περίληψη του room")).toEqual(new Set());
    expect(parseSharedChatMentions("στείλε email στο test@deepseek.com")).toEqual(new Set());
  });

  it("parses a single mention", () => {
    expect(parseSharedChatMentions("@deepseek βοήθεια σε παρακαλώ")).toEqual(new Set(["cli:deepseek"]));
  });

  it("parses mentions followed by a colon", () => {
    expect(parseSharedChatMentions("@deepseek: βοήθεια")).toEqual(new Set(["cli:deepseek"]));
    expect(parseSharedChatMentions("Ρώτα @opencode: τι λες;")).toEqual(new Set(["cli:opencode"]));
  });

  it("parses multiple mentions case-insensitively", () => {
    expect(parseSharedChatMentions("Ρώτα @DeepSeek και μετά @CLAUDE")).toEqual(
      new Set(["cli:deepseek", "cli:claude"])
    );
  });

  it("does not match mention fragments inside other words", () => {
    expect(parseSharedChatMentions("μην γράψεις @deepseekx εδώ")).toEqual(new Set());
  });

  it("does not wake anyone for @codex-only messages (codex is excluded from dispatch)", () => {
    expect(parseSharedChatMentions("μίλα @codex")).toEqual(new Set(["cli:codex"]));
  });
});

describe("resolveSharedChatDispatchRuntimeIds", () => {
  const alwaysExcluded = new Set(["cli:codex"]);
  const mentionOnly = new Set(["cli:deepseek"]);

  it("targets every runtime except codex and deepseek for plain messages", () => {
    const runtimeIds = resolveSharedChatDispatchRuntimeIds("καλημέρα σε όλους");
    expect(runtimeIds.has("cli:codex")).toBe(false);
    expect(runtimeIds.has("cli:deepseek")).toBe(false);
    for (const runtimeId of cliToggleRuntimeIds) {
      if (alwaysExcluded.has(runtimeId) || mentionOnly.has(runtimeId)) continue;
      expect(runtimeIds.has(runtimeId)).toBe(true);
    }
  });

  it("includes deepseek only when explicitly mentioned", () => {
    expect(resolveSharedChatDispatchRuntimeIds("τι λέτε;").has("cli:deepseek")).toBe(false);
    expect(resolveSharedChatDispatchRuntimeIds("ρωτήστε @DeepSeek").has("cli:deepseek")).toBe(true);
    expect(resolveSharedChatDispatchRuntimeIds("ρωτήστε @deepseek: κάτι").has("cli:deepseek")).toBe(true);
  });

  it("never includes codex even when mentioned", () => {
    expect(resolveSharedChatDispatchRuntimeIds("μίλα @codex").has("cli:codex")).toBe(false);
  });

  it("does not treat email addresses as deepseek mentions", () => {
    expect(resolveSharedChatDispatchRuntimeIds("στείλε στο a@deepseek.com").has("cli:deepseek")).toBe(false);
  });
});

describe("pickSharedChatDispatchTarget", () => {
  it("returns null when the runtime has no sessions", async () => {
    const store = new InMemorySpaceStore();
    expect(await pickSharedChatDispatchTarget(store, "cli:deepseek")).toBeNull();
  });

  it("picks the most recently updated eligible pane for the requested runtime", async () => {
    const store = new InMemorySpaceStore();
    const older = createIdleDeepseekPane(store, "Deepseek A");
    const newer = createIdleDeepseekPane(store, "Deepseek B");
    createRunningSession(store, older.room.id, older.pane.id, "cli:deepseek", "2026-08-15T09:00:00.000Z");
    createRunningSession(store, newer.room.id, newer.pane.id, "cli:deepseek", "2026-08-15T10:00:00.000Z");

    const target = await pickSharedChatDispatchTarget(store, "cli:deepseek");
    expect(target).not.toBeNull();
    expect(target!.pane.id).toBe(newer.pane.id);
  });

  it("only considers the requested runtime", async () => {
    const store = new InMemorySpaceStore();
    const claude = createIdleDeepseekPane(store, "Claude pane");
    createRunningSession(store, claude.room.id, claude.pane.id, "cli:claude", "2026-08-15T09:00:00.000Z");
    expect(await pickSharedChatDispatchTarget(store, "cli:deepseek")).toBeNull();
  });

  it("skips RUNNING, closed and non-NORMAL panes/sessions", async () => {
    const store = new InMemorySpaceStore();
    const idle = createIdleDeepseekPane(store, "Idle deepseek");
    createRunningSession(store, idle.room.id, idle.pane.id, "cli:deepseek", "2026-08-15T09:00:00.000Z");

    const runningRoom = store.createRoom({ name: "running", initialPaneCount: 0 });
    const runningPane = store.createPane({
      roomId: runningRoom.id,
      title: "Running deepseek",
      mode: "TERMINAL",
      terminalRuntimeId: "cli:deepseek"
    });
    store.updatePane(runningPane.id, { status: "RUNNING" });
    createRunningSession(store, runningRoom.id, runningPane.id, "cli:deepseek", "2026-08-15T11:00:00.000Z");

    const closedRoom = store.createRoom({ name: "closed", initialPaneCount: 0 });
    const closedPane = store.createPane({
      roomId: closedRoom.id,
      title: "Closed deepseek",
      mode: "TERMINAL",
      terminalRuntimeId: "cli:deepseek"
    });
    store.updatePane(closedPane.id, { isClosed: true });

    const target = await pickSharedChatDispatchTarget(store, "cli:deepseek");
    expect(target).not.toBeNull();
    expect(target!.pane.id).toBe(idle.pane.id);
  });
});

describe("buildSharedChatDispatchPrompt", () => {
  it("never embeds mention tokens and points to the shell posting helper", () => {
    const prompt = buildSharedChatDispatchPrompt("τι κάνεις;", "Deepseek pane", "cli:deepseek");
    expect(prompt).not.toContain("@deepseek");
    expect(prompt).toContain("The operator wrote in the Shared Chat");
    expect(prompt).toContain("τι κάνεις;");
    expect(prompt).toContain("/opt/spaceapp/scripts/space-chat-post.sh");
    expect(prompt).toContain("--runtime \"cli:deepseek\"");
    // Enter is pressed separately after the paste (submitCliPrompt), never inside the typed text.
    expect(prompt).not.toMatch(/[\r\n]$/);
  });
});
