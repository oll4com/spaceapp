import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { createCsrfToken, signSession } from "../src/auth.js";
import {
  ReleasePublishingManager,
  createReleaseControlClient,
  type ReleaseControl
} from "../src/release-publishing.js";
import { getApiConfig } from "../src/config.js";

const sessionSecret = "release-publishing-test-secret";
const apps: FastifyInstance[] = [];
const previewState = {
  tag: "v2026.07.23.1",
  notes: "- Add release publishing (abc123456)",
  sourceCommit: "42aac2eac274e2ab0512071615647073582d43a8",
  previousTag: "v2026.07.22.1",
  remoteMainCommits: {
    gitea: "15aac2eac274e2ab0512071615647073582d43a1",
    github: "15aac2eac274e2ab0512071615647073582d43a1"
  },
  expiresAt: "2026-07-23T09:00:00.000Z"
} as const;

function authHeaders(role: "OPERATOR" | "ADMIN", includeCsrf = true) {
  const session = signSession(
    { id: `user:${role.toLowerCase()}`, email: `${role.toLowerCase()}@space.local`, role },
    sessionSecret
  );
  return {
    cookie: `space_session=${session}`,
    ...(includeCsrf ? { "x-space-csrf-token": createCsrfToken(session, sessionSecret)! } : {})
  };
}

function connectedStore() {
  const store = new InMemorySpaceStore();
  store.upsertSourceControlConnection({
    provider: "gitea",
    accountLogin: "gitea-admin",
    connectionStatus: "CONNECTED",
    secretRef: "source_control_gitea_12345678",
    lastVerifiedAt: "2026-07-23T08:00:00.000Z",
    lastVerificationCode: "VERIFIED"
  });
  store.upsertSourceControlConnection({
    provider: "github",
    accountLogin: "github-admin",
    connectionStatus: "CONNECTED",
    secretRef: "source_control_github_12345678",
    lastVerifiedAt: "2026-07-23T08:00:00.000Z",
    lastVerificationCode: "VERIFIED"
  });
  return store;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("release publishing control boundary", () => {
  it("passes only protected references in fixed sudo arguments and keeps release text on stdin", async () => {
    const calls: Array<{ command: string; args: string[]; stdin: string }> = [];
    const client = createReleaseControlClient(async (command, args, stdin) => {
      calls.push({ command, args, stdin });
      return JSON.stringify(previewState);
    });
    const connections = await connectedStore().listSourceControlConnections();

    const preview = await client.preview(connections, { notes: previewState.notes });

    expect(preview).toEqual(previewState);
    expect(calls).toEqual([{
      command: "/usr/bin/sudo",
      args: [
        "-n",
        "/opt/spaceapp/bin/space-release-control",
        "preview",
        "source_control_gitea_12345678",
        "source_control_github_12345678"
      ],
      stdin: `${JSON.stringify({ notes: previewState.notes })}\n`
    }]);
    expect(calls[0]?.args.join(" ")).not.toContain(previewState.notes);
  });
});

describe("release publishing manager", () => {
  it("persists an actor-bound preview and queues an exact confirmed release", async () => {
    const store = connectedStore();
    const control: ReleaseControl = {
      preview: vi.fn(async () => previewState),
      dispatch: vi.fn(async () => undefined)
    };
    const manager = new ReleasePublishingManager({
      store,
      control,
      now: () => new Date("2026-07-23T08:35:00.000Z")
    });

    const preview = await manager.createPreview({}, "user:admin");
    const run = await manager.publish({
      previewId: preview.id,
      tag: preview.tag,
      notes: preview.notes,
      confirmation: "PUBLISH"
    }, "user:admin");

    expect(preview).toMatchObject({ ...previewState, actorUserId: "user:admin" });
    expect(run).toMatchObject({
      operationType: "SPACE_RELEASE",
      status: "QUEUED",
      actorUserId: "user:admin",
      result: {
        previewId: preview.id,
        tag: preview.tag,
        sourceCommit: preview.sourceCommit,
        notes: preview.notes
      }
    });
    expect(control.dispatch).toHaveBeenCalledWith(run.id);
  });

  it("rejects another actor, an expired preview, changed notes, and concurrent release runs", async () => {
    const store = connectedStore();
    const control: ReleaseControl = {
      preview: vi.fn(async () => previewState),
      dispatch: vi.fn(async () => undefined)
    };
    let now = new Date("2026-07-23T08:35:00.000Z");
    const manager = new ReleasePublishingManager({ store, control, now: () => now });
    const preview = await manager.createPreview({}, "user:admin");
    const request = {
      previewId: preview.id,
      tag: preview.tag,
      notes: preview.notes,
      confirmation: "PUBLISH"
    };

    await expect(manager.publish(request, "user:other"))
      .rejects.toMatchObject({ code: "PREVIEW_ACTOR_MISMATCH" });
    await expect(manager.publish({ ...request, notes: `${preview.notes}\nchanged` }, "user:admin"))
      .rejects.toMatchObject({ code: "PREVIEW_MISMATCH" });
    now = new Date("2026-07-23T09:01:00.000Z");
    await expect(manager.publish(request, "user:admin"))
      .rejects.toMatchObject({ code: "PREVIEW_EXPIRED" });
    now = new Date("2026-07-23T08:40:00.000Z");
    await manager.publish(request, "user:admin");
    await expect(manager.publish(request, "user:admin"))
      .rejects.toMatchObject({ code: "RELEASE_IN_PROGRESS" });
  });

  it("allows an expired preview only as an explicit retry of a matching partial run", async () => {
    const store = connectedStore();
    const control: ReleaseControl = {
      preview: vi.fn(async () => previewState),
      dispatch: vi.fn(async () => undefined)
    };
    const manager = new ReleasePublishingManager({
      store,
      control,
      now: () => new Date("2026-07-23T09:05:00.000Z")
    });
    const preview = await manager.createPreview({}, "user:admin");
    const partial = await store.createAdminOperationRun({
      operationType: "SPACE_RELEASE",
      actorUserId: "user:admin",
      summary: `Space release ${preview.tag} was published partially.`,
      result: {
        previewId: preview.id,
        tag: preview.tag,
        sourceCommit: preview.sourceCommit
      }
    });
    await store.updateAdminOperationRun(partial.id, {
      status: "PARTIAL",
      finishedAt: "2026-07-23T08:50:00.000Z"
    });

    const retry = await manager.publish({
      previewId: preview.id,
      tag: preview.tag,
      notes: preview.notes,
      confirmation: "PUBLISH"
    }, "user:admin");

    expect(retry.result).toMatchObject({
      previewId: preview.id,
      notes: preview.notes,
      retryOfRunId: partial.id
    });
    expect(control.dispatch).toHaveBeenCalledWith(retry.id);
  });

  it("keeps an expired partial release retryable after a failed dispatch attempt", async () => {
    const store = connectedStore();
    const control: ReleaseControl = {
      preview: vi.fn(async () => previewState),
      dispatch: vi.fn(async () => undefined)
    };
    const manager = new ReleasePublishingManager({
      store,
      control,
      now: () => new Date("2026-07-23T09:05:00.000Z")
    });
    const preview = await manager.createPreview({}, "user:admin");
    const partial = await store.createAdminOperationRun({
      operationType: "SPACE_RELEASE",
      actorUserId: "user:admin",
      summary: `Space release ${preview.tag} was published partially.`,
      result: {
        previewId: preview.id,
        tag: preview.tag,
        sourceCommit: preview.sourceCommit,
        notes: preview.notes
      }
    });
    const durablePartial = await store.updateAdminOperationRun(partial.id, {
      status: "PARTIAL",
      finishedAt: "2026-07-23T08:50:00.000Z"
    });
    const queuedFailedRetry = await store.createAdminOperationRun({
      operationType: "SPACE_RELEASE",
      actorUserId: "user:admin",
      summary: `Space release ${preview.tag} could not be dispatched.`,
      result: {
        previewId: preview.id,
        tag: preview.tag,
        sourceCommit: preview.sourceCommit,
        notes: preview.notes,
        retryOfRunId: partial.id,
        code: "DISPATCH_FAILED"
      }
    });
    const failedRetry = await store.updateAdminOperationRun(queuedFailedRetry.id, {
      status: "FAILED",
      finishedAt: "2026-07-23T08:55:00.000Z"
    });
    vi.spyOn(store, "listAdminOperationRuns").mockReturnValue([failedRetry, durablePartial]);

    const retry = await manager.publish({
      previewId: preview.id,
      tag: preview.tag,
      notes: preview.notes,
      confirmation: "PUBLISH"
    }, "user:admin");

    expect(retry.result.retryOfRunId).toBe(partial.id);
    expect(control.dispatch).toHaveBeenCalledWith(retry.id);
  });
});

describe("release publishing API", () => {
  it("requires ADMIN and CSRF, then exposes preview, publish, and durable run reads", async () => {
    const store = connectedStore();
    const control: ReleaseControl = {
      preview: vi.fn(async () => previewState),
      dispatch: vi.fn(async () => undefined)
    };
    const manager = new ReleasePublishingManager({
      store,
      control,
      now: () => new Date("2026-07-23T08:35:00.000Z")
    });
    const app = await createApp({
      store,
      releasePublishingManager: manager,
      config: getApiConfig({}),
      auth: { sessionSecret, devLogin: false, secureCookies: false }
    });
    apps.push(app);

    const forbidden = await app.inject({
      method: "POST",
      url: "/api/admin/releases/previews",
      headers: authHeaders("OPERATOR"),
      payload: {}
    });
    expect(forbidden.statusCode).toBe(403);

    const csrfRejected = await app.inject({
      method: "POST",
      url: "/api/admin/releases/previews",
      headers: authHeaders("ADMIN", false),
      payload: {}
    });
    expect(csrfRejected.statusCode).toBe(403);

    const previewResponse = await app.inject({
      method: "POST",
      url: "/api/admin/releases/previews",
      headers: authHeaders("ADMIN"),
      payload: {}
    });
    expect(previewResponse.statusCode).toBe(201);
    const preview = previewResponse.json();

    const publishResponse = await app.inject({
      method: "POST",
      url: "/api/admin/releases",
      headers: authHeaders("ADMIN"),
      payload: {
        previewId: preview.id,
        tag: preview.tag,
        notes: preview.notes,
        confirmation: "PUBLISH"
      }
    });
    expect(publishResponse.statusCode).toBe(202);
    const run = publishResponse.json();

    const list = await app.inject({
      method: "GET",
      url: "/api/admin/releases/runs",
      headers: authHeaders("ADMIN")
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toEqual([run]);

    const detail = await app.inject({
      method: "GET",
      url: `/api/admin/releases/runs/${encodeURIComponent(run.id)}`,
      headers: authHeaders("ADMIN")
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toEqual(run);
  });
});
