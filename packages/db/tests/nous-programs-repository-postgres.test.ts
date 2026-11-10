// The startup programs registry (migration 0288) on a real, disposable PostgreSQL and in memory: a program is stored
// whole with its jsonb mails, amount and re-apply flag, read back per owner in the same order, and keeps its createdAt.
// Skips the PostgreSQL half without Docker.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NousProgram } from "@space/contracts";
import { InMemoryNousProgramsRepository, PostgresNousProgramsRepository, type NousProgramsRepository } from "../src/nous-programs-repository.js";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const owner = "user:programs";
const program = (id: string, parent: string, name: string, extra: Partial<NousProgram> = {}): NousProgram => ({
  id, page: "startup", parent, program: name, project: "SpaceApp", url: null, status: "APPLIED", statusReason: null, appliedAt: "2026-10-20T00:00:00.000Z",
  decidedAt: null, expectedReplyBy: null, validUntil: null, amount: null, commitments: null, account: "ntheo@spaceapp.dev", contacts: [], mails: [],
  nextAction: null, reapply: null, sources: [], notes: null, givesMoney: null, tags: [], whatItIs: null, howWeUse: null, benefits: [], tiers: [], locked: [], createdAt: "2026-11-03T10:00:00.000Z", updatedAt: "2026-11-03T10:00:00.000Z", ...extra
});

async function behaves(repository: NousProgramsRepository) {
  const inception = program("nvidia-inception", "NVIDIA", "Inception", {
    status: "APPROVED", givesMoney: true, tags: ["server-access", "ai-tokens"], whatItIs: "NVIDIA's startup program", howWeUse: "GPU credits; nothing from you", amount: { text: "$10.000 AWS credits", value: 10000, currency: "USD" }, contacts: ["inception@nvidia.com"], sources: ["clipboard:ZXXTJ1o3kIoJ"],
    mails: [{ date: "2026-10-21T08:00:00.000Z", direction: "RECEIVED", from: "inception@nvidia.com", to: ["ntheo@spaceapp.dev"], subject: "Welcome", gmailAccount: "ntheo@spaceapp.dev", threadId: "19a0b" }],
    reapply: { needed: false, why: null, when: null },
    benefits: [{ what: "AWS credits", account: null, perMonth: null, total: { text: "$10,000", value: 10000, currency: "USD" }, used: null, remaining: null, usageAt: null,
      validUntil: null, status: "PENDING", source: "benefits.md", notes: null, allocations: [] }],
    tiers: [{ name: "Member", status: "REACHED", requires: null, gives: null, amount: null, source: null }]
  });
  await repository.put(owner, inception);
  await repository.put(owner, program("anthropic-startups", "Anthropic", "Claude for Startups"));
  await repository.put(owner, program("meta-hackathon", "Meta", "Llama hackathon", { project: "LoopCloser" }));
  await repository.put("user:other", program("nvidia-dli", "NVIDIA", "DLI"));
  expect(await repository.get(owner, "nvidia-inception")).toEqual(inception);
  expect((await repository.list(owner)).map((row) => row.id)).toEqual(["anthropic-startups", "meta-hackathon", "nvidia-inception"]);
  expect((await repository.list(owner, "startup")).map((row) => row.id)).toEqual(["anthropic-startups", "meta-hackathon", "nvidia-inception"]);
  expect(await repository.get(owner, "nvidia-dli")).toBeNull();
  const rewritten = await repository.put(owner, { ...inception, status: "EXPIRED", createdAt: "2026-11-04T00:00:00.000Z", updatedAt: "2026-11-04T00:00:00.000Z" });
  expect(rewritten).toMatchObject({ status: "EXPIRED", createdAt: inception.createdAt, updatedAt: "2026-11-04T00:00:00.000Z" });
  expect(await repository.get(owner, "nvidia-inception")).toEqual(rewritten);
  expect(await repository.delete("user:other", "nvidia-inception")).toBe(false);
  expect(await repository.delete(owner, "nvidia-inception")).toBe(true);
  expect(await repository.delete(owner, "nvidia-inception")).toBe(false);
  expect((await repository.list(owner)).map((row) => row.id)).toEqual(["anthropic-startups", "meta-hackathon"]);
}

it("keeps programs in memory", async () => behaves(new InMemoryNousProgramsRepository()));

const unavailable = disposablePostgresUnavailableReason();
describe.skipIf(unavailable !== null)(`Programs on PostgreSQL${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;
  beforeAll(async () => {
    server = await startDisposablePostgres("nous-programs");
    await server.createDatabase("space_nous_programs");
    pool = server.pool("space_nous_programs", 2);
    const client = await pool.connect();
    try { await applyPendingMigrations(client, await loadMigrations()); } finally { client.release(); }
  }, 120_000);
  afterAll(async () => { await pool?.end(); await server?.stop(); });

  it("keeps programs in PostgreSQL", async () => behaves(new PostgresNousProgramsRepository(pool)));
  it("reads benefit lines stored before allocations existed with none", async () => {
    const repository = new PostgresNousProgramsRepository(pool);
    await repository.put("user:old", program("old-line", "NVIDIA", "Old"));
    await pool.query(`UPDATE nous_programs SET benefits = '[{"what":"Credits","status":"ACTIVE"}]'::jsonb WHERE owner_user_id = 'user:old'`);
    expect((await repository.get("user:old", "old-line"))!.benefits).toEqual([{ what: "Credits", status: "ACTIVE", allocations: [] }]);
  });
  it("reads a row left on the removed oll4-funding page as startup and lists it there", async () => {
    const repository = new PostgresNousProgramsRepository(pool);
    await repository.put("user:funding", program("left-over", "Meta", "Llama"));
    await pool.query(`UPDATE nous_programs SET page = 'oll4-funding' WHERE owner_user_id = 'user:funding'`);
    expect((await repository.list("user:funding")).map((row) => [row.id, row.page])).toEqual([["left-over", "startup"]]);
  });
});
