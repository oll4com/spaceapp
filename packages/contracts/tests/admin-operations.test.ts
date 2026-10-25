import { describe, expect, it } from "vitest";
import {
  adminOperationRunSchema,
  cliMaintenanceAuthHandoffSchema,
  cliMaintenanceEventSchema,
  cliMaintenanceRequestSchema,
  createReleaseRequestSchema,
  releasePreviewSchema,
  roomKindSchema,
  sourceControlConnectionSchema,
  updateSourceControlConnectionInputSchema
} from "../src/index.js";

const now = "2026-07-23T09:15:00.000+03:00";

describe("admin operation contracts", () => {
  it("accepts durable operation runs without accepting arbitrary commands", () => {
    const run = adminOperationRunSchema.parse({
      id: "admin_run:release_12345678",
      operationType: "SPACE_RELEASE",
      status: "RUNNING",
      actorUserId: "user:admin_12345678",
      summary: "Publishing v2026.07.23.1",
      result: { completedProviders: ["gitea"] },
      createdAt: now,
      startedAt: now,
      finishedAt: null,
      updatedAt: now
    });

    expect(run.status).toBe("RUNNING");
    expect(() =>
      adminOperationRunSchema.parse({
        ...run,
        command: "git push --force"
      })
    ).toThrow();
  });

  it("requires the exact destructive CLI update confirmation", () => {
    expect(cliMaintenanceRequestSchema.parse({ mode: "CHECK" })).toEqual({ mode: "CHECK" });
    expect(cliMaintenanceRequestSchema.parse({ mode: "REPAIR" })).toEqual({ mode: "REPAIR" });
    expect(
      cliMaintenanceRequestSchema.parse({
        mode: "UPDATE",
        confirmation: "UPDATE ALL CLI APPS"
      })
    ).toEqual({
      mode: "UPDATE",
      confirmation: "UPDATE ALL CLI APPS"
    });
    expect(() => cliMaintenanceRequestSchema.parse({ mode: "UPDATE", confirmation: "UPDATE" })).toThrow();
  });

  it("adds repair operations, ordered safe events, auth handoffs, and the recovery room kind", () => {
    expect(roomKindSchema.parse("CLI_RECOVERY")).toBe("CLI_RECOVERY");
    expect(
      adminOperationRunSchema.parse({
        id: "admin_run:Repair_123-x",
        operationType: "CLI_MAINTENANCE_REPAIR",
        status: "RUNNING",
        actorUserId: "user:admin_12345678",
        summary: "Repairing managed CLI runtimes",
        result: {},
        createdAt: now,
        startedAt: now,
        finishedAt: null,
        updatedAt: now
      }).operationType
    ).toBe("CLI_MAINTENANCE_REPAIR");

    const event = cliMaintenanceEventSchema.parse({
      id: "cli_maintenance_event:Abcd_1234-xy",
      runId: "admin_run:Repair_123-x",
      sequence: 7,
      runtimeId: "cli:gemini",
      phase: "AUTH_HANDOFF",
      state: "WARNING",
      severity: "WARN",
      code: "AUTH_REQUIRED",
      message: "Gemini requires provider login.",
      attempt: 1,
      installedVersion: "0.52.0",
      availableVersion: "0.52.0",
      targetVersion: "0.52.0",
      durationMs: 125,
      outcome: "ACTION_REQUIRED",
      rollback: null,
      diagnostics: { provider: "gemini", redacted: true },
      createdAt: now
    });
    expect(event.sequence).toBe(7);
    expect(() => cliMaintenanceEventSchema.parse({
      ...event,
      diagnostics: { value: "x".repeat(20_000) }
    })).toThrow();

    expect(cliMaintenanceAuthHandoffSchema.parse({
      id: "cli_auth_handoff:Abcd_1234-xy",
      runId: "admin_run:Repair_123-x",
      runtimeId: "cli:gemini",
      roomId: "room:Recovery_123",
      status: "PENDING",
      attemptCount: 0,
      safeErrorCode: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null
    }).status).toBe("PENDING");
  });

  it("keeps source-control tokens write-only", () => {
    const input = updateSourceControlConnectionInputSchema.parse({
      token: "test_value_123456789012345678901234567890123456"
    });
    expect(input.token).toContain("test_value_");

    const connection = sourceControlConnectionSchema.parse({
      provider: "github",
      repositoryOwner: "oll4com",
      repositoryName: "space",
      accountLogin: "oll4com",
      status: "CONNECTED",
      secretConfigured: true,
      lastVerifiedAt: now,
      lastVerificationCode: "VERIFIED",
      updatedAt: now
    });
    expect(connection).not.toHaveProperty("token");
    expect(() => sourceControlConnectionSchema.parse({ ...connection, token: input.token })).toThrow();

    expect(sourceControlConnectionSchema.parse({
      ...connection,
      provider: "gitea"
    }).repositoryName).toBe("space");
    expect(() => sourceControlConnectionSchema.parse({
      ...connection,
      provider: "gitea",
      repositoryName: "coder/codex/rooms"
    })).toThrow();
  });

  it("requires the exact PUBLISH confirmation and rejects injection-shaped tags", () => {
    const preview = releasePreviewSchema.parse({
      id: "release_preview:12345678",
      tag: "v2026.07.23.1",
      notes: "## Changes\n\n- Add maintenance",
      sourceCommit: "43a3d4c04b43ec507ba1d8e9c77b840a58a9a467",
      previousTag: "v2026.07.22.1",
      remoteMainCommits: {
        gitea: "42aac2eac274e2ab0512071615647073582d43a8",
        github: "42aac2eac274e2ab0512071615647073582d43a8"
      },
      expiresAt: "2026-07-23T09:25:00.000+03:00",
      createdAt: now
    });

    expect(
      createReleaseRequestSchema.parse({
        previewId: preview.id,
        tag: preview.tag,
        notes: preview.notes,
        confirmation: "PUBLISH"
      }).tag
    ).toBe(preview.tag);
    expect(() =>
      createReleaseRequestSchema.parse({
        previewId: preview.id,
        tag: "v2026.07.23.1; rm -rf /tmp/x",
        notes: preview.notes,
        confirmation: "PUBLISH"
      })
    ).toThrow();
    expect(() =>
      createReleaseRequestSchema.parse({
        previewId: preview.id,
        tag: preview.tag,
        notes: preview.notes,
        confirmation: "PUBLISH v2026.07.23.2"
      })
    ).toThrow();
  });
});
