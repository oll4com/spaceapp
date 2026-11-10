// The clipboard history cap on a real, disposable PostgreSQL: the newest-100 prune on every insert deleted the oldest rows
// of any source, so the operator's PLAN records went whenever 100 newer clips arrived (clipboard loss 2026-10-19). Only
// COPY/PASTE rows are pruned; plans and notes survive the cap and a paste of their text. Skips when Docker or the image is missing.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SpaceConflictError, SpaceNotFoundError } from "@space/runtime";
import { PostgresSpaceStore } from "../src/space-store.js";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const unavailable = disposablePostgresUnavailableReason();
const owner = { id: "user:clipcap", email: "clipcap@space.local", role: "ADMIN" as const };

describe.skipIf(unavailable !== null)(`Clipboard prune on PostgreSQL${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;
  let store: PostgresSpaceStore;

  beforeAll(async () => {
    server = await startDisposablePostgres("clipcap");
    await server.createDatabase("space_clipcap");
    pool = server.pool("space_clipcap", 4);
    const client = await pool.connect();
    try {
      await applyPendingMigrations(client, await loadMigrations());
    } finally {
      client.release();
    }
    store = new PostgresSpaceStore(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await server?.stop();
  });

  it("keeps every PLAN and note while COPY and PASTE history stays capped at 100", async () => {
    const user = await store.upsertUser(owner);
    const kept = [
      await store.upsertClipboardItem({ ownerUserId: user.id, text: "plan body", source: "PLAN", title: "Plan", minimumModel: "claude-opus-5-5" }),
      await store.upsertClipboardItem({ ownerUserId: user.id, text: "manual note", source: "MANUAL_NOTE" }),
      await store.upsertClipboardItem({ ownerUserId: user.id, text: "agent note", source: "AGENT_NOTE" })
    ];
    for (let index = 0; index < 120; index += 1) {
      await store.upsertClipboardItem({ ownerUserId: user.id, text: `clip ${index}`, source: index % 2 ? "COPY" : "PASTE" });
    }
    for (const item of kept) await store.upsertClipboardItem({ ownerUserId: user.id, text: item.text, source: "PASTE" });
    for (let index = 120; index < 240; index += 1) {
      await store.upsertClipboardItem({ ownerUserId: user.id, text: `clip ${index}`, source: "COPY" });
    }

    for (const item of kept) {
      expect(await store.getClipboardItem(user.id, item.id)).toMatchObject({ source: item.source, title: item.title });
    }
    expect((await store.listClipboardItems(user.id, { page: 1, pageSize: 100, source: "COPY" })).total).toBe(100);
    expect((await store.listClipboardItems(user.id, { page: 1, pageSize: 100 })).total).toBe(103);
    await store.deleteClipboardItem(user.id, kept[0]!.id);
    expect(await store.getClipboardItem(user.id, kept[0]!.id)).toBeNull();
  }, 60_000);

  it("edits a note's text in place and keeps its id, source, room, pane and created time", async () => {
    const user = await store.upsertUser({ id: "user:clipnote", email: "clipnote@space.local", role: "ADMIN" });
    const room = await store.createRoom({ kind: "AGENT_PROOF", name: "AGENT_PROOF clip note", initialPaneCount: 1 });
    const pane = (await store.listPanes(room.id))[0]!;
    const note = await store.upsertClipboardItem({ ownerUserId: user.id, text: "agent note", source: "AGENT_NOTE", roomId: room.id, paneId: pane.id, paneTitle: "Bob" });
    const other = await store.upsertClipboardItem({ ownerUserId: user.id, text: "manual note", source: "MANUAL_NOTE" });
    const plan = await store.upsertClipboardItem({ ownerUserId: user.id, text: "plan body", source: "PLAN", title: "Plan", minimumModel: "claude-opus-5-5" });

    const edited = await store.updateClipboardNoteText(user.id, note.id, "agent note, edited");
    expect(edited).toMatchObject({ id: note.id, source: "AGENT_NOTE", text: "agent note, edited", roomId: room.id, paneId: pane.id, paneTitle: "Bob",
      characterCount: 18, createdAt: note.createdAt });
    await expect(store.updateClipboardNoteText(user.id, note.id, "manual note")).rejects.toBeInstanceOf(SpaceConflictError);
    await expect(store.updateClipboardNoteText(user.id, plan.id, "x")).rejects.toBeInstanceOf(SpaceNotFoundError);
    await expect(store.updateClipboardNoteText("user:clipcap", other.id, "x")).rejects.toBeInstanceOf(SpaceNotFoundError);
    expect(await store.getClipboardItem(user.id, other.id)).toMatchObject({ text: "manual note", source: "MANUAL_NOTE" });
  }, 60_000);
});
