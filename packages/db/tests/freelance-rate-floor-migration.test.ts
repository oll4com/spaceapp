// Operator 14/11: migration 0334 moves Freelance panes saved with the old $35 hourly floor to $20; any other floor stays. Skips without Docker.
import type pg from "pg";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const unavailable = disposablePostgresUnavailableReason();

describe.skipIf(unavailable !== null)(`Freelance rate floor migration${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;

  beforeAll(async () => {
    server = await startDisposablePostgres("freelance-rate-floor");
    await server.createDatabase("space_freelance_rate_floor");
    pool = server.pool("space_freelance_rate_floor", 2);
    const client = await pool.connect();
    try { await applyPendingMigrations(client, await loadMigrations()); } finally { client.release(); }
    await pool.query("INSERT INTO users(id, email, role) VALUES ('user:fl', 'fl@space.local', 'OPERATOR')");
    await pool.query("INSERT INTO rooms(id,name,trace_id,owner_user_id) VALUES ('room:fl000001','Freelance','trace:fl000001','user:fl')");
    for (const [id, floor] of [["pane:fl35", 35], ["pane:fl50", 50]] as const) {
      await pool.query("INSERT INTO panes(id,room_id,title,mode,status,pane_order,freelance_copilot_metadata) VALUES ($1,'room:fl000001','Freelance','FREELANCE_COPILOT','IDLE',0,$2::jsonb)",
        [id, JSON.stringify({ version: 1, settings: { autonomy: "FULL", rateFloorHourly: floor, followUps: true } })]);
    }
  }, 120_000);
  afterAll(async () => { await pool?.end(); await server?.stop(); });

  it("sets 35 to 20 and keeps the rest of the settings and other floors", async () => {
    await pool.query(await readFile(new URL("../migrations/0334_freelance_rate_floor_20.sql", import.meta.url), "utf8"));
    const rows = (await pool.query<{ id: string; settings: Record<string, unknown> }>("SELECT id, freelance_copilot_metadata->'settings' AS settings FROM panes ORDER BY id")).rows;
    expect(rows).toEqual([{ id: "pane:fl35", settings: { autonomy: "FULL", rateFloorHourly: 20, followUps: true } }, { id: "pane:fl50", settings: { autonomy: "FULL", rateFloorHourly: 50, followUps: true } }]);
  });
});
