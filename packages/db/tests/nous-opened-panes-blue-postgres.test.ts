import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { PostgresSpaceStore } from "../src/space-store.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const unavailable = disposablePostgresUnavailableReason();

// Operator 12/11: panes Nous opens are blue. A pane is created with its color; 0320 colors the open ones Nous opened earlier.
describe.skipIf(unavailable !== null)(`Nous's panes are blue on disposable PostgreSQL${unavailable ? ` (${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  beforeAll(async () => { server = await startDisposablePostgres("nous-panes-blue"); }, 120_000);
  afterAll(async () => { await server?.stop(); }, 120_000);

  it("creates a pane with its color, and 0320 colors only Nous's open uncolored panes", async () => {
    await server.createDatabase("nous_blue");
    const pool = server.pool("nous_blue");
    const migrations = await loadMigrations();
    const index = migrations.findIndex((item) => item.filename.startsWith("0320_nous_opened_panes_blue"));
    expect(index).toBeGreaterThan(0);
    const client = await pool.connect();
    try { await applyPendingMigrations(client, migrations.slice(0, index)); } finally { client.release(); }
    const store = new PostgresSpaceStore(pool);
    const room = await store.createRoom({ kind: "AGENT_PROOF", name: "AGENT_PROOF blue", initialPaneCount: 0 });
    const open = (requestId: string, count: number, categoryColor?: "blue") => store.createPanes(
      Array.from({ length: count }, () => ({ roomId: room.id, title: "Files", mode: "FILES" as const, ...(categoryColor ? { categoryColor } : {}) })),
      "trace_nous_blue", { actorId: "user_1", requestId, payloadHash: requestId });

    expect((await open("web:new", 1, "blue")).map((pane) => pane.categoryColor)).toEqual(["blue"]);
    const [nousOpen, nousRed, nousClosed] = await open("nous:turn_1:call_1", 3);
    const [operator] = await open("web:operator", 1);
    await store.updatePane(nousRed!.id, { categoryColor: "red" });
    await store.updatePane(nousClosed!.id, { isClosed: true });

    await pool.query(migrations[index]!.sql);
    const colors = Object.fromEntries((await pool.query<{ id: string; color: string | null }>("SELECT id, category_color AS color FROM panes")).rows.map((row) => [row.id, row.color]));
    expect([colors[nousOpen!.id], colors[nousRed!.id], colors[nousClosed!.id], colors[operator!.id]]).toEqual(["blue", "red", null, null]);
  }, 120_000);
});
