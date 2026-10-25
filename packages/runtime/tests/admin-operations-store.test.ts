import { describe, expect, it } from "vitest";
import { InMemorySpaceStore } from "../src/index.js";

describe("admin operation persistence", () => {
  it("persists durable operation status transitions", () => {
    const store = new InMemorySpaceStore();
    const run = store.createAdminOperationRun({
      operationType: "CLI_MAINTENANCE_CHECK",
      actorUserId: null,
      summary: "Queued daily CLI health check"
    });

    const running = store.updateAdminOperationRun(run.id, {
      status: "RUNNING",
      startedAt: "2026-07-23T09:20:00.000+03:00",
      summary: "Checking Space and all CLI runtimes"
    });
    const completed = store.updateAdminOperationRun(run.id, {
      status: "PARTIAL",
      finishedAt: "2026-07-23T09:21:00.000+03:00",
      result: { warningCount: 1 }
    });

    expect(running.status).toBe("RUNNING");
    expect(completed.result).toEqual({ warningCount: 1 });
    expect(store.getAdminOperationRun(run.id)).toEqual(completed);
    expect(store.listAdminOperationRuns(10)).toEqual([completed]);
  });

  it("persists ordered redacted maintenance events and durable auth handoffs", () => {
    const store = new InMemorySpaceStore();
    const run = store.createAdminOperationRun({
      operationType: "CLI_MAINTENANCE_REPAIR",
      actorUserId: "user:admin_12345678",
      summary: "Queued CLI health and repair"
    });
    const first = store.appendCliMaintenanceEvent({
      runId: run.id,
      runtimeId: "cli:gemini",
      phase: "CHECK",
      state: "STARTED",
      severity: "INFO",
      code: "CHECK_STARTED",
      message: "Checking Gemini.",
      attempt: 1,
      installedVersion: "0.51.0",
      availableVersion: "0.52.0",
      targetVersion: "0.52.0",
      durationMs: null,
      outcome: null,
      rollback: null,
      diagnostics: {
        provider: "gemini",
        authorization: "Bearer must-not-survive",
        nested: { cookie: "space_session=must-not-survive" }
      }
    });
    const second = store.appendCliMaintenanceEvent({
      runId: run.id,
      runtimeId: "cli:gemini",
      phase: "AUTH_HANDOFF",
      state: "WARNING",
      severity: "WARN",
      code: "AUTH_REQUIRED",
      message: "Gemini provider login is required.",
      attempt: 1,
      installedVersion: "0.52.0",
      availableVersion: "0.52.0",
      targetVersion: "0.52.0",
      durationMs: 25,
      outcome: "ACTION_REQUIRED",
      rollback: null,
      diagnostics: { provider: "gemini" }
    });

    expect([first.sequence, second.sequence]).toEqual([1, 2]);
    expect(store.listCliMaintenanceEvents(run.id, 1, 50)).toEqual([second]);
    expect(JSON.stringify(store.listCliMaintenanceEvents(run.id, 0, 50))).not.toContain("must-not-survive");

    const handoff = store.createCliMaintenanceAuthHandoff({
      runId: run.id,
      runtimeId: "cli:gemini",
      roomId: null
    });
    const failed = store.updateCliMaintenanceAuthHandoff(handoff.id, {
      status: "FAILED",
      roomId: "room:Recovery_123",
      attemptCount: 1,
      safeErrorCode: "LOGIN_EXITED"
    });
    expect(store.listCliMaintenanceAuthHandoffs(run.id)).toEqual([failed]);
    expect(failed.completedAt).toBeTruthy();
  });

  it("persists only a protected source-control secret reference", () => {
    const store = new InMemorySpaceStore();
    expect(store.getSourceControlConnection("gitea").repositoryName).toBe("spaceapp");
    const record = store.upsertSourceControlConnection({
      provider: "github",
      accountLogin: "oll4com",
      connectionStatus: "CONNECTED",
      secretRef: "source_control_github_12345678",
      lastVerifiedAt: "2026-07-23T09:20:00.000+03:00",
      lastVerificationCode: "VERIFIED"
    });

    expect(record.secretRef).toBe("source_control_github_12345678");
    expect(record.repositoryName).toBe("spaceapp");
    expect(record).not.toHaveProperty("token");
    expect(JSON.stringify(store.snapshot())).not.toContain("write_only_value_");
  });

  it("persists release previews bound to the actor and exact commit state", () => {
    const store = new InMemorySpaceStore();
    const preview = store.createReleasePreview(
      {
        tag: "v2026.07.23.1",
        notes: "## Changes\n\n- Maintenance",
        sourceCommit: "43a3d4c04b43ec507ba1d8e9c77b840a58a9a467",
        previousTag: "v2026.07.22.1",
        remoteMainCommits: {
          gitea: "42aac2eac274e2ab0512071615647073582d43a8",
          github: "42aac2eac274e2ab0512071615647073582d43a8"
        },
        expiresAt: "2026-07-23T09:30:00.000+03:00"
      },
      "user:admin_12345678"
    );

    expect(preview.actorUserId).toBe("user:admin_12345678");
    expect(store.getReleasePreview(preview.id)).toEqual(preview);
  });
});
