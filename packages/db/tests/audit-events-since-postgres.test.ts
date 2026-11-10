import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { PostgresSpaceStore } from "../src/space-store.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const unavailable = disposablePostgresUnavailableReason();

describe.skipIf(unavailable !== null)(`Audit events since a time on PostgreSQL${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;

  beforeAll(async () => {
    server = await startDisposablePostgres("auditsince");
    await server.createDatabase("space_audit_since");
    pool = server.pool("space_audit_since", 2);
    const client = await pool.connect();
    try { await applyPendingMigrations(client, await loadMigrations()); } finally { client.release(); }
  }, 120_000);
  afterAll(async () => { await pool?.end(); await server?.stop(); });

  it("lists the pane moves Nous follows names by, newest first, only of the asked actions and time (R10-2)", async () => {
    const store = new PostgresSpaceStore(pool);
    const before = new Date(Date.now() - 1_000).toISOString();
    await pool.query("INSERT INTO audit_events(id, actor_user_id, trace_id, action, target_type, target_id, metadata, created_at) VALUES "
      + "('audit:old', NULL, 'trace:audit01', 'pane.move', 'pane', 'pane:old', '{}', now() - interval '8 days')");
    await store.recordAuditEvent({ actorUserId: null, traceId: "trace:audit02", action: "pane.move", targetType: "pane", targetId: "pane:dana", metadata: { sourceRoomId: "room:bruno", sourcePaneName: "Dana" } });
    await store.recordAuditEvent({ actorUserId: null, traceId: "trace:audit03", action: "pane.update", targetType: "pane", targetId: "pane:dana", metadata: {} });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.recordAuditEvent({ actorUserId: null, traceId: "trace:audit04", action: "pane.move", targetType: "pane", targetId: "pane:cody", metadata: { sourceRoomId: "room:bruno", sourcePaneName: "Cody" } });
    const moves = await store.listAuditEventsSince({ actions: ["pane.move"], since: before, limit: 10 });
    expect(moves.map((move) => move.targetId)).toEqual(["pane:cody", "pane:dana"]);
    expect(moves[1]!.metadata).toEqual({ sourceRoomId: "room:bruno", sourcePaneName: "Dana" });
    expect(await store.listAuditEventsSince({ actions: ["pane.move"], since: before, limit: 1 })).toHaveLength(1);
  });
});
