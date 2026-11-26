// 23/11: a pane moved out of Dino left "Needs attention" on Dino: its plan, the plan's card and Thread kept the old room.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { PostgresSpaceStore } from "../src/space-store.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const unavailable = disposablePostgresUnavailableReason();

describe.skipIf(unavailable !== null)(`Pane move carries its attention${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;

  beforeAll(async () => {
    server = await startDisposablePostgres("panemoveatt");
    await server.createDatabase("space_pane_move_att");
    pool = server.pool("space_pane_move_att", 2);
    const client = await pool.connect();
    try { await applyPendingMigrations(client, await loadMigrations()); } finally { client.release(); }
  }, 120_000);
  afterAll(async () => { await pool?.end(); await server?.stop(); });

  it("moves the pane's plans, their cards and Threads to the new room; other rooms' records stay", async () => {
    const store = new PostgresSpaceStore(pool);
    await store.upsertUser({ id: "user:operator", email: "op@example.com", role: "ADMIN" });
    const from = await store.createRoom({ kind: "AGENT_PROOF", name: "AGENT_PROOF from", initialPaneCount: 0 });
    const to = await store.createRoom({ kind: "AGENT_PROOF", name: "AGENT_PROOF to", initialPaneCount: 0 });
    const pane = await store.createPane({ roomId: from.id, title: "Andy", mode: "TERMINAL" }, "trace:pma01");
    const plan = await store.upsertClipboardItem({ ownerUserId: "user:operator", text: "the moved plan", source: "PLAN", title: "the moved plan", roomId: from.id, paneId: pane.id, minimumModel: "claude-opus-5-5" });
    const card = (id: string, paneId: string | null, planId: string) => pool.query(
      `INSERT INTO space_notifications (id, owner_user_id, room_id, pane_id, source, kind, severity, title, link, payload)
       VALUES ($1, 'user:operator', $2, $3, 'SYSTEM', 'NEEDS_YOU', 'ATTENTION', 't', $4::jsonb, $5::jsonb)`,
      [id, from.id, paneId, JSON.stringify({ roomId: from.id }), JSON.stringify({ planId })]);
    await card("notification:plancard1", null, plan.id); // Space's plan card: no pane, only the plan
    await card("notification:panecard1", pane.id, "clipboard:other");
    await card("notification:otherone1", null, "clipboard:other");
    const thread = (id: string, refs: object) => pool.query(
      `INSERT INTO space_inbox_threads (id, owner_user_id, key, title, origin, origin_label, waiting_for, priority, refs, created_at, last_event_at)
       VALUES ($1, 'user:operator', $1, 't', 'NOUS', 'Nous', 'OPERATOR', 'ATTENTION', $2::jsonb, now(), now())`, [id, JSON.stringify(refs)]);
    await thread("thread:plan", { planId: plan.id, roomId: from.id });
    await thread("thread:other", { planId: "clipboard:other", roomId: from.id });

    await store.movePane(pane.id, { targetRoomId: to.id }, "trace:pma02");

    expect((await pool.query("SELECT room_id FROM clipboard_items WHERE id = $1", [plan.id])).rows[0].room_id).toBe(to.id);
    const cards = Object.fromEntries((await pool.query("SELECT id, room_id, link->>'roomId' AS link FROM space_notifications")).rows.map((r) => [r.id, `${r.room_id} ${r.link}`]));
    expect(cards).toEqual({ "notification:plancard1": `${to.id} ${to.id}`, "notification:panecard1": `${to.id} ${to.id}`, "notification:otherone1": `${from.id} ${from.id}` });
    const threads = Object.fromEntries((await pool.query("SELECT id, refs->>'roomId' AS room FROM space_inbox_threads")).rows.map((r) => [r.id, r.room]));
    expect(threads).toEqual({ "thread:plan": to.id, "thread:other": from.id });
  });
});
