// The Rooms dock's "Needs attention" on a real, disposable PostgreSQL: pending.byRoom counts what needs the user under
// its pane's current room, and nothing for a closed pane. Skips with a reason when Docker or the image is missing.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NotificationRaiseInput } from "@space/contracts";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { InMemorySpaceNotificationsRepository, PostgresSpaceNotificationsRepository } from "../src/space-notifications-repository.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const unavailable = disposablePostgresUnavailableReason();
const owner = "user:notify";
const raise = (paneId: string | null, roomId: string, severity: NotificationRaiseInput["severity"] = "ATTENTION"): NotificationRaiseInput => ({
  ownerUserId: owner, roomId, paneId, source: "JOB_COPILOT", kind: "QUESTION", severity, title: "Needs you", body: "", link: {}, dedupeKey: null, payload: {}, telegram: null
});

describe.skipIf(unavailable !== null)(`notifications repository on PostgreSQL${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;
  let repository: PostgresSpaceNotificationsRepository;

  beforeAll(async () => {
    server = await startDisposablePostgres("notifications");
    await server.createDatabase("space_notifications");
    pool = server.pool("space_notifications", 4);
    const client = await pool.connect();
    try {
      await applyPendingMigrations(client, await loadMigrations());
    } finally {
      client.release();
    }
    await pool.query("INSERT INTO users(id, email, role) VALUES ($1, $2, 'OPERATOR')", [owner, "notify@space.local"]);
    for (const [order, room] of ["room:a", "room:b"].entries()) await pool.query("INSERT INTO rooms(id, name, trace_id, owner_user_id, room_order) VALUES ($1, $1, 'trace:t', $2, $3)", [room, owner, order]);
    for (const [pane, room, order] of [["pane:moved", "room:b", 0], ["pane:closed", "room:a", 1], ["pane:open", "room:a", 2]] as const) {
      await pool.query("INSERT INTO panes(id, room_id, title, mode, status, pane_order) VALUES ($1, $2, $1, 'JOB_APPLY', 'IDLE', $3)", [pane, room, order]);
    }
    await pool.query("UPDATE panes SET is_closed = true WHERE id = 'pane:closed'");
    repository = new PostgresSpaceNotificationsRepository(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await server?.stop();
  });

  it("filters Done by kind and key, and keeps its history for 30 days after acknowledgement", async () => {
    const { notification } = await repository.raise({ ...raise(null, "room:a"), source: "NOUS", kind: "REQUEST_DONE", dedupeKey: "nous:done:clipboard:history" });
    await pool.query("UPDATE space_notifications SET created_at = now() - interval '40 days' WHERE id = $1", [notification.id]);
    await repository.setStatus(owner, notification.id, "ACKED");
    await repository.prune(new Date(Date.now() - 30 * 86_400_000).toISOString());
    const query = { status: "ALL" as const, source: "NOUS" as const, kind: "REQUEST_DONE", dedupeKey: "nous:done:clipboard:history", limit: 200 };
    expect((await repository.list(owner, query)).map((record) => record.id)).toEqual([notification.id]);
    expect(await repository.list(owner, { ...query, kind: "OTHER" })).toEqual([]);
    // Step 4 of plan clipboard:7L5KyWp3kQsP: one pane's records (its copilot questions no longer waiting), in both stores.
    for (const store of [repository, new InMemorySpaceNotificationsRepository()]) {
      const onPane = (await store.raise({ ...raise("pane:open", "room:a"), dedupeKey: "job-apply:question:jobq:panefilter1" })).notification;
      const listed = await store.list(owner, { status: "ALL", paneId: "pane:open", limit: 200 });
      expect(listed.map((record) => record.id)).toContain(onPane.id);
      expect(listed.every((record) => record.paneId === "pane:open")).toBe(true);
      expect(await store.list(owner, { ...query, paneId: "pane:open" })).toEqual([]);
      await store.setStatus(owner, onPane.id, "RESOLVED");
    }
    await pool.query("UPDATE space_notifications SET acked_at = now() - interval '31 days' WHERE id = $1", [notification.id]);
    await repository.prune(new Date(Date.now() - 30 * 86_400_000).toISOString());
    expect(await repository.get(owner, notification.id)).toBeNull();
  });

  it("counts what needs the user under its pane's current room, never for a closed pane or an INFO notice", async () => {
    await repository.raise(raise("pane:moved", "room:a"));
    await repository.raise(raise("pane:closed", "room:a"));
    await repository.raise(raise("pane:open", "room:a", "INFO"));
    await repository.raise({ ...raise(null, "room:a", "URGENT"), link: { roomId: "room:a" } });
    // Without a pane only the room the link opens counts: a Nous decision naming a room opens the Nous dock.
    await repository.raise({ ...raise(null, "room:b"), source: "NOUS", kind: "DECISION_DIRECTION", link: { surface: "nous" } });
    // A deleted pane or room leaves its id in the link only (ON DELETE SET NULL): neither marks a room.
    await repository.raise({ ...raise(null, "room:a"), link: { roomId: "room:a", paneId: "pane:deleted" } });
    await pool.query(`INSERT INTO space_notifications(id, owner_user_id, source, kind, severity, title, link)
      VALUES ('notification:room-deleted', $1, 'JOB_COPILOT', 'QUESTION', 'ATTENTION', 'Needs you', '{"roomId":"room:deleted"}')`, [owner]);
    const pending = await repository.pending(owner);
    expect(pending.byRoom).toEqual({ "room:a": 1, "room:b": 1 });
    expect(pending.total).toBe(7);
    expect(pending.latest[0]).not.toHaveProperty("currentRoomId");
    // Every owner's unresolved notifications of a source (the browser handoff settle); resolved ones drop out.
    await repository.raise({ ...raise("pane:open", "room:a"), source: "BROWSER_HANDOFF", dedupeKey: "browser-handoff:pane:open" });
    expect((await repository.unresolvedBySource("BROWSER_HANDOFF")).map((item) => item.dedupeKey)).toEqual(["browser-handoff:pane:open"]);
    expect(await repository.resolveByDedupeKey(owner, "browser-handoff:pane:open")).toBe(1);
    expect(await repository.unresolvedBySource("BROWSER_HANDOFF")).toEqual([]);
  }, 60_000);

  it("prunes old INFO and resolved notifications, never an unresolved ATTENTION or URGENT one (Record Retention Invariant)", async () => {
    const waiting = (await repository.raise(raise("pane:open", "room:a"))).notification;
    const urgentRead = (await repository.raise(raise(null, "room:b", "URGENT"))).notification;
    await repository.setStatus(owner, urgentRead.id, "READ");
    const info = (await repository.raise(raise("pane:open", "room:a", "INFO"))).notification;
    const resolved = (await repository.raise(raise("pane:open", "room:a"))).notification;
    await repository.setStatus(owner, resolved.id, "RESOLVED");
    const ids = [waiting.id, urgentRead.id, info.id, resolved.id];
    await pool.query("UPDATE space_notifications SET created_at = now() - interval '90 days' WHERE id = ANY($1::text[])", [ids]);
    expect(await repository.prune(new Date(Date.now() - 30 * 86_400_000).toISOString())).toBeGreaterThanOrEqual(2);
    const left = (await pool.query<{ id: string }>("SELECT id FROM space_notifications WHERE id = ANY($1::text[])", [ids])).rows.map((row) => row.id);
    expect(left.sort()).toEqual([waiting.id, urgentRead.id].sort());
  }, 60_000);

  it("R13: lists a user's active push devices, most recently seen first, never a disabled one or another user's", async () => {
    const other = "user:push-other";
    await pool.query("INSERT INTO users(id, email, role) VALUES ($1, $2, 'OPERATOR')", [other, "push-other@space.local"]);
    const [older, newer, gone, theirs] = ["older", "newer", "gone", "theirs"].map((name) => `${name}:${"a".repeat(30)}`);
    await repository.registerPushDevice(owner, { token: older!, platform: "ANDROID", appVersion: "0.2.12" });
    await repository.registerPushDevice(owner, { token: newer!, platform: "ANDROID", appVersion: null });
    await repository.registerPushDevice(owner, { token: gone!, platform: "ANDROID", appVersion: null });
    await repository.disablePushDevice(gone!);
    await repository.registerPushDevice(other, { token: theirs!, platform: "ANDROID", appVersion: null });
    await pool.query("UPDATE space_push_devices SET last_seen_at = now() - interval '1 hour' WHERE token = $1", [older]);
    expect(await repository.pushDevices(owner)).toEqual([
      { token: newer, platform: "ANDROID", appVersion: null, level: "NOUS", lastSeenAt: expect.any(String) },
      { token: older, platform: "ANDROID", appVersion: "0.2.12", level: "NOUS", lastSeenAt: expect.any(String) }]);
    const memory = new InMemorySpaceNotificationsRepository();
    await memory.registerPushDevice(owner, { token: older!, platform: "ANDROID", appVersion: "0.2.12" });
    await memory.registerPushDevice(other, { token: theirs!, platform: "ANDROID", appVersion: null });
    expect(await memory.pushDevices(owner)).toEqual([{ token: older, platform: "ANDROID", appVersion: "0.2.12", level: "NOUS", lastSeenAt: expect.any(String) }]);
  }, 60_000);

  it("keeps what needs the user in byRoom when hundreds of newer INFO notices are open", async () => {
    const busy = "user:notify-busy";
    await pool.query("INSERT INTO users(id, email, role) VALUES ($1, $2, 'OPERATOR')", [busy, "busy@space.local"]);
    await repository.raise({ ...raise("pane:open", "room:a"), ownerUserId: busy });
    await pool.query(`INSERT INTO space_notifications(id, owner_user_id, room_id, pane_id, source, kind, severity, title, created_at)
      SELECT 'notification:info-' || lpad(n::text, 3, '0'), $1, 'room:a', 'pane:open', 'MAIL_COPILOT', 'MAIL_RECEIVED', 'INFO', 'Mail', now() + n * interval '1 second'
      FROM generate_series(1, 500) AS n`, [busy]);
    const pending = await repository.pending(busy);
    expect(pending.byRoom).toEqual({ "room:a": 1 });
    expect(pending.latest[0]?.id).toBe("notification:info-500");
  }, 60_000);

  it("lists the needs-you requests still waiting: open or read on an open pane, never INFO, settled, other kinds or a closed pane's", async () => {
    const person = "user:notify-needs";
    await pool.query("INSERT INTO users(id, email, role) VALUES ($1, $2, 'OPERATOR')", [person, "needs@space.local"]);
    const ask = (paneId: string | null, extra: Partial<NotificationRaiseInput> = {}) => repository.raise({ ...raise(paneId, "room:a"), ownerUserId: person, ...extra });
    const open = (await ask("pane:open")).notification;
    const notNow = (await ask("pane:moved", { source: "AGENT", kind: "NEEDS_YOU" })).notification;
    await repository.setStatus(person, notNow.id, "READ");
    const designAsk = (await ask("pane:open", { source: "DESIGN", kind: "DESIGN_APPROVAL" })).notification;
    await ask("pane:closed");
    await ask("pane:open", { severity: "INFO" });
    await ask("pane:open", { kind: "APPLICATION_FAILED" });
    await ask(null);
    await repository.setStatus(person, (await ask("pane:open")).notification.id, "ACKED");
    await repository.setStatus(person, (await ask("pane:open")).notification.id, "RESOLVED");
    // A copilot question held for Nous (Ask Last step 7) stays out until its hour ends.
    await ask("pane:open", { source: "JOB_COPILOT", kind: "QUESTION", payload: { heldForNous: { until: new Date(Date.now() + 3_600_000).toISOString() } } });
    const heldOver = (await ask("pane:open", { source: "JOB_COPILOT", kind: "QUESTION", payload: { heldForNous: { until: new Date(Date.now() - 60_000).toISOString() } } })).notification;
    // Operator 2/11 15:08 BKK: a review held under "May send" stays out past its hour too, and counts in no pending total (pane dots, rooms).
    const pendingBefore = (await repository.pending(person)).total;
    await ask("pane:open", { source: "MARKETING_COPILOT", kind: "REVIEW_REQUESTED", payload: { heldForNous: { until: new Date(Date.now() - 60_000).toISOString(), allowance: "maySend" } } });
    expect((await repository.pending(person)).total).toBe(pendingBefore);
    const listed = await repository.list(person, { status: "NEEDS_YOU", limit: 50 });
    expect(listed.map((item) => item.id).sort()).toEqual([open.id, notNow.id, designAsk.id, heldOver.id].sort());
  }, 60_000);

  it("refreshes a card by its dedupe key, unread again only when it re-alerts (Nous's per-pane card)", async () => {
    const card = { ...raise("pane:open", "room:a"), source: "NOUS" as const, kind: "NEEDS_HANDS", dedupeKey: "nous:pane:pane:open", title: "Upwork needs you", body: "• one" };
    const { notification } = await repository.raise(card);
    await repository.setStatus(owner, notification.id, "READ");
    const quiet = await repository.raise({ ...card, body: "• one\n• two" });
    expect(quiet).toMatchObject({ created: false, notification: { id: notification.id, status: "READ", body: "• one\n• two" } });
    const loud = await repository.raise({ ...card, body: "• one\n• two\n• three", reopen: true });
    expect(loud).toMatchObject({ created: false, notification: { id: notification.id, status: "OPEN", readAt: null } });
  }, 60_000);

  it("reads a card stored with Space's account facts without them (operator 2/11 09:49 BKK «γιατι βλεπω ολα αυτα τα εμαιλ!!»)", async () => {
    const body = "• Sign in to github.com\n\nSpace's account facts:\n• Sign-ins for github.com: OTHER with a@example.com (0 successful)\n"
      + "• Connected Google accounts: a@example.com, b@example.com\n• Vault: 2 logins for github.com: github.com (a@example.com)\n\nChecked first:\n• the page";
    const { notification } = await repository.raise({ ...raise("pane:open", "room:a"), source: "NOUS" as const, kind: "NEEDS_HANDS", dedupeKey: "nous:pane:facts", title: "Andy needs you", body });
    for (const read of [notification, await repository.get(owner, notification.id)]) expect(read!.body).toBe("• Sign in to github.com\n\nChecked first:\n• the page");
    await repository.setStatus(owner, notification.id, "RESOLVED");
  }, 60_000);

  it("gives a card whose room was deleted its room back on the next raise, and keeps both when a raise names none (28/10 Cleo/Kate)", async () => {
    await pool.query("INSERT INTO rooms(id, name, trace_id, owner_user_id, room_order) VALUES ('room:gone', 'room:gone', 'trace:t', $1, 9)", [owner]);
    for (const store of [repository, new InMemorySpaceNotificationsRepository()]) {
      const card = { ...raise("pane:moved", "room:gone"), source: "NOUS" as const, kind: "NEEDS_HANDS", dedupeKey: `nous:pane:pane:moved:${store === repository ? "pg" : "mem"}` };
      const { notification } = await store.raise(card);
      if (store === repository) await pool.query("DELETE FROM rooms WHERE id = 'room:gone'");
      else (store as unknown as { items: Map<string, { roomId: string | null }> }).items.get(notification.id)!.roomId = null;
      expect((await store.get(owner, notification.id))?.roomId).toBeNull();
      const again = await store.raise({ ...card, roomId: "room:b", title: "Kate needs you" });
      expect(again).toMatchObject({ created: false, notification: { id: notification.id, roomId: "room:b", paneId: "pane:moved", title: "Kate needs you" } });
      expect((await store.raise({ ...card, roomId: null, paneId: null })).notification).toMatchObject({ roomId: "room:b", paneId: "pane:moved" });
    }
  }, 60_000);

  it("raises a card whose pane and room were deleted before the raise without them, never a foreign-key error (stable 3/11: a campaign paused with no card)", async () => {
    const card = { ...raise("pane:deleted-before", "room:deleted-before"), source: "MAIL_COPILOT" as const, kind: "CAMPAIGN_PAUSED", dedupeKey: "mail-copilot:campaign:mcamp:gone:paused" };
    const { notification, created } = await repository.raise(card);
    expect({ created, roomId: notification.roomId, paneId: notification.paneId }).toEqual({ created: true, roomId: null, paneId: null });
    expect((await repository.raise({ ...card, roomId: "room:a", paneId: "pane:open" })).notification).toMatchObject({ id: notification.id, roomId: "room:a", paneId: "pane:open" });
    expect((await repository.raise(card)).notification).toMatchObject({ id: notification.id, roomId: "room:a", paneId: "pane:open" });
    await repository.setStatus(owner, notification.id, "RESOLVED");
  }, 60_000);

  it("moves a record only forward, and migration 0253 closes parked Job Copilot questions and records a late read reopened (2026-10-25)", async () => {
    const asked = (await repository.raise(raise("pane:open", "room:a"))).notification;
    await repository.setStatus(owner, asked.id, "RESOLVED");
    expect(await repository.setStatus(owner, asked.id, "READ")).toMatchObject({ status: "RESOLVED" });
    expect(await repository.setStatus(owner, asked.id, "ACKED")).toMatchObject({ status: "RESOLVED" });
    const dismissed = (await repository.raise(raise("pane:open", "room:a"))).notification;
    // Needs you as questions (plan clipboard:5AQvaoSR-IZa): the operator's answer joins the payload with the move, never after it.
    expect((await repository.setStatus(owner, dismissed.id, "ACKED", { answer: { text: "Blue" } }))?.payload).toMatchObject({ ...dismissed.payload, answer: { text: "Blue" } });
    expect((await repository.setStatus(owner, dismissed.id, "RESOLVED", { answer: { text: "Red" } }))?.payload).toMatchObject({ answer: { text: "Blue" } });
    expect(await repository.setStatus(owner, dismissed.id, "READ")).toMatchObject({ status: "ACKED" });
    // R13-6: a failed answer joins a waiting record's payload with its status unchanged; a settled record takes none.
    const waiting = (await repository.raise(raise("pane:open", "room:a"))).notification;
    expect(await repository.addPayload(owner, waiting.id, { answerError: { text: "Gmail answered 403" } })).toMatchObject({ status: "OPEN", payload: { answerError: { text: "Gmail answered 403" } } });
    expect(await repository.addPayload(owner, dismissed.id, { answerError: { text: "late" } })).toBeNull();
    // Rows as stable held them before the fix: a parked posting's question keyed by its event, a resolved record a read reopened.
    const parked = (await repository.raise({ ...raise("pane:open", "room:a"), dedupeKey: "job-apply:question:jobevt:parked0001" })).notification;
    const real = (await repository.raise({ ...raise("pane:open", "room:a"), dedupeKey: "job-apply:question:jobq:real000001" })).notification;
    const reopened = (await repository.raise(raise("pane:open", "room:a"))).notification;
    await pool.query("UPDATE space_notifications SET status = 'READ', read_at = now(), resolved_at = now() WHERE id = $1", [reopened.id]);
    await pool.query((await loadMigrations()).find((item) => item.filename.startsWith("0253_"))!.sql);
    expect((await repository.get(owner, parked.id))?.status).toBe("RESOLVED");
    expect((await repository.get(owner, real.id))?.status).toBe("OPEN");
    expect((await repository.get(owner, reopened.id))?.status).toBe("RESOLVED");
  }, 60_000);
});

describe("notifications prune in memory (Record Retention Invariant)", () => {
  it("moves a record only forward: a late read never reopens a resolved one", async () => {
    const repository = new InMemorySpaceNotificationsRepository();
    const { notification } = await repository.raise(raise("pane:open", "room:a"));
    await repository.setStatus(owner, notification.id, "RESOLVED");
    expect(await repository.setStatus(owner, notification.id, "READ")).toMatchObject({ status: "RESOLVED" });
  });

  it("prunes old INFO and resolved notifications, never an unresolved ATTENTION or URGENT one", async () => {
    let at = "2026-07-01T00:00:00.000Z";
    const repository = new InMemorySpaceNotificationsRepository(() => at);
    const waiting = (await repository.raise(raise("pane:open", "room:a"))).notification;
    const info = (await repository.raise(raise("pane:open", "room:a", "INFO"))).notification;
    const resolved = (await repository.raise(raise("pane:open", "room:a", "URGENT"))).notification;
    await repository.setStatus(owner, resolved.id, "RESOLVED");
    at = "2026-10-19T00:00:00.000Z";
    expect(await repository.prune("2026-09-19T00:00:00.000Z")).toBe(2);
    expect((await repository.list(owner, { status: "ALL", limit: 10 })).map((item) => item.id)).toEqual([waiting.id]);
    expect(info.id).not.toBe(waiting.id);
  });
});
