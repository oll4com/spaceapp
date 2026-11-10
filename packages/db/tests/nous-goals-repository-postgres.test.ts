// Nous Goals on a real, disposable PostgreSQL (migration 0257, operator request 2026-10-27): a goal row per owner in priority order,
// Nous's patch, the operator's reorder and explicit delete, the goal's events (newest per goal) and their class-B prune. Skips without Docker.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryNousGoalsRepository, PostgresNousGoalsRepository, type NousGoalsRepository } from "../src/nous-goals-repository.js";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const unavailable = disposablePostgresUnavailableReason();
const owner = "user:nous";

/** The same expectations for both stores: the in-memory one runs everywhere, PostgreSQL where Docker is. */
async function exercise(repository: NousGoalsRepository) {
  const first = await repository.create(owner, "Sell 100 SpaceApp licences by December");
  const second = await repository.create(owner, "Get the Job Copilot an interview a week");
  expect(first).toMatchObject({ status: "ACTIVE", priority: 1, progress: 0, planIds: [], waitsOn: null, limit: null, unchangedTurns: 0, nextTurnAt: null });
  expect(second.priority).toBe(2);
  expect((await repository.list(owner)).map((goal) => goal.id)).toEqual([first.id, second.id]);
  expect(await repository.list("user:someone")).toEqual([]);
  expect(await repository.get("user:someone", first.id)).toBeNull();
  // Nous's patch: progress, criteria, plans, what it waits on, its note and the loop's state; JSON columns read back as they were written.
  const updated = await repository.update(owner, first.id, { progress: 40, criteria: "100 paid licences in Stripe", planIds: ["clipboard:plan00000001"],
    waitsOn: { kind: "THIRD_PARTY", what: "Stripe account review", until: null }, note: "Opened the pricing plan.", lastWorkedAt: "2026-10-27T10:00:00.000Z",
    nextTurnAt: "2026-10-27T10:15:00.000Z", fingerprint: "f1", unchangedTurns: 2 });
  expect(updated).toMatchObject({ progress: 40, criteria: "100 paid licences in Stripe", planIds: ["clipboard:plan00000001"], waitsOn: { kind: "THIRD_PARTY", what: "Stripe account review", until: null },
    note: "Opened the pricing plan.", lastWorkedAt: "2026-10-27T10:00:00.000Z", nextTurnAt: "2026-10-27T10:15:00.000Z", fingerprint: "f1", unchangedTurns: 2 });
  expect(await repository.update("user:someone", first.id, { progress: 90 })).toBeNull();
  // The goal's limit (migration 0278, plan clipboard:ESIzQb7rHGQM): a deadline or a target, null clears it; the LIMIT event kind is allowed.
  expect((await repository.update(owner, first.id, { limit: { kind: "DATE", until: "2026-12-31T16:59:00.000Z" } }))?.limit).toEqual({ kind: "DATE", until: "2026-12-31T16:59:00.000Z" });
  expect((await repository.update(owner, first.id, { limit: { kind: "TARGET", what: "100 paid licences" } }))?.limit).toEqual({ kind: "TARGET", what: "100 paid licences" });
  expect((await repository.get(owner, first.id))?.limit).toEqual({ kind: "TARGET", what: "100 paid licences" });
  expect((await repository.update(owner, first.id, { limit: null }))?.limit).toBeNull();
  expect((await repository.addEvent(owner, { goalId: first.id, kind: "LIMIT", text: "Limit: target: 100 paid licences" })).kind).toBe("LIMIT");
  expect((await repository.update(owner, first.id, {}))?.progress).toBe(40);
  // The operator's reorder puts the listed goals first; the rest keep their order after them.
  expect((await repository.reorder(owner, [second.id])).map((goal) => [goal.id, goal.priority])).toEqual([[second.id, 1], [first.id, 2]]);
  expect((await repository.list(owner, { statuses: ["PAUSED"] })).length).toBe(0);
  expect((await repository.update(owner, second.id, { status: "PAUSED" }))?.status).toBe("PAUSED");
  expect((await repository.list(owner, { statuses: ["ACTIVE"] })).map((goal) => goal.id)).toEqual([first.id]);
  // Events: the newest per goal, newest first; a prune by age is the only automatic delete (class B); the goal's delete takes its events.
  for (const [index, kind] of (["CREATED", "NOTE", "TURN"] as const).entries()) await repository.addEvent(owner, { goalId: first.id, kind, text: `event ${index}`, turnId: kind === "TURN" ? "nous_turn:t1" : null });
  await repository.addEvent(owner, { goalId: second.id, kind: "PAUSED", text: "Paused by the operator" });
  const events = await repository.listEvents(owner, [first.id, second.id], 2);
  expect(events.map((event) => [event.goalId, event.kind]).sort()).toEqual([[first.id, "NOTE"], [first.id, "TURN"], [second.id, "PAUSED"]].sort());
  expect(events.find((event) => event.kind === "TURN")?.turnId).toBe("nous_turn:t1");
  // "Load earlier" (31/10): the page before the oldest shown event holds the rest of the goal's log.
  const shown = events.filter((event) => event.goalId === first.id);
  const earlier = await repository.listEvents(owner, [first.id], 2, shown.at(-1)!.id);
  expect([...shown, ...earlier].map((event) => event.kind).sort()).toEqual(["CREATED", "LIMIT", "NOTE", "TURN"]);
  expect(await repository.listEvents("user:someone", [first.id], 5)).toEqual([]);
  expect(await repository.pruneEvents("2000-01-01T00:00:00.000Z")).toBe(0);
  expect(await repository.remove("user:someone", first.id)).toBe(false);
  expect(await repository.remove(owner, first.id)).toBe(true);
  expect(await repository.listEvents(owner, [first.id], 5)).toEqual([]);
  expect((await repository.list(owner)).map((goal) => goal.id)).toEqual([second.id]);
  expect(await repository.pruneEvents(new Date(Date.now() + 60_000).toISOString())).toBe(1);
  expect(await repository.listEvents(owner, [second.id], 5)).toEqual([]);
}

describe("Nous goals in memory", () => {
  it("keeps goals per owner in priority order with Nous's patch, the operator's reorder and delete, and the goal's events", async () => {
    await exercise(new InMemoryNousGoalsRepository());
  });
});

describe.skipIf(unavailable !== null)(`Nous goals on PostgreSQL${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;
  let repository: PostgresNousGoalsRepository;

  beforeAll(async () => {
    server = await startDisposablePostgres("nous-goals");
    await server.createDatabase("space_nous_goals");
    pool = server.pool("space_nous_goals", 4);
    const client = await pool.connect();
    try {
      await applyPendingMigrations(client, await loadMigrations());
    } finally {
      client.release();
    }
    await pool.query("INSERT INTO users(id, email, role) VALUES ($1, $2, 'OPERATOR')", [owner, "nous@space.local"]);
    repository = new PostgresNousGoalsRepository(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await server?.stop();
  });

  it("keeps goals per owner in priority order with Nous's patch, the operator's reorder and delete, and the goal's events", async () => {
    await exercise(repository);
    // The CHECKs hold: an unknown status or event kind is refused; a GOAL turn's facts row carries its goal.
    await expect(pool.query("UPDATE nous_goals SET status = 'LOST'")).rejects.toThrow();
    await expect(pool.query("INSERT INTO nous_goal_events (owner_user_id, goal_id, kind, text) SELECT $1, id, 'SOMETHING', 'x' FROM nous_goals LIMIT 1", [owner])).rejects.toThrow();
    await pool.query(`INSERT INTO nous_turn_facts (turn_id, owner_user_id, reason, status, started_at, ended_at, goal_id) VALUES ('nous_turn:g1', $1, 'GOAL', 'DONE', now(), now(), 'nous_goal:x')`, [owner]);
    expect((await pool.query("SELECT goal_id FROM nous_turn_facts WHERE turn_id = 'nous_turn:g1'")).rows[0]).toEqual({ goal_id: "nous_goal:x" });
  });
});
