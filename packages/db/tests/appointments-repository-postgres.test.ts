// Appointments on a real, disposable PostgreSQL (migration 0283) and in memory: create, list by end time, one per source (a cancelled one
// stays cancelled), a moved start clears the reminders sent, reminders marked once. Skips the PostgreSQL half without Docker.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryAppointmentsRepository, PostgresAppointmentsRepository, type AppointmentsRepository } from "../src/appointments-repository.js";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const owner = "user:appts";
async function behaves(repository: AppointmentsRepository) {
  const zone = { timeZone: "Asia/Bangkok" };
  const call = await repository.create(owner, { title: "IP Fabric call", startsAt: "2026-11-09T21:30:00+07:00", endsAt: "2026-11-09T22:00:00+07:00", kind: "CALL", ...zone }, "2026-11-02T08:00:00.000Z");
  expect(call).toMatchObject({ startsAt: "2026-11-09T14:30:00.000Z", endsAt: "2026-11-09T15:00:00.000Z", status: "UPCOMING", remindersSent: [], kind: "CALL" });
  const test = await repository.upsertBySource(owner, { title: "Turing tests", startsAt: "2026-11-02T22:05:00+07:00", kind: "DEADLINE", sourceRef: "task:t1", ...zone });
  expect((await repository.upsertBySource(owner, { title: "Turing tests v2", startsAt: "2026-11-02T22:05:00+07:00", kind: "DEADLINE", sourceRef: "task:t1", ...zone })).id).toBe(test.id);
  await repository.update(owner, test.id, { status: "CANCELLED" });
  expect((await repository.upsertBySource(owner, { title: "Turing tests v3", startsAt: "2026-11-02T22:05:00+07:00", kind: "DEADLINE", sourceRef: "task:t1", ...zone })).status).toBe("CANCELLED");
  expect((await repository.list(owner, "2026-11-09T14:45:00.000Z")).map((item) => item.id)).toEqual([call.id]);
  expect((await repository.list(owner, "2026-11-01T00:00:00.000Z")).map((item) => item.title)).toEqual(["Turing tests v3", "IP Fabric call"]);
  // An UPCOMING one is listed whatever its time, until done or cancelled (operator 7/11, nous_msg:cc777543e99e44e8bcba66db); a cancelled one only within `since`.
  expect((await repository.list(owner, "2026-12-01T00:00:00.000Z")).map((item) => item.id)).toEqual([call.id]);
  await repository.update(owner, call.id, { status: "DONE" });
  expect(await repository.list(owner, "2026-12-01T00:00:00.000Z")).toEqual([]);
  await repository.update(owner, call.id, { status: "UPCOMING" });
  expect((await repository.list("user:other", "2026-11-01T00:00:00.000Z"))).toEqual([]);
  expect((await repository.upcoming("2026-11-02T00:00:00.000Z")).map((item) => item.id)).toEqual([call.id]);
  await repository.markReminded(call.id, [1440, 180]);
  await repository.markReminded(call.id, [180, 60]);
  expect((await repository.get(owner, call.id))!.remindersSent.sort((a, b) => a - b)).toEqual([60, 180, 1440]);
  const moved = await repository.update(owner, call.id, { startsAt: "2026-11-10T21:30:00+07:00", endsAt: null });
  expect(moved).toMatchObject({ title: "IP Fabric call", kind: "CALL", remindersSent: [], endsAt: null, startsAt: "2026-11-10T14:30:00.000Z" });
  expect(await repository.get("user:other", call.id)).toBeNull();
}

it("keeps appointments in memory", async () => behaves(new InMemoryAppointmentsRepository()));

const unavailable = disposablePostgresUnavailableReason();
describe.skipIf(unavailable !== null)(`Appointments on PostgreSQL${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;
  beforeAll(async () => {
    server = await startDisposablePostgres("appointments");
    await server.createDatabase("space_appointments");
    pool = server.pool("space_appointments", 2);
    const client = await pool.connect();
    try { await applyPendingMigrations(client, await loadMigrations()); } finally { client.release(); }
  }, 120_000);
  afterAll(async () => { await pool?.end(); await server?.stop(); });

  it("keeps appointments in PostgreSQL", async () => behaves(new PostgresAppointmentsRepository(pool)));
});
