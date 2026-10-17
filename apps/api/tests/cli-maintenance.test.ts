import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { createCsrfToken, signSession } from "../src/auth.js";
import {
  CliMaintenanceManager,
  createCliMaintenanceDispatcherClient,
  createCliUpdateAllRunner,
  type CliMaintenanceDispatcher,
  type CliUpdateAllRunner
} from "../src/cli-maintenance.js";
import { getApiConfig } from "../src/config.js";

const sessionSecret = "cli-maintenance-test-secret";
const timestamp = "2026-07-24T03:00:00.000Z";
const apps: FastifyInstance[] = [];

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

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("CLI maintenance manager", () => {
  it("keeps the repair operation disabled until the compatibility rollout is enabled", async () => {
    const dispatcher: CliMaintenanceDispatcher = { dispatch: vi.fn(async () => undefined) };
    const store = new InMemorySpaceStore();
    const disabled = new CliMaintenanceManager({ store, dispatcher });

    await expect(disabled.start({ mode: "REPAIR" }, "user:admin")).rejects.toMatchObject({
      code: "CLI_MAINTENANCE_REPAIR_DISABLED"
    });

    const enabled = new CliMaintenanceManager({ store, dispatcher, repairEnabled: true });
    await expect(enabled.start({ mode: "REPAIR" }, "user:admin")).resolves.toMatchObject({
      operationType: "CLI_MAINTENANCE_REPAIR",
      status: "QUEUED"
    });
  });

  it("dispatches only the durable run id through the fixed privileged command", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const dispatcher = createCliMaintenanceDispatcherClient(async (command, args) => {
      calls.push({ command, args });
    });
    const store = new InMemorySpaceStore();
    const manager = new CliMaintenanceManager({ store, dispatcher });

    const run = await manager.start({ mode: "CHECK" }, "user:admin");

    expect(run).toMatchObject({
      operationType: "CLI_MAINTENANCE_CHECK",
      status: "QUEUED",
      actorUserId: "user:admin"
    });
    expect(calls).toEqual([{
      command: "/usr/bin/sudo",
      args: ["-n", "/opt/spaceapp/bin/space-cli-maintenance-dispatcher", run.id]
    }]);
    expect(calls[0]?.args.join(" ")).not.toMatch(/doctor|update|upgrade|codex|claude|bash|sh -c/i);
  });

  it("serializes check and update runs across the durable store", async () => {
    const dispatcher: CliMaintenanceDispatcher = { dispatch: vi.fn(async () => undefined) };
    const store = new InMemorySpaceStore();
    const manager = new CliMaintenanceManager({ store, dispatcher });

    const first = await manager.start({ mode: "CHECK" }, "user:admin");

    await expect(
      manager.start({ mode: "UPDATE", confirmation: "UPDATE ALL CLI APPS" }, "user:admin")
    ).rejects.toMatchObject({ code: "CLI_MAINTENANCE_IN_PROGRESS" });
    expect(store.getAdminOperationRun(first.id)?.status).toBe("QUEUED");
  });

  it("completes provider handoffs and reconciles a partial repair after verified login", async () => {
    const store = new InMemorySpaceStore();
    const run = store.createAdminOperationRun({
      operationType: "CLI_MAINTENANCE_REPAIR",
      actorUserId: null,
      summary: "CLI repair requires provider login."
    });
    store.updateAdminOperationRun(run.id, {
      status: "PARTIAL",
      summary: "CLI repair completed partially; provider login or operator attention is required.",
      result: {
        mode: "REPAIR",
        overallStatus: "WARN",
        space: { status: "PASS", code: "SPACE_HEALTHY", summary: "Space is healthy.", checks: [] },
        runtimes: [{
          runtimeId: "cli:gemini",
          displayName: "Gemini CLI",
          installedVersion: "0.52.0",
          availableVersion: "0.52.0",
          status: "WARN",
          code: "AUTH_REQUIRED",
          summary: "Provider login is required.",
          checks: [],
          outcome: "ACTION_REQUIRED",
          authRequired: true
        }]
      },
      startedAt: timestamp,
      finishedAt: timestamp
    });
    const handoff = store.createCliMaintenanceAuthHandoff({
      runId: run.id,
      runtimeId: "cli:gemini",
      roomId: null
    });
    const openedHandoff = store.updateCliMaintenanceAuthHandoff(handoff.id, {
      status: "OPENED",
      roomId: "room:Recovery123"
    });
    const manager = new CliMaintenanceManager({
      store,
      dispatcher: { dispatch: vi.fn(async () => undefined) },
      repairEnabled: true
    });

    expect(manager.isStreamTerminal({
      run: store.getAdminOperationRun(run.id)!,
      events: [],
      authHandoffs: [openedHandoff]
    })).toBe(false);
    const completed = await manager.completeAuthHandoffsForRuntime("cli:gemini");

    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      id: handoff.id,
      status: "COMPLETED",
      safeErrorCode: null
    });
    expect(store.getAdminOperationRun(run.id)).toMatchObject({
      status: "SUCCEEDED",
      summary: "Space and all managed CLI repairs completed successfully after provider login.",
      result: {
        overallStatus: "PASS",
        runtimes: [{
          runtimeId: "cli:gemini",
          status: "PASS",
          code: "AUTH_RECOVERED",
          outcome: "HEALTHY",
          authRequired: false
        }]
      }
    });
    expect(store.listCliMaintenanceEvents(run.id).map((event) => event.code)).toEqual([
      "CLI_AUTH_RECOVERED",
      "REPAIR_SUCCEEDED_AFTER_AUTH"
    ]);
    expect(manager.isStreamTerminal(await manager.replay(run.id))).toBe(true);
    await expect(manager.completeAuthHandoffsForRuntime("cli:gemini")).resolves.toEqual([]);
    expect(store.listCliMaintenanceEvents(run.id)).toHaveLength(2);
  });
});

describe("CLI maintenance API", () => {
  it("routes detection to unprivileged node and updates to the fixed root control", async () => {
    const detectExecutor = vi.fn(async () => ({
      code: 0,
      stderr: "",
      stdout: `${JSON.stringify({
        schemaVersion: "space.cli-update-all.detection.v1",
        detectedAt: timestamp,
        cliTypes: [{
          key: "qwen",
          cliType: "cli:qwen",
          displayName: "Qwen Code CLI",
          managed: true,
          updateKind: "patched-npm",
          enabled: false,
          hasCustom: false,
          custom: []
        }]
      })}\n`
    }));
    const controlExecutor = vi.fn(async () => ({
      code: 0,
      stderr: "",
      stdout: `${JSON.stringify({
        mode: "UPDATE_ALL",
        overallStatus: "PASS",
        scope: ["qwen"],
        reinstall: true,
        runtimes: [],
        startedAt: null,
        finishedAt: timestamp
      })}\n`
    }));
    const runner = createCliUpdateAllRunner(detectExecutor, controlExecutor);

    await expect(runner.detect()).resolves.toMatchObject({ schemaVersion: "space.cli-update-all.detection.v1" });
    await expect(runner.updateAll({ keys: ["qwen"], reinstall: true })).resolves.toMatchObject({ overallStatus: "PASS" });
    expect(detectExecutor).toHaveBeenCalledWith(["/opt/spaceapp/scripts/cli-maintenance-update-all.mjs", "detect"]);
    expect(controlExecutor).toHaveBeenCalledWith({ keys: ["qwen"], reinstall: true });
  });

  it("guards update-all, passes real runtime visibility to detection, and rejects unknown keys", async () => {
    const store = new InMemorySpaceStore();
    store.updateCliRuntimeSetting(
      "cli:gemini",
      { enabled: false, confirmationToken: "u".repeat(32) },
      "user:admin"
    );
    const detect = vi.fn(async (settings: ReadonlyArray<{ runtimeId: string; enabled: boolean }> = []) => ({
      schemaVersion: "space.cli-update-all.detection.v1" as const,
      detectedAt: timestamp,
      cliTypes: [{
        key: "gemini",
        cliType: "cli:gemini",
        displayName: "Gemini CLI",
        managed: true,
        updateKind: "antigravity",
        enabled: settings.find((setting) => setting.runtimeId === "cli:gemini")?.enabled ?? true,
        hasCustom: false,
        custom: []
      }]
    }));
    const updateAll = vi.fn(async () => ({
      mode: "UPDATE_ALL" as const,
      overallStatus: "PASS" as const,
      scope: "all" as const,
      reinstall: false,
      runtimes: [],
      startedAt: null,
      finishedAt: timestamp
    }));
    const runner: CliUpdateAllRunner = { detect, updateAll };
    const app = await createApp({
      store,
      cliUpdateAllRunner: runner,
      config: getApiConfig({}),
      auth: { sessionSecret, devLogin: false, secureCookies: false }
    });
    apps.push(app);

    const forbidden = await app.inject({
      method: "GET",
      url: "/api/admin/cli-maintenance/update-all/detect",
      headers: authHeaders("OPERATOR")
    });
    expect(forbidden.statusCode).toBe(403);

    const detection = await app.inject({
      method: "GET",
      url: "/api/admin/cli-maintenance/update-all/detect",
      headers: authHeaders("ADMIN")
    });
    expect(detection.statusCode).toBe(200);
    expect(detection.json().cliTypes[0]).toMatchObject({ cliType: "cli:gemini", enabled: false });
    expect(detect).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ runtimeId: "cli:gemini", enabled: false })
    ]));

    const invalid = await app.inject({
      method: "POST",
      url: "/api/admin/cli-maintenance/update-all/run",
      headers: authHeaders("ADMIN"),
      payload: { keys: ["not-a-runtime"] }
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe("INVALID_UPDATE_ALL_REQUEST");
    expect(updateAll).not.toHaveBeenCalled();

    const accepted = await app.inject({
      method: "POST",
      url: "/api/admin/cli-maintenance/update-all/run",
      headers: authHeaders("ADMIN"),
      payload: { keys: ["gemini"], reinstall: true }
    });
    expect(accepted.statusCode).toBe(200);
    expect(updateAll).toHaveBeenCalledWith({ keys: ["gemini"], reinstall: true });
    // The end of the update reaches the operator even when its window was minimized or closed.
    const notifications = await app.inject({ method: "GET", url: "/api/notifications?status=OPEN&source=SYSTEM", headers: authHeaders("ADMIN") });
    expect(notifications.json().notifications).toEqual([expect.objectContaining({
      kind: "CLI_UPDATE_FINISHED", severity: "INFO", title: "CLI update finished", body: "0 updated · 0 failed · 0 checked."
    })]);
  });

  it("requires ADMIN, CSRF, and the exact update confirmation", async () => {
    const store = new InMemorySpaceStore();
    const dispatcher: CliMaintenanceDispatcher = { dispatch: vi.fn(async () => undefined) };
    const manager = new CliMaintenanceManager({ store, dispatcher });
    const app = await createApp({
      store,
      cliMaintenanceManager: manager,
      config: getApiConfig({}),
      auth: { sessionSecret, devLogin: false, secureCookies: false }
    });
    apps.push(app);

    const forbidden = await app.inject({
      method: "POST",
      url: "/api/admin/cli-maintenance/runs",
      headers: authHeaders("OPERATOR"),
      payload: { mode: "CHECK" }
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe("ADMIN_REQUIRED");

    const csrfRejected = await app.inject({
      method: "POST",
      url: "/api/admin/cli-maintenance/runs",
      headers: authHeaders("ADMIN", false),
      payload: { mode: "CHECK" }
    });
    expect(csrfRejected.statusCode).toBe(403);
    expect(csrfRejected.json().error.code).toBe("CSRF_INVALID");

    const confirmationRejected = await app.inject({
      method: "POST",
      url: "/api/admin/cli-maintenance/runs",
      headers: authHeaders("ADMIN"),
      payload: { mode: "UPDATE", confirmation: "UPDATE" }
    });
    expect(confirmationRejected.statusCode).toBe(422);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/admin/cli-maintenance/runs",
      headers: authHeaders("ADMIN"),
      payload: { mode: "UPDATE", confirmation: "UPDATE ALL CLI APPS" }
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({
      operationType: "CLI_MAINTENANCE_UPDATE",
      status: "QUEUED",
      actorUserId: "user:admin"
    });
  });

  it("lists and reads durable runs without exposing a command surface", async () => {
    const store = new InMemorySpaceStore();
    const dispatcher: CliMaintenanceDispatcher = { dispatch: vi.fn(async () => undefined) };
    const manager = new CliMaintenanceManager({ store, dispatcher });
    const run = await manager.start({ mode: "CHECK" }, "user:admin");
    const app = await createApp({
      store,
      cliMaintenanceManager: manager,
      config: getApiConfig({}),
      auth: { sessionSecret, devLogin: false, secureCookies: false }
    });
    apps.push(app);

    const list = await app.inject({
      method: "GET",
      url: "/api/admin/cli-maintenance/runs",
      headers: authHeaders("ADMIN")
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toEqual([run]);

    const detail = await app.inject({
      method: "GET",
      url: `/api/admin/cli-maintenance/runs/${encodeURIComponent(run.id)}`,
      headers: authHeaders("ADMIN")
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toEqual(run);
    expect(JSON.stringify(detail.json())).not.toMatch(/command|argv|shell/i);
  });

  it("replays ordered repair events, resumes SSE, and exports only redacted diagnostics", async () => {
    const store = new InMemorySpaceStore();
    const run = store.createAdminOperationRun({
      operationType: "CLI_MAINTENANCE_REPAIR",
      actorUserId: "user:admin",
      summary: "Queued Space and CLI health and repair."
    });
    const baseEvent = {
      runId: run.id,
      runtimeId: "cli:codex" as const,
      state: "SUCCEEDED" as const,
      severity: "INFO" as const,
      attempt: 1,
      installedVersion: "1.0.0",
      availableVersion: "1.1.0",
      targetVersion: "1.1.0",
      durationMs: 4,
      outcome: "REPAIRED" as const,
      rollback: null
    };
    store.appendCliMaintenanceEvent({
      ...baseEvent,
      phase: "CHECK",
      code: "CHECK_COMPLETE",
      message: "Check complete.",
      diagnostics: { authorization: "Bearer secret-value", note: "safe" }
    });
    const second = store.appendCliMaintenanceEvent({
      ...baseEvent,
      phase: "COMPLETE",
      code: "REPAIR_COMPLETE",
      message: "Repair complete.",
      diagnostics: { cookie: "space_session=secret-cookie", safeCode: "DONE" }
    });
    store.createCliMaintenanceAuthHandoff({
      runId: run.id,
      runtimeId: "cli:codex",
      roomId: null
    });
    store.updateAdminOperationRun(run.id, {
      status: "PARTIAL",
      summary: "Repair requires provider login.",
      result: { code: "AUTH_REQUIRED", access_token: "must-not-export" },
      startedAt: timestamp,
      finishedAt: timestamp
    });
    const manager = new CliMaintenanceManager({
      store,
      dispatcher: { dispatch: vi.fn(async () => undefined) },
      repairEnabled: true
    });
    const app = await createApp({
      store,
      cliMaintenanceManager: manager,
      config: getApiConfig({ SPACE_CLI_MAINTENANCE_REPAIR_ENABLED: "true" }),
      auth: { sessionSecret, devLogin: false, secureCookies: false }
    });
    apps.push(app);

    const replay = await app.inject({
      method: "GET",
      url: `/api/admin/cli-maintenance/runs/${encodeURIComponent(run.id)}/replay?afterSequence=0`,
      headers: authHeaders("ADMIN")
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().events.map((event: { sequence: number }) => event.sequence)).toEqual([1, 2]);
    expect(replay.json().authHandoffs).toHaveLength(1);
    expect(JSON.stringify(replay.json())).not.toMatch(/secret-value|secret-cookie|must-not-export/);
    expect(JSON.stringify(replay.json())).toContain("[REDACTED]");

    store.updateAdminOperationRun(run.id, {
      status: "SUCCEEDED",
      summary: "Repair complete.",
      finishedAt: timestamp
    });
    const stream = await app.inject({
      method: "GET",
      url: `/api/admin/cli-maintenance/runs/${encodeURIComponent(run.id)}/stream`,
      headers: {
        ...authHeaders("ADMIN"),
        "last-event-id": "1"
      }
    });
    expect(stream.statusCode).toBe(200);
    expect(stream.headers["content-type"]).toContain("text/event-stream");
    expect(stream.body).toContain(`id: ${second.sequence}`);
    expect(stream.body).not.toContain("id: 1\n");

    const exported = await app.inject({
      method: "GET",
      url: `/api/admin/cli-maintenance/runs/${encodeURIComponent(run.id)}/export`,
      headers: authHeaders("ADMIN")
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-disposition"]).toContain(".json");
    expect(exported.json().schemaVersion).toBe("space.cli-maintenance.export.v1");
    expect(exported.json().events).toHaveLength(2);
    expect(JSON.stringify(exported.json())).not.toMatch(/secret-value|secret-cookie|must-not-export/);
    expect(JSON.stringify(exported.json())).toContain("[REDACTED]");
  });

  it("opens pending auth handoffs in one reusable CLI Recovery room", async () => {
    const store = new InMemorySpaceStore();
    const run = store.createAdminOperationRun({
      operationType: "CLI_MAINTENANCE_REPAIR",
      actorUserId: null,
      summary: "Scheduled repair requires provider login."
    });
    const handoff = store.createCliMaintenanceAuthHandoff({
      runId: run.id,
      runtimeId: "cli:gemini",
      roomId: null
    });
    const opened: Array<{ roomId: string; runtimeId: string }> = [];
    const manager = new CliMaintenanceManager({
      store,
      dispatcher: { dispatch: vi.fn(async () => undefined) },
      repairEnabled: true
    });
    const app = await createApp({
      store,
      cliMaintenanceManager: manager,
      cliRecoveryLoginOpener: async (input) => {
        opened.push({ roomId: input.roomId, runtimeId: input.runtimeId });
        return { paneId: "pane:Recovery12" };
      },
      config: getApiConfig({ SPACE_CLI_MAINTENANCE_REPAIR_ENABLED: "true" }),
      auth: { sessionSecret, devLogin: false, secureCookies: false }
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/cli-maintenance/auth-handoffs/open",
      headers: authHeaders("ADMIN"),
      payload: {}
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "OPENED",
      room: { kind: "CLI_RECOVERY", name: "CLI Recovery" },
      handoffs: [{
        id: handoff.id,
        runtimeId: "cli:gemini",
        status: "OPENED",
        attemptCount: 1
      }]
    });
    expect(opened).toEqual([{
      roomId: response.json().room.id,
      runtimeId: "cli:gemini"
    }]);
    expect(store.listRooms().filter((room) => room.kind === "CLI_RECOVERY")).toHaveLength(1);

    const second = await app.inject({
      method: "POST",
      url: "/api/admin/cli-maintenance/auth-handoffs/open",
      headers: authHeaders("ADMIN"),
      payload: {}
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().room.id).toBe(response.json().room.id);
    expect(opened).toHaveLength(1);

    store.deleteRoom(response.json().room.id);
    const reopened = await app.inject({
      method: "POST",
      url: "/api/admin/cli-maintenance/auth-handoffs/open",
      headers: authHeaders("ADMIN"),
      payload: {}
    });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json().room.id).not.toBe(response.json().room.id);
    expect(reopened.json().handoffs[0]).toMatchObject({
      status: "OPENED",
      attemptCount: 2,
      roomId: reopened.json().room.id
    });
    expect(opened).toHaveLength(2);
  });

  it("ignores auth handoffs for disabled CLI runtimes", async () => {
    const store = new InMemorySpaceStore();
    const run = store.createAdminOperationRun({
      operationType: "CLI_MAINTENANCE_REPAIR",
      actorUserId: null,
      summary: "Scheduled repair found provider logins."
    });
    store.updateCliRuntimeSetting(
      "cli:gemini",
      { enabled: false, confirmationToken: "i".repeat(32) },
      "user:admin"
    );
    store.createCliMaintenanceAuthHandoff({
      runId: run.id,
      runtimeId: "cli:gemini",
      roomId: null
    });
    const enabledHandoff = store.createCliMaintenanceAuthHandoff({
      runId: run.id,
      runtimeId: "cli:codex",
      roomId: null
    });
    const opened: string[] = [];
    const manager = new CliMaintenanceManager({
      store,
      dispatcher: { dispatch: vi.fn(async () => undefined) },
      repairEnabled: true
    });
    const app = await createApp({
      store,
      cliMaintenanceManager: manager,
      cliRecoveryLoginOpener: async ({ runtimeId }) => {
        opened.push(runtimeId);
        return { paneId: "pane:RecoveryEnabled" };
      },
      config: getApiConfig({ SPACE_CLI_MAINTENANCE_REPAIR_ENABLED: "true" }),
      auth: { sessionSecret, devLogin: false, secureCookies: false }
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/cli-maintenance/auth-handoffs/open",
      headers: authHeaders("ADMIN"),
      payload: {}
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().handoffs).toEqual([
      expect.objectContaining({ id: enabledHandoff.id, runtimeId: "cli:codex", status: "OPENED" })
    ]);
    expect(opened).toEqual(["cli:codex"]);
  });
});

describe("reviewed maintenance plans", () => {
  async function fixture() {
    const store = new InMemorySpaceStore();
    const dispatcher = { dispatch: vi.fn(async () => undefined) };
    const manager = new CliMaintenanceManager({ store, dispatcher, repairEnabled: true });
    const source = await manager.createPlan({ scope: "enabled" }, "user:admin");
    await store.updateAdminOperationRun(source.id, { status: "SUCCEEDED", result: { plan: {
      planId: source.id, scope: "enabled", checkedAt: timestamp,
      actions: [{ id: "cli:codex", label: "Codex", kind: "UPDATE", reasons: ["Update available"], installedVersion: "1", targetVersion: "2", fingerprint: "check" }]
    } } });
    const input = { selectedActionIds: ["cli:codex" as const], idempotencyKey: "12345678-1234-4234-8234-123456789012", confirmation: "APPLY MAINTENANCE" as const };
    return { store, dispatcher, manager, source, input };
  }
  it("deduplicates retries without dispatching twice", async () => {
    const { manager, source, input, dispatcher } = await fixture();
    const first = await manager.applyPlan(source.id, input, "user:admin");
    expect(await manager.applyPlan(source.id, input, "user:admin")).toEqual(first);
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(2); // one check, one apply
    expect(first.result).toMatchObject({ scope: "enabled", selectedActionIds: ["cli:codex"] });
  });
  it("rejects scope widening and another actor", async () => {
    const { manager, source, input } = await fixture();
    await expect(manager.applyPlan(source.id, { ...input, selectedActionIds: ["cli:claude"] }, "user:admin")).rejects.toMatchObject({ statusCode: 409 });
    await expect(manager.applyPlan(source.id, input, "user:other")).rejects.toMatchObject({ statusCode: 409 });
  });
  it("retains the existing compatibility rollout gate", async () => {
    const { store, dispatcher, source, input } = await fixture();
    const manager = new CliMaintenanceManager({ store, dispatcher, repairEnabled: false });
    await expect(manager.applyPlan(source.id, input, "user:admin")).rejects.toMatchObject({ code: "CLI_MAINTENANCE_REPAIR_DISABLED" });
  });
});
