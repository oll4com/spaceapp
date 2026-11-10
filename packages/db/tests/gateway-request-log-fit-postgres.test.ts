import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresGatewayRepository } from "../src/gateway-repository.js";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const unavailable = disposablePostgresUnavailableReason();

// OBS-006 (2026-11-03): the request log is written in batches of up to 100 rows in one INSERT, so a single row whose
// client-chosen text breaks a column CHECK (request_id 1-120, model 1-160, reasoning_effort 20, tiers 40) dropped
// every row of the batch, other clients' included, with their daily usage sums.
describe.skipIf(unavailable !== null)(`Space Gateway request log batches on PostgreSQL${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;

  beforeAll(async () => {
    server = await startDisposablePostgres("gwlogfit");
    await server.createDatabase("space_gateway_log_fit");
    pool = server.pool("space_gateway_log_fit", 2);
    const client = await pool.connect();
    try { await applyPendingMigrations(client, await loadMigrations()); } finally { client.release(); }
  }, 120_000);
  afterAll(async () => { await pool?.end(); await server?.stop(); });

  it("keeps every row of a batch when one row carries over-long client text, fitted to its columns", async () => {
    const repository = new PostgresGatewayRepository(pool);
    const base = { provider: "CODEX" as const, accountId: null, apiKeyId: null, serviceTier: null, transport: "http", errorCode: null, latencyMs: 10,
      firstTokenMs: null, inputTokens: 1, cachedInputTokens: null, outputTokens: 1, reasoningTokens: null, costUsd: null, compressionTokensSaved: null,
      stickyKind: null, stickyKeyHash: null, requestedAt: "2030-02-01T10:00:00.000Z", status: "success" };
    await repository.insertRequestLogs([
      { ...base, requestId: "req_before", model: "gpt-5.5", reasoningEffort: "high" },
      { ...base, requestId: "x".repeat(121), model: "m".repeat(200), reasoningEffort: "e".repeat(30), requestedServiceTier: "t".repeat(50),
        serviceTier: "s".repeat(50), status: "error", errorCode: "c".repeat(150) },
      { ...base, requestId: "req_after", model: "gpt-5.5", reasoningEffort: "low" }
    ]);
    const rows = (await pool.query(`SELECT request_id, model, reasoning_effort, requested_service_tier, service_tier, error_code
      FROM space_gateway_request_logs ORDER BY id`)).rows;
    expect(rows.map((row) => row.request_id)).toEqual(["req_before", "x".repeat(120), "req_after"]);
    expect(rows[1]).toEqual({ request_id: "x".repeat(120), model: "m".repeat(160), reasoning_effort: "e".repeat(20), requested_service_tier: "t".repeat(40),
      service_tier: "s".repeat(40), error_code: "c".repeat(120) });
    expect((await pool.query(`SELECT sum(requests)::int AS requests FROM space_gateway_usage_daily`)).rows[0].requests).toBe(3);
  });
});
