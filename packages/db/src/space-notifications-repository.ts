import { randomUUID } from "node:crypto";
import type { NotificationListQuery, NotificationRaiseInput, NotificationSource, NotificationStatus, NotificationsPending, PushDeviceRegistration, SpaceNotification } from "@space/contracts";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

// One record per thing the operator should see; the API's notification service decides channels. Postgres on
// the live instances, in-memory for tests.

export interface SpaceNotificationsRepository {
  /** Inserts, or refreshes the open notification with the same dedupe key; `created` says which. */
  /** `reopen`: refreshing an open or read record makes it unread again (a re-alert). */
  raise(input: NotificationRaiseInput & { id?: string; reopen?: boolean }): Promise<{ notification: SpaceNotification; created: boolean }>;
  get(owner: string, id: string): Promise<SpaceNotification | null>;
  list(owner: string, query: NotificationListQuery): Promise<SpaceNotification[]>;
  pending(owner: string): Promise<NotificationsPending>;
  setStatus(owner: string, id: string, status: Exclude<NotificationStatus, "OPEN">): Promise<SpaceNotification | null>;
  readAll(owner: string): Promise<number>;
  /** Resolves the open notifications carrying a dedupe key (a question answered, a thread handled). */
  resolveByDedupeKey(owner: string, dedupeKey: string): Promise<number>;
  /** Every owner's open or read (not yet resolved) notifications of one source, newest first, at most 500. */
  unresolvedBySource(source: NotificationSource): Promise<SpaceNotification[]>;
  prune(before: string): Promise<number>;
  /** Queues the notification for the paired Telegram bot through the completion outbox; false when Telegram is off. */
  /** One Telegram message per notification; a re-alert passes its own `alertKey` so it is sent again. */
  enqueueTelegram(notification: SpaceNotification, labels: { source: string }, alertKey?: string): Promise<boolean>;
  /** Registers or refreshes a push (FCM) token for the user; a token registered by another user moves to this one. */
  registerPushDevice(owner: string, device: PushDeviceRegistration): Promise<void>;
  /** Removes one of the user's push tokens; false when it was not theirs. */
  removePushDevice(owner: string, token: string): Promise<boolean>;
  /** The user's active push tokens, most recently seen first. */
  pushTokens(owner: string): Promise<string[]>;
  /** FCM reported the token unregistered or invalid: no more pushes until the device registers it again. */
  disablePushDevice(token: string): Promise<void>;
  dispose(): Promise<void>;
}

const clip = (value: string, max: number) => value.length > max ? `${value.slice(0, max - 1)}…` : value;

function build(input: NotificationRaiseInput & { id?: string }, at: string): SpaceNotification {
  return {
    id: input.id ?? `notification:${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    ownerUserId: input.ownerUserId, roomId: input.roomId, paneId: input.paneId, source: input.source, kind: input.kind, severity: input.severity,
    title: clip(input.title, 200), body: clip(input.body, 2000), link: input.link, dedupeKey: input.dedupeKey, status: "OPEN", payload: input.payload,
    createdAt: at, updatedAt: at, readAt: null, ackedAt: null, resolvedAt: null
  };
}

/** `roomOf`: the room a notification counts for in byRoom (its pane's current room; null when that pane is closed). */
function pendingOf(items: SpaceNotification[], roomOf: (item: SpaceNotification) => string | null = (item) => item.roomId): NotificationsPending {
  const open = items.filter((item) => item.status === "OPEN").sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const count = (key: (item: SpaceNotification) => string | null, items = open) => {
    const out: Record<string, number> = {};
    for (const item of items) { const value = key(item); if (value) out[value] = (out[value] ?? 0) + 1; }
    return out;
  };
  // byRoom drives the Rooms dock's "Needs attention": INFO (new mail, a finished run) never needs the user.
  return { total: open.length, bySource: count((item) => item.source), byRoom: count(roomOf, open.filter((item) => item.severity !== "INFO")),
    byPane: count((item) => item.paneId), latest: open.slice(0, 20) };
}

export class InMemorySpaceNotificationsRepository implements SpaceNotificationsRepository {
  private readonly items = new Map<string, SpaceNotification>();
  readonly telegram: SpaceNotification[] = [];
  constructor(private readonly now: () => string = () => new Date().toISOString(), private readonly telegramEnabled = false) {}
  async raise(input: NotificationRaiseInput & { id?: string; reopen?: boolean }) {
    const at = this.now();
    const existing = input.dedupeKey ? [...this.items.values()].find((item) => item.ownerUserId === input.ownerUserId && item.dedupeKey === input.dedupeKey && (item.status === "OPEN" || item.status === "READ")) : undefined;
    if (existing) {
      const refreshed = { ...existing, title: clip(input.title, 200), body: clip(input.body, 2000), severity: input.severity, link: input.link, payload: input.payload, updatedAt: at,
        ...(input.reopen ? { status: "OPEN" as const, readAt: null } : {}) };
      this.items.set(existing.id, refreshed);
      return { notification: { ...refreshed }, created: false };
    }
    const notification = build(input, at);
    this.items.set(notification.id, notification);
    return { notification: { ...notification }, created: true };
  }
  async get(owner: string, id: string) { const item = this.items.get(id); return item && item.ownerUserId === owner ? { ...item } : null; }
  async list(owner: string, query: NotificationListQuery) {
    return [...this.items.values()].filter((item) => item.ownerUserId === owner && (query.status === "ALL" || item.status === "OPEN") && (!query.source || item.source === query.source)
      && (!query.before || item.createdAt < query.before)).sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, query.limit).map((item) => ({ ...item }));
  }
  async pending(owner: string) { return pendingOf([...this.items.values()].filter((item) => item.ownerUserId === owner)); }
  async setStatus(owner: string, id: string, status: Exclude<NotificationStatus, "OPEN">) {
    const item = this.items.get(id);
    if (!item || item.ownerUserId !== owner) return null;
    const at = this.now();
    const next = { ...item, status, updatedAt: at, readAt: item.readAt ?? at, ...(status === "ACKED" ? { ackedAt: at } : {}), ...(status === "RESOLVED" ? { resolvedAt: at } : {}) };
    this.items.set(id, next);
    return { ...next };
  }
  async readAll(owner: string) {
    let count = 0;
    const at = this.now();
    for (const [id, item] of this.items) if (item.ownerUserId === owner && item.status === "OPEN") { this.items.set(id, { ...item, status: "READ", readAt: at, updatedAt: at }); count += 1; }
    return count;
  }
  async resolveByDedupeKey(owner: string, dedupeKey: string) {
    let count = 0;
    const at = this.now();
    for (const [id, item] of this.items) {
      if (item.ownerUserId === owner && item.dedupeKey === dedupeKey && (item.status === "OPEN" || item.status === "READ")) { this.items.set(id, { ...item, status: "RESOLVED", resolvedAt: at, updatedAt: at }); count += 1; }
    }
    return count;
  }
  async unresolvedBySource(source: NotificationSource) {
    return [...this.items.values()].filter((item) => item.source === source && (item.status === "OPEN" || item.status === "READ"))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 500);
  }
  async prune(before: string) {
    let count = 0;
    for (const [id, item] of this.items) if (item.createdAt < before && !(item.severity !== "INFO" && (item.status === "OPEN" || item.status === "READ"))) { this.items.delete(id); count += 1; }
    return count;
  }
  async enqueueTelegram(notification: SpaceNotification) { if (!this.telegramEnabled) return false; this.telegram.push(notification); return true; }
  readonly pushDevices = new Map<string, { owner: string; appVersion: string | null; disabled: boolean }>();
  async registerPushDevice(owner: string, device: PushDeviceRegistration) { this.pushDevices.delete(device.token); this.pushDevices.set(device.token, { owner, appVersion: device.appVersion, disabled: false }); }
  async removePushDevice(owner: string, token: string) { return this.pushDevices.get(token)?.owner === owner && this.pushDevices.delete(token); }
  async pushTokens(owner: string) { return [...this.pushDevices].filter(([, device]) => device.owner === owner && !device.disabled).map(([token]) => token).reverse(); }
  async disablePushDevice(token: string) { const device = this.pushDevices.get(token); if (device) device.disabled = true; }
  async dispose() {}
}

interface Row { id: string; ownerUserId: string; roomId: string | null; paneId: string | null; source: NotificationSource; kind: string; severity: SpaceNotification["severity"]; title: string; body: string;
  link: SpaceNotification["link"]; dedupeKey: string | null; status: NotificationStatus; payload: Record<string, unknown>; createdAt: Date | string; updatedAt: Date | string; readAt: Date | string | null; ackedAt: Date | string | null; resolvedAt: Date | string | null }
const columns = `id, owner_user_id AS "ownerUserId", room_id AS "roomId", pane_id AS "paneId", source, kind, severity, title, body, link, dedupe_key AS "dedupeKey", status, payload,
  created_at AS "createdAt", updated_at AS "updatedAt", read_at AS "readAt", acked_at AS "ackedAt", resolved_at AS "resolvedAt"`;
const iso = (value: Date | string | null) => value === null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const fromRow = (row: Row): SpaceNotification => ({ ...row, createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)!, readAt: iso(row.readAt), ackedAt: iso(row.ackedAt), resolvedAt: iso(row.resolvedAt) });

export class PostgresSpaceNotificationsRepository implements SpaceNotificationsRepository {
  constructor(private readonly pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresSpaceNotificationsRepository(createSpacePgPool(url, { max: 2 })); }
  async raise(input: NotificationRaiseInput & { id?: string; reopen?: boolean }): Promise<{ notification: SpaceNotification; created: boolean }> {
    if (input.dedupeKey) {
      const existing = await this.pool.query<Row>(`UPDATE space_notifications SET title = $3, body = $4, severity = $5, link = $6::jsonb, payload = $7::jsonb, updated_at = now(),
          status = CASE WHEN $8 THEN 'OPEN' ELSE status END, read_at = CASE WHEN $8 THEN NULL ELSE read_at END
        WHERE owner_user_id = $1 AND dedupe_key = $2 AND status IN ('OPEN', 'READ') RETURNING ${columns}`,
        [input.ownerUserId, input.dedupeKey, clip(input.title, 200), clip(input.body, 2000), input.severity, JSON.stringify(input.link), JSON.stringify(input.payload), input.reopen === true]);
      if (existing.rows[0]) return { notification: fromRow(existing.rows[0]), created: false };
    }
    const notification = build(input, new Date().toISOString());
    // Two raises of the same key at once: the partial unique index lets one in; the other refreshes it.
    const inserted = await this.pool.query<Row>(`INSERT INTO space_notifications (id, owner_user_id, room_id, pane_id, source, kind, severity, title, body, link, dedupe_key, status, payload)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, 'OPEN', $12::jsonb) ON CONFLICT DO NOTHING RETURNING ${columns}`,
      [notification.id, notification.ownerUserId, notification.roomId, notification.paneId, notification.source, notification.kind, notification.severity, notification.title, notification.body,
        JSON.stringify(notification.link), notification.dedupeKey, JSON.stringify(notification.payload)]);
    if (inserted.rows[0]) return { notification: fromRow(inserted.rows[0]), created: true };
    return this.raise({ ...input, dedupeKey: input.dedupeKey ?? null });
  }
  async get(owner: string, id: string) {
    const result = await this.pool.query<Row>(`SELECT ${columns} FROM space_notifications WHERE owner_user_id = $1 AND id = $2`, [owner, id]);
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }
  async list(owner: string, query: NotificationListQuery) {
    const result = await this.pool.query<Row>(`SELECT ${columns} FROM space_notifications WHERE owner_user_id = $1 AND ($2::text IS NULL OR status = $2)
      AND ($3::text IS NULL OR source = $3) AND ($4::timestamptz IS NULL OR created_at < $4) ORDER BY created_at DESC, id DESC LIMIT $5`,
      [owner, query.status === "OPEN" ? "OPEN" : null, query.source ?? null, query.before ?? null, query.limit]);
    return result.rows.map(fromRow);
  }
  async pending(owner: string) {
    // A pane moved to another room takes its notifications along; a closed pane's ones mark no room.
    const result = await this.pool.query<Row & { currentRoomId: string | null }>(`SELECT ${columns}, CASE WHEN pane_id IS NULL THEN room_id
      ELSE (SELECT p.room_id FROM panes p WHERE p.id = space_notifications.pane_id AND NOT p.is_closed) END AS "currentRoomId"
      FROM space_notifications WHERE owner_user_id = $1 AND status = 'OPEN' ORDER BY created_at DESC, id DESC LIMIT 500`, [owner]);
    const rooms = new Map(result.rows.map((row) => [row.id, row.currentRoomId]));
    return pendingOf(result.rows.map(({ currentRoomId: _room, ...row }) => fromRow(row)), (item) => rooms.get(item.id) ?? null);
  }
  async setStatus(owner: string, id: string, status: Exclude<NotificationStatus, "OPEN">) {
    const result = await this.pool.query<Row>(`UPDATE space_notifications SET status = $3, updated_at = now(), read_at = coalesce(read_at, now()),
      acked_at = CASE WHEN $3 = 'ACKED' THEN now() ELSE acked_at END, resolved_at = CASE WHEN $3 = 'RESOLVED' THEN now() ELSE resolved_at END
      WHERE owner_user_id = $1 AND id = $2 RETURNING ${columns}`, [owner, id, status]);
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }
  async readAll(owner: string) {
    const result = await this.pool.query("UPDATE space_notifications SET status = 'READ', read_at = now(), updated_at = now() WHERE owner_user_id = $1 AND status = 'OPEN'", [owner]);
    return (result as { rowCount?: number | null }).rowCount ?? 0;
  }
  async unresolvedBySource(source: NotificationSource) {
    const result = await this.pool.query<Row>(`SELECT ${columns} FROM space_notifications WHERE source = $1 AND status IN ('OPEN', 'READ') ORDER BY created_at DESC, id DESC LIMIT 500`, [source]);
    return result.rows.map(fromRow);
  }
  async resolveByDedupeKey(owner: string, dedupeKey: string) {
    const result = await this.pool.query("UPDATE space_notifications SET status = 'RESOLVED', resolved_at = now(), updated_at = now() WHERE owner_user_id = $1 AND dedupe_key = $2 AND status IN ('OPEN', 'READ')", [owner, dedupeKey]);
    return (result as { rowCount?: number | null }).rowCount ?? 0;
  }
  async prune(before: string) {
    // An unresolved ATTENTION or URGENT item (a review, a question, a Nous card) waits for the operator however old it is.
    const result = await this.pool.query("DELETE FROM space_notifications WHERE created_at < $1 AND NOT (severity <> 'INFO' AND status IN ('OPEN', 'READ'))", [before]);
    return (result as { rowCount?: number | null }).rowCount ?? 0;
  }
  async enqueueTelegram(notification: SpaceNotification, labels: { source: string }, alertKey?: string) {
    const result = await this.pool.query(`INSERT INTO telegram_notification_outbox (
        delivery_id, integration_generation, source_key, source_type, room_id, pane_id, turn_id, room_name, pane_title,
        agent_label, task_title, final_response, completed_at, status, available_at, created_at, updated_at)
      SELECT $1, i.generation, $2, 'NOTIFICATION', r.id, p.id, NULL, coalesce(r.name, 'Space'), coalesce(p.title, ''), $3, $4, $5, now(), 'PENDING', now(), now(), now()
      FROM telegram_integrations i
      LEFT JOIN rooms r ON r.id = $6
      LEFT JOIN panes p ON p.id = $7
      WHERE i.id = 'global' AND i.connection_status = 'CONNECTED' AND i.is_enabled = true
        AND i.enabled_at IS NOT NULL AND now() >= i.enabled_at
      ON CONFLICT (source_key) DO NOTHING`,
    [`telegram_delivery:${randomUUID()}`, `space-notification:${notification.id}${alertKey ? `:${alertKey}` : ""}`, clip(labels.source, 120), clip(notification.title, 120), clip(notification.body || notification.title, 4000),
      notification.roomId, notification.paneId]);
    return ((result as { rowCount?: number | null }).rowCount ?? 0) > 0;
  }
  async registerPushDevice(owner: string, device: PushDeviceRegistration) {
    await this.pool.query(`INSERT INTO space_push_devices (token, user_id, platform, app_version) VALUES ($1, $2, $3, $4)
      ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, app_version = EXCLUDED.app_version, last_seen_at = now(), disabled_at = NULL`,
    [device.token, owner, device.platform, device.appVersion]);
  }
  async removePushDevice(owner: string, token: string) {
    const result = await this.pool.query("DELETE FROM space_push_devices WHERE user_id = $1 AND token = $2", [owner, token]);
    return ((result as { rowCount?: number | null }).rowCount ?? 0) > 0;
  }
  async pushTokens(owner: string) {
    const result = await this.pool.query<{ token: string }>("SELECT token FROM space_push_devices WHERE user_id = $1 AND disabled_at IS NULL ORDER BY last_seen_at DESC LIMIT 20", [owner]);
    return result.rows.map((row) => row.token);
  }
  async disablePushDevice(token: string) {
    await this.pool.query("UPDATE space_push_devices SET disabled_at = now() WHERE token = $1 AND disabled_at IS NULL", [token]);
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
