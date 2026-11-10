// Nous's pane board summaries on a real, disposable PostgreSQL (migration 0237, plan clipboard:Y9cgKVHFaHrr): the newest row per
// pane (any source and MODEL only), the daily cap's batch count, owner scoping and pruning that keeps each pane's line. Skips without Docker.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryNousPaneSummariesRepository, PostgresNousPaneSummariesRepository, type NewNousPaneSummaryRow, type NousPaneSummariesRepository } from "../src/nous-pane-summaries-repository.js";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const unavailable = disposablePostgresUnavailableReason();
const owner = "user:board";
const row = (input: Partial<NewNousPaneSummaryRow> & Pick<NewNousPaneSummaryRow, "paneId" | "generatedAt">): NewNousPaneSummaryRow => ({
  roomId: "room:alpha0001", fingerprint: "fp", line: "line", waitsOn: "NONE", needsOperator: false, until: null, detail: null, model: "claude-haiku-5-5",
  source: "MODEL", batchId: null, inputReportId: null, ...input
});

async function exercise(repository: NousPaneSummariesRepository) {
  await repository.add(owner, [
    row({ paneId: "pane:andy0001", generatedAt: "2026-10-01T10:00:00.000Z", line: "old", batchId: "b0" }),
    row({ paneId: "pane:andy0001", generatedAt: "2026-10-19T10:00:00.000Z", line: "model now", batchId: "b1", waitsOn: "OPERATOR", needsOperator: true,
      until: "2026-10-20T08:00:00.000Z", detail: "Approve the promote", inputReportId: "41" }),
    row({ paneId: "pane:bob00001", generatedAt: "2026-10-19T10:00:00.000Z", line: "bob model", batchId: "b1" })
  ]);
  const [fallback] = await repository.add(owner, [row({ paneId: "pane:andy0001", generatedAt: "2026-10-19T11:00:00.000Z", line: "fallback", source: "FALLBACK", model: null })]);
  await repository.add("user:other", [row({ paneId: "pane:andy0001", generatedAt: "2026-10-19T12:00:00.000Z", line: "not yours", batchId: "x" })]);

  expect(fallback).toEqual(expect.objectContaining({ id: expect.any(String), paneId: "pane:andy0001", source: "FALLBACK", model: null, tokensIn: null, tokensOut: null }));
  const latest = await repository.latest(owner);
  expect(latest.any.map((entry) => [entry.paneId, entry.line]).sort()).toEqual([["pane:andy0001", "fallback"], ["pane:bob00001", "bob model"]]);
  expect(latest.model.map((entry) => [entry.paneId, entry.line]).sort()).toEqual([["pane:andy0001", "model now"], ["pane:bob00001", "bob model"]]);
  expect(latest.model.find((entry) => entry.paneId === "pane:andy0001")).toEqual(expect.objectContaining({
    waitsOn: "OPERATOR", needsOperator: true, until: "2026-10-20T08:00:00.000Z", detail: "Approve the promote", inputReportId: "41", batchId: "b1" }));
  expect(await repository.batchesSince(owner, "2026-10-19T00:00:00.000Z")).toBe(1);
  expect(await repository.batchesSince(owner, "2026-09-01T00:00:00.000Z")).toBe(2);
  expect(await repository.prune("2026-10-10T00:00:00.000Z")).toBe(1);
  // A pane's only row stays however old it is: it is still the board's line.
  await repository.add(owner, [row({ paneId: "pane:carl0001", generatedAt: "2026-09-01T00:00:00.000Z", line: "quiet pane" })]);
  expect(await repository.prune("2026-10-10T00:00:00.000Z")).toBe(0);
  expect((await repository.latest(owner)).any.map((entry) => entry.line).sort()).toEqual(["bob model", "fallback", "quiet pane"]);
}

describe("Nous pane summaries in memory", () => {
  it("keeps the newest line per pane, counts batches and prunes", async () => exercise(new InMemoryNousPaneSummariesRepository()));
});

describe.skipIf(unavailable !== null)(`Nous pane summaries on PostgreSQL${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;

  beforeAll(async () => {
    server = await startDisposablePostgres("nous-pane-summaries");
    await server.createDatabase("space_nous_pane_summaries");
    pool = server.pool("space_nous_pane_summaries", 4);
    const client = await pool.connect();
    try {
      await applyPendingMigrations(client, await loadMigrations());
    } finally {
      client.release();
    }
    await pool.query("INSERT INTO users(id, email, role) VALUES ($1, $2, 'OPERATOR'), ($3, $4, 'OPERATOR')", [owner, "board@space.local", "user:other", "other@space.local"]);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await server?.stop();
  });

  it("keeps the newest line per pane, counts batches, scopes by owner and prunes", async () => exercise(new PostgresNousPaneSummariesRepository(pool)));
});
