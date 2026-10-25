import { describe, expect, it, vi } from "vitest";
import { codexHistoryPurgePreviewResponseSchema } from "@space/contracts";
import {
  createCodexHistoryAccessCoordinator,
  createCodexHistoryPurgeService
} from "../src/codex-history-purge.js";

const actorId = "user:admin";
const previewId = "9943e22b-97a3-48b6-ae84-1a2cced6a353";
const backupId = "c3d866d1-9690-4db5-b44c-6294c07aa83e";
const protectedThreadId = "8f2c4dcc-5f4d-4a33-950c-7b74825dca55";
const checkedAt = "2026-07-17T08:00:00.000Z";

describe("Codex history purge command service", () => {
  it("uses only fixed wrapper actions, sends strict JSON on stdin, and validates every response", async () => {
    const previewResponse = {
      status: "READY",
      previewId,
      candidates: { threads: 1, indexEntries: 1, rolloutFiles: 1, shellSnapshots: 0 },
      protectedThreads: 1,
      expiresAt: "2026-07-17T08:05:00.000Z",
      checkedAt
    };
    expect(codexHistoryPurgePreviewResponseSchema.safeParse(previewResponse)).toMatchObject({ success: true });
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      switch (args[0]) {
        case "history-purge-preview":
          return JSON.stringify(previewResponse);
        case "history-purge-execute":
          return JSON.stringify({
            status: "COMPLETED",
            previewId,
            backupId,
            purged: { threads: 1, indexEntries: 1, rolloutFiles: 1, shellSnapshots: 0 },
            protectedThreads: 1,
            newlyProtectedThreads: 0,
            completedAt: checkedAt
          });
        case "history-purge-rollback":
          return JSON.stringify({ status: "ROLLED_BACK", previewId, backupId, rolledBackAt: checkedAt });
        default:
          throw new Error("unexpected action");
      }
    });
    const service = createCodexHistoryPurgeService({ command: "/fixed/wrapper", runCommand });

    await service.preview({ actorId, protectedThreadIds: [protectedThreadId] });
    await service.execute({ actorId, previewId, protectedThreadIds: [protectedThreadId] });
    await service.rollback({ actorId, previewId, backupId });

    expect(runCommand.mock.calls).toEqual([
      [
        "/fixed/wrapper",
        ["history-purge-preview"],
        JSON.stringify({ actorId, protectedThreadIds: [protectedThreadId] }),
        { timeoutMs: 120_000 }
      ],
      [
        "/fixed/wrapper",
        ["history-purge-execute"],
        JSON.stringify({ actorId, previewId, protectedThreadIds: [protectedThreadId] }),
        { timeoutMs: 330_000 }
      ],
      [
        "/fixed/wrapper",
        ["history-purge-rollback"],
        JSON.stringify({ actorId, previewId, backupId }),
        { timeoutMs: 330_000 }
      ]
    ]);
  });

  it("reports execute failures as unconfirmed instead of claiming the helper is unavailable", async () => {
    const service = createCodexHistoryPurgeService({
      runCommand: vi.fn(async () => {
        throw new Error("command timed out");
      })
    });

    await expect(service.execute({ actorId, previewId, protectedThreadIds: [] })).rejects.toMatchObject({
      message: "History purge did not complete. No success was confirmed; refresh the preview before retrying."
    });
  });

  it.each(["preview", "execute", "rollback"] as const)("keeps %s helper diagnostics private", async (action) => {
    const service = createCodexHistoryPurgeService({
      runCommand: async () => {
        throw new Error("/private/session.json Authorization: Bearer synthetic-private-value");
      }
    });
    await expect(service[action]({ actorId, previewId, backupId, protectedThreadIds: [] }))
      .rejects.toMatchObject({ message: action === "execute"
        ? "History purge did not complete. No success was confirmed; refresh the preview before retrying."
        : "History purge is unavailable." });
  });

  it("replaces command failures and forged helper output with one safe error", async () => {
    const leakedPath = "/var/lib/spaceapp-user/.codex/session_index.jsonl";
    const rejected = createCodexHistoryPurgeService({
      runCommand: vi.fn(async () => {
        throw new Error(`failed at ${leakedPath}`);
      })
    });
    await expect(rejected.preview({ actorId, protectedThreadIds: [] })).rejects.toMatchObject({
      message: "History purge is unavailable."
    });

    const forged = createCodexHistoryPurgeService({
      runCommand: vi.fn(async () => JSON.stringify({
        status: "NOOP",
        previewId,
        candidates: { threads: 0, indexEntries: 0, rolloutFiles: 0, shellSnapshots: 0 },
        protectedThreads: 0,
        expiresAt: "2026-07-17T08:05:00.000Z",
        checkedAt,
        internalPath: leakedPath
      }))
    });
    await expect(forged.preview({ actorId, protectedThreadIds: [] })).rejects.toMatchObject({
      message: "History purge is unavailable."
    });
  });
});

describe("Codex history access coordinator", () => {
  it("waits for an attachment before purge and blocks later attachments until purge completes", async () => {
    const coordinator = createCodexHistoryAccessCoordinator();
    const order: string[] = [];
    let releaseFirstAttachment!: () => void;
    let releasePurge!: () => void;

    const firstAttachment = coordinator.withHistoryAttachment(async () => {
      order.push("attachment:start");
      await new Promise<void>((resolve) => { releaseFirstAttachment = resolve; });
      order.push("attachment:end");
    });
    await vi.waitFor(() => expect(order).toEqual(["attachment:start"]));

    const purge = coordinator.withExclusivePurge(async () => {
      order.push("purge:start");
      await new Promise<void>((resolve) => { releasePurge = resolve; });
      order.push("purge:end");
    });
    const secondAttachment = coordinator.withHistoryAttachment(async () => {
      order.push("attachment:second");
    });
    await Promise.resolve();
    expect(order).toEqual(["attachment:start"]);

    releaseFirstAttachment();
    await vi.waitFor(() => expect(order).toContain("purge:start"));
    expect(order).not.toContain("attachment:second");

    releasePurge();
    await Promise.all([firstAttachment, purge, secondAttachment]);
    expect(order).toEqual([
      "attachment:start",
      "attachment:end",
      "purge:start",
      "purge:end",
      "attachment:second"
    ]);
  });
});
