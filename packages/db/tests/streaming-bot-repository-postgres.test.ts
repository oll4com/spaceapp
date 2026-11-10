// Bot memory search on a real, disposable PostgreSQL: any word of a viewer's question finds an approved fact.
// Skips with a reason when Docker or the image is missing.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryStreamingBotRepository, PostgresStreamingBotRepository } from "../src/streaming-bot-repository.js";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const unavailable = disposablePostgresUnavailableReason();

async function searchCases(repository: InMemoryStreamingBotRepository | PostgresStreamingBotRepository) {
  await repository.saveMemory({ title: "GPU", body: "The stream runs on an RTX 5090.", source: "OPERATOR" });
  await repository.saveMemory({ title: "Schedule", body: "Live every Tuesday at 20:00.", source: "OPERATOR" });
  await repository.saveMemory({ title: "100% pending", body: "Not approved yet.", source: "BOT" });
  expect((await repository.listMemory("APPROVED", 10, "which gpu do you use?")).map(item => item.title)).toEqual(["GPU"]);
  expect((await repository.listMemory("APPROVED", 10, "")).length).toBe(2);
  expect(await repository.listMemory("APPROVED", 10, "%")).toEqual([]);
  expect((await repository.listMemory("PENDING", 10, "approved")).map(item => item.title)).toEqual(["100% pending"]);
}

async function reviewCases(repository: InMemoryStreamingBotRepository | PostgresStreamingBotRepository) {
  const base = { platform: "TWITCH" as const, accountId: "account-1", channelId: "chat-1", userId: "viewer-1", durationSeconds: null, platformActionId: null, safeErrorCode: null };
  await repository.recordModerationAction({ ...base, id: "moderation:review", messageId: "message-1", decision: "REVIEW", reason: "AMBIGUOUS", result: "REVIEW" });
  await repository.recordModerationAction({ ...base, id: "moderation:warn", messageId: "message-2", decision: "WARN", reason: "ABUSE", result: "SUCCEEDED" });
  expect(await repository.resolveModerationReview("moderation:review", "TIMEOUT_5M", 300))
    .toMatchObject({ decision: "TIMEOUT_5M", durationSeconds: 300, result: "PENDING", reason: "OPERATOR_COMMAND" });
  expect(await repository.resolveModerationReview("moderation:review", "TIMEOUT_5M", 300)).toBeNull();
  expect(await repository.resolveModerationReview("moderation:warn", "TIMEOUT_30M", 1800)).toBeNull();
}

describe("streaming bot memory search and moderation review", () => {
  it("matches any word in memory", async () => {
    await searchCases(new InMemoryStreamingBotRepository());
  });
  it("turns only a REVIEW item into a pending timeout, once", async () => {
    await reviewCases(new InMemoryStreamingBotRepository());
  });
});

describe.skipIf(unavailable !== null)(`streaming bot memory search on PostgreSQL${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;

  beforeAll(async () => {
    server = await startDisposablePostgres("streaming-bot");
    await server.createDatabase("space_streaming_bot");
    pool = server.pool("space_streaming_bot", 4);
    const client = await pool.connect();
    try {
      await applyPendingMigrations(client, await loadMigrations());
    } finally {
      client.release();
    }
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await server?.stop();
  });

  it("matches any word with strpos, never LIKE wildcards", async () => {
    await searchCases(new PostgresStreamingBotRepository(pool));
  }, 60_000);

  it("turns only a REVIEW item into a pending timeout, once", async () => {
    await reviewCases(new PostgresStreamingBotRepository(pool));
  }, 60_000);
});
