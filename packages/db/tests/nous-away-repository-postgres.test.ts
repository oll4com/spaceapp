// Nous Away mode on a real, disposable PostgreSQL (migration 0225, plan clipboard:B7eTUHTJYg3X): one open session per owner,
// the grant can change while it is open, an ended session stays ended, and the log reads back oldest first. Skips without Docker.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresNousAwayRepository } from "../src/nous-away-repository.js";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const unavailable = disposablePostgresUnavailableReason();
const owner = "user:nous";

describe.skipIf(unavailable !== null)(`Nous away sessions on PostgreSQL${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;
  let repository: PostgresNousAwayRepository;

  beforeAll(async () => {
    server = await startDisposablePostgres("nous-away");
    await server.createDatabase("space_nous_away");
    pool = server.pool("space_nous_away", 4);
    const client = await pool.connect();
    try {
      await applyPendingMigrations(client, await loadMigrations());
    } finally {
      client.release();
    }
    await pool.query("INSERT INTO users(id, email, role) VALUES ($1, $2, 'OPERATOR')", [owner, "nous@space.local"]);
    repository = new PostgresNousAwayRepository(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await server?.stop();
  });

  it("keeps one open session per owner, its grant and its log", async () => {
    const input = { id: "nous_away:a1", ownerUserId: owner, startedAt: "2026-10-17T16:29:00.000Z", until: "2026-10-18T01:00:00.000Z", reason: "Sleeping",
      mandate: "Keep the plans moving", grant: ["PROMOTE"], operatorMessageId: "nous_msg:abcdef1", operatorQuote: "I give you full control until morning" };
    expect(await repository.start(input)).toMatchObject({ id: "nous_away:a1", grant: ["PROMOTE"], endedAt: null, until: "2026-10-18T01:00:00.000Z" });
    expect(await repository.start({ ...input, id: "nous_away:a2" })).toBeNull();
    expect((await repository.setGrant(owner, "nous_away:a1", ["PROMOTE", "TEST_PANES"]))?.grant).toEqual(["PROMOTE", "TEST_PANES"]);
    expect((await repository.listOpen()).map((session) => session.id)).toEqual(["nous_away:a1"]);
    await repository.log("nous_away:a1", { at: "2026-10-17T17:00:00.000Z", source: "INBOX", what: "Pane round", result: "Andy unblocked" });
    await repository.log("nous_away:a1", { at: "2026-10-17T17:30:00.000Z", source: "HEARTBEAT", what: "Heartbeat", result: "Nothing to do" });
    expect((await repository.listLog("nous_away:a1", 10)).map((entry) => entry.source)).toEqual(["INBOX", "HEARTBEAT"]);
    expect(await repository.end(owner, "nous_away:a1", "RETURN", "2026-10-18T00:10:00.000Z")).toMatchObject({ endReason: "RETURN", endedAt: "2026-10-18T00:10:00.000Z" });
    expect(await repository.end(owner, "nous_away:a1", "UNTIL", "2026-10-18T01:00:00.000Z")).toBeNull();
    expect(await repository.open(owner)).toBeNull();
    expect(await repository.start({ ...input, id: "nous_away:a3" })).toMatchObject({ id: "nous_away:a3" });
  });
});
