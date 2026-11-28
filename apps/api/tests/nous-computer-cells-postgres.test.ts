import { readFile } from "node:fs/promises";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "../../../packages/db/tests/support/disposable-postgres.js";
import { createFakeCellDriver } from "../src/computer/cell-driver.js";
import { IDLE_TO_SLEEP_MS, SLEEP_TO_COLD_MS, createCellOrchestrator, createPgCellStore } from "../src/computer/cells.js";

// Migrations 0415-0416 + createPgCellStore on real PostgreSQL (synthetic tenants, fake cell driver): the lifecycle survives a new orchestrator.
describe.skipIf(disposablePostgresUnavailableReason())("nous computer cells on PostgreSQL", () => {
  let server: DisposablePostgres, pool: pg.Pool;
  beforeAll(async () => {
    server = await startDisposablePostgres("nous-cells");
    await server.createDatabase("nous_cells");
    pool = server.pool("nous_cells", 2);
    for (const file of ["0415_nous_computer_cells.sql", "0416_nous_computer_cell_suspension.sql"]) {
      await pool.query(await readFile(new URL(`../../../packages/db/migrations/${file}`, import.meta.url), "utf8"));
    }
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
    await server?.stop();
  }, 120_000);

  it("round-trips every field, upserts, and keeps state across orchestrators", async () => {
    const store = createPgCellStore(pool);
    let t = 1_700_000_000_000;
    const orchestrator = () => createCellOrchestrator({ driver: createFakeCellDriver({ advance: (ms) => (t += ms) }), store,
      hosts: [{ id: "h1", ramMib: 8192, maxAwake: 4 }], now: () => t, cellMemMib: 1024 });

    await orchestrator().ensureAwake("tenant:a");
    expect(await store.get("tenant:a")).toMatchObject({ tenantId: "tenant:a", state: "AWAKE", hostId: "h1", memMib: 1024, sleptAt: null });
    t += IDLE_TO_SLEEP_MS;
    expect((await orchestrator().tick()).slept).toEqual(["tenant:a"]);
    t += SLEEP_TO_COLD_MS;
    await orchestrator().tick();
    const cold = await store.get("tenant:a");
    expect(cold?.state).toBe("COLD");
    expect(cold?.hostId).toBeNull();
    expect(typeof cold?.sleptAt).toBe("number");

    const full = { tenantId: "tenant:b", state: "DELETED" as const, hostId: null, memMib: 2048, lastActiveAt: t, sleptAt: t - 5,
      snapshotBytes: 2_500_000_000, objectKey: "cells/b.snap", exportKey: "exports/b.tar", exportedAt: t - 1, suspendedAt: t - 2, updatedAt: t };
    await store.put(full);
    expect(await store.get("tenant:b")).toEqual(full);
    expect((await store.list()).map((cell) => cell.tenantId)).toEqual(["tenant:a", "tenant:b"]);
    expect(await store.get("tenant:none")).toBeUndefined();
    await expect(pool.query("INSERT INTO nous_computer_cells (tenant_id, state, mem_mib, last_active_at, updated_at) VALUES ('x', 'BOGUS', 1, now(), now())"))
      .rejects.toThrow(/check constraint/);
  });
});
