// Council runs on a real, disposable PostgreSQL: migration 0195 applies on top of the full chain, a run round-trips,
// the owner keeps one active run, a restart closes runs left working, and reads are owner-scoped.
// Skips with a reason when Docker or the image is missing.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CouncilRun } from "@space/contracts";
import { CouncilActiveRunError, PostgresCouncilRepository, newCouncilRunId } from "../src/council-repository.js";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const unavailable = disposablePostgresUnavailableReason();
const owner = "user:council";
const at = "2026-10-14T12:00:00.000Z";
const run = (overrides: Partial<CouncilRun> = {}): CouncilRun => ({
  id: newCouncilRunId(), ownerUserId: owner, question: "How can I earn 100 euros today?", coordinatorModelId: "claude/claude-opus-5-5",
  status: "PLANNING", stage: "PLAN", plan: null, estimate: null, qa: [], changeRequests: [], evidence: [], answers: [], rounds: [], final: null,
  events: [{ at, text: "Started" }], error: null, createdAt: at, updatedAt: at, ...overrides
});

describe.skipIf(unavailable !== null)(`council repository on PostgreSQL${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;
  let repository: PostgresCouncilRepository;

  beforeAll(async () => {
    server = await startDisposablePostgres("council");
    await server.createDatabase("space_council");
    pool = server.pool("space_council", 4);
    const client = await pool.connect();
    try {
      await applyPendingMigrations(client, await loadMigrations());
    } finally {
      client.release();
    }
    await pool.query("INSERT INTO users(id, email, role) VALUES ($1, $2, 'OPERATOR')", [owner, "council@space.local"]);
    repository = new PostgresCouncilRepository(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await server?.stop();
  });

  it("round-trips a run, keeps one active run per owner and closes runs a restart left working", async () => {
    const first = await repository.create(run());
    await expect(repository.create(run())).rejects.toBeInstanceOf(CouncilActiveRunError);
    const answered = await repository.save({ ...first, status: "RUNNING", stage: "ANSWERS",
      answers: [{ modelId: "codex/gpt-6-astra", status: "DONE", text: "Deliver food.", claims: ["Couriers earn daily."], error: null, ms: 900 }], updatedAt: "2026-10-14T12:01:00.000Z" });
    expect(answered.answers[0]?.claims).toEqual(["Couriers earn daily."]);
    expect(await repository.get("user:other", first.id)).toBeNull();
    expect(await repository.interruptStale("stopped: the server restarted")).toBe(1);
    expect((await repository.get(owner, first.id))?.status).toBe("INTERRUPTED");
    const second = await repository.create(run({ createdAt: "2026-10-14T13:00:00.000Z" }));
    expect((await repository.list(owner, 10)).map((item) => item.id)).toEqual([second.id, first.id]);
    await expect(repository.save({ ...first, status: "RUNNING" })).rejects.toBeInstanceOf(CouncilActiveRunError);
    expect(await repository.delete(owner, first.id)).toBe(true);
    expect(await repository.get(owner, first.id)).toBeNull();
  }, 60_000);
});
