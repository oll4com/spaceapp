import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySpaceStore, SpaceEventBus, SpaceNotFoundError } from "@space/runtime";
import { InMemoryTaskTitleRepository } from "@space/db";
import { taskTitleSettingsSchema } from "@space/contracts";
import {
  TaskTitleService,
  taskTitleFailureCode,
  submittedTaskRequests,
  submittedTaskEntries,
  extractReferencedPlanId,
  parseTaskSummary,
  titleSummaryPrompt,
  titlePromptMaxBytes,
  type TaskTitleContext,
} from "../src/task-title-service.js";
import {
  TaskTitleProviders,
  TitleProviderFailure,
} from "../src/task-title-providers.js";
import type { CodexParityService } from "../src/codex-parity.js";
import type { NativeTaskTitles } from "../src/task-title-native.js";
function fixture(nativeTitles?: Pick<NativeTaskTitles, "metadata">, extra: { artifactRoot?: string; summaryAllowed?: (paneId: string) => Promise<boolean> } = {}) {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Titles", paneCap: 12 });
  const pane = store.createPane({
    roomId: room.id,
    title: "[Image #1] Fix menu",
    mode: "TERMINAL",
    terminalRuntimeId: "cli:qwen",
    cwd: "/etc",
  });
  const session = store.createPaneCliSession({
    sessionId: "cli_session:title-test",
    paneId: pane.id,
    roomId: room.id,
    runtimeId: "cli:qwen",
    providerId: "qwen",
    agentId: "qwen",
    modelId: null,
    reasoningEffort: "none",
    cwd: "/etc",
    status: "RUNNING",
    isActive: true,
    purpose: "NORMAL",
  });
  let now = new Date("2026-09-08T10:00:00Z");
  let nativeId: string | null = null,
    nativeTitle: string | null = null;
  let nativeManual = false;
  let key = "task:test";
  let requests = ["[Image #1] Improve workspace menu layout"];
  let images: string[] = [];
  let runtimeId = session.runtimeId;
  const context = async (): Promise<TaskTitleContext> => ({
    key,
    pane: store.getPane(pane.id),
    sessionId: session.sessionId,
    runtimeId,
    nativeId,
    revisionId: null,
    requests,
    nativeTitle,
    nativeManual,
    images,
  });
  const generate = vi.fn(async (_prompt: string, _signal: AbortSignal) =>
    JSON.stringify({
      title: "Workspace menu layout",
      description: "Improve workspace navigation and menu readability.",
      steps: ["Improve workspace menu layout"],
      earlierWork: "",
    }),
  );
  const candidates: any[] = [
    {
      id: "free:model",
      providerId: "free",
      modelId: "model",
      billing: "free",
      availability: "available",
      generate,
    },
  ];
  const providers = {
    eligible: vi.fn(async () => candidates),
    refresh: vi.fn(async () => {}),
    status: vi.fn(async () => []),
  } as unknown as TaskTitleProviders;
  const repository = new InMemoryTaskTitleRepository();
  const onError = vi.fn();
  const service = new TaskTitleService({
    store,
    repository,
    providers,
    codex: {} as CodexParityService,
    eventBus: new SpaceEventBus(),
    loadContext: context,
    now: () => now,
    nativeTitles,
    onError,
    artifactRoot: extra.artifactRoot,
    summaryAllowed: extra.summaryAllowed,
  });
  return {
    store,
    room,
    pane,
    repository,
    service,
    generate,
    candidates,
    onError,
    setNative: (id: string, title: string | null, manual = false) => {
      nativeId = id;
      nativeTitle = title;
      nativeManual = manual;
      key = `native:qwen:${id}`;
    },
    setRequests: (r: string[]) => {
      requests = r;
    },
    setImages: (paths: string[]) => {
      images = paths;
    },
    setRuntime: (id: string) => {
      runtimeId = id;
    },
    providers,
    advance: (seconds: number) => {
      now = new Date(now.getTime() + seconds * 1000);
    },
  };
}
describe("task title coordinator", () => {
  it("continues reconciliation when a listed room has just been deleted", async () => {
    const f = fixture();
    const remaining = f.store.createRoom({ name: "Still active", paneCap: 12 });
    const list = f.store.listRooms.bind(f.store);
    vi.spyOn(f.store, "listRooms").mockImplementationOnce(() => {
      const rooms = list();
      f.store.deleteRoom(f.room.id);
      return rooms;
    });
    const listPanes = vi.spyOn(f.store, "listPanes");
    try {
      await expect(f.service.reconcile()).resolves.toBeUndefined();
      expect(listPanes).toHaveBeenCalledWith(remaining.id);
      expect(f.onError).not.toHaveBeenCalled();
    } finally { await f.service.close(); }
  });

  it("ignores a pane deleted between listing and session lookup", async () => {
    const f = fixture();
    vi.spyOn(f.store, "getActivePaneCliSession").mockImplementationOnce(() => {
      f.store.deleteRoom(f.room.id);
      throw new SpaceNotFoundError("Pane disappeared");
    });
    try {
      await expect(f.service.reconcile()).resolves.toBeUndefined();
      expect(f.onError).not.toHaveBeenCalled();
    } finally { await f.service.close(); }
  });

  it("preserves unrelated not-found errors and store failures during reconciliation", async () => {
    const f = fixture();
    const missing = new SpaceNotFoundError("Related record missing");
    const offline = new Error("Database unavailable");
    const list = vi.spyOn(f.store, "listPanes");
    try {
      list.mockImplementationOnce(() => { throw missing; });
      await expect(f.service.reconcile()).rejects.toBe(missing);
      list.mockImplementationOnce(() => { throw offline; });
      await expect(f.service.reconcile()).rejects.toBe(offline);
      await expect(f.service.reconcile()).resolves.toBeUndefined();
    } finally { await f.service.close(); }
  });

  it("categorizes background failures without including private error text", () => {
    expect(taskTitleFailureCode(new SpaceNotFoundError("private prompt"))).toBe("NOT_FOUND");
    expect(taskTitleFailureCode(new TitleProviderFailure(429))).toBe("PROVIDER_REJECTED");
    expect(taskTitleFailureCode(new DOMException("private URL", "TimeoutError"))).toBe("TIMEOUT");
    expect(taskTitleFailureCode(Object.assign(new Error("private SQL"), { code: "40001" }))).toBe("STORE_CONFLICT");
    expect(taskTitleFailureCode({ code: "ECONNRESET", message: "private token" })).toBe("STORE_UNAVAILABLE");
    expect(taskTitleFailureCode({ code: "private token", name: "private URL" })).toBe("UNEXPECTED");
  });

  it("retires a deleted pane's queued work without dropping its retained summary", async () => {
    const f = fixture();
    try {
      await f.service.observe(f.pane.id);
      const before = await f.repository.get("task:test");
      f.store.deleteRoom(f.room.id);
      f.advance(6);
      await f.service.tick();
      const after = await f.repository.get("task:test");
      expect(after).toEqual({ ...before, dueAt: null });
      expect(f.generate).not.toHaveBeenCalled();
      expect(f.onError).not.toHaveBeenCalled();
      f.advance(3600);
      expect(await f.repository.claim(new Date("2026-09-08T11:00:06Z").toISOString())).toBeNull();
      await expect(f.service.observe(f.pane.id)).rejects.toBeInstanceOf(SpaceNotFoundError);
    } finally { await f.service.close(); }
  });

  it("ignores pending notifications after their pane is deleted", async () => {
    const f = fixture();
    try {
      f.service.notify(f.pane.id);
      f.store.deleteRoom(f.room.id);
      f.advance(6);
      await f.service.tick();
      expect(f.onError).not.toHaveBeenCalled();
      expect(f.generate).not.toHaveBeenCalled();
      expect(await f.repository.get("task:test")).toBeNull();
    } finally { await f.service.close(); }
  });

  it("reports a missing related record when the pane itself still exists", async () => {
    const f = fixture();
    try {
      await f.service.observe(f.pane.id);
      const error = new SpaceNotFoundError("Related record missing");
      vi.spyOn(f.repository, "getSettings").mockRejectedValueOnce(error);
      f.advance(6);
      await f.service.tick();
      expect(f.onError).toHaveBeenCalledWith(error);
      expect((await f.repository.get("task:test"))?.dueAt).toBe("2026-09-08T10:05:06.000Z");
    } finally { await f.service.close(); }
  });

  it("returns no context for a removed pane and preserves failures of the store", async () => {
    const store = new InMemorySpaceStore();
    const service = new TaskTitleService({ store, repository: new InMemoryTaskTitleRepository(),
      providers: {} as TaskTitleProviders, codex: {} as CodexParityService, eventBus: new SpaceEventBus() });
    try {
      await expect(service.context("pane:deleted")).resolves.toBeNull();
      vi.spyOn(store, "getPane").mockImplementation(() => { throw new Error("Database unavailable"); });
      await expect(service.context("pane:deleted")).rejects.toThrow("Database unavailable");
    } finally { await service.close(); }
  });

  it("backs off a failed repository and resumes processing when it recovers", async () => {
    const f = fixture();
    const claim = vi.spyOn(f.repository, "claim").mockRejectedValueOnce(new Error("Database unavailable")).mockRejectedValueOnce(new Error("Database unavailable"));
    try {
      await expect(f.service.tick()).rejects.toThrow("Database unavailable");
      f.advance(4);
      await f.service.tick();
      expect(claim).toHaveBeenCalledTimes(1);
      f.advance(1);
      await expect(f.service.tick()).rejects.toThrow("Database unavailable");
      f.advance(9);
      await f.service.tick();
      expect(claim).toHaveBeenCalledTimes(2);
      f.advance(1);
      await f.service.tick();
      expect(claim).toHaveBeenCalledTimes(3);
      await f.service.tick();
      expect(claim).toHaveBeenCalledTimes(4);
    } finally { await f.service.close(); }
  });

  it("releases a claimed task when reading its settings fails", async () => {
    const f = fixture();
    try {
      await f.service.observe(f.pane.id);
      f.advance(65);
      const finish = vi.spyOn(f.repository, "finish");
      vi.spyOn(f.repository, "getSettings").mockRejectedValueOnce(new Error("Settings unavailable"));
      await f.service.tick();
      expect(finish).toHaveBeenCalledOnce();
      expect(f.generate).not.toHaveBeenCalled();
      f.advance(301);
      await f.service.tick();
      expect(f.generate).toHaveBeenCalledOnce();
    } finally { await f.service.close(); }
  });

  it.each([true, false])("confirms a native Codex name before repeating a write (matches: %s)", async (matches) => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Native name reconciliation" });
    const pane = store.createPane({ roomId: room.id, mode: "TERMINAL", terminalRuntimeId: "cli:codex", cwd: "/etc", title: "Pinned task", titleSource: "manual" });
    const threadId = "12345678-1234-4234-8234-123456789abc";
    const session = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:codex", providerId: "codex", agentId: "codex", cwd: "/etc", modelId: null, reasoningEffort: "none", codexThreadId: threadId });
    const readCodexName = vi.fn(async () => matches ? "Pinned task" : "Earlier name");
    const renameCodex = vi.fn(async () => {});
    const eligible = vi.fn(async () => []);
    const service = new TaskTitleService({ store, repository: new InMemoryTaskTitleRepository(), providers: { eligible } as unknown as TaskTitleProviders,
      codex: { getHistoryThread: async () => ({ title: "", firstUserMessage: "" }), getThread: async () => ({ items: [] }) } as unknown as CodexParityService,
      readCodexName, renameCodex, eventBus: new SpaceEventBus() });
    try {
      await service.requestSync(pane.id);
      await service.tick();
      expect(store.getPane(pane.id).taskMetadata?.nativeSyncStatus).toBe("synced");
      expect(readCodexName).toHaveBeenCalledWith(session.sessionId, threadId);
      expect(renameCodex).toHaveBeenCalledTimes(matches ? 0 : 1);
      if (!matches) expect(renameCodex).toHaveBeenCalledWith(session.sessionId, threadId, "Pinned task");
      expect(eligible).not.toHaveBeenCalled();
    } finally { await service.close(); }
  });
  it.each([false, true])("keeps Chat tool-envelope titles out while preserving an intentional user quote (%s)", async quoted => {
    const store = new InMemorySpaceStore(), room = store.createRoom({ name: "Chat title" });
    const pane = store.createPane({ roomId: room.id, mode: "CHAT", title: "Conversation" });
    const heading = "Space private clipboard tools selected";
    const prompt = quoted ? heading + ": explain this wording" : "τεστ";
    const session = store.createSpaceAgentSession({ paneId: pane.id, roomId: room.id, title: pane.title,
      status: "READY", isActive: true, threadId: "thread:chat-title", selectedProviderId: "codex",
      selectedModelId: null, selectedModelConfigId: null, selectedProviderName: "Codex",
      selectedModelName: null, selectedReasoningKey: null });
    store.createSpaceAgentMessage({ sessionId: session.sessionId, roomId: room.id, paneId: pane.id,
      role: "user", status: "COMPLETED", content: prompt });
    const service = new TaskTitleService({ store, repository: new InMemoryTaskTitleRepository(), providers: {} as TaskTitleProviders,
      codex: { getHistoryThread: async () => ({ title: heading, firstUserMessage: heading + ":\nInternal envelope" }),
        getThread: async () => ({ items: [{ kind: "message", role: "user", content: "Internal envelope" }] }) } as unknown as CodexParityService,
      eventBus: new SpaceEventBus() });
    try {
      const context = await service.context(pane.id);
      expect(context?.requests).toEqual(quoted ? [prompt] : []);
      expect(context?.nativeTitle).toBe(quoted ? heading : null);
    } finally { await service.close(); }
  });

  it("adopts the active native Codex name instead of its legacy history title", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Native Codex names" });
    const pane = store.createPane({ roomId: room.id, mode: "TERMINAL", terminalRuntimeId: "cli:codex", cwd: "/etc", title: "Task" });
    const threadId = "12345678-1234-4234-8234-123456789abc";
    const session = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:codex", providerId: "codex", agentId: "codex", cwd: "/etc", modelId: null, reasoningEffort: "none", codexThreadId: threadId });
    const readCodexName = vi.fn(async () => "Native task name");
    const service = new TaskTitleService({ store, repository: new InMemoryTaskTitleRepository(), providers: {} as TaskTitleProviders,
      codex: { getHistoryThread: async () => ({ title: "Legacy prompt", firstUserMessage: "Improve native task naming" }), getThread: async () => ({ items: [] }) } as unknown as CodexParityService,
      readCodexName, eventBus: new SpaceEventBus() });
    expect((await service.observe(pane.id)).title).toBe("Native task name");
    expect(readCodexName).toHaveBeenCalledWith(session.sessionId, threadId);
    await service.close();
  });
  it("reads a resumed Claude pane's prompts and saved title from its transcript", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Claude titles" });
    const pane = store.createPane({ roomId: room.id, mode: "TERMINAL", terminalRuntimeId: "cli:claude", cwd: "/etc", title: "Task" });
    const session = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:claude", providerId: "claude", agentId: "claude", cwd: "/etc", modelId: null, reasoningEffort: "none" });
    store.appendPaneCliTranscriptChunk({ paneId: pane.id, roomId: room.id, sessionId: session.sessionId, sequence: 1, stream: "stdin", content: "continue\r" });
    const readClaudeTitle = vi.fn(async () => ({
      nativeId: "4b21b46d-8944-40f8-8b6a-28a654d78ad4",
      title: "Σύστημα τίτλων συνεδριών",
      manual: false,
      requests: ["[Image #1] αναβάθμισε το σύστημα που φτιάχνει τον τίτλο", "continue"],
    }));
    const repository = new InMemoryTaskTitleRepository();
    const service = new TaskTitleService({ store, repository, providers: {} as TaskTitleProviders,
      codex: {} as CodexParityService, readClaudeTitle, eventBus: new SpaceEventBus() });
    try {
      const context = await service.context(pane.id);
      expect(context?.requests).toEqual(["[Image #1] αναβάθμισε το σύστημα που φτιάχνει τον τίτλο"]);
      expect(context?.key).toBe("native:cli:claude:default:4b21b46d-8944-40f8-8b6a-28a654d78ad4");
      const observed = await service.observe(pane.id);
      expect(observed.title).toBe("Σύστημα τίτλων συνεδριών");
      expect(observed.taskMetadata).toMatchObject({ nativeTitle: "Σύστημα τίτλων συνεδριών", nativeTitleLabel: "Claude Code" });
      expect((await repository.get(context!.key))?.request).toBe("αναβάθμισε το σύστημα που φτιάχνει τον τίτλο");
    } finally { await service.close(); }
  });
  it.each(["close", "manual rename"])("rechecks the Harness pane after native history awaits a concurrent %s", async (change) => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Harness race" });
    const pane = store.createPane({ roomId: room.id, mode: "HARNESS", title: "Original" });
    const service = new TaskTitleService({
      store,
      repository: new InMemoryTaskTitleRepository(),
      codex: {} as CodexParityService,
      providers: {} as TaskTitleProviders,
      eventBus: new SpaceEventBus(),
      harness: {
        read: async () => {
          store.updatePane(pane.id, change === "close" ? { isClosed: true } : { title: "Pinned task", titleSource: "manual" });
          return { sessionId: "selected-task", title: "Native title", requests: [] };
        },
        rename: async () => {},
      },
    });
    if (change === "close") {
      await expect(service.bindHarnessSession(pane.id, "selected-task")).rejects.toThrow("unavailable");
      expect(store.getPane(pane.id).taskMetadata).toBeUndefined();
    } else {
      expect((await service.bindHarnessSession(pane.id, "selected-task")).title).toBe("Pinned task");
    }
    await service.close();
  });
  it("follows Harness selection and rejects a late projection for the previous native session", async () => {
    const store = new InMemorySpaceStore(),
      room = store.createRoom({ name: "Harness title test" }),
      pane = store.createPane({
        roomId: room.id,
        mode: "HARNESS",
        title: "Harness",
      });
    const repository = new InMemoryTaskTitleRepository();
    const read = vi.fn(
      async (_paneId: string, id = `space-pane-${pane.id.slice(5)}`) => ({
        sessionId: id,
        title: id === "selected-task" ? "Selected task" : "Original task",
        requests: [
          id === "selected-task"
            ? "Repair native title bindings"
            : "Improve workspace navigation",
        ],
      }),
    );
    const service = new TaskTitleService({
      store,
      repository,
      codex: {} as CodexParityService,
      providers: {
        eligible: async () => [],
        refresh: async () => {},
      } as unknown as TaskTitleProviders,
      eventBus: new SpaceEventBus(),
      harness: { read, rename: async () => {} },
    });
    await service.observe(pane.id);
    const prior = (await repository.get(
      store.getPane(pane.id).taskMetadata!.taskKey,
    ))!;
    const selected = await service.bindHarnessSession(pane.id, "selected-task");
    expect(selected.title).toBe("Selected task");
    // The selected session's request waits for its summary; the raw prompt is
    // never shown as the description.
    expect(selected.taskMetadata?.description).toBe("");
    expect((await repository.get(selected.taskMetadata!.taskKey))?.request).toBe(
      "Repair native title bindings",
    );
    expect(selected.taskMetadata?.harnessSessionId).toBe("selected-task");
    expect(store.applyTaskTitle(prior)).toBeNull();
    expect((await service.context(pane.id))?.nativeId).toBe("selected-task");
    await expect(
      service.bindHarnessSession(pane.id, "../foreign"),
    ).rejects.toThrow();
    await service.close();
  });
  it("preserves a native manual title across new requests and explicitly restores automatic naming", async () => {
    const metadata = vi.fn(async (_session, update) => ({
      nativeId: "session-1",
      title: update?.title ?? "Pinned native title",
      manual: !update?.resetManual,
    }));
    const f = fixture({ metadata });
    f.setNative("session-1", "Pinned native title", true);
    await f.service.observe(f.pane.id);
    f.advance(6);
    await f.service.tick();
    expect(f.store.getPane(f.pane.id).title).toBe("Pinned native title");
    expect(f.store.getPane(f.pane.id).taskMetadata?.generationStatus).toBe(
      "ready",
    );
    f.setRequests(["Fix native history naming"]);
    f.advance(61);
    await f.service.observe(f.pane.id);
    f.advance(6);
    await f.service.tick();
    expect(f.store.getPane(f.pane.id).title).toBe("Pinned native title");
    f.advance(61);
    await f.service.requestSync(f.pane.id, true);
    await f.service.tick();
    expect(metadata.mock.calls.at(-1)?.[1]).toMatchObject({
      nativeId: "session-1",
      title: "Workspace menu layout",
      manual: false,
      resetManual: true,
    });
    expect(f.store.getPane(f.pane.id).title).toBe("Workspace menu layout");
    expect(
      (await f.repository.get("native:qwen:session-1"))?.resetNativeManual,
    ).toBe(false);
  });
  it("never summarizes a pane whose summary would run on someone else's model accounts (MU-002)", async () => {
    const summaryAllowed = vi.fn(async () => false);
    const f = fixture(undefined, { summaryAllowed });
    await f.service.observe(f.pane.id);
    f.advance(6);
    await f.service.tick();
    expect(summaryAllowed).toHaveBeenCalledWith(f.pane.id);
    expect(f.generate).not.toHaveBeenCalled();
    // The pane keeps a clean local title.
    expect(f.store.getPane(f.pane.id).title).not.toContain("Image");
  });

  it("creates clean metadata and deduplicates identical requests without another call", async () => {
    const f = fixture();
    await f.service.observe(f.pane.id);
    expect(f.store.getPane(f.pane.id).title).not.toContain("Image");
    f.advance(6);
    await f.service.tick();
    expect(f.generate).toHaveBeenCalledTimes(1);
    await f.service.observe(f.pane.id);
    f.advance(600);
    await f.service.tick();
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.store.getPane(f.pane.id).taskMetadata?.description).toContain(
      "navigation",
    );
  });
  it("repairs a stale pending projection at the same version without another model call", async () => {
    const f = fixture();
    await f.service.observe(f.pane.id);
    const pending = structuredClone(f.store.getPane(f.pane.id));
    f.advance(6);
    await f.service.tick();
    const completed = structuredClone(f.store.getPane(f.pane.id));
    expect(completed.taskMetadata?.version).toBe(pending.taskMetadata?.version);
    f.store.updatePane(f.pane.id, { title: pending.title, taskMetadata: pending.taskMetadata });
    await f.service.observe(f.pane.id);
    expect(f.store.getPane(f.pane.id).taskMetadata).toEqual(completed.taskMetadata);
    expect(f.store.getPane(f.pane.id).title).toBe(completed.title);
    expect(f.generate).toHaveBeenCalledTimes(1);
    await f.service.close();
  });
  it("preserves manual titles while generating descriptions", async () => {
    const f = fixture();
    f.store.updatePane(f.pane.id, {
      title: "My pinned title",
      titleSource: "manual",
    });
    await f.service.observe(f.pane.id);
    f.advance(6);
    await f.service.tick();
    expect(f.store.getPane(f.pane.id).title).toBe("My pinned title");
    expect(f.store.getPane(f.pane.id).taskMetadata?.source).toBe("ai");
  });
  it("does not regenerate an unavailable summary when only the manual title changes", async () => {
    const f = fixture();
    f.generate.mockRejectedValue(new TitleProviderFailure(503));
    await f.service.observe(f.pane.id);
    f.advance(6);
    await f.service.tick();
    f.store.updatePane(f.pane.id, {
      title: "Pinned offline title",
      titleSource: "manual",
    });
    await f.service.requestSync(f.pane.id);
    await f.service.tick();
    f.advance(600);
    await f.service.tick();
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.store.getPane(f.pane.id).title).toBe("Pinned offline title");
  });
  it("does not schedule generation retries when automatic summaries are disabled", async () => {
    const f = fixture();
    await f.repository.setSettings(
      taskTitleSettingsSchema.parse({ enabled: false }),
    );
    await f.service.observe(f.pane.id);
    f.advance(6);
    await f.service.tick();
    expect(f.generate).not.toHaveBeenCalled();
    expect((await f.repository.get("task:test"))?.dueAt).toBeNull();
  });
  it("persists preference and metadata versions together without a model call", async () => {
    const f = fixture();
    await f.service.observe(f.pane.id);
    f.advance(6);
    await f.service.tick();
    await f.service.setPreference(f.pane.id, "other:small");
    const state = (await f.repository.get("task:test"))!;
    expect(state.metadata.version).toBe(state.version);
    expect(f.store.getPane(f.pane.id).taskMetadata?.preferredCandidateId).toBe(
      "other:small",
    );
    f.advance(600);
    await f.service.tick();
    expect(f.generate).toHaveBeenCalledTimes(1);
  });
  it("carries the generated summary into an exact native binding and adopts later CLI renames", async () => {
    const f = fixture();
    await f.service.observe(f.pane.id);
    f.advance(6);
    await f.service.tick();
    f.setNative("session-1", null);
    await f.service.observe(f.pane.id);
    await f.service.tick();
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.store.getPane(f.pane.id).taskMetadata?.description).toContain(
      "navigation",
    );
    f.setNative("session-1", "Native custom title");
    await f.service.observe(f.pane.id);
    await f.service.tick();
    expect(f.store.getPane(f.pane.id).title).toBe("Native custom title");
    expect(f.generate).toHaveBeenCalledTimes(1);
    f.store.updatePane(f.pane.id, {
      title: "Space pinned title",
      titleSource: "manual",
    });
    f.setNative("session-1", "Another native title");
    await f.service.observe(f.pane.id);
    expect(f.store.getPane(f.pane.id).title).toBe("Space pinned title");
  });
  it("never inherits another native task's description when the pane is reused", async () => {
    const f = fixture();
    f.setNative("session-1", null);
    await f.service.observe(f.pane.id);
    f.advance(6);
    await f.service.tick();
    f.setNative("session-2", null);
    f.setRequests(["Fix provider availability"]);
    await f.service.observe(f.pane.id);
    expect(f.store.getPane(f.pane.id).taskMetadata?.description).not.toContain(
      "navigation",
    );
  });
  it("ignores acknowledgements and does not call a provider", async () => {
    const f = fixture();
    f.setRequests(["συνέχισε"]);
    await f.service.observe(f.pane.id);
    f.advance(10);
    await f.service.tick();
    expect(f.generate).not.toHaveBeenCalled();
  });
  it("carries earlier context into a second task and enforces the minute interval", async () => {
    const f = fixture();
    await f.service.observe(f.pane.id);
    f.advance(6);
    await f.service.tick();
    f.setRequests(["Now repair the title tooltip"]);
    await f.service.observe(f.pane.id);
    f.advance(6);
    await f.service.tick();
    expect(f.generate).toHaveBeenCalledTimes(1);
    f.advance(60);
    await f.service.tick();
    expect(f.generate).toHaveBeenCalledTimes(2);
    expect(f.generate.mock.calls[1]?.[0]).toContain("navigation");
  });
  it("drops stale model results after another request arrives", async () => {
    const f = fixture();
    let resolve!: (s: string) => void;
    f.generate.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    await f.service.observe(f.pane.id);
    f.advance(6);
    const running = f.service.tick();
    await vi.waitFor(() => expect(f.generate).toHaveBeenCalled());
    f.setRequests(["Fix session history synchronization"]);
    await f.service.observe(f.pane.id);
    resolve(
      JSON.stringify({
        title: "Old result",
        description: "Old result",
        steps: [],
        earlierWork: "",
      }),
    );
    await running;
    expect(f.store.getPane(f.pane.id).title).not.toBe("Old result");
    f.advance(6);
    await f.service.tick();
    expect(f.generate).toHaveBeenCalledTimes(1);
    f.advance(60);
    await f.service.tick();
    expect(f.generate).toHaveBeenCalledTimes(2);
  });
  it("keeps attempt budgets when the native ID becomes known", async () => {
    const f = fixture();
    await f.repository.setSettings(
      taskTitleSettingsSchema.parse({ perTaskDayAttempts: 1 }),
    );
    await f.service.observe(f.pane.id);
    f.advance(6);
    await f.service.tick();
    f.setNative("session-1", null);
    f.setRequests(["Fix the next task process"]);
    await f.service.observe(f.pane.id);
    f.advance(61);
    await f.service.tick();
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect((await f.repository.get("native:qwen:session-1"))?.budgetKey).toBe(
      "task:test",
    );
    expect(f.store.getPane(f.pane.id).taskMetadata?.generationStatus).toBe(
      "deferred",
    );
  });
  it("falls back once and records quota cooldown instead of retrying the failed route", async () => {
    const f = fixture();
    f.generate.mockRejectedValueOnce(new TitleProviderFailure(429, 120));
    const fallback = vi.fn(async () =>
      JSON.stringify({
        title: "Fallback title",
        description: "A clean task description",
        steps: [],
        earlierWork: "",
      }),
    );
    f.candidates.push({
      ...f.candidates[0],
      id: "other:model",
      providerId: "other",
      generate: fallback,
    });
    await f.service.observe(f.pane.id);
    f.advance(6);
    await f.service.tick();
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(
      await f.repository.cooldowns("2026-09-08T10:00:07.000Z"),
    ).toHaveProperty("provider:free");
  });
  it("keeps usable local metadata when the budget is exhausted", async () => {
    const f = fixture();
    await f.repository.setSettings(
      taskTitleSettingsSchema.parse({ globalDayAttempts: 1 }),
    );
    await f.service.observe(f.pane.id);
    f.advance(6);
    await f.service.tick();
    f.setRequests(["Fix native session naming"]);
    await f.service.observe(f.pane.id);
    f.advance(61);
    await f.service.tick();
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.store.getPane(f.pane.id).taskMetadata?.generationStatus).toBe(
      "deferred",
    );
  });
});
describe("summarized task title lines", () => {
  const reply = (value: Record<string, unknown>) => JSON.stringify(value);
  it("summarizes the first prompt into line one without ever showing the raw prompt", async () => {
    const f = fixture();
    f.setRequests(["θέλω όλο αυτό το κομμάτι του μενού βελτίωση"]);
    f.generate.mockResolvedValueOnce(reply({ sameTopic: false, title: "Βελτίωση μενού", summary: "Ο χρήστης θέλει να βελτιωθεί το μενού." }));
    const pending = await f.service.observe(f.pane.id);
    expect(pending.title).toBe("New task");
    expect(pending.taskMetadata).toMatchObject({ generationStatus: "pending", description: "", topics: [] });
    await f.service.tick();
    const ready = f.store.getPane(f.pane.id);
    expect(ready.title).toBe("Βελτίωση μενού");
    expect(ready.taskMetadata).toMatchObject({
      generationStatus: "ready",
      description: "Ο χρήστης θέλει να βελτιωθεί το μενού.",
      steps: ["Βελτίωση μενού"],
      topics: [{ title: "Βελτίωση μενού", summary: "Ο χρήστης θέλει να βελτιωθεί το μενού.", source: "ai" }],
    });
    await f.service.close();
  });

  it("adds a new summarized line only when a later prompt asks for different work", async () => {
    const f = fixture();
    const first = "Improve the workspace menu layout";
    f.setRequests([first]);
    f.generate.mockResolvedValueOnce(reply({ sameTopic: false, title: "Workspace menu layout", summary: "Improve the menu." }));
    await f.service.observe(f.pane.id);
    await f.service.tick();

    f.setRequests([first, "Also make the same menu open faster"]);
    f.generate.mockResolvedValueOnce(reply({ sameTopic: true, title: "Faster menu", summary: "Same menu work." }));
    await f.service.observe(f.pane.id);
    f.advance(61);
    await f.service.tick();
    const prompt = JSON.parse(f.generate.mock.calls[1]![0]);
    expect(prompt.topics).toEqual([{ title: "Workspace menu layout", summary: "Improve the menu." }]);
    expect(prompt.newRequests).toEqual(["Also make the same menu open faster"]);
    expect(f.store.getPane(f.pane.id).title).toBe("Workspace menu layout");
    expect(f.store.getPane(f.pane.id).taskMetadata?.topics).toHaveLength(1);

    f.setRequests([first, "Also make the same menu open faster", "Fix the login 500 error"]);
    f.generate.mockResolvedValueOnce(reply({ sameTopic: false, title: "Login 500 error fix", summary: "Repair the failing login." }));
    await f.service.observe(f.pane.id);
    expect(f.store.getPane(f.pane.id).title).toBe("Workspace menu layout");
    f.advance(61);
    await f.service.tick();
    const pane = f.store.getPane(f.pane.id);
    expect(pane.title).toBe("Login 500 error fix");
    expect(pane.taskMetadata?.topics?.map((topic) => topic.title)).toEqual(["Workspace menu layout", "Login 500 error fix"]);
    expect(pane.taskMetadata?.steps).toEqual(["Workspace menu layout", "Login 500 error fix"]);
    expect(pane.taskMetadata?.description).toBe("Repair the failing login.");
    await f.service.close();
  });

  it("routes an attached screenshot of this pane to a vision model and never reads another pane's upload", async () => {
    const root = await mkdtemp(join(tmpdir(), "title-images-"));
    try {
      const f = fixture(undefined, { artifactRoot: root });
      const dir = (pane: string) => join(root, "cli-uploads", f.room.id.replace(/[^a-zA-Z0-9._-]/g, "_"), pane, "cli_session_x", "2026-10-12");
      const own = join(dir(f.pane.id.replace(/[^a-zA-Z0-9._-]/g, "_")), "upload_a-clipboard-image-1.png");
      const foreign = join(dir("pane_other"), "upload_b-clipboard-image-1.png");
      for (const path of [own, foreign]) {
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, "png");
      }
      const vision = vi.fn(async (_prompt: string, _signal: AbortSignal, _images?: readonly string[]) =>
        reply({ sameTopic: false, title: "Fix login 500 error", summary: "The screenshot shows a failing login." }));
      f.candidates.unshift({ ...f.candidates[0], id: "free:vision", modelId: "vision", vision: true, generate: vision });
      f.setRequests(["φτιάξε αυτό"]);
      f.setImages([own]);
      await f.service.observe(f.pane.id);
      await f.service.tick();
      expect((f.providers.eligible as any).mock.calls.at(-1)?.[2]).toEqual({ images: true });
      expect(vision.mock.calls[0]?.[2]).toEqual([await realpath(own)]);
      expect(JSON.parse(vision.mock.calls[0]![0]).attachedImages).toBe(1);
      expect(f.store.getPane(f.pane.id).taskMetadata?.topics?.[0]).toMatchObject({ title: "Fix login 500 error", hasImages: true });

      // The same words with another pane's screenshot are a new request, but
      // that file is never read or shown to the model.
      f.setImages([foreign]);
      vision.mockResolvedValueOnce(reply({ sameTopic: true, title: "Same", summary: "Same." }));
      await f.service.observe(f.pane.id);
      f.advance(61);
      await f.service.tick();
      expect(vision).toHaveBeenCalledTimes(2);
      expect(vision.mock.calls[1]?.[2]).toBeUndefined();
      expect(JSON.parse(vision.mock.calls[1]![0]).attachedImages).toBeUndefined();
      await f.service.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("uses a trusted CLI title as line one and keeps showing the CLI's saved title", async () => {
    const f = fixture();
    f.setRuntime("cli:claude");
    f.setNative("11111111-2222-4333-8444-555555555555", "Claude saved title");
    f.setRequests(["Please improve the task titles of every pane"]);
    f.generate.mockResolvedValueOnce(reply({ sameTopic: false, title: "Model title", summary: "Improve pane task titles." }));
    expect((await f.service.observe(f.pane.id)).title).toBe("Claude saved title");
    await f.service.tick();
    let pane = f.store.getPane(f.pane.id);
    expect(pane.title).toBe("Claude saved title");
    expect(pane.taskMetadata).toMatchObject({
      nativeTitle: "Claude saved title",
      nativeTitleLabel: "Claude Code",
      nativeSyncStatus: "unsupported",
      topics: [{ title: "Claude saved title", summary: "Improve pane task titles.", source: "native" }],
    });

    f.setRequests(["Please improve the task titles of every pane", "Now fix the chess clock"]);
    f.generate.mockResolvedValueOnce(reply({ sameTopic: false, title: "Chess clock fix", summary: "Repair the clock." }));
    await f.service.observe(f.pane.id);
    f.advance(61);
    await f.service.tick();
    // A later Claude title names the session, not the newest line.
    f.setNative("11111111-2222-4333-8444-555555555555", "Claude newer title");
    await f.service.observe(f.pane.id);
    pane = f.store.getPane(f.pane.id);
    expect(pane.title).toBe("Chess clock fix");
    expect(pane.taskMetadata?.topics?.map((topic) => topic.title)).toEqual(["Claude saved title", "Chess clock fix"]);
    expect(pane.taskMetadata?.nativeTitle).toBe("Claude newer title");
    await f.service.close();
  });

  it("adopts a CLI's own title for line one when it is saved after the summary", async () => {
    const f = fixture();
    f.setRuntime("cli:claude");
    f.setNative("11111111-2222-4333-8444-555555555555", null);
    await f.service.observe(f.pane.id);
    await f.service.tick();
    expect(f.store.getPane(f.pane.id).title).toBe("Workspace menu layout");
    f.setNative("11111111-2222-4333-8444-555555555555", "Claude menu redesign");
    await f.service.observe(f.pane.id);
    const pane = f.store.getPane(f.pane.id);
    expect(pane.title).toBe("Claude menu redesign");
    expect(pane.taskMetadata?.topics).toMatchObject([{ title: "Claude menu redesign", source: "native" }]);
    expect(f.generate).toHaveBeenCalledTimes(1);
    await f.service.close();
  });

  it("never shows an envelope tag as a CLI's saved title", async () => {
    const f = fixture();
    f.setRuntime("cli:codex");
    f.setNative("thread-1", "<send_user_message_question_reply>");
    const pane = await f.service.observe(f.pane.id);
    expect(pane.title).toBe("New task");
    expect(pane.taskMetadata?.nativeTitle).toBeNull();
    await f.service.close();
  });
  it("summarizes again a line that was named by an envelope tag", async () => {
    const f = fixture();
    await f.service.observe(f.pane.id);
    await f.service.tick();
    const state = (await f.repository.get("task:test"))!;
    const tagged = { ...state, version: state.version + 1, title: "<send_user_message_question_reply>",
      metadata: { ...state.metadata, version: state.version + 1, topics: [{ ...state.metadata.topics![0]!, title: "<send_user_message_question_reply>", source: "native" as const }] } };
    await f.repository.enqueue(tagged, state.version);
    f.generate.mockResolvedValueOnce(JSON.stringify({ sameTopic: true, title: "Workspace menu layout", summary: "Improve the menu." }));
    await f.service.observe(f.pane.id);
    f.advance(61);
    await f.service.tick();
    const pane = f.store.getPane(f.pane.id);
    expect(pane.title).toBe("Workspace menu layout");
    expect(pane.taskMetadata?.topics).toMatchObject([{ title: "Workspace menu layout", source: "ai" }]);
    expect(f.generate).toHaveBeenCalledTimes(2);
    await f.service.observe(f.pane.id);
    f.advance(600);
    await f.service.tick();
    expect(f.generate).toHaveBeenCalledTimes(2);
    await f.service.close();
  });
  it("never uses a CLI title that only repeats the prompt", async () => {
    const f = fixture();
    f.setRuntime("cli:opencode");
    f.setNative("ses_native", "Improve workspace menu layout");
    const pane = await f.service.observe(f.pane.id);
    expect(pane.title).toBe("New task");
    expect(pane.taskMetadata?.nativeTitle).toBeNull();
    await f.service.close();
  });

  it("shows a local line when no model answers and replaces it once one does", async () => {
    const f = fixture();
    f.generate.mockRejectedValueOnce(new TitleProviderFailure(503));
    await f.service.observe(f.pane.id);
    await f.service.tick();
    let pane = f.store.getPane(f.pane.id);
    expect(pane.taskMetadata?.generationStatus).toBe("unavailable");
    expect(pane.taskMetadata?.topics).toMatchObject([{ title: "Improve workspace menu layout", source: "local" }]);
    expect(pane.title).toBe("Improve workspace menu layout");
    f.advance(301);
    await f.service.tick();
    pane = f.store.getPane(f.pane.id);
    expect(pane.taskMetadata?.topics).toMatchObject([{ title: "Workspace menu layout", source: "ai" }]);
    expect(pane.title).toBe("Workspace menu layout");
    await f.service.close();
  });

  it("fills in the summary of a CLI-named line once a model answers", async () => {
    const f = fixture();
    f.setRuntime("cli:claude");
    f.setNative("11111111-2222-4333-8444-555555555555", "Claude saved title");
    f.generate.mockRejectedValueOnce(new TitleProviderFailure(503));
    await f.service.observe(f.pane.id);
    await f.service.tick();
    expect(f.store.getPane(f.pane.id).taskMetadata?.topics).toMatchObject([{ title: "Claude saved title", summary: "", source: "native" }]);
    f.generate.mockResolvedValueOnce(reply({ sameTopic: true, title: "Model title", summary: "Improve the workspace menu." }));
    f.advance(301);
    await f.service.tick();
    const pane = f.store.getPane(f.pane.id);
    expect(pane.taskMetadata?.topics).toMatchObject([{ title: "Claude saved title", summary: "Improve the workspace menu.", source: "native" }]);
    expect(pane.title).toBe("Claude saved title");
    await f.service.close();
  });
  it("regenerates the latest line in place", async () => {
    const f = fixture();
    await f.service.observe(f.pane.id);
    await f.service.tick();
    f.generate.mockResolvedValueOnce(reply({ sameTopic: true, title: "Menu layout cleanup", summary: "Tidy the menu." }));
    await f.service.observe(f.pane.id, true);
    f.advance(61);
    await f.service.tick();
    const pane = f.store.getPane(f.pane.id);
    expect(pane.taskMetadata?.topics).toMatchObject([{ title: "Menu layout cleanup", summary: "Tidy the menu." }]);
    expect(pane.title).toBe("Menu layout cleanup");
    await f.service.close();
  });

  it("adds a local line per new request when automatic summaries are off", async () => {
    const f = fixture();
    await f.repository.setSettings(taskTitleSettingsSchema.parse({ enabled: false }));
    await f.service.observe(f.pane.id);
    await f.service.tick();
    f.setRequests(["Improve workspace menu layout", "Repair the chess clock display"]);
    await f.service.observe(f.pane.id);
    f.advance(61);
    await f.service.tick();
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.store.getPane(f.pane.id).taskMetadata?.topics?.map((topic) => topic.title))
      .toEqual(["Improve workspace menu layout", "Repair the chess clock display"]);
    await f.service.close();
  });
});
describe("task input boundaries", () => {
  it("bounds the prompt for multibyte and oversized graphemes without losing the latest request", async () => {
    const f = fixture();
    await f.service.observe(f.pane.id);
    const state = (await f.repository.get("task:test"))!;
    state.title = "α".repeat(160);
    state.request = "Fix task naming " + "😀".repeat(3000);
    state.pendingRequests = ["β".repeat(3000), state.request];
    state.metadata.earlierWork = "α".repeat(400);
    state.metadata.topics = Array(12).fill({ title: "🛠️".repeat(40), summary: "🛠️".repeat(120), source: "ai", at: "2026-09-08T10:00:00.000Z" });
    const prompt = titleSummaryPrompt(state, { shown: 1 });
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(titlePromptMaxBytes);
    expect(JSON.parse(prompt).newRequests.at(-1)).toContain("Fix task naming");
    expect(JSON.parse(prompt).attachedImages).toBe(1);
    state.pendingRequests = ["Fix naming a" + "\u0301".repeat(8000)];
    expect(Buffer.byteLength(titleSummaryPrompt(state))).toBeLessThanOrEqual(
      titlePromptMaxBytes,
    );
  });
  it("counts a submitted image with a short instruction and keeps its raw upload path", () => {
    const path = "/opt/spaceapp/var/artifacts/cli-uploads/room_a/pane_b/cli_session_c/2026-10-12/upload_x-clipboard-image-1.png";
    const entries = submittedTaskEntries([
      { stream: "stdin", content: `'${path}' αυτό\r` },
      { stream: "stdin", content: `'${path}'\r` },
      { stream: "stdin", content: "ok\r" },
    ]);
    expect(entries).toEqual([
      { text: "αυτό", raw: `'${path}' αυτό` },
      { text: "Attached image", raw: `'${path}'` },
    ]);
    expect(submittedTaskRequests([{ stream: "stdin", content: `'${path}' αυτό\r` }])).toEqual([]);
  });
  it("reassembles paste, backspace and fragmented submitted text without drafts", () => {
    expect(
      submittedTaskRequests([
        { stream: "stdin", content: "Fix lgo\b\bogin\rUnsubmitted draft" },
      ]),
    ).toEqual(["Fix login"]);
    expect(
      submittedTaskRequests([
        { stream: "stdin", content: "\x1b[200~Fix menu\nAnd title\x1b[201~\r" },
      ]),
    ).toEqual(["Fix menu And title"]);
    expect(
      submittedTaskRequests([
        { stream: "stdout", content: "Fake user prompt\r" },
        { stream: "stdin", content: "continue\r" },
      ]),
    ).toEqual([]);
  });
  it("reads the same-work verdict, including a renamed flag, from wrapped model output", () => {
    expect(parseTaskSummary('Here you go: {"sameTopic":true,"title":"Menu fix","summary":"Same."} done')).toEqual({ sameTopic: true, title: "Menu fix", summary: "Same." });
    expect(parseTaskSummary('{"isNewTopic":false,"title":"Menu fix","summary":"Same."}').sameTopic).toBe(true);
    expect(parseTaskSummary('{"isNewTopic":true,"title":"Menu fix","summary":"New."}').sameTopic).toBe(false);
  });
  it("rejects malformed and empty model metadata", () => {
    expect(() =>
      parseTaskSummary('{"title":"[Image #1]","description":"Hi","steps":[]}'),
    ).toThrow();
    expect(() =>
      parseTaskSummary('{"title":"Hello","description":42,"steps":[]}'),
    ).toThrow();
  });
});

describe("plan handoff binding", () => {
  it("extracts any clipboard item id format from a Plan ID reference", () => {
    expect(extractReferencedPlanId('Implement the following plan: ("Fix menu") Plan ID: clipboard:3tVTUEaY7m9V')).toBe("clipboard:3tVTUEaY7m9V");
    expect(extractReferencedPlanId("Implement the following plan: (\"Handoff\") Plan ID: clip-plan-claude-1791636542963-1oa1 κανε διορθωσεις")).toBe("clip-plan-claude-1791636542963-1oa1");
    expect(extractReferencedPlanId("Plan ID: clipboard:abc12345.")).toBe("clipboard:abc12345");
    expect(extractReferencedPlanId("Plan ID: short")).toBeNull();
    expect(extractReferencedPlanId("Fix the plan menu")).toBeNull();
  });

  it("binds a non-clipboard: plan id to the pane and records it in task metadata", async () => {
    const f = fixture();
    const room = f.store.getRoom(f.room.id);
    vi.spyOn(f.store, "getRoom").mockReturnValue({ ...room, ownerUserId: "user:operator" });
    const bind = vi.spyOn(f.store, "updateClipboardItemProgress").mockImplementation((_owner, id) => {
      if (id !== "clip-plan-claude-1791636542963-1oa1") throw new SpaceNotFoundError("missing");
      return {} as any;
    });
    try {
      f.setRequests(["Implement the following plan: (\"Handoff Plan\") Plan ID: clip-plan-claude-1791636542963-1oa1 finish it"]);
      await f.service.observe(f.pane.id);
      expect(bind).toHaveBeenCalledWith(
        "user:operator",
        "clip-plan-claude-1791636542963-1oa1",
        expect.objectContaining({ paneId: f.pane.id, roomId: f.room.id }),
      );
      expect(f.store.getPane(f.pane.id).taskMetadata?.planId).toBe("clip-plan-claude-1791636542963-1oa1");
    } finally { await f.service.close(); }
  });

  it("skips Plan ID references that do not name an existing plan", async () => {
    const f = fixture();
    const room = f.store.getRoom(f.room.id);
    vi.spyOn(f.store, "getRoom").mockReturnValue({ ...room, ownerUserId: "user:operator" });
    const bind = vi.spyOn(f.store, "updateClipboardItemProgress").mockImplementation(() => {
      throw new SpaceNotFoundError("missing");
    });
    try {
      f.setRequests(["Use the Plan ID: notarealplan from yesterday and fix the menu"]);
      await f.service.observe(f.pane.id);
      expect(bind).toHaveBeenCalledTimes(1);
      expect(f.store.getPane(f.pane.id).taskMetadata?.planId ?? null).toBeNull();
    } finally { await f.service.close(); }
  });
});
