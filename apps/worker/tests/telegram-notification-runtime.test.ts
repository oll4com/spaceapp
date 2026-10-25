import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TelegramIntegrationRecord } from "@space/runtime";
import {
  runTelegramNotificationCycle,
  TelegramNotificationCycleError,
  TelegramNotificationLoop,
  writeSpaceCodexOwnershipManifest
} from "../src/telegram-notification-runtime.js";

const roots: string[] = [];
const now = "2026-07-14T10:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function integration(overrides: Partial<TelegramIntegrationRecord> = {}): TelegramIntegrationRecord {
  return {
    connectionStatus: "CONNECTED",
    isEnabled: true,
    botUserId: "42",
    botUsername: "space_bot",
    chatId: "998877",
    chatDisplayName: "Ada",
    secretVersion: "telegram_test_version",
    generation: 1,
    pollingOffset: 0,
    legacySuppressionActive: true,
    pairedAt: now,
    enabledAt: now,
    disabledAt: null,
    lastTestedAt: now,
    lastDeliveredAt: null,
    errorCode: null,
    errorAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

describe("Telegram notification runtime", () => {
  it("publishes a secret-free active ownership manifest before sweep and delivery", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-telegram-manifest-"));
    roots.push(root);
    const manifestPath = join(root, "integrations", "telegram", "space-codex-thread-ownership.json");
    const order: string[] = [];
    const sweep = vi.fn(async () => {
      order.push("sweep");
      return { claimed: 1, completed: 1, deferred: 0, ignored: 0, failed: 0 };
    });
    const delivery = vi.fn(async () => {
      order.push("delivery");
      return { claimed: 1, delivered: 1, retried: 0, failed: 0, cancelled: 0 };
    });

    await expect(runTelegramNotificationCycle({
      store: { async listManagedCodexThreadIds() { return [
        "019f0000-0000-7000-8000-000000000022",
        "019f0000-0000-7000-8000-000000000021",
        "019f0000-0000-7000-8000-000000000022"
      ]; } },
      persistence: { async getIntegration() { return integration(); } },
      deliveryWorker: { runOnce: delivery },
      sweep,
      manifestPath,
      now: () => new Date(now),
      writeManifest: async (input) => {
        const result = await writeSpaceCodexOwnershipManifest(input);
        order.push("manifest");
        return result;
      }
    })).resolves.toMatchObject({
      manifest: { active: true, threadCount: 2, changed: true },
      sweep: { completed: 1 },
      delivery: { delivered: 1 }
    });

    expect(order).toEqual(["manifest", "sweep", "delivery"]);
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toEqual({
      schemaVersion: 1,
      owner: "space",
      active: true,
      threadIds: [
        "019f0000-0000-7000-8000-000000000021",
        "019f0000-0000-7000-8000-000000000022"
      ],
      updatedAt: now
    });
    expect((await stat(manifestPath)).mode & 0o777).toBe(0o644);
    expect(await readFile(manifestPath, "utf8")).not.toMatch(/chatId|botToken|secretVersion|998877/);
    await expect(writeSpaceCodexOwnershipManifest({
      manifestPath,
      active: true,
      threadIds: [
        "019f0000-0000-7000-8000-000000000021",
        "019f0000-0000-7000-8000-000000000022"
      ],
      updatedAt: "2026-07-14T10:01:00.000Z"
    })).resolves.toMatchObject({ changed: false });
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toMatchObject({ updatedAt: now });
  });

  it("deactivates legacy suppression whenever Space delivery is disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-telegram-manifest-disabled-"));
    roots.push(root);
    const manifestPath = join(root, "space-codex-thread-ownership.json");

    await runTelegramNotificationCycle({
      store: { async listManagedCodexThreadIds() { return ["019f0000-0000-7000-8000-000000000031"]; } },
      persistence: { async getIntegration() { return integration({ connectionStatus: "DISABLED", isEnabled: false }); } },
      deliveryWorker: { async runOnce() { return { claimed: 0, delivered: 0, retried: 0, failed: 0, cancelled: 0 }; } },
      sweep: async () => ({ claimed: 0, completed: 0, deferred: 0, ignored: 0, failed: 0 }),
      manifestPath,
      now: () => new Date(now)
    });

    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toMatchObject({ active: false });
  });

  it("still sweeps and delivers when the ownership manifest stage fails", async () => {
    const sweep = vi.fn(async () => ({ claimed: 0, completed: 0, deferred: 0, ignored: 0, failed: 0 }));
    const delivery = vi.fn(async () => ({ claimed: 1, delivered: 1, retried: 0, failed: 0, cancelled: 0 }));
    const cycle = runTelegramNotificationCycle({
      store: { async listManagedCodexThreadIds() { throw new Error("database unavailable"); } },
      persistence: { async getIntegration() { return integration(); } },
      deliveryWorker: { runOnce: delivery },
      sweep,
      manifestPath: "/unused/space-codex-thread-ownership.json",
      now: () => new Date(now)
    });

    await expect(cycle).rejects.toMatchObject({ failedStages: ["manifest"] });
    await expect(cycle).rejects.toBeInstanceOf(TelegramNotificationCycleError);
    expect(sweep).toHaveBeenCalledOnce();
    expect(delivery).toHaveBeenCalledOnce();

    const logs: unknown[] = [];
    const loop = new TelegramNotificationLoop({
      intervalMs: 5_000,
      runCycle: async () => { throw new TelegramNotificationCycleError(["sweep"]); },
      log: (record) => logs.push(record)
    });
    await loop.runOnce();
    expect(logs).toEqual([{ status: "FAILED", safeErrorCode: "TELEGRAM_NOTIFICATION_CYCLE_FAILED", failedStages: ["sweep"] }]);
  });

  it("never overlaps notification cycles and reports only a safe loop error code", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runCycle = vi.fn(async () => blocked);
    const logs: Array<{ status: string; safeErrorCode: string | null }> = [];
    const loop = new TelegramNotificationLoop({
      intervalMs: 5_000,
      runCycle,
      log: (record) => logs.push(record)
    });

    const first = loop.runOnce();
    await expect(loop.runOnce()).resolves.toBe(false);
    release();
    await expect(first).resolves.toBe(true);
    expect(runCycle).toHaveBeenCalledOnce();

    const failing = new TelegramNotificationLoop({
      intervalMs: 5_000,
      runCycle: async () => { throw new Error("must not leak this database detail"); },
      log: (record) => logs.push(record)
    });
    await expect(failing.runOnce()).resolves.toBe(true);
    expect(logs).toContainEqual({ status: "FAILED", safeErrorCode: "TELEGRAM_NOTIFICATION_CYCLE_FAILED" });
    expect(JSON.stringify(logs)).not.toContain("database detail");
  });
});
