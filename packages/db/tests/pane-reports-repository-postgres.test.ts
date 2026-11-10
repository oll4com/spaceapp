// Pane reports on a real, disposable PostgreSQL (migration 0226, plan clipboard:ot6-jLKOWDNC): the newest report per pane,
// one pane's history newest first, owner scoping and pruning. Skips without Docker.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresPaneReportsRepository } from "../src/pane-reports-repository.js";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const unavailable = disposablePostgresUnavailableReason();
const owner = "user:reports";

describe.skipIf(unavailable !== null)(`Pane reports on PostgreSQL${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;
  let repository: PostgresPaneReportsRepository;

  beforeAll(async () => {
    server = await startDisposablePostgres("pane-reports");
    await server.createDatabase("space_pane_reports");
    pool = server.pool("space_pane_reports", 4);
    const client = await pool.connect();
    try {
      await applyPendingMigrations(client, await loadMigrations());
    } finally {
      client.release();
    }
    await pool.query("INSERT INTO users(id, email, role) VALUES ($1, $2, 'OPERATOR'), ($3, $4, 'OPERATOR')", [owner, "reports@space.local", "user:other", "other@space.local"]);
    repository = new PostgresPaneReportsRepository(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await server?.stop();
  });

  it("keeps each pane's history, answers the newest per pane, scopes by owner and prunes old reports", async () => {
    const base = { roomId: "room:bruno0001", source: "AUTO" as const, status: "TURN_END" as const };
    await repository.add(owner, { ...base, paneId: "pane:andy0001", at: "2026-10-01T10:00:00.000Z", summary: "old" });
    await repository.add(owner, { ...base, paneId: "pane:andy0001", at: "2026-10-17T10:00:00.000Z", summary: "turn ended", body: "full text" });
    const newest = await repository.add(owner, { ...base, paneId: "pane:andy0001", at: "2026-10-17T11:00:00.000Z", source: "AGENT", status: "PROGRESS",
      summary: "step 3", planId: "clipboard:ot6-jLKOWDNC", step: 3, percent: 40, ticket: "q-1", next: "tests", needs: null });
    await repository.add(owner, { ...base, paneId: "pane:bob00001", at: "2026-10-17T09:00:00.000Z", summary: "bob" });
    await repository.add("user:other", { ...base, paneId: "pane:andy0001", at: "2026-10-17T12:00:00.000Z", summary: "not yours" });

    expect(newest).toEqual({ id: expect.any(String), roomId: "room:bruno0001", paneId: "pane:andy0001", at: "2026-10-17T11:00:00.000Z", source: "AGENT", status: "PROGRESS",
      summary: "step 3", planId: "clipboard:ot6-jLKOWDNC", step: 3, percent: 40, ticket: "q-1", next: "tests", needs: null, body: null });
    expect((await repository.latest(owner)).map((report) => [report.paneId, report.summary]).sort()).toEqual([["pane:andy0001", "step 3"], ["pane:bob00001", "bob"]]);
    expect((await repository.list(owner, "pane:andy0001", 2)).map((report) => report.summary)).toEqual(["step 3", "turn ended"]);
    expect((await repository.latestPlans(owner)).map((report) => [report.planId, report.summary])).toEqual([["clipboard:ot6-jLKOWDNC", "step 3"]]);
    expect((await repository.listForPlans(owner, ["clipboard:ot6-jLKOWDNC", "clipboard:other00001"])).map((report) => report.summary)).toEqual(["step 3"]);
    expect(await repository.listForPlans(owner, [])).toEqual([]);
    expect(await repository.prune("2026-10-10T00:00:00.000Z")).toBe(1);
    expect((await repository.list(owner, "pane:andy0001", 10)).map((report) => report.summary)).toEqual(["step 3", "turn ended"]);
  });
});
