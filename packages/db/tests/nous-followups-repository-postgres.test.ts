// Nous's follow-ups on a real, disposable PostgreSQL (migration 0216, plan clipboard:8s0ZNiO3q5ZT S3): the three triggers
// round-trip, open ones list first, a follow-up closes once and only for its owner. Skips when Docker or the image is missing.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresNousFollowupsRepository } from "../src/nous-followups-repository.js";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const unavailable = disposablePostgresUnavailableReason();
const owner = "user:nous";

describe.skipIf(unavailable !== null)(`Nous follow-ups on PostgreSQL${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;
  let repository: PostgresNousFollowupsRepository;

  beforeAll(async () => {
    server = await startDisposablePostgres("nous-followups");
    await server.createDatabase("space_nous_followups");
    pool = server.pool("space_nous_followups", 4);
    const client = await pool.connect();
    try {
      await applyPendingMigrations(client, await loadMigrations());
    } finally {
      client.release();
    }
    await pool.query("INSERT INTO users(id, email, role) VALUES ($1, $2, 'OPERATOR')", [owner, "nous@space.local"]);
    repository = new PostgresNousFollowupsRepository(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await server?.stop();
  });

  it("keeps the three triggers, lists open ones first and closes each once for its owner", async () => {
    const time = await repository.add({ ownerUserId: owner, note: "Look at the deploy", trigger: { kind: "TIME", dueAt: "2026-10-17T13:30:00.000Z" } });
    const ticket = await repository.add({ ownerUserId: owner, note: "Merge dev", trigger: { kind: "TICKET", ticketId: "q-20261017-124931-f2cc" } });
    const pane = await repository.add({ ownerUserId: owner, note: "Read Andy", trigger: { kind: "PANE", paneId: "pane:andy0001", paneLabel: "Andy" } });
    expect(time).toMatchObject({ status: "OPEN", trigger: { kind: "TIME", dueAt: "2026-10-17T13:30:00.000Z" }, closedAt: null });
    expect((await repository.listOpen()).map((item) => item.trigger.kind)).toEqual(["TIME", "TICKET", "PANE"]);

    expect(await repository.close("user:someone", ticket.id, "FIRED", "x")).toBeNull();
    expect(await repository.close(owner, ticket.id, "FIRED", "ticket q-20261017-124931-f2cc DEPLOYED")).toMatchObject({ status: "FIRED", outcome: "ticket q-20261017-124931-f2cc DEPLOYED" });
    expect(await repository.close(owner, ticket.id, "CANCELLED", "again")).toBeNull();
    expect((await repository.list(owner, 10)).map((item) => [item.id, item.status])).toEqual([[pane.id, "OPEN"], [time.id, "OPEN"], [ticket.id, "FIRED"]]);
    // R23-4: a note joins an open follow-up on its own line; a closed one or another owner's is not changed.
    expect(await repository.appendNote(owner, pane.id, "Then read Bob")).toMatchObject({ note: "Read Andy\nThen read Bob", status: "OPEN" });
    expect(await repository.appendNote(owner, ticket.id, "late")).toBeNull();
    expect(await repository.appendNote("user:someone", pane.id, "x")).toBeNull();
  });

  it("lists and reads every open follow-up, with no row limit (operator 2026-10-27)", async () => {
    const many = "user:nous-many";
    await pool.query("INSERT INTO users(id, email, role) VALUES ($1, $2, 'OPERATOR')", [many, "nous-many@space.local"]);
    await pool.query(`INSERT INTO nous_followups (id, owner_user_id, note, trigger_kind, ticket_id, status)
      SELECT 'nous_followup:bulk' || lpad(g::text, 6, '0'), $1, 'n' || g, 'TICKET', 'q-20261027-000000-0000', 'OPEN' FROM generate_series(1, 1002) g`, [many]);
    const closed = await repository.close(many, "nous_followup:bulk000001", "CANCELLED", "Cancelled by Nous");
    expect((await repository.listOpen()).filter((item) => item.ownerUserId === many)).toHaveLength(1001);
    const listed = await repository.list(many, 1);
    expect(listed).toHaveLength(1002);
    expect(listed.at(-1)).toMatchObject({ id: closed!.id, status: "CANCELLED" });
    expect(await repository.get(many, closed!.id)).toMatchObject({ status: "CANCELLED", outcome: "Cancelled by Nous" });
    expect(await repository.get(owner, closed!.id)).toBeNull();
  });
});
