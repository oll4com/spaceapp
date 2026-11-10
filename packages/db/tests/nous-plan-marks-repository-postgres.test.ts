// When each plan's percentage last changed, on a real, disposable PostgreSQL (migration 0217, plan clipboard:8s0ZNiO3q5ZT
// S4): a new mark starts at the plan's own time, the same percentage keeps it, a new one moves it. Skips without Docker.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresNousPlanMarksRepository } from "../src/nous-plan-marks-repository.js";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const unavailable = disposablePostgresUnavailableReason();
const owner = "user:nous";

describe.skipIf(unavailable !== null)(`Nous plan marks on PostgreSQL${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;
  let repository: PostgresNousPlanMarksRepository;

  beforeAll(async () => {
    server = await startDisposablePostgres("nous-plan-marks");
    await server.createDatabase("space_nous_plan_marks");
    pool = server.pool("space_nous_plan_marks", 4);
    const client = await pool.connect();
    try {
      await applyPendingMigrations(client, await loadMigrations());
    } finally {
      client.release();
    }
    await pool.query("INSERT INTO users(id, email, role) VALUES ($1, $2, 'OPERATOR')", [owner, "nous@space.local"]);
    repository = new PostgresNousPlanMarksRepository(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await server?.stop();
  });

  it("keeps the time of the last change per plan: the percentage, or the steps' statuses (migration 0243), and when it was last nudged", async () => {
    const mark = (changedAt: string, lastNudgedAt: string | null = null) => ({ changedAt, lastNudgedAt });
    const first = await repository.observe(owner, [{ planId: "clipboard:a", percent: 40, since: "2026-10-17T02:00:00.000Z", fingerprint: "IN_PROGRESS|1:PENDING" },
      { planId: "clipboard:b", percent: 0, since: "2026-10-17T01:00:00.000Z" }], new Date("2026-10-17T09:00:00.000Z"));
    expect(Object.fromEntries(first)).toEqual({ "clipboard:a": mark("2026-10-17T02:00:00.000Z"), "clipboard:b": mark("2026-10-17T01:00:00.000Z") });
    const later = await repository.observe(owner, [{ planId: "clipboard:a", percent: 40, since: "2026-10-17T08:59:00.000Z", fingerprint: "IN_PROGRESS|1:PENDING" },
      { planId: "clipboard:b", percent: 25, since: "2026-10-17T09:30:00.000Z" }], new Date("2026-10-17T10:00:00.000Z"));
    expect(Object.fromEntries(later)).toEqual({ "clipboard:a": mark("2026-10-17T02:00:00.000Z"), "clipboard:b": mark("2026-10-17T10:00:00.000Z") });
    // A step's status moves the mark with the percentage unchanged; a mark from before fingerprints takes the first one without moving.
    const steps = await repository.observe(owner, [{ planId: "clipboard:a", percent: 40, since: "2026-10-17T08:59:00.000Z", fingerprint: "IN_PROGRESS|1:IN_PROGRESS" },
      { planId: "clipboard:b", percent: 25, since: "2026-10-17T09:30:00.000Z", fingerprint: "IN_PROGRESS|1:PENDING" }], new Date("2026-10-17T11:00:00.000Z"));
    expect(Object.fromEntries(steps)).toEqual({ "clipboard:a": mark("2026-10-17T11:00:00.000Z"), "clipboard:b": mark("2026-10-17T10:00:00.000Z") });
    await repository.nudged(owner, ["clipboard:a"], new Date("2026-10-17T11:05:00.000Z"));
    const nudged = await repository.observe(owner, [{ planId: "clipboard:a", percent: 40, since: "2026-10-17T08:59:00.000Z", fingerprint: "IN_PROGRESS|1:IN_PROGRESS" }], new Date("2026-10-17T11:10:00.000Z"));
    expect(Object.fromEntries(nudged)).toEqual({ "clipboard:a": mark("2026-10-17T11:00:00.000Z", "2026-10-17T11:05:00.000Z") });
    expect((await repository.observe(owner, [], new Date())).size).toBe(0);
  });
});
