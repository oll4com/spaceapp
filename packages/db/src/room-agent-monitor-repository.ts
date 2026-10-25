import { randomUUID } from "node:crypto";
import type { RoomAgentEvent, RoomAgentEventKind, RoomAgentEventStatus, RoomAgentPaneActivity } from "@space/contracts";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

/** The activity the room monitor last saw in a pane; a restart compares against it instead of repeating events. */
export interface RoomPaneActivityRecord {
  paneId: string;
  roomId: string;
  activity: RoomAgentPaneActivity;
  reason: string | null;
  since: string | null;
}

export interface AddRoomAgentEventInput {
  roomId: string;
  paneId: string | null;
  paneName: string | null;
  kind: RoomAgentEventKind;
  severity: RoomAgentEvent["severity"];
  title: string;
  detail: string | null;
  status?: RoomAgentEventStatus;
}

export interface RoomAgentMonitorRepository {
  /** Rooms whose monitor the operator turned off; every other room is monitored. */
  disabledRooms(): Promise<Set<string>>;
  monitorEnabled(roomId: string): Promise<boolean>;
  setMonitorEnabled(roomId: string, enabled: boolean): Promise<void>;
  /** Whether the Room Agent answers its panes' prompts by itself (on unless switched off). */
  autopilotEnabled(roomId: string): Promise<boolean>;
  setAutopilotEnabled(roomId: string, enabled: boolean): Promise<void>;
  paneActivity(roomId: string): Promise<RoomPaneActivityRecord[]>;
  savePaneActivity(records: RoomPaneActivityRecord[]): Promise<void>;
  addEvent(input: AddRoomAgentEventInput): Promise<RoomAgentEvent>;
  /** Moves an event only from one of `from` (when given), so concurrent writers never overwrite a decision. */
  updateEvent(eventId: string, patch: { status?: RoomAgentEventStatus; decision?: string | null; detail?: string | null }, from?: RoomAgentEventStatus[]): Promise<RoomAgentEvent | null>;
  getEvent(eventId: string): Promise<RoomAgentEvent | null>;
  /** Newest first. */
  listEvents(roomId: string, options?: { limit?: number; statuses?: RoomAgentEventStatus[]; paneId?: string }): Promise<RoomAgentEvent[]>;
  /** Attention events still waiting (OPEN or ESCALATED) per room. */
  pendingCounts(roomIds: string[]): Promise<Record<string, number>>;
  /** Newest attention events still waiting across these rooms. */
  latestPending(roomIds: string[], limit: number): Promise<RoomAgentEvent[]>;
  pruneEvents(before: string): Promise<number>;
  /**
   * Queues a Telegram message about an event that needs the operator, through the existing completion outbox
   * (only while the Telegram integration is connected and enabled; one message per event).
   */
  enqueueTelegramNotice(event: RoomAgentEvent): Promise<boolean>;
  dispose(): Promise<void>;
}

const clip = (value: string | null, max: number) => value === null ? null : value.length > max ? `${value.slice(0, max - 1)}…` : value;

function newEvent(input: AddRoomAgentEventInput, at: string): RoomAgentEvent {
  return {
    eventId: `room_agent_event:${randomUUID()}`,
    roomId: input.roomId,
    paneId: input.paneId,
    paneName: clip(input.paneName, 60),
    kind: input.kind,
    severity: input.severity,
    title: clip(input.title, 200) || input.kind,
    detail: clip(input.detail, 2000),
    status: input.status ?? "OPEN",
    decision: null,
    createdAt: at,
    updatedAt: at
  };
}

export class InMemoryRoomAgentMonitorRepository implements RoomAgentMonitorRepository {
  private disabled = new Set<string>();
  private autopilotOff = new Set<string>();
  private activity = new Map<string, RoomPaneActivityRecord>();
  private events = new Map<string, RoomAgentEvent>();
  private clock = 0;
  /** Telegram notices queued in memory (tests). */
  readonly telegramNotices: RoomAgentEvent[] = [];
  // Strictly increasing timestamps keep newest-first order stable within one millisecond.
  private now() { this.clock = Math.max(this.clock + 1, Date.now()); return new Date(this.clock).toISOString(); }
  async disabledRooms() { return new Set(this.disabled); }
  async monitorEnabled(roomId: string) { return !this.disabled.has(roomId); }
  async setMonitorEnabled(roomId: string, enabled: boolean) { if (enabled) this.disabled.delete(roomId); else this.disabled.add(roomId); }
  async autopilotEnabled(roomId: string) { return !this.autopilotOff.has(roomId); }
  async setAutopilotEnabled(roomId: string, enabled: boolean) { if (enabled) this.autopilotOff.delete(roomId); else this.autopilotOff.add(roomId); }
  async paneActivity(roomId: string) { return [...this.activity.values()].filter((record) => record.roomId === roomId).map((record) => ({ ...record })); }
  async savePaneActivity(records: RoomPaneActivityRecord[]) { for (const record of records) this.activity.set(record.paneId, { ...record }); }
  async addEvent(input: AddRoomAgentEventInput) { const event = newEvent(input, this.now()); this.events.set(event.eventId, event); return { ...event }; }
  async updateEvent(eventId: string, patch: { status?: RoomAgentEventStatus; decision?: string | null; detail?: string | null }, from?: RoomAgentEventStatus[]) {
    const event = this.events.get(eventId);
    if (!event || (from && !from.includes(event.status))) return null;
    const next = { ...event, ...(patch.status ? { status: patch.status } : {}),
      ...(patch.decision !== undefined ? { decision: clip(patch.decision, 2000) } : {}),
      ...(patch.detail !== undefined ? { detail: clip(patch.detail, 2000) } : {}), updatedAt: this.now() };
    this.events.set(eventId, next);
    return { ...next };
  }
  async getEvent(eventId: string) { const event = this.events.get(eventId); return event ? { ...event } : null; }
  async listEvents(roomId: string, options: { limit?: number; statuses?: RoomAgentEventStatus[]; paneId?: string } = {}) {
    return [...this.events.values()]
      .filter((event) => event.roomId === roomId && (!options.statuses || options.statuses.includes(event.status)) && (!options.paneId || event.paneId === options.paneId))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, options.limit ?? 50)
      .map((event) => ({ ...event }));
  }
  async pendingCounts(roomIds: string[]) {
    const counts: Record<string, number> = {};
    for (const event of this.events.values()) {
      if (roomIds.includes(event.roomId) && event.severity === "ATTENTION" && (event.status === "OPEN" || event.status === "ESCALATED")) {
        counts[event.roomId] = (counts[event.roomId] ?? 0) + 1;
      }
    }
    return counts;
  }
  async latestPending(roomIds: string[], limit: number) {
    return [...this.events.values()]
      .filter((event) => roomIds.includes(event.roomId) && event.severity === "ATTENTION" && (event.status === "OPEN" || event.status === "ESCALATED"))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, limit).map((event) => ({ ...event }));
  }
  async pruneEvents(before: string) {
    let removed = 0;
    for (const [id, event] of this.events) if (event.createdAt < before) { this.events.delete(id); removed += 1; }
    return removed;
  }
  async enqueueTelegramNotice(event: RoomAgentEvent) {
    if (this.telegramNotices.some((notice) => notice.eventId === event.eventId)) return false;
    this.telegramNotices.push({ ...event });
    return true;
  }
  async dispose() {}
}

interface EventRow {
  event_id: string; room_id: string; pane_id: string | null; pane_name: string | null; kind: RoomAgentEventKind;
  severity: RoomAgentEvent["severity"]; title: string; detail: string | null; status: RoomAgentEventStatus; decision: string | null;
  created_at: Date | string; updated_at: Date | string;
}
const iso = (value: Date | string) => (value instanceof Date ? value : new Date(value)).toISOString();
function eventFromRow(row: EventRow): RoomAgentEvent {
  return {
    eventId: row.event_id, roomId: row.room_id, paneId: row.pane_id, paneName: row.pane_name, kind: row.kind, severity: row.severity,
    title: row.title, detail: row.detail, status: row.status, decision: row.decision, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
  };
}
const eventColumns = "event_id, room_id, pane_id, pane_name, kind, severity, title, detail, status, decision, created_at, updated_at";

export class PostgresRoomAgentMonitorRepository implements RoomAgentMonitorRepository {
  constructor(private pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresRoomAgentMonitorRepository(createSpacePgPool(url, { max: 4 })); }
  async disabledRooms() {
    const result = await this.pool.query<{ room_id: string }>("SELECT room_id FROM room_agent_monitor_settings WHERE enabled = false");
    return new Set(result.rows.map((row) => row.room_id));
  }
  async monitorEnabled(roomId: string) {
    const result = await this.pool.query<{ enabled: boolean }>("SELECT enabled FROM room_agent_monitor_settings WHERE room_id = $1", [roomId]);
    return result.rows[0]?.enabled ?? true;
  }
  async setMonitorEnabled(roomId: string, enabled: boolean) {
    await this.pool.query(`INSERT INTO room_agent_monitor_settings (room_id, enabled) VALUES ($1, $2)
      ON CONFLICT (room_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`, [roomId, enabled]);
  }
  async autopilotEnabled(roomId: string) {
    const result = await this.pool.query<{ autopilot_enabled: boolean }>("SELECT autopilot_enabled FROM room_agent_monitor_settings WHERE room_id = $1", [roomId]);
    return result.rows[0]?.autopilot_enabled ?? true;
  }
  async setAutopilotEnabled(roomId: string, enabled: boolean) {
    await this.pool.query(`INSERT INTO room_agent_monitor_settings (room_id, autopilot_enabled) VALUES ($1, $2)
      ON CONFLICT (room_id) DO UPDATE SET autopilot_enabled = EXCLUDED.autopilot_enabled, updated_at = now()`, [roomId, enabled]);
  }
  async paneActivity(roomId: string) {
    const result = await this.pool.query<{ pane_id: string; room_id: string; activity: RoomAgentPaneActivity; reason: string | null; since: Date | string | null }>(
      "SELECT pane_id, room_id, activity, reason, since FROM room_pane_activity WHERE room_id = $1", [roomId]);
    return result.rows.map((row) => ({ paneId: row.pane_id, roomId: row.room_id, activity: row.activity, reason: row.reason, since: row.since === null ? null : iso(row.since) }));
  }
  async savePaneActivity(records: RoomPaneActivityRecord[]) {
    if (!records.length) return;
    await this.pool.query(`INSERT INTO room_pane_activity (pane_id, room_id, activity, reason, since)
      SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::timestamptz[])
      ON CONFLICT (pane_id) DO UPDATE SET room_id = EXCLUDED.room_id, activity = EXCLUDED.activity, reason = EXCLUDED.reason,
        since = EXCLUDED.since, updated_at = now()`,
    [records.map((r) => r.paneId), records.map((r) => r.roomId), records.map((r) => r.activity), records.map((r) => clip(r.reason, 80)), records.map((r) => r.since)]);
  }
  async addEvent(input: AddRoomAgentEventInput) {
    const event = newEvent(input, new Date().toISOString());
    const result = await this.pool.query<EventRow>(`INSERT INTO room_agent_events (event_id, room_id, pane_id, pane_name, kind, severity, title, detail, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${eventColumns}`,
    [event.eventId, event.roomId, event.paneId, event.paneName, event.kind, event.severity, event.title, event.detail, event.status]);
    return eventFromRow(result.rows[0]!);
  }
  async updateEvent(eventId: string, patch: { status?: RoomAgentEventStatus; decision?: string | null; detail?: string | null }, from?: RoomAgentEventStatus[]) {
    const result = await this.pool.query<EventRow>(`UPDATE room_agent_events SET status = COALESCE($2, status),
        decision = CASE WHEN $3::boolean THEN $4 ELSE decision END, detail = CASE WHEN $6::boolean THEN $7 ELSE detail END, updated_at = now()
      WHERE event_id = $1 AND ($5::text[] IS NULL OR status = ANY($5::text[])) RETURNING ${eventColumns}`,
    [eventId, patch.status ?? null, patch.decision !== undefined, patch.decision === undefined ? null : clip(patch.decision, 2000), from ?? null,
      patch.detail !== undefined, patch.detail === undefined ? null : clip(patch.detail, 2000)]);
    return result.rows[0] ? eventFromRow(result.rows[0]) : null;
  }
  async getEvent(eventId: string) {
    const result = await this.pool.query<EventRow>(`SELECT ${eventColumns} FROM room_agent_events WHERE event_id = $1`, [eventId]);
    return result.rows[0] ? eventFromRow(result.rows[0]) : null;
  }
  async listEvents(roomId: string, options: { limit?: number; statuses?: RoomAgentEventStatus[]; paneId?: string } = {}) {
    const result = await this.pool.query<EventRow>(`SELECT ${eventColumns} FROM room_agent_events
      WHERE room_id = $1 AND ($2::text[] IS NULL OR status = ANY($2::text[])) AND ($3::text IS NULL OR pane_id = $3)
      ORDER BY created_at DESC, event_id DESC LIMIT $4`, [roomId, options.statuses ?? null, options.paneId ?? null, Math.min(200, options.limit ?? 50)]);
    return result.rows.map(eventFromRow);
  }
  async pendingCounts(roomIds: string[]) {
    if (!roomIds.length) return {};
    const result = await this.pool.query<{ room_id: string; count: string | number }>(`SELECT room_id, count(*) AS count FROM room_agent_events
      WHERE room_id = ANY($1::text[]) AND severity = 'ATTENTION' AND status IN ('OPEN', 'ESCALATED') GROUP BY room_id`, [roomIds]);
    return Object.fromEntries(result.rows.map((row) => [row.room_id, Number(row.count)]));
  }
  async latestPending(roomIds: string[], limit: number) {
    if (!roomIds.length) return [];
    const result = await this.pool.query<EventRow>(`SELECT ${eventColumns} FROM room_agent_events
      WHERE room_id = ANY($1::text[]) AND severity = 'ATTENTION' AND status IN ('OPEN', 'ESCALATED')
      ORDER BY created_at DESC, event_id DESC LIMIT $2`, [roomIds, Math.min(50, limit)]);
    return result.rows.map(eventFromRow);
  }
  async pruneEvents(before: string) {
    const result = await this.pool.query("DELETE FROM room_agent_events WHERE created_at < $1", [before]);
    return (result as { rowCount?: number | null }).rowCount ?? 0;
  }
  async enqueueTelegramNotice(event: RoomAgentEvent) {
    if (!event.paneId) return false;
    const message = [event.decision, event.detail].filter(Boolean).join("\n\n") || event.title;
    const result = await this.pool.query(`INSERT INTO telegram_notification_outbox (
        delivery_id, integration_generation, source_key, source_type, room_id, pane_id, turn_id, room_name, pane_title,
        agent_label, task_title, final_response, completed_at, status, available_at, created_at, updated_at)
      SELECT $1, i.generation, $2, 'ROOM_AGENT', r.id, p.id, NULL, r.name, p.title, 'Room Agent', $3, $4, now(), 'PENDING', now(), now(), now()
      FROM telegram_integrations i
      JOIN rooms r ON r.id = $5
      JOIN panes p ON p.id = $6
      WHERE i.id = 'global' AND i.connection_status = 'CONNECTED' AND i.is_enabled = true
        AND i.enabled_at IS NOT NULL AND now() >= i.enabled_at
      ON CONFLICT (source_key) DO NOTHING`,
    [`telegram_delivery:${randomUUID()}`, `room-agent-event:${event.eventId}`, clip(event.title, 120), clip(message, 4000), event.roomId, event.paneId]);
    return ((result as { rowCount?: number | null }).rowCount ?? 0) > 0;
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
