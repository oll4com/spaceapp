import { describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore, SpaceEventBus } from "@space/runtime";
import { InMemoryTaskTitleRepository } from "@space/db";
import { TaskTitleService } from "../src/task-title-service.js";
import type { TaskTitleProviders } from "../src/task-title-providers.js";
import type { CodexParityService } from "../src/codex-parity.js";
import type { NativeTaskTitles } from "../src/task-title-native.js";

function qwenFixture(nativeId: string | null, runtimeId = "cli:qwen") {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Qwen resume", initialPaneCount: 0 });
  const pane = store.createPane({ roomId: room.id, title: "Qwen", mode: "TERMINAL", terminalRuntimeId: runtimeId, cwd: "/etc" });
  const revision = store.createCliTaskRevision({
    revisionId: "cli_revision:qwen-ref", taskId: "cli_task:qwen-ref", runtimeId, providerId: "qwen", agentId: "qwen",
    nativeTaskRef: null, sourceRevisionId: null, latestSpaceSessionId: null, displayTitle: pane.title,
    firstUserMessage: "Fix the menu", preview: "", cwd: "/etc", modelId: null, reasoningEffort: "none"
  });
  const session = store.createPaneCliSession({
    sessionId: "cli_session:qwen-ref", paneId: pane.id, roomId: room.id, runtimeId, providerId: "qwen", agentId: "qwen",
    modelId: null, reasoningEffort: "none", cwd: "/etc", status: "RUNNING", isActive: true, purpose: "NORMAL",
    cliTaskId: "cli_task:qwen-ref", cliTaskRevisionId: revision.revisionId
  });
  const metadata = vi.fn<NativeTaskTitles["metadata"]>(async () => ({ nativeId, title: null }));
  const service = new TaskTitleService({
    store,
    repository: new InMemoryTaskTitleRepository(),
    providers: { eligible: vi.fn(async () => []), refresh: vi.fn(async () => {}), status: vi.fn(async () => []) } as unknown as TaskTitleProviders,
    codex: {} as CodexParityService,
    eventBus: new SpaceEventBus(),
    nativeTitles: { metadata },
  });
  return { store, pane, session, revision, service, metadata };
}

describe("Qwen exact resume reference", () => {
  it("records the session the metadata bridge bound to the pane process as the revision's native ref", async () => {
    const f = qwenFixture("85de09e6-3d1f-4e13-9173-142a9e9a36cf");
    const context = await f.service.context(f.pane.id);
    expect(context?.nativeId).toBe("85de09e6-3d1f-4e13-9173-142a9e9a36cf");
    expect(f.store.getCliTaskRevision(f.revision.revisionId)?.nativeTaskRef).toBe("85de09e6-3d1f-4e13-9173-142a9e9a36cf");
    expect(f.metadata).toHaveBeenCalledTimes(1);
  });

  it("never records an id outside the exact-resume pattern", async () => {
    for (const nativeId of ["85DE09E6-3D1F-4E13-9173-142A9E9A36CF", "../x", "85de09e6-3d1f-4e13-9173-142a9e9a36cf;id"]) {
      const f = qwenFixture(nativeId);
      await f.service.context(f.pane.id);
      expect(f.store.getCliTaskRevision(f.revision.revisionId)?.nativeTaskRef, nativeId).toBeNull();
    }
  });

  it("leaves other bridged runtimes on provider selection", async () => {
    const f = qwenFixture("hermes_session_1", "cli:hermes");
    await f.service.context(f.pane.id);
    expect(f.store.getCliTaskRevision(f.revision.revisionId)?.nativeTaskRef).toBeNull();
  });
});
