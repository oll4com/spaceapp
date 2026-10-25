import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  TelegramApiError,
  TelegramDeliveryWorker,
  TelegramIntegrationError,
  TelegramSecretStore,
  formatTelegramCompletionParts,
  normalizeTelegramTaskTitle,
  type TelegramIntegrationRecord,
  type TelegramOutboxPersistence,
  type TelegramOutboxRecord
} from "../src/index.js";

const roots: string[] = [];
const now = "2026-07-14T10:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function delivery(overrides: Partial<TelegramOutboxRecord> = {}): TelegramOutboxRecord {
  return {
    deliveryId: "telegram_delivery:test123",
    integrationGeneration: 3,
    sourceKey: "terminal:marker-1",
    sourceType: "TERMINAL",
    roomId: "room:test123",
    paneId: "pane:test123",
    turnId: null,
    roomName: "Ελληνικό δωμάτιο",
    paneTitle: "Codex Terminal",
    agentLabel: "Agent 3",
    taskTitle: "Διόρθωση Telegram ειδοποιήσεων",
    finalResponse: "Ολοκληρώθηκε ✅",
    completedAt: now,
    status: "SENDING",
    nextPartIndex: 0,
    attemptCount: 1,
    availableAt: now,
    lockedAt: now,
    lockedBy: "worker:test",
    safeErrorCode: null,
    createdAt: now,
    updatedAt: now,
    deliveredAt: null,
    ...overrides
  };
}

function integration(secretVersion: string): TelegramIntegrationRecord {
  return {
    connectionStatus: "CONNECTED",
    isEnabled: true,
    botUserId: "42",
    botUsername: "space_bot",
    chatId: "998877",
    chatDisplayName: "Ada",
    secretVersion,
    generation: 3,
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
    updatedAt: now
  };
}

class FakeOutbox implements TelegramOutboxPersistence {
  retries: Array<{ availableAt: string; safeErrorCode: string }> = [];
  retryAttemptCounts: Array<boolean | undefined> = [];
  failures: string[] = [];
  progress: Array<{ nextPartIndex: number; delivered: boolean }> = [];
  markedErrors: string[] = [];

  constructor(public currentIntegration: TelegramIntegrationRecord, public queued: TelegramOutboxRecord[]) {}
  async getIntegration() { return this.currentIntegration; }
  async claimDeliveries() { return this.queued.splice(0); }
  async recordDeliveryProgress(input: { nextPartIndex: number; delivered: boolean }) {
    this.progress.push({ nextPartIndex: input.nextPartIndex, delivered: input.delivered });
  }
  async retryDelivery(input: { availableAt: string; safeErrorCode: string; countAttempt?: boolean }) {
    this.retries.push({ availableAt: input.availableAt, safeErrorCode: input.safeErrorCode });
    this.retryAttemptCounts.push(input.countAttempt);
  }
  async failDelivery(input: { safeErrorCode: string }) { this.failures.push(input.safeErrorCode); }
  async cancelDelivery() {}
  async markError(code: string) {
    this.markedErrors.push(code);
    this.currentIntegration = { ...this.currentIntegration, connectionStatus: "ERROR", isEnabled: false };
    return this.currentIntegration;
  }
}

describe("Telegram notification formatting and delivery", () => {
  it("labels Room Agent notices as questions for the operator, not completions", () => {
    const [notice] = formatTelegramCompletionParts(delivery({ sourceKey: "room-agent-event:room_agent_event:abc", sourceType: "ROOM_AGENT",
      agentLabel: "Room Agent", taskTitle: "Dana is waiting: Permission prompt", finalResponse: "Needs you: only the operator may approve git push." }));
    expect(notice).toContain("Space — Room Agent needs you");
    expect(notice).toContain("Question: Dana is waiting: Permission prompt");
    expect(notice).not.toContain("Task completed");
    expect(formatTelegramCompletionParts(delivery())[0]).toContain("Space — Task completed");
  });

  it("preserves full Greek and Unicode responses across bounded labelled parts", () => {
    const finalResponse = "αβγ🙂\n".repeat(1_400);
    const parts = formatTelegramCompletionParts(delivery({ finalResponse }));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => Array.from(part).length <= 2_500)).toBe(true);
    expect(parts[0]).toContain(`[part 1/${parts.length}]`);
    expect(parts[0]).toContain("Agent: Agent 3");
    expect(parts[0]).toContain("Room: Ελληνικό δωμάτιο");
    expect(parts[0]).toContain("Task: Διόρθωση Telegram ειδοποιήσεων");
    expect(parts[0]).not.toContain("Pane:");
    expect(parts.at(-1)).toContain("[END]");
    const reconstructed = parts.map((part) => part.split("\n\n").slice(1).join("\n\n").replace(/\n\n\[END\]$/, "")).join("");
    expect(reconstructed).toBe(finalResponse);
  });

  it("derives a bounded deterministic Room Agent task title from the first non-empty prompt line", () => {
    expect(normalizeTelegramTaskTitle(
      "\n  Διόρθωση   Telegram\t ειδοποιήσεων  \nΑγνόησε αυτή τη δεύτερη γραμμή.",
      "Room Agent task"
    )).toBe("Διόρθωση Telegram ειδοποιήσεων");
    expect(Array.from(normalizeTelegramTaskTitle("🙂".repeat(140), "Room Agent task"))).toHaveLength(120);
    expect(normalizeTelegramTaskTitle(" \n\t ", "Room Agent task")).toBe("Room Agent task");
  });

  it("resumes multipart delivery and records progress after every successful part", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-telegram-delivery-"));
    roots.push(root);
    const secrets = new TelegramSecretStore(root);
    const version = await secrets.write("123456789:abcdefghijklmnopqrstuvwxyz_ABCDE");
    const record = delivery({ finalResponse: "Δ".repeat(6_000), nextPartIndex: 1 });
    const persistence = new FakeOutbox(integration(version), [record]);
    const sent: string[] = [];
    const worker = new TelegramDeliveryWorker({
      persistence,
      secrets,
      workerId: "worker:test",
      clientFactory: () => ({ async sendMessage(_chatId, text) { sent.push(text); return { messageId: "1" }; } })
    });

    const result = await worker.runOnce();
    const totalParts = formatTelegramCompletionParts(record).length;
    expect(result).toMatchObject({ delivered: 1, retried: 0, failed: 0 });
    expect(sent).toHaveLength(totalParts - 1);
    expect(persistence.progress.at(-1)).toEqual({ nextPartIndex: totalParts, delivered: true });
  });

  it("honors retry_after and turns permanent Telegram failures into visible integration errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-telegram-retry-"));
    roots.push(root);
    const secrets = new TelegramSecretStore(root);
    const version = await secrets.write("123456789:abcdefghijklmnopqrstuvwxyz_ABCDE");
    const retryStore = new FakeOutbox(integration(version), [delivery({ attemptCount: 2 })]);
    const retryWorker = new TelegramDeliveryWorker({
      persistence: retryStore,
      secrets,
      workerId: "worker:test",
      now: () => new Date(now),
      clientFactory: () => ({ async sendMessage() { throw new TelegramApiError("TELEGRAM_RATE_LIMITED", 429, 17); } })
    });
    await expect(retryWorker.runOnce()).resolves.toMatchObject({ retried: 1 });
    expect(retryStore.retries).toEqual([{ availableAt: "2026-07-14T10:00:17.000Z", safeErrorCode: "TELEGRAM_RATE_LIMITED" }]);

    const permanentStore = new FakeOutbox(integration(version), [delivery()]);
    const permanentWorker = new TelegramDeliveryWorker({
      persistence: permanentStore,
      secrets,
      workerId: "worker:test",
      clientFactory: () => ({ async sendMessage() { throw new TelegramApiError("TELEGRAM_FORBIDDEN", 403, null, true); } })
    });
    await expect(permanentWorker.runOnce()).resolves.toMatchObject({ failed: 1 });
    expect(permanentStore.failures).toEqual(["TELEGRAM_FORBIDDEN"]);
    expect(permanentStore.markedErrors).toEqual(["TELEGRAM_FORBIDDEN"]);
  });

  it("waits out a rate limit on the final attempt and holds the rest of the batch", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-telegram-rate-limit-"));
    roots.push(root);
    const secrets = new TelegramSecretStore(root);
    const version = await secrets.write("123456789:abcdefghijklmnopqrstuvwxyz_ABCDE");
    const persistence = new FakeOutbox(integration(version), [
      delivery({ attemptCount: 5 }),
      delivery({ deliveryId: "telegram_delivery:second123", attemptCount: 1 })
    ]);
    let sendCount = 0;
    const worker = new TelegramDeliveryWorker({
      persistence,
      secrets,
      workerId: "worker:test",
      now: () => new Date(now),
      clientFactory: () => ({
        async sendMessage() {
          sendCount += 1;
          throw new TelegramApiError("TELEGRAM_RATE_LIMITED", 429, 30);
        }
      })
    });

    await expect(worker.runOnce()).resolves.toMatchObject({ retried: 2, failed: 0 });
    expect(sendCount).toBe(1);
    expect(persistence.failures).toEqual([]);
    expect(persistence.retries).toEqual([
      { availableAt: "2026-07-14T10:00:30.000Z", safeErrorCode: "TELEGRAM_RATE_LIMITED" },
      { availableAt: "2026-07-14T10:00:30.000Z", safeErrorCode: "TELEGRAM_RATE_LIMITED" }
    ]);
    expect(persistence.retryAttemptCounts).toEqual([false, false]);
  });

  it("does not spend the attempt cap when an attempt delivered some parts", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-telegram-partial-"));
    roots.push(root);
    const secrets = new TelegramSecretStore(root);
    const version = await secrets.write("123456789:abcdefghijklmnopqrstuvwxyz_ABCDE");
    const persistence = new FakeOutbox(integration(version), [delivery({ attemptCount: 5, finalResponse: "Δ".repeat(6_000) })]);
    let sendCount = 0;
    const worker = new TelegramDeliveryWorker({
      persistence,
      secrets,
      workerId: "worker:test",
      now: () => new Date(now),
      clientFactory: () => ({
        async sendMessage() {
          sendCount += 1;
          if (sendCount > 1) throw new TelegramApiError("TELEGRAM_UPSTREAM_UNAVAILABLE", 502);
          return { messageId: "1" };
        }
      })
    });

    await expect(worker.runOnce()).resolves.toMatchObject({ retried: 1, failed: 0 });
    expect(persistence.progress).toEqual([{ nextPartIndex: 1, delivered: false }]);
    expect(persistence.retryAttemptCounts).toEqual([false]);
  });

  it("fails only the rejected message on a bad request and never retries unformattable messages", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-telegram-bad-request-"));
    roots.push(root);
    const secrets = new TelegramSecretStore(root);
    const version = await secrets.write("123456789:abcdefghijklmnopqrstuvwxyz_ABCDE");
    const persistence = new FakeOutbox(integration(version), [
      delivery(),
      delivery({ deliveryId: "telegram_delivery:huge-header", roomName: "R".repeat(3_000) })
    ]);
    let sendCount = 0;
    const worker = new TelegramDeliveryWorker({
      persistence,
      secrets,
      workerId: "worker:test",
      clientFactory: () => ({
        async sendMessage() {
          sendCount += 1;
          throw new TelegramApiError("TELEGRAM_BAD_REQUEST", 400, null, true);
        }
      })
    });

    await expect(worker.runOnce()).resolves.toMatchObject({ failed: 2, retried: 0 });
    expect(sendCount).toBe(1);
    expect(persistence.failures).toEqual(["TELEGRAM_BAD_REQUEST", "TELEGRAM_MESSAGE_UNFORMATTABLE"]);
    expect(persistence.markedErrors).toEqual([]);
    expect(persistence.currentIntegration.connectionStatus).toBe("CONNECTED");
  });

  it("retries a transient credential read instead of disabling the integration", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-telegram-flaky-credential-"));
    roots.push(root);
    class FlakySecretStore extends TelegramSecretStore {
      override async read(): Promise<string> {
        throw Object.assign(new Error("i/o error"), { code: "EIO" });
      }
    }
    const persistence = new FakeOutbox(integration("telegram_flaky_credential"), [delivery({ attemptCount: 1 })]);
    const worker = new TelegramDeliveryWorker({
      persistence,
      secrets: new FlakySecretStore(root),
      workerId: "worker:test",
      now: () => new Date(now)
    });

    await expect(worker.runOnce()).resolves.toMatchObject({ retried: 1, failed: 0 });
    expect(persistence.retries).toEqual([{ availableAt: "2026-07-14T10:00:05.000Z", safeErrorCode: "TELEGRAM_CREDENTIAL_READ_FAILED" }]);
    expect(persistence.markedErrors).toEqual([]);

    persistence.queued.push(delivery({ attemptCount: 5 }));
    await expect(worker.runOnce()).resolves.toMatchObject({ retried: 0, failed: 1 });
    expect(persistence.failures).toEqual(["TELEGRAM_CREDENTIAL_UNAVAILABLE"]);
    expect(persistence.markedErrors).toEqual(["TELEGRAM_CREDENTIAL_UNAVAILABLE"]);
  });

  it("never resends a part because recording its progress failed", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-telegram-progress-"));
    roots.push(root);
    const secrets = new TelegramSecretStore(root);
    const version = await secrets.write("123456789:abcdefghijklmnopqrstuvwxyz_ABCDE");
    class FlakyProgressOutbox extends FakeOutbox {
      progressFailures: Error[] = [];
      override async recordDeliveryProgress(input: { nextPartIndex: number; delivered: boolean }) {
        const failure = this.progressFailures.shift();
        if (failure) throw failure;
        await super.recordDeliveryProgress(input);
      }
    }
    const sent: string[] = [];
    const sleeps: number[] = [];
    const run = async (persistence: FlakyProgressOutbox) => new TelegramDeliveryWorker({
      persistence,
      secrets,
      workerId: "worker:test",
      now: () => new Date(now),
      sleep: async (ms) => { sleeps.push(ms); },
      clientFactory: () => ({ async sendMessage(_chatId, text) { sent.push(text); return { messageId: "1" }; } })
    }).runOnce();

    const recovered = new FlakyProgressOutbox(integration(version), [delivery()]);
    recovered.progressFailures.push(new Error("connection reset"), new Error("connection reset"));
    await expect(run(recovered)).resolves.toMatchObject({ delivered: 1, retried: 0 });
    expect(sent).toHaveLength(1);
    expect(sleeps).toEqual([250, 500]);
    expect(recovered.progress).toEqual([{ nextPartIndex: 1, delivered: true }]);

    sent.length = 0;
    const unrecorded = new FlakyProgressOutbox(integration(version), [delivery({ finalResponse: "Δ".repeat(6_000) })]);
    unrecorded.progressFailures.push(...Array.from({ length: 3 }, () => new Error("database unavailable")));
    await expect(run(unrecorded)).resolves.toMatchObject({ delivered: 0, retried: 1, failed: 0 });
    expect(sent).toHaveLength(1);
    expect(unrecorded.retries).toEqual([]);

    sent.length = 0;
    const logs: Array<{ status: string; safeErrorCode: string | null }> = [];
    const lockLost = new FlakyProgressOutbox(integration(version), [delivery({ finalResponse: "Δ".repeat(6_000) })]);
    lockLost.progressFailures.push(new TelegramIntegrationError("TELEGRAM_DELIVERY_LOCK_LOST", "Telegram delivery lock is no longer held.", 409));
    await expect(new TelegramDeliveryWorker({
      persistence: lockLost,
      secrets,
      workerId: "worker:test",
      log: (record) => logs.push(record),
      clientFactory: () => ({ async sendMessage(_chatId, text) { sent.push(text); return { messageId: "1" }; } })
    }).runOnce()).resolves.toMatchObject({ retried: 1 });
    expect(sent).toHaveLength(1);
    expect(lockLost.retries).toEqual([]);
    expect(logs).toEqual([expect.objectContaining({ status: "RETRY", safeErrorCode: "TELEGRAM_DELIVERY_LOCK_LOST" })]);
  });

  it("moves the integration to a safe error state when its credential is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-telegram-missing-credential-"));
    roots.push(root);
    const missingVersion = "telegram_missing_credential";
    const persistence = new FakeOutbox(integration(missingVersion), [delivery()]);
    const worker = new TelegramDeliveryWorker({
      persistence,
      secrets: new TelegramSecretStore(root),
      workerId: "worker:test"
    });

    await expect(worker.runOnce()).resolves.toMatchObject({ failed: 1, retried: 0 });
    expect(persistence.failures).toEqual(["TELEGRAM_CREDENTIAL_UNAVAILABLE"]);
    expect(persistence.markedErrors).toEqual(["TELEGRAM_CREDENTIAL_UNAVAILABLE"]);
  });
});
