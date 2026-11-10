import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { PostgresSpaceStore } from "../src/space-store.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const unavailable = disposablePostgresUnavailableReason();

describe.skipIf(unavailable !== null)(`One maximized pane per room on PostgreSQL${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;

  beforeAll(async () => {
    server = await startDisposablePostgres("panemax");
    await server.createDatabase("space_pane_max");
    pool = server.pool("space_pane_max", 2);
    const client = await pool.connect();
    try { await applyPendingMigrations(client, await loadMigrations()); } finally { client.release(); }
  }, 120_000);
  afterAll(async () => { await pool?.end(); await server?.stop(); });

  // 1/11: Needs you "Stay" left the Mail pane maximized, Go to pane maximized the Browser pane, and a refresh brought Mail back on top of it.
  it("maximizing a pane un-maximizes its room's other panes, leaves other rooms and every updated_at alone", async () => {
    const store = new PostgresSpaceStore(pool);
    const room = await store.createRoom({ kind: "AGENT_PROOF", name: "AGENT_PROOF maximize", initialPaneCount: 0 });
    const other = await store.createRoom({ kind: "AGENT_PROOF", name: "AGENT_PROOF maximize other", initialPaneCount: 0 });
    const mail = await store.createPane({ roomId: room.id, title: "Mail", mode: "BROWSER" }, "trace:max01");
    const browser = await store.createPane({ roomId: room.id, title: "Browser", mode: "BROWSER" }, "trace:max02");
    const elsewhere = await store.createPane({ roomId: other.id, title: "Elsewhere", mode: "BROWSER" }, "trace:max03");
    await store.updatePane(mail.id, { isMaximized: true }, "trace:max04");
    await store.updatePane(elsewhere.id, { isMaximized: true }, "trace:max05");
    const mailBefore = (await store.listPanes(room.id, true)).find((pane) => pane.id === mail.id)!;

    await store.updatePane(browser.id, { isMaximized: true }, "trace:max06");

    const panes = await store.listPanes(room.id, true);
    expect(panes.filter((pane) => pane.isMaximized).map((pane) => pane.id)).toEqual([browser.id]);
    expect(panes.find((pane) => pane.id === mail.id)!.updatedAt).toBe(mailBefore.updatedAt);
    expect((await store.listPanes(other.id, true)).find((pane) => pane.id === elsewhere.id)!.isMaximized).toBe(true);
    // Restoring keeps the rest as they are.
    await store.updatePane(browser.id, { isMaximized: false }, "trace:max07");
    expect((await store.listPanes(room.id, true)).some((pane) => pane.isMaximized)).toBe(false);
  });
});
