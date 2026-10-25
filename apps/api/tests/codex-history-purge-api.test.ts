import { describe, expect, it, vi } from "vitest";
import type { CodexHistoryPurgePreviewResponse, CodexHistoryPurgeResponse } from "@space/contracts";
import { InMemorySpaceStore, SpaceConflictError } from "@space/runtime";
import { createApp } from "../src/app.js";
import { createCsrfToken, signSession } from "../src/auth.js";
import type {
  CodexHistoryAccessCoordinator,
  CodexHistoryPurgeService
} from "../src/codex-history-purge.js";

const sessionSecret = "codex-history-purge-api-test-secret";
const previewId = "9943e22b-97a3-48b6-ae84-1a2cced6a353";
const backupId = "c3d866d1-9690-4db5-b44c-6294c07aa83e";
const activeThreadA = "8f2c4dcc-5f4d-4a33-950c-7b74825dca55";
const activeThreadB = "cd6ee617-85e7-49da-ace8-3b495f91af69";
const checkedAt = "2026-07-17T08:00:00.000Z";

const previewResponse: CodexHistoryPurgePreviewResponse = {
  status: "READY",
  previewId,
  candidates: { threads: 1, cliTasks: 0, indexEntries: 1, rolloutFiles: 1, shellSnapshots: 0 },
  protectedThreads: 1,
  expiresAt: "2026-07-17T08:05:00.000Z",
  checkedAt
};

const purgeResponse: CodexHistoryPurgeResponse = {
  status: "COMPLETED",
  previewId,
  backupId,
  purged: { threads: 1, cliTasks: 0, indexEntries: 1, rolloutFiles: 1, shellSnapshots: 0 },
  protectedThreads: 2,
  newlyProtectedThreads: 1,
  completedAt: checkedAt
};

function authHeaders(role: "OPERATOR" | "ADMIN", id = `user:${role.toLowerCase()}`) {
  const session = signSession({ id, email: `${id.replace(":", "-")}@space.local`, role }, sessionSecret);
  return {
    cookie: `space_session=${session}`,
    csrf: createCsrfToken(session, sessionSecret)!
  };
}

function createService(overrides: Partial<CodexHistoryPurgeService> = {}) {
  return {
    preview: vi.fn(async () => previewResponse),
    execute: vi.fn(async () => purgeResponse),
    rollback: vi.fn(async () => undefined),
    ...overrides
  } satisfies CodexHistoryPurgeService;
}

async function setup(options: {
  store?: InMemorySpaceStore;
  service?: CodexHistoryPurgeService;
  coordinator?: CodexHistoryAccessCoordinator;
} = {}) {
  const store = options.store ?? new InMemorySpaceStore();
  const service = options.service ?? createService();
  const app = await createApp({
    store,
    codexHistoryPurgeService: service,
    codexHistoryAccessCoordinator: options.coordinator,
    auth: { sessionSecret, devLogin: false, secureCookies: false }
  });
  return { app, store, service };
}

describe("Codex history purge API", () => {
  it("requires ADMIN and CSRF while rejecting client-selected actors or targets", async () => {
    const service = createService();
    const { app } = await setup({ service });
    const operator = authHeaders("OPERATOR");
    const admin = authHeaders("ADMIN");

    expect((await app.inject({ method: "POST", url: "/api/admin/codex-history-purge-previews", payload: {} })).statusCode).toBe(401);
    expect((await app.inject({
      method: "POST",
      url: "/api/admin/codex-history-purge-previews",
      headers: { cookie: operator.cookie, "x-space-csrf-token": operator.csrf },
      payload: {}
    })).statusCode).toBe(403);
    expect((await app.inject({
      method: "POST",
      url: "/api/admin/codex-history-purge-previews",
      headers: { cookie: admin.cookie },
      payload: {}
    })).statusCode).toBe(403);

    const forgedPreview = await app.inject({
      method: "POST",
      url: "/api/admin/codex-history-purge-previews",
      headers: { cookie: admin.cookie, "x-space-csrf-token": admin.csrf },
      payload: { actorId: "user:forged", protectedThreadIds: [] }
    });
    const forgedExecute = await app.inject({
      method: "POST",
      url: "/api/admin/codex-history-purges",
      headers: { cookie: admin.cookie, "x-space-csrf-token": admin.csrf },
      payload: { previewId, confirmation: "PURGE HISTORY", targetIds: [activeThreadA] }
    });
    const wrongConfirmation = await app.inject({
      method: "POST",
      url: "/api/admin/codex-history-purges",
      headers: { cookie: admin.cookie, "x-space-csrf-token": admin.csrf },
      payload: { previewId, confirmation: "PURGE" }
    });

    expect([forgedPreview.statusCode, forgedExecute.statusCode, wrongConfirmation.statusCode]).toEqual([422, 422, 422]);
    expect(service.preview).not.toHaveBeenCalled();
    expect(service.execute).not.toHaveBeenCalled();
    await app.close();
  });

  it("binds previews to the authenticated actor and re-samples active threads inside the purge barrier", async () => {
    let boundActor = "";
    const service = createService({
      preview: vi.fn(async (input) => {
        boundActor = input.actorId;
        return previewResponse;
      }),
      execute: vi.fn(async (input) => {
        if (input.actorId !== boundActor) throw new SpaceConflictError("History purge is unavailable.");
        return purgeResponse;
      })
    });
    const store = new InMemorySpaceStore();
    const listActive = vi.fn()
      .mockReturnValueOnce([activeThreadA])
      .mockReturnValue([activeThreadA, activeThreadB]);
    Object.assign(store, { listActiveManagedCodexThreadIds: listActive });
    const order: string[] = [];
    const coordinator: CodexHistoryAccessCoordinator = {
      withHistoryAttachment: async (operation) => operation(),
      withExclusivePurge: async (operation) => {
        order.push("barrier");
        return operation();
      }
    };
    const { app } = await setup({ store, service, coordinator });
    const firstAdmin = authHeaders("ADMIN", "user:admin-one");
    const secondAdmin = authHeaders("ADMIN", "user:admin-two");

    const preview = await app.inject({
      method: "POST",
      url: "/api/admin/codex-history-purge-previews",
      headers: { cookie: firstAdmin.cookie, "x-space-csrf-token": firstAdmin.csrf },
      payload: {}
    });
    expect(preview.statusCode).toBe(200);

    const otherActor = await app.inject({
      method: "POST",
      url: "/api/admin/codex-history-purges",
      headers: { cookie: secondAdmin.cookie, "x-space-csrf-token": secondAdmin.csrf },
      payload: { previewId, confirmation: "PURGE HISTORY" }
    });
    expect(otherActor.statusCode).toBe(409);

    const executed = await app.inject({
      method: "POST",
      url: "/api/admin/codex-history-purges",
      headers: { cookie: firstAdmin.cookie, "x-space-csrf-token": firstAdmin.csrf },
      payload: { previewId, confirmation: "PURGE HISTORY" }
    });
    expect(executed.statusCode).toBe(200);
    expect(executed.json()).toEqual(purgeResponse);
    expect(service.preview).toHaveBeenCalledWith({ actorId: "user:admin-one", protectedThreadIds: [activeThreadA] });
    expect(service.execute).toHaveBeenLastCalledWith({
      actorId: "user:admin-one",
      previewId,
      protectedThreadIds: [activeThreadA, activeThreadB]
    });
    expect(order).toEqual(["barrier", "barrier", "barrier"]);
    expect(listActive).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("requires the exact shared-task preview before executing native history purge", async () => {
    const service = createService();
    const { app } = await setup({ service });
    const admin = authHeaders("ADMIN");

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/codex-history-purges",
      headers: { cookie: admin.cookie, "x-space-csrf-token": admin.csrf },
      payload: { previewId, confirmation: "PURGE HISTORY" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).toContain("refresh the preview");
    expect(service.execute).not.toHaveBeenCalled();
    await app.close();
  });

  it("previews and purges inactive shared CLI tasks through the same history action", async () => {
    const store = new InMemorySpaceStore();
    const listInactivePaneCliTaskIds = vi.fn(() => ["cli_task:duplicate-a", "cli_task:duplicate-b"]);
    const hideInactivePaneCliTasks = vi.fn(() => ["cli_task:duplicate-a", "cli_task:duplicate-b"]);
    const restorePaneCliTasks = vi.fn();
    Object.assign(store, {
      listInactivePaneCliTaskIds,
      hideInactivePaneCliTasks,
      restorePaneCliTasks
    });
    const service = createService();
    const { app } = await setup({ store, service });
    const admin = authHeaders("ADMIN");

    const preview = await app.inject({
      method: "POST",
      url: "/api/admin/codex-history-purge-previews",
      headers: { cookie: admin.cookie, "x-space-csrf-token": admin.csrf },
      payload: {}
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      status: "READY",
      candidates: {
        threads: 1,
        cliTasks: 2
      }
    });

    const executed = await app.inject({
      method: "POST",
      url: "/api/admin/codex-history-purges",
      headers: { cookie: admin.cookie, "x-space-csrf-token": admin.csrf },
      payload: { previewId, confirmation: "PURGE HISTORY" }
    });
    expect(executed.statusCode).toBe(200);
    expect(executed.json()).toMatchObject({
      status: "COMPLETED",
      purged: {
        threads: 1,
        cliTasks: 2
      }
    });
    expect(hideInactivePaneCliTasks).toHaveBeenCalledWith([
      "cli_task:duplicate-a",
      "cli_task:duplicate-b"
    ]);
    expect(restorePaneCliTasks).not.toHaveBeenCalled();
    await app.close();
  });

  it("rolls back the exact purge target when its audit record cannot be persisted", async () => {
    const service = createService();
    const store = new InMemorySpaceStore();
    const restorePaneCliTasks = vi.fn();
    Object.assign(store, {
      listInactivePaneCliTaskIds: vi.fn(() => ["cli_task:audit-rollback"]),
      hideInactivePaneCliTasks: vi.fn(() => ["cli_task:audit-rollback"]),
      restorePaneCliTasks
    });
    vi.spyOn(store, "recordAuditEvent").mockRejectedValueOnce(new Error("audit database path leaked"));
    const { app } = await setup({ store, service });
    const admin = authHeaders("ADMIN");
    await app.inject({
      method: "POST",
      url: "/api/admin/codex-history-purge-previews",
      headers: { cookie: admin.cookie, "x-space-csrf-token": admin.csrf },
      payload: {}
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/codex-history-purges",
      headers: { cookie: admin.cookie, "x-space-csrf-token": admin.csrf },
      payload: { previewId, confirmation: "PURGE HISTORY" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).not.toContain("database path");
    expect(restorePaneCliTasks).toHaveBeenCalledWith(["cli_task:audit-rollback"]);
    expect(service.rollback).toHaveBeenCalledWith({ actorId: "user:admin", previewId, backupId });
    await app.close();
  });

  it("purges shared CLI history for any enabled runtime and skips native codex history when codex is disabled", async () => {
    const store = new InMemorySpaceStore();
    store.updateCliRuntimeSetting("cli:codex", { enabled: false, confirmationToken: "i".repeat(32) }, "user:admin");
    const listInactivePaneCliTaskIds = vi.fn(() => ["cli_task:opencode-a", "cli_task:claude-b"]);
    const hideInactivePaneCliTasks = vi.fn(() => ["cli_task:opencode-a", "cli_task:claude-b"]);
    Object.assign(store, {
      listInactivePaneCliTaskIds,
      hideInactivePaneCliTasks
    });
    const service = createService();
    const { app } = await setup({ store, service });
    const admin = authHeaders("ADMIN");

    const preview = await app.inject({
      method: "POST",
      url: "/api/admin/codex-history-purge-previews",
      headers: { cookie: admin.cookie, "x-space-csrf-token": admin.csrf },
      payload: {}
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      status: "READY",
      candidates: {
        threads: 0,
        cliTasks: 2,
        indexEntries: 0,
        rolloutFiles: 0,
        shellSnapshots: 0
      }
    });
    expect(service.preview).not.toHaveBeenCalled();

    const executed = await app.inject({
      method: "POST",
      url: "/api/admin/codex-history-purges",
      headers: { cookie: admin.cookie, "x-space-csrf-token": admin.csrf },
      payload: { previewId: preview.json().previewId, confirmation: "PURGE HISTORY" }
    });
    expect(executed.statusCode).toBe(200);
    expect(executed.json()).toMatchObject({
      status: "COMPLETED",
      purged: {
        threads: 0,
        cliTasks: 2,
        indexEntries: 0,
        rolloutFiles: 0,
        shellSnapshots: 0
      }
    });
    expect(service.execute).not.toHaveBeenCalled();
    expect(service.rollback).not.toHaveBeenCalled();
    expect(hideInactivePaneCliTasks).toHaveBeenCalledWith([
      "cli_task:opencode-a",
      "cli_task:claude-b"
    ]);
    await app.close();
  });

  it("blocks history purge preview and execution when no CLI runtime is enabled", async () => {
    const store = new InMemorySpaceStore();
    for (const { runtimeId } of store.listCliRuntimeSettings()) {
      store.updateCliRuntimeSetting(runtimeId, { enabled: false, confirmationToken: "i".repeat(32) }, "user:admin");
    }
    const service = createService();
    const { app } = await setup({ store, service });
    const admin = authHeaders("ADMIN");

    const preview = await app.inject({
      method: "POST",
      url: "/api/admin/codex-history-purge-previews",
      headers: { cookie: admin.cookie, "x-space-csrf-token": admin.csrf },
      payload: {}
    });
    expect(preview.statusCode).toBe(503);
    expect(preview.body).toContain("No CLI runtime is enabled");

    const executed = await app.inject({
      method: "POST",
      url: "/api/admin/codex-history-purges",
      headers: { cookie: admin.cookie, "x-space-csrf-token": admin.csrf },
      payload: { previewId, confirmation: "PURGE HISTORY" }
    });
    expect(executed.statusCode).toBe(503);
    expect(service.preview).not.toHaveBeenCalled();
    expect(service.execute).not.toHaveBeenCalled();
    await app.close();
  });

  it("rate limits repeated destructive executions", async () => {
    const service = createService();
    const { app } = await setup({ service });
    const admin = authHeaders("ADMIN");
    await app.inject({
      method: "POST",
      url: "/api/admin/codex-history-purge-previews",
      headers: { cookie: admin.cookie, "x-space-csrf-token": admin.csrf },
      payload: {}
    });
    const responses = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      responses.push(await app.inject({
        method: "POST",
        url: "/api/admin/codex-history-purges",
        headers: { cookie: admin.cookie, "x-space-csrf-token": admin.csrf },
        payload: { previewId, confirmation: "PURGE HISTORY" }
      }));
    }
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 429]);
    expect(service.execute).toHaveBeenCalledTimes(2);
    await app.close();
  });
});
