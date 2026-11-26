import { randomUUID } from "node:crypto";
import type { InboxAsk, InboxEvent, InboxEventType, InboxThread, InboxThreadRefs } from "@space/contracts";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

// «Εισερχόμενα» v2 (migration 0346, plan clipboard:aE7U1J_gU9OV): Threads and their append-only events. Durable records: nothing here deletes.

export type NewInboxThread = Omit<InboxThread, "id">;
export type NewInboxEvent = Omit<InboxEvent, "id">;
/** An event with what it mirrors (`<ref>:<TYPE>:<n>`). */
export interface InboxEventRow extends InboxEvent { sourceKey: string }

export interface InboxRepository {
  thread(owner: string, id: string): Promise<InboxThread | null>;
  threadByKey(owner: string, key: string): Promise<InboxThread | null>;
  /** The Thread holding the newest event of that source record (an ask moved out of a request's Thread lives in its own). */
  threadOfRef(owner: string, ref: string): Promise<InboxThread | null>;
  /** The oldest Thread whose refs name the plan. */
  threadOfPlan(owner: string, planId: string): Promise<InboxThread | null>;
  /** Creates it, or answers the owner's Thread already holding that key. */
  createThread(input: NewInboxThread): Promise<InboxThread>;
  saveThread(thread: InboxThread): Promise<void>;
  /** Appends once per source key; null when that key was already recorded. */
  append(owner: string, sourceKey: string, event: NewInboxEvent): Promise<InboxEvent | null>;
  /** A Thread's events in the order they were recorded. */
  events(owner: string, threadId: string): Promise<InboxEvent[]>;
  /** Events of many Threads in one batched query, grouped by threadId in recorded order. */
  eventsOfThreads(owner: string, threadIds: readonly string[]): Promise<Map<string, InboxEvent[]>>;
  /** Every event of those source records, in the order they were recorded. */
  eventsOfRefs(owner: string, refs: readonly string[]): Promise<InboxEventRow[]>;
  /** The owner's Threads, newest event first; `open` keeps those not closed. */
  threads(owner: string, options?: { open?: boolean }): Promise<InboxThread[]>;
  /** A page of closed Threads, newest event first, after the cursor (`lastEventAt|id` of the previous page's last), none older than `since`. */
  /** `holding`: only the Threads with an event of that type (the Updates tab's read updates). */
  closedThreads(owner: string, options: ClosedThreadsOptions): Promise<InboxThread[]>;
  /** Every Thread with the words of its title, refs and events (search, §6); closed ones only from `since` on. */
  threadTexts(owner: string, since?: string): Promise<Array<{ thread: InboxThread; text: string }>>;
  dispose(): Promise<void>;
}

export interface ClosedThreadsOptions { limit: number; after?: { at: string; id: string }; since?: string; holding?: InboxEventType }
const newId = (prefix: string) => `${prefix}:${randomUUID().replace(/-/g, "").slice(0, 24)}`;
const copy = <T>(value: T): T => structuredClone(value);
const recent = (left: InboxThread, right: InboxThread) => right.lastEventAt.localeCompare(left.lastEventAt) || right.id.localeCompare(left.id);

// Drops the stored-only fields (a destructured omit leaves unused bindings the lint ceiling counts).
function without<T extends object, K extends keyof T>(row: T, ...keys: K[]): Omit<T, K> {
  const rest: Partial<T> = { ...row };
  for (const key of keys) delete rest[key];
  return rest as Omit<T, K>;
}

export class InMemoryInboxRepository implements InboxRepository {
  private readonly threadRows: InboxThread[] = [];
  private readonly eventRows: Array<InboxEventRow & { owner: string }> = [];
  async thread(owner: string, id: string) { return copy(this.threadRows.find((row) => row.ownerUserId === owner && row.id === id) ?? null); }
  async threadByKey(owner: string, key: string) { return copy(this.threadRows.find((row) => row.ownerUserId === owner && row.key === key) ?? null); }
  async threadOfRef(owner: string, ref: string) {
    const event = this.eventRows.findLast((row) => row.owner === owner && row.ref === ref);
    return event ? this.thread(owner, event.threadId) : null;
  }
  async threadOfPlan(owner: string, planId: string) { return copy(this.threadRows.find((row) => row.ownerUserId === owner && row.refs.planId === planId) ?? null); }
  async createThread(input: NewInboxThread) {
    const existing = await this.threadByKey(input.ownerUserId, input.key);
    if (existing) return existing;
    const thread = { ...copy(input), id: newId("thread") };
    this.threadRows.push(thread);
    return copy(thread);
  }
  async saveThread(thread: InboxThread) {
    const index = this.threadRows.findIndex((row) => row.ownerUserId === thread.ownerUserId && row.id === thread.id);
    if (index >= 0) this.threadRows[index] = copy(thread);
  }
  async append(owner: string, sourceKey: string, event: NewInboxEvent) {
    if (this.eventRows.some((row) => row.owner === owner && row.sourceKey === sourceKey)) return null;
    const stored: InboxEvent = { ...copy(event), id: newId("ievent") };
    this.eventRows.push({ ...copy(stored), sourceKey, owner });
    return stored;
  }
  async events(owner: string, threadId: string) {
    return this.eventRows.filter((row) => row.owner === owner && row.threadId === threadId).map((row) => copy(without(row, "owner", "sourceKey")));
  }
  async eventsOfThreads(owner: string, threadIds: readonly string[]) {
    const out = new Map<string, InboxEvent[]>();
    const wanted = new Set(threadIds);
    if (!wanted.size) return out;
    for (const row of this.eventRows) {
      if (row.owner !== owner || !wanted.has(row.threadId)) continue;
      const event = copy(without(row, "owner", "sourceKey"));
      const list = out.get(row.threadId);
      if (list) list.push(event); else out.set(row.threadId, [event]);
    }
    return out;
  }
  async eventsOfRefs(owner: string, refs: readonly string[]) {
    const wanted = new Set(refs);
    return this.eventRows.filter((row) => row.owner === owner && row.ref && wanted.has(row.ref)).map((row) => copy(without(row, "owner")));
  }
  async threads(owner: string, options: { open?: boolean } = {}) {
    return copy(this.threadRows.filter((row) => row.ownerUserId === owner && (!options.open || !row.closedAt)).sort(recent));
  }
  async closedThreads(owner: string, options: ClosedThreadsOptions) {
    const { after, since, holding } = options;
    return copy(this.threadRows.filter((row) => row.ownerUserId === owner && row.closedAt && (!since || row.lastEventAt >= since)
      && (!holding || this.eventRows.some((event) => event.threadId === row.id && event.type === holding))
      && (!after || row.lastEventAt < after.at || (row.lastEventAt === after.at && row.id < after.id))).sort(recent).slice(0, options.limit));
  }
  async threadTexts(owner: string, since?: string) {
    return this.threadRows.filter((row) => row.ownerUserId === owner && (!row.closedAt || !since || row.lastEventAt >= since)).map((thread) => ({ thread: copy(thread),
      text: [thread.title, JSON.stringify(thread.refs), ...this.eventRows.filter((row) => row.threadId === thread.id).map((row) => `${row.title} ${row.body} ${row.ref ?? ""}`)].join(" ") }));
  }
  async dispose() {}
}

interface ThreadRow { id: string; owner_user_id: string; key: string; title: string; origin: InboxThread["origin"]; origin_label: string; waiting_for: InboxThread["waitingFor"];
  unseen: boolean; closed_at: Date | null; closed_by: InboxThread["closedBy"]; priority: InboxThread["priority"]; now: string; progress: number | null; refs: InboxThreadRefs;
  created_at: Date; last_event_at: Date }
interface EventRow { id: string; thread_id: string; source_key: string; at: Date; type: InboxEvent["type"]; actor: string; title: string; body: string;
  priority: InboxEvent["priority"]; ref: string | null; ask: InboxAsk | null }
const iso = (value: Date | string) => new Date(value).toISOString();
const threadOf = (row: ThreadRow): InboxThread => ({ id: row.id, ownerUserId: row.owner_user_id, key: row.key, title: row.title, origin: row.origin, originLabel: row.origin_label,
  waitingFor: row.waiting_for, unseen: row.unseen, closedAt: row.closed_at ? iso(row.closed_at) : null, closedBy: row.closed_by, priority: row.priority, now: row.now,
  progress: row.progress, refs: row.refs ?? {}, createdAt: iso(row.created_at), lastEventAt: iso(row.last_event_at) });
const eventOf = (row: EventRow): InboxEventRow => ({ id: row.id, threadId: row.thread_id, sourceKey: row.source_key, at: iso(row.at), type: row.type, actor: row.actor,
  title: row.title, body: row.body, priority: row.priority, ...(row.ref ? { ref: row.ref } : {}), ...(row.ask ? { ask: row.ask } : {}) });
const withoutKey = (event: InboxEventRow): InboxEvent => without(event, "sourceKey");
// Technical bound: one query's ref list (Postgres parameters of an ANY array stay cheap at this size); larger lists are read in batches.
const REF_BATCH = 500;

export class PostgresInboxRepository implements InboxRepository {
  constructor(private readonly pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresInboxRepository(createSpacePgPool(url, { max: 2 })); }

  private async one(sql: string, values: unknown[]) { return (await this.pool.query<ThreadRow>(sql, values)).rows.map(threadOf)[0] ?? null; }
  async thread(owner: string, id: string) { return this.one("SELECT * FROM space_inbox_threads WHERE owner_user_id = $1 AND id = $2", [owner, id]); }
  async threadByKey(owner: string, key: string) { return this.one("SELECT * FROM space_inbox_threads WHERE owner_user_id = $1 AND key = $2", [owner, key]); }
  async threadOfRef(owner: string, ref: string) {
    return this.one(`SELECT t.* FROM space_inbox_threads t WHERE t.owner_user_id = $1 AND t.id = (SELECT thread_id FROM space_inbox_events WHERE owner_user_id = $1 AND ref = $2
      ORDER BY seq DESC LIMIT 1)`, [owner, ref]);
  }
  async threadOfPlan(owner: string, planId: string) {
    return this.one("SELECT * FROM space_inbox_threads WHERE owner_user_id = $1 AND refs->>'planId' = $2 ORDER BY created_at, id LIMIT 1", [owner, planId]);
  }
  async createThread(input: NewInboxThread) {
    const inserted = await this.one(`INSERT INTO space_inbox_threads (id, owner_user_id, key, title, origin, origin_label, waiting_for, unseen, closed_at, closed_by, priority, now,
      progress, refs, created_at, last_event_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16)
      ON CONFLICT (owner_user_id, key) DO NOTHING RETURNING *`, [newId("thread"), input.ownerUserId, input.key, input.title, input.origin, input.originLabel, input.waitingFor,
      input.unseen, input.closedAt, input.closedBy, input.priority, input.now, input.progress, JSON.stringify(input.refs), input.createdAt, input.lastEventAt]);
    return inserted ?? (await this.threadByKey(input.ownerUserId, input.key))!;
  }
  async saveThread(thread: InboxThread) {
    await this.pool.query(`UPDATE space_inbox_threads SET title = $3, origin = $4, origin_label = $5, waiting_for = $6, unseen = $7, closed_at = $8, closed_by = $9, priority = $10,
      now = $11, progress = $12, refs = $13::jsonb, last_event_at = $14 WHERE owner_user_id = $1 AND id = $2`, [thread.ownerUserId, thread.id, thread.title, thread.origin,
      thread.originLabel, thread.waitingFor, thread.unseen, thread.closedAt, thread.closedBy, thread.priority, thread.now, thread.progress, JSON.stringify(thread.refs), thread.lastEventAt]);
  }
  async append(owner: string, sourceKey: string, event: NewInboxEvent) {
    const result = await this.pool.query<EventRow>(`INSERT INTO space_inbox_events (id, owner_user_id, thread_id, source_key, at, type, actor, title, body, priority, ref, ask)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb) ON CONFLICT (owner_user_id, source_key) DO NOTHING RETURNING *`,
    [newId("ievent"), owner, event.threadId, sourceKey, event.at, event.type, event.actor, event.title, event.body, event.priority, event.ref ?? null, event.ask ? JSON.stringify(event.ask) : null]);
    const row = result.rows[0];
    return row ? withoutKey(eventOf(row)) : null;
  }
  async events(owner: string, threadId: string) {
    return (await this.pool.query<EventRow>("SELECT * FROM space_inbox_events WHERE owner_user_id = $1 AND thread_id = $2 ORDER BY seq", [owner, threadId])).rows.map(eventOf).map(withoutKey);
  }
  async eventsOfThreads(owner: string, threadIds: readonly string[]) {
    const out = new Map<string, InboxEvent[]>();
    const unique = [...new Set(threadIds)];
    for (let start = 0; start < unique.length; start += REF_BATCH) {
      const batch = unique.slice(start, start + REF_BATCH);
      const rows = (await this.pool.query<EventRow>("SELECT * FROM space_inbox_events WHERE owner_user_id = $1 AND thread_id = ANY($2::text[]) ORDER BY seq",
        [owner, batch])).rows.map(eventOf).map(withoutKey);
      for (const event of rows) {
        const list = out.get(event.threadId);
        if (list) list.push(event); else out.set(event.threadId, [event]);
      }
    }
    return out;
  }
  async eventsOfRefs(owner: string, refs: readonly string[]) {
    const out: InboxEventRow[] = [];
    for (let start = 0; start < refs.length; start += REF_BATCH) {
      const batch = refs.slice(start, start + REF_BATCH);
      out.push(...(await this.pool.query<EventRow>("SELECT * FROM space_inbox_events WHERE owner_user_id = $1 AND ref = ANY($2::text[]) ORDER BY seq",
        [owner, batch])).rows.map(eventOf));
    }
    return out;
  }
  async threads(owner: string, options: { open?: boolean } = {}) {
    return (await this.pool.query<ThreadRow>(`SELECT * FROM space_inbox_threads WHERE owner_user_id = $1 ${options.open ? "AND closed_at IS NULL" : ""}
      ORDER BY last_event_at DESC, id DESC`, [owner])).rows.map(threadOf);
  }
  async closedThreads(owner: string, options: ClosedThreadsOptions) {
    // shortcut: `holding` probes each closed Thread's events (space_inbox_events_thread) down the recent index; give events a (owner, type) index if this page turns slow.
    return (await this.pool.query<ThreadRow>(`SELECT * FROM space_inbox_threads t WHERE owner_user_id = $1 AND closed_at IS NOT NULL
      AND ($2::timestamptz IS NULL OR last_event_at >= $2) AND ($3::timestamptz IS NULL OR (last_event_at, id) < ($3, $4))
      AND ($6::text IS NULL OR EXISTS (SELECT 1 FROM space_inbox_events e WHERE e.thread_id = t.id AND e.type = $6))
      ORDER BY last_event_at DESC, id DESC LIMIT $5`, [owner, options.since ?? null, options.after?.at ?? null, options.after?.id ?? "", options.limit, options.holding ?? null])).rows.map(threadOf);
  }
  async threadTexts(owner: string, since?: string) {
    const rows = (await this.pool.query<ThreadRow & { text: string }>(`SELECT t.*, concat_ws(' ', t.title, t.refs::text,
      string_agg(concat_ws(' ', e.title, e.body, e.ref), ' ' ORDER BY e.seq)) AS text
      FROM space_inbox_threads t LEFT JOIN space_inbox_events e ON e.thread_id = t.id
      WHERE t.owner_user_id = $1 AND (t.closed_at IS NULL OR $2::timestamptz IS NULL OR t.last_event_at >= $2) GROUP BY t.id`, [owner, since ?? null])).rows;
    return rows.map((row) => ({ thread: threadOf(row), text: row.text ?? "" }));
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
