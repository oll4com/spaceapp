import { describe, expect, it } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { UnifiedCliTaskRegistry } from "../unified-cli-task-registry.js";

function appendTask(
  store: InMemorySpaceStore,
  input: {
    runtimeId: string;
    providerId: string;
    title: string;
    firstUserMessage: string;
    response: string;
    codexThreadId?: string | null;
    cliTaskId?: string;
    cliTaskRevisionId?: string;
  }
) {
  const room = store.createRoom({ name: `${input.title} room`, initialPaneCount: 0 });
  const pane = store.createPane({
    roomId: room.id,
    title: input.title,
    mode: "TERMINAL",
    terminalRuntimeId: input.runtimeId,
    cwd: "/etc"
  });
  const session = store.createPaneCliSession({
    paneId: pane.id,
    roomId: room.id,
    runtimeId: input.runtimeId,
    providerId: input.providerId,
    agentId: input.runtimeId.slice("cli:".length),
    modelId: null,
    reasoningEffort: "medium",
    launchMode: "FRESH",
    cwd: "/etc",
    codexThreadId: input.codexThreadId ?? null,
    cliTaskId: input.cliTaskId,
    cliTaskRevisionId: input.cliTaskRevisionId,
    status: "RUNNING",
    isActive: true
  });
  store.appendPaneCliTranscriptChunk({
    sessionId: session.sessionId,
    paneId: pane.id,
    roomId: room.id,
    sequence: 0,
    stream: "stdin",
    content: `${input.firstUserMessage}\r`
  });
  store.appendPaneCliTranscriptChunk({
    sessionId: session.sessionId,
    paneId: pane.id,
    roomId: room.id,
    sequence: 1,
    stream: "stdout",
    content: input.response
  });
  return { pane, session };
}

describe("UnifiedCliTaskRegistry", () => {
  it("lists provider-neutral tasks from Space-owned CLI sessions", async () => {
    const store = new InMemorySpaceStore();
    const codex = appendTask(store, {
      runtimeId: "cli:codex",
      providerId: "codex",
      title: "Codex task",
      firstUserMessage: "Inspect the API",
      response: "API inspection complete."
    });
    const claude = appendTask(store, {
      runtimeId: "cli:claude",
      providerId: "anthropic",
      title: "Claude task",
      firstUserMessage: "Review the frontend",
      response: "Frontend review complete."
    });

    const registry = new UnifiedCliTaskRegistry(store);
    const result = await registry.listAllTasks({ page: 1, pageSize: 50 });

    expect(result.tasks).toHaveLength(2);
    expect(result.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: codex.session.sessionId,
        taskId: codex.session.sessionId,
        runtimeId: "cli:codex",
        providerId: "codex",
        providerLabel: "Codex"
      }),
      expect.objectContaining({
        id: claude.session.sessionId,
        taskId: claude.session.sessionId,
        runtimeId: "cli:claude",
        providerId: "anthropic",
        providerLabel: "Claude Code"
      })
    ]));
  });

  it("searches Space transcript content literally and paginates the matching tasks", async () => {
    const store = new InMemorySpaceStore();
    appendTask(store, {
      runtimeId: "cli:kimi",
      providerId: "kimi-code",
      title: "Kimi task",
      firstUserMessage: "Find the 100% rollout regression",
      response: "Found the rollout regression."
    });
    appendTask(store, {
      runtimeId: "cli:grok",
      providerId: "xai",
      title: "Grok task",
      firstUserMessage: "Unrelated task",
      response: "Nothing to report."
    });

    const registry = new UnifiedCliTaskRegistry(store);
    const result = await registry.listAllTasks({ page: 1, pageSize: 1, q: "100%" });

    expect(result.total).toBe(1);
    expect(result.tasks).toEqual([
      expect.objectContaining({
        title: "Kimi task",
        firstUserMessage: "Find the 100% rollout regression"
      })
    ]);
  });

  it("resolves a legacy native thread id only to its existing Space-owned task", async () => {
    const store = new InMemorySpaceStore();
    const nativeThreadId = "019f3805-9299-7b92-b70c-cd4d49b02774";
    const source = appendTask(store, {
      runtimeId: "cli:codex",
      providerId: "codex",
      title: "Legacy Codex task",
      firstUserMessage: "Continue safely",
      response: "Prior response",
      codexThreadId: nativeThreadId
    });

    const registry = new UnifiedCliTaskRegistry(store);

    await expect(registry.getTask(nativeThreadId)).resolves.toMatchObject({
      taskId: source.session.sessionId,
      session: { sessionId: source.session.sessionId, codexThreadId: nativeThreadId }
    });
  });

  it("returns one row per logical task and uses its current revision provider", async () => {
    const store = new InMemorySpaceStore();
    const original = appendTask(store, {
      runtimeId: "cli:codex",
      providerId: "codex",
      title: "Shared investigation",
      firstUserMessage: "Inspect the original failure",
      response: "Original Codex findings"
    });
    const revisionId = "cli_revision:shared-investigation-2";
    store.createCliTaskRevision({
      revisionId,
      taskId: original.session.cliTaskId!,
      sourceRevisionId: original.session.cliTaskRevisionId,
      runtimeId: "cli:claude",
      providerId: "anthropic",
      agentId: "claude",
      nativeTaskRef: "019f8e42-2463-7b6f-8b45-3df4e53ddd25",
      displayTitle: "Shared investigation",
      firstUserMessage: "Inspect the original failure",
      preview: "Claude continued the investigation",
      cwd: "/etc",
      modelId: null,
      reasoningEffort: "medium"
    });
    const latest = appendTask(store, {
      runtimeId: "cli:claude",
      providerId: "anthropic",
      title: "Shared investigation",
      firstUserMessage: "Continue the same task",
      response: "Claude continued the investigation",
      cliTaskId: original.session.cliTaskId!,
      cliTaskRevisionId: revisionId
    });

    const registry = new UnifiedCliTaskRegistry(store);
    const result = await registry.listAllTasks({ page: 1, pageSize: 50 });

    expect(result.total).toBe(1);
    expect(result.tasks).toEqual([
      expect.objectContaining({
        taskId: original.session.cliTaskId,
        revisionId,
        runtimeId: "cli:claude",
        providerLabel: "Claude Code"
      })
    ]);
    await expect(registry.getTask(original.session.sessionId)).resolves.toMatchObject({
      taskId: original.session.cliTaskId,
      revisionId,
      firstUserMessage: "Inspect the original failure",
      session: { sessionId: latest.session.sessionId }
    });
  });

  it("keeps different logical tasks with identical titles separate and filters by current runtime", async () => {
    const store = new InMemorySpaceStore();
    appendTask(store, {
      runtimeId: "cli:codex",
      providerId: "codex",
      title: "Same title",
      firstUserMessage: "First independent task",
      response: "First response"
    });
    appendTask(store, {
      runtimeId: "cli:claude",
      providerId: "anthropic",
      title: "Same title",
      firstUserMessage: "Second independent task",
      response: "Second response"
    });

    const registry = new UnifiedCliTaskRegistry(store);
    expect((await registry.listAllTasks({ page: 1, pageSize: 50 })).total).toBe(2);
    const claudeOnly = await registry.listAllTasks({ page: 1, pageSize: 50, runtimeIds: ["cli:claude"] });
    expect(claudeOnly.total).toBe(1);
    expect(claudeOnly.tasks[0]).toMatchObject({ runtimeId: "cli:claude", title: "Same title" });
  });
});
