import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryNousSharedMemoryRepository, PostgresNousSharedMemoryRepository, type NousSharedMemoryRepository } from "../src/nous-shared-memory-repository.js";
import { loadMigrations } from "../src/migrations.js";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

async function exercise(repo: NousSharedMemoryRepository) {
  const entry = await repo.create("team:a", { title: "Evidence", body: "Verify the result before reporting success.", tags: ["working"], source: "NOUS", status: "PROPOSED", actor: "user:a", introducedVersion: "1.2.0" });
  expect(entry).toMatchObject({ revision: 1, status: "PROPOSED", adminModified: false });
  expect(await repo.list("team:b")).toEqual([]);
  expect(await repo.get("team:b", entry.id)).toBeNull();
  expect((await repo.create("team:a", { title: entry.title, body: entry.body, tags: entry.tags, source: "NOUS", status: "PROPOSED", actor: "user:b", introducedVersion: "1.2.0" })).id).toBe(entry.id);
  expect(await repo.update("team:b", entry.id, 1, { status: "ACTIVE" }, "user:b")).toBeNull();
  expect(await repo.update("team:a", entry.id, 2, { status: "ACTIVE" }, "user:a")).toBeNull();
  expect(await repo.update("team:a", entry.id, 1, { status: "ACTIVE" }, "user:a")).toMatchObject({ revision: 2, status: "ACTIVE", adminModified: true });
  const racers = await Promise.all([repo.update("team:a", entry.id, 2, { status: "RETIRED" }, "user:a"), repo.update("team:a", entry.id, 2, { status: "ACTIVE" }, "user:b")]);
  expect(racers.filter(Boolean)).toHaveLength(1);
  const duplicate = await repo.create("team:a", { title: "Evidence", body: "Read the task list.", tags: [], source: "ADMIN", status: "ACTIVE", actor: "user:a", introducedVersion: "1.2.0" });
  const current = (await repo.get("team:a", entry.id))!;
  expect(await repo.update("team:a", current.id, current.revision, { title: duplicate.title, body: duplicate.body, tags: duplicate.tags }, "user:a")).toBeNull();
  expect((await repo.get("team:a", current.id))?.body).toBe(current.body);
  await repo.remove("team:a", duplicate.id, duplicate.revision, "user:a");
  expect(await repo.update("team:a", current.id, current.revision, { title: duplicate.title, body: duplicate.body, tags: duplicate.tags }, "user:a")).toBeNull();
  expect(await repo.policy("team:a")).toMatchObject({ autoApprove: false, dailyUpgrade: true, lastDailyDay: null });
  await repo.savePolicy("team:a", { autoApprove: true });
  expect((await repo.policy("team:b")).autoApprove).toBe(false);
  expect(await repo.claimDay("team:a", "2026-10-29")).toBe(true);
  expect(await repo.claimDay("team:a", "2026-10-29")).toBe(false);
  expect(await repo.claimDay("team:a", "2026-10-28")).toBe(false);
  const seed = { key: "identity", title: "Identity", body: "I am Nous, the mind of SpaceApp.", tags: ["identity"] };
  await repo.mergeSeed("team:a", "1.2.0", [seed]);
  await repo.mergeSeed("team:a", "1.2.1", [{ ...seed, body: "I am Nous, from the Greek Νους (mind), the mind of SpaceApp." }]);
  let seeded = (await repo.list("team:a")).find((row) => row.seedKey === "identity")!;
  expect(seeded.body).toContain("Νους");
  await repo.update("team:a", seeded.id, seeded.revision, { body: "I am Nous, working with care." }, "user:a");
  await repo.mergeSeed("team:a", "1.2.2", [seed]);
  seeded = (await repo.get("team:a", seeded.id))!;
  expect(seeded.body).toBe("I am Nous, working with care.");
  expect(await repo.remove("team:b", seeded.id, seeded.revision, "user:b")).toBe(false);
  expect(await repo.remove("team:a", seeded.id, seeded.revision, "user:a")).toBe(true);
  await repo.mergeSeed("team:a", "1.2.3", [seed]);
  expect(await repo.get("team:a", seeded.id)).toBeNull();
  expect((await repo.list("team:a")).some((row) => row.seedKey === "identity")).toBe(false);
}

it("isolates teams and preserves admin edits, revisions and seed tombstones in memory", async () => exercise(new InMemoryNousSharedMemoryRepository()));
const unavailable = disposablePostgresUnavailableReason();
describe.skipIf(unavailable !== null)(`shared Nous memory on PostgreSQL (${unavailable ?? "available"})`, () => {
  let server: DisposablePostgres; let pool: pg.Pool;
  beforeAll(async () => {
    server = await startDisposablePostgres("nous-shared");
    await server.createDatabase("space_nous_shared"); pool = server.pool("space_nous_shared");
    const client = await pool.connect();
    try { await applyPendingMigrations(client, await loadMigrations()); } finally { client.release(); }
  }, 120_000);
  afterAll(async () => { await pool?.end(); await server?.stop(); });
  it("isolates teams and preserves admin edits, revisions and seed tombstones on PostgreSQL", async () => exercise(new PostgresNousSharedMemoryRepository(pool)));
});
