import type { FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  appDiagnosticsEventBatchMaxBytes,
  appDiagnosticsVideoSegmentMaxBytes
} from "@space/contracts";
import { InMemoryAppDiagnosticsRepository } from "@space/db";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { AppDiagnosticsService } from "../src/app-diagnostics.js";
import { createCsrfToken, csrfHeaderName, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";

const sessionSecret = "app-diagnostics-api-test-secret";
const apps: FastifyInstance[] = [];
const roots: string[] = [];

function authHeaders(
  role: "ADMIN" | "OPERATOR",
  includeCsrf = true,
  automationScope?: "APP_DIAGNOSTICS"
) {
  const session = signSession({
    id: `user:${role.toLowerCase()}`,
    email: `${role.toLowerCase()}@space.test`,
    role,
    ...(automationScope ? {
      proofScope: "READ_ONLY" as const,
      automationScope
    } : {})
  }, sessionSecret);
  return {
    cookie: `space_session=${session}`,
    ...(includeCsrf ? { [csrfHeaderName]: createCsrfToken(session, sessionSecret)! } : {})
  };
}

async function setup(options: { cliHostClient?: unknown } = {}) {
  const root = await mkdtemp(join(tmpdir(), "space-app-diagnostics-api-"));
  roots.push(root);
  const diagnosticsRepository = new InMemoryAppDiagnosticsRepository();
  let nowMs = Date.parse("2026-07-24T10:00:00.000Z");
  let nextId = 0;
  const diagnostics = new AppDiagnosticsService({
    repository: diagnosticsRepository,
    root,
    now: () => new Date(nowMs),
    createId: (prefix) => `${prefix}:api${String(++nextId).padStart(8, "0")}`
  });
  const store = new InMemorySpaceStore();
  const app = await createApp({
    store,
    appDiagnosticsService: diagnostics,
    config: getApiConfig({}),
    auth: { sessionSecret, devLogin: false, secureCookies: false },
    ...(options.cliHostClient ? { cliHostClient: options.cliHostClient as never } : {})
  });
  apps.push(app);
  return {
    app,
    store,
    diagnosticsRepository,
    setNow: (value: string) => {
      nowMs = Date.parse(value);
    }
  };
}

function eventBatch(captureId: string) {
  return {
    captureId,
    clientId: "app_debug_client:abcdefgh1234",
    batchId: "app_debug_batch:abcdefgh1234",
    firstSequence: 1,
    lastSequence: 1,
    startedAt: "2026-07-24T10:00:00.000Z",
    endedAt: "2026-07-24T10:00:01.000Z",
    droppedBeforeBatch: 0,
    events: [
      {
        sequence: 1,
        occurredAt: "2026-07-24T10:00:00.100Z",
        category: "LIFECYCLE",
        event: "MOUNT"
      }
    ],
    snapshots: []
  };
}

function webm(): Buffer {
  const value = Buffer.alloc(700);
  value.set([0x1a, 0x45, 0xdf, 0xa3], 0);
  return value;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("app diagnostics API", () => {
  it("keeps app-diagnostics automation read-only outside diagnostics and bounded CLI telemetry", async () => {
    const { app, store } = await setup({
      cliHostClient: {
        inspect: async () => null,
        close: async () => undefined
      }
    });
    const automation = authHeaders("ADMIN", true, "APP_DIAGNOSTICS");

    const rooms = await app.inject({
      method: "GET",
      url: "/api/rooms",
      headers: automation
    });
    expect(rooms.statusCode).toBe(200);

    const existingRoom = store.createRoom({ name: "Existing workspace", initialPaneCount: 0 });
    const existingPane = store.createPane({
      roomId: existingRoom.id,
      title: "Existing CLI",
      mode: "TERMINAL",
      terminalRuntimeId: "cli:codex",
      cwd: "/etc"
    });
    const existingSession = store.createPaneCliSession({
      paneId: existingPane.id,
      roomId: existingRoom.id,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: null,
      reasoningEffort: "low",
      cwd: "/etc",
      status: "RUNNING",
      statusReason: "existing",
      isActive: true
    });
    store.appendPaneCliTranscriptChunk({
      sessionId: existingSession.sessionId,
      paneId: existingPane.id,
      roomId: existingRoom.id,
      sequence: 0,
      stream: "stdout",
      content: "private terminal content"
    });
    const observerSession = await app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(existingPane.id)}/cli/session?includeTranscript=true`,
      headers: automation
    });
    expect(observerSession.statusCode).toBe(200);
    expect(observerSession.json().transcript).toEqual([]);
    expect(observerSession.json().websocket.proofScope).toBe("READ_ONLY");
    expect(observerSession.json().runtime).toMatchObject({
      id: "cli:codex",
      status: "ENABLED",
      statusReason:
        "An existing Space-managed CLI process is running; diagnostics observer metadata skips launch and credential probes."
    });

    const enabled = await app.inject({
      method: "PATCH",
      url: "/api/admin/app-diagnostics",
      headers: automation,
      payload: { isEnabled: true }
    });
    expect(enabled.statusCode).toBe(200);

    const telemetry = await app.inject({
      method: "POST",
      url: "/api/cli/client-events",
      headers: automation,
      payload: {
        event: "SOCKET_READY",
        outcome: "SUCCESS",
        reason: "INITIAL_ATTACH",
        paneId: "pane:diagnostics-automation",
        sessionId: "cli_session:diagnostics-automation",
        runtimeId: "cli:codex",
        controlState: "OBSERVER",
        protocolVersion: 2,
        clientMode: "OBSERVER",
        socketGeneration: 1,
        clientAt: "2026-07-24T10:00:00.000Z"
      }
    });
    expect(telemetry.statusCode).toBe(202);

    const roomsBeforeMutations = await store.listRooms();

    for (const mutation of [
      {
        method: "POST" as const,
        url: "/api/rooms",
        payload: { name: "Must not be created", initialPaneCount: 0 }
      },
      {
        method: "POST" as const,
        url: "/api/panes",
        payload: {}
      }
    ]) {
      const response = await app.inject({
        ...mutation,
        headers: automation
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("AUTOMATION_SCOPE_READ_ONLY");
    }
    expect(await store.listRooms()).toEqual(roomsBeforeMutations);

    const disabled = await app.inject({
      method: "PATCH",
      url: "/api/admin/app-diagnostics",
      headers: automation,
      payload: { isEnabled: false }
    });
    expect(disabled.statusCode).toBe(200);
  });

  it("is readable by operators but only admins can change the global CSRF-protected setting", async () => {
    const { app, store } = await setup();
    const operator = authHeaders("OPERATOR");
    const admin = authHeaders("ADMIN");

    const initial = await app.inject({ method: "GET", url: "/api/app-diagnostics", headers: operator });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({ isEnabled: false, captureId: null });

    const forbidden = await app.inject({
      method: "PATCH",
      url: "/api/admin/app-diagnostics",
      headers: operator,
      payload: { isEnabled: true }
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe("ADMIN_REQUIRED");

    const noCsrf = await app.inject({
      method: "PATCH",
      url: "/api/admin/app-diagnostics",
      headers: authHeaders("ADMIN", false),
      payload: { isEnabled: true }
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().error.code).toBe("CSRF_INVALID");

    const enabled = await app.inject({
      method: "PATCH",
      url: "/api/admin/app-diagnostics",
      headers: admin,
      payload: { isEnabled: true }
    });
    const repeated = await app.inject({
      method: "PATCH",
      url: "/api/admin/app-diagnostics",
      headers: admin,
      payload: { isEnabled: true }
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().isEnabled).toBe(true);
    expect(repeated.json().captureId).toBe(enabled.json().captureId);
    expect((await store.listAuditEvents()).filter((event) => event.action === "admin.app_diagnostics.enabled"))
      .toHaveLength(1);
  });

  it("accepts strict client batches and rejects all late uploads immediately after OFF", async () => {
    const { app } = await setup();
    const admin = authHeaders("ADMIN");
    const operator = authHeaders("OPERATOR");
    const enabled = await app.inject({
      method: "PATCH",
      url: "/api/admin/app-diagnostics",
      headers: admin,
      payload: { isEnabled: true }
    });
    const captureId = enabled.json().captureId as string;

    const accepted = await app.inject({
      method: "POST",
      url: "/api/app-diagnostics/event-batches",
      headers: operator,
      payload: eventBatch(captureId)
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ acceptedEvents: 1, acceptedSnapshots: 0 });

    const forbiddenText = await app.inject({
      method: "POST",
      url: "/api/app-diagnostics/event-batches",
      headers: operator,
      payload: {
        ...eventBatch(captureId),
        events: [{
          sequence: 1,
          occurredAt: "2026-07-24T10:00:00.100Z",
          category: "ERROR",
          name: "Error",
          message: "terminal output must not be accepted"
        }]
      }
    });
    expect(forbiddenText.statusCode).toBe(422);

    await app.inject({
      method: "PATCH",
      url: "/api/admin/app-diagnostics",
      headers: admin,
      payload: { isEnabled: false }
    });
    const late = await app.inject({
      method: "POST",
      url: "/api/app-diagnostics/event-batches",
      headers: operator,
      payload: eventBatch(captureId)
    });
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe("CAPTURE_INACTIVE");
  });

  it("enforces event-batch body and rate limits at the HTTP boundary", async () => {
    const { app } = await setup();
    const admin = authHeaders("ADMIN");
    const operator = authHeaders("OPERATOR");
    const enabled = await app.inject({
      method: "PATCH",
      url: "/api/admin/app-diagnostics",
      headers: admin,
      payload: { isEnabled: true }
    });
    const captureId = enabled.json().captureId as string;

    const oversized = await app.inject({
      method: "POST",
      url: "/api/app-diagnostics/event-batches",
      headers: operator,
      payload: {
        ...eventBatch(captureId),
        ignoredPadding: "x".repeat(appDiagnosticsEventBatchMaxBytes)
      }
    });
    expect(oversized.statusCode).toBe(413);

    for (let index = 0; index < 60; index += 1) {
      const accepted = await app.inject({
        method: "POST",
        url: "/api/app-diagnostics/event-batches",
        headers: operator,
        payload: {
          ...eventBatch(captureId),
          batchId: `app_debug_batch:rate${String(index).padStart(8, "0")}`
        }
      });
      expect(accepted.statusCode).toBe(200);
    }
    const rateLimited = await app.inject({
      method: "POST",
      url: "/api/app-diagnostics/event-batches",
      headers: operator,
      payload: {
        ...eventBatch(captureId),
        batchId: "app_debug_batch:rate99999999"
      }
    });
    expect(rateLimited.statusCode).toBe(429);

    const otherClient = await app.inject({
      method: "POST",
      url: "/api/app-diagnostics/event-batches",
      headers: operator,
      payload: {
        ...eventBatch(captureId),
        clientId: "app_debug_client:otherclient12",
        batchId: "app_debug_batch:otherclient12"
      }
    });
    expect(otherClient.statusCode).toBe(200);
  });

  it("keeps video lease, upload, listing, and download endpoints admin-only", async () => {
    const { app } = await setup();
    const admin = authHeaders("ADMIN");
    const operator = authHeaders("OPERATOR");
    const enabled = await app.inject({
      method: "PATCH",
      url: "/api/admin/app-diagnostics",
      headers: admin,
      payload: { isEnabled: true }
    });
    const captureId = enabled.json().captureId as string;

    const operatorLease = await app.inject({
      method: "POST",
      url: "/api/admin/app-diagnostics/video-leases",
      headers: operator,
      payload: {
        clientId: "app_debug_client:abcdefgh1234",
        pageClientId: "app_debug_page:abcdefgh1234"
      }
    });
    expect(operatorLease.statusCode).toBe(403);

    const leaseResponse = await app.inject({
      method: "POST",
      url: "/api/admin/app-diagnostics/video-leases",
      headers: admin,
      payload: {
        clientId: "app_debug_client:abcdefgh1234",
        pageClientId: "app_debug_page:abcdefgh1234"
      }
    });
    expect(leaseResponse.statusCode).toBe(200);
    const leaseId = leaseResponse.json().leaseId as string;

    const heartbeat = await app.inject({
      method: "POST",
      url: `/api/admin/app-diagnostics/video-leases/${encodeURIComponent(leaseId)}/heartbeats`,
      headers: admin,
      payload: { captureId }
    });
    expect(heartbeat.statusCode).toBe(200);
    expect(heartbeat.json().status).toBe("ACTIVE");

    const invalidMime = await app.inject({
      method: "POST",
      url: `/api/admin/app-diagnostics/video-segments/${encodeURIComponent(leaseId)}/0?startedAt=2026-07-24T10%3A00%3A00.000Z&endedAt=2026-07-24T10%3A00%3A30.000Z&firstEventSequence=1&lastEventSequence=2`,
      headers: { ...admin, "content-type": "application/octet-stream" },
      payload: webm()
    });
    expect(invalidMime.statusCode).toBe(415);

    const invalidMagic = await app.inject({
      method: "POST",
      url: `/api/admin/app-diagnostics/video-segments/${encodeURIComponent(leaseId)}/0?startedAt=2026-07-24T10%3A00%3A00.000Z&endedAt=2026-07-24T10%3A00%3A30.000Z&firstEventSequence=1&lastEventSequence=2`,
      headers: { ...admin, "content-type": "video/webm" },
      payload: Buffer.from("not a WebM segment")
    });
    expect(invalidMagic.statusCode).toBe(415);
    expect(invalidMagic.json().error.code).toBe("VIDEO_MAGIC_INVALID");

    const oversized = Buffer.alloc(appDiagnosticsVideoSegmentMaxBytes + 1);
    oversized.set([0x1a, 0x45, 0xdf, 0xa3]);
    const oversizedUpload = await app.inject({
      method: "POST",
      url: `/api/admin/app-diagnostics/video-segments/${encodeURIComponent(leaseId)}/0?startedAt=2026-07-24T10%3A00%3A00.000Z&endedAt=2026-07-24T10%3A00%3A30.000Z&firstEventSequence=1&lastEventSequence=2`,
      headers: { ...admin, "content-type": "video/webm" },
      payload: oversized
    });
    expect(oversizedUpload.statusCode).toBe(413);

    const uploaded = await app.inject({
      method: "POST",
      url: `/api/admin/app-diagnostics/video-segments/${encodeURIComponent(leaseId)}/0?startedAt=2026-07-24T10%3A00%3A00.000Z&endedAt=2026-07-24T10%3A00%3A30.000Z&firstEventSequence=1&lastEventSequence=2`,
      headers: { ...admin, "content-type": "video/webm" },
      payload: webm()
    });
    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.json()).toMatchObject({ kind: "VIDEO", byteSize: 700 });
    const segmentId = uploaded.json().segmentId as string;

    const operatorList = await app.inject({
      method: "GET",
      url: "/api/admin/app-diagnostics/segments",
      headers: operator
    });
    expect(operatorList.statusCode).toBe(403);

    const listed = await app.inject({
      method: "GET",
      url: `/api/admin/app-diagnostics/segments?captureId=${encodeURIComponent(captureId)}`,
      headers: admin
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().data.some((segment: { segmentId: string }) => segment.segmentId === segmentId)).toBe(true);

    const downloaded = await app.inject({
      method: "GET",
      url: `/api/admin/app-diagnostics/segments/${encodeURIComponent(segmentId)}/content`,
      headers: admin
    });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.headers["content-type"]).toContain("video/webm");
    expect(downloaded.rawPayload.subarray(0, 4)).toEqual(webm().subarray(0, 4));

    const released = await app.inject({
      method: "DELETE",
      url: `/api/admin/app-diagnostics/video-leases/${encodeURIComponent(leaseId)}`,
      headers: admin
    });
    expect(released.statusCode).toBe(200);
    expect(released.json().status).toBe("RELEASED");
  });
});
