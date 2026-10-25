import { randomBytes } from "node:crypto";
import type { MailActionRecord, MailCopilotEvent, MailCopilotMemory, MailCopilotMemoryQuery, MailCopilotRun, MailCopilotSyncState, MailRule } from "@space/contracts";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

// Mail Copilot's own storage: memory with full-text recall, the activity feed that doubles as the agent's
// work queue (PENDING → TAKEN → DONE rows), and one active run per pane. Postgres live, in-memory for tests.

export const newMailMemoryId = () => `mailmem:${randomBytes(9).toString("base64url")}`;
export const newMailEventId = () => `mailevt:${randomBytes(9).toString("base64url")}`;
export const newMailRunId = () => `mailrun:${randomBytes(9).toString("base64url")}`;

export type MailMemoryCreate = Omit<MailCopilotMemory, "id" | "uses" | "lastUsedAt" | "createdAt" | "updatedAt">;
export type MailMemoryPatch = Partial<Pick<MailCopilotMemory, "kind" | "key" | "text" | "tags" | "confidence" | "pinned">>;
export type MailEventCreate = Omit<MailCopilotEvent, "id" | "createdAt">;
export interface MailEventFilter { paneId?: string | null; threadId?: string | null; accountEmail?: string | null; types?: string[]; status?: string[]; since?: string | null; limit: number }
export type MailRunPatch = Partial<Pick<MailCopilotRun, "status" | "counters" | "currentEventId" | "kickoffSentAt" | "pausedAt" | "stoppedAt" | "lastActivityAt">>;
export type MailRuleCreate = Omit<MailRule, "id" | "createdAt" | "updatedAt" | "appliedCount" | "lastAppliedAt" | "decidedAt">;
export type MailRulePatch = Partial<Pick<MailRule, "status" | "decidedAt" | "appliedCount" | "lastAppliedAt">>;
export type MailSyncPatch = Partial<Pick<MailCopilotSyncState, "historyId" | "lastSyncedAt" | "lastError" | "consecutiveFailures" | "backfillPageToken" | "backfillDoneAt">>;
const newMailRuleId = () => `mailrule:${randomBytes(9).toString("base64url")}`;
const newMailActionId = () => `mailact:${randomBytes(9).toString("base64url")}`;
export type MailActionCreate = Omit<MailActionRecord, "id" | "occurredAt"> & { occurredAt?: string };
/** Newest first; every filter narrows. */
export interface MailActionFilter { accountEmail?: string; threadId?: string; fromAddress?: string; fromDomain?: string; actions?: string[]; actors?: string[]; sources?: string[]; since?: string; limit: number }

export interface MailCopilotRepository {
  listMemory(owner: string, query: MailCopilotMemoryQuery): Promise<MailCopilotMemory[]>;
  getMemory(owner: string, id: string): Promise<MailCopilotMemory | null>;
  /** Inserts, or replaces the memory with the same kind, key and scope. */
  upsertMemory(input: MailMemoryCreate): Promise<MailCopilotMemory>;
  updateMemory(owner: string, id: string, patch: MailMemoryPatch): Promise<MailCopilotMemory | null>;
  deleteMemory(owner: string, id: string): Promise<boolean>;
  touchMemories(owner: string, ids: string[]): Promise<void>;
  createEvent(input: MailEventCreate): Promise<MailCopilotEvent>;
  listEvents(owner: string, filter: MailEventFilter): Promise<MailCopilotEvent[]>;
  getEvent(owner: string, id: string): Promise<MailCopilotEvent | null>;
  /** Atomically takes the next work item for the pane: the operator's hand-offs (FIX_REQUESTED) first, then the oldest PENDING one (or one TAKEN longer than `staleMs` ago). */
  takeNextItem(owner: string, paneId: string, staleMs: number): Promise<MailCopilotEvent | null>;
  countPendingItems(owner: string): Promise<number>;
  setItemStatus(owner: string, id: string, status: "PENDING" | "TAKEN" | "DONE"): Promise<MailCopilotEvent | null>;
  getActiveRun(paneId: string): Promise<MailCopilotRun | null>;
  createRun(input: { ownerUserId: string; paneId: string; status: "RUNNING" | "PAUSED" }): Promise<MailCopilotRun>;
  updateRun(owner: string, id: string, patch: MailRunPatch): Promise<MailCopilotRun | null>;
  listRules(owner: string, filter?: { status?: MailRule["status"][]; accountEmail?: string | null }): Promise<MailRule[]>;
  getRule(owner: string, id: string): Promise<MailRule | null>;
  createRule(input: MailRuleCreate): Promise<MailRule>;
  updateRule(owner: string, id: string, patch: MailRulePatch): Promise<MailRule | null>;
  getSyncState(owner: string, accountEmail: string): Promise<MailCopilotSyncState | null>;
  setSyncState(owner: string, accountEmail: string, patch: MailSyncPatch): Promise<MailCopilotSyncState>;
  /** The per-account log of what was done to mail (operator, copilot, Space). */
  recordAction(input: MailActionCreate): Promise<MailActionRecord>;
  listActions(owner: string, filter: MailActionFilter): Promise<MailActionRecord[]>;
  deleteActions(owner: string, ids: string[]): Promise<number>;
  /** Drops every owner's rows older than `before`. */
  pruneActions(before: string): Promise<number>;
  dispose(): Promise<void>;
}

const emptyCounters = { taken: 0, replied: 0, drafted: 0, archived: 0, labeled: 0, skipped: 0, needsUser: 0, fixed: 0 };
function tokens(text: string): string[] { return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 1); }
function scope(memory: Pick<MailCopilotMemory, "contactEmail" | "domain" | "accountEmail">): string { return `${memory.contactEmail ?? ""}|${memory.domain ?? ""}|${memory.accountEmail ?? ""}`; }

export class InMemoryMailCopilotRepository implements MailCopilotRepository {
  private memories = new Map<string, MailCopilotMemory>();
  private events: MailCopilotEvent[] = [];
  private runs = new Map<string, MailCopilotRun>();
  constructor(private now: () => string = () => new Date().toISOString()) {}
  async listMemory(owner: string, query: MailCopilotMemoryQuery) {
    const words = tokens(query.query ?? "");
    const rows = [...this.memories.values()].filter((memory) => memory.ownerUserId === owner
      && (!query.kinds?.length || query.kinds.includes(memory.kind))
      && (!query.contactEmail || !memory.contactEmail || memory.contactEmail === query.contactEmail)
      && (!query.domain || !memory.domain || memory.domain === query.domain)
      && (!query.pinnedOnly || memory.pinned));
    const score = (memory: MailCopilotMemory) => {
      if (!words.length) return 0;
      const haystack = new Set(tokens(`${memory.key ?? ""} ${memory.text} ${memory.contactEmail ?? ""} ${memory.domain ?? ""} ${memory.tags.join(" ")}`));
      return words.filter((word) => haystack.has(word)).length / words.length;
    };
    return rows.filter((memory) => !words.length || score(memory) > 0)
      .sort((left, right) => Number(right.pinned) - Number(left.pinned) || score(right) - score(left) || Number(Boolean(right.contactEmail)) - Number(Boolean(left.contactEmail)) || right.uses - left.uses || right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, query.limit).map((memory) => ({ ...memory }));
  }
  async getMemory(owner: string, id: string) { const memory = this.memories.get(id); return memory && memory.ownerUserId === owner ? { ...memory } : null; }
  async upsertMemory(input: MailMemoryCreate) {
    const at = this.now();
    const existing = input.key ? [...this.memories.values()].find((memory) => memory.ownerUserId === input.ownerUserId && memory.kind === input.kind && memory.key === input.key && scope(memory) === scope(input)) : undefined;
    if (existing) {
      const next = { ...existing, text: input.text, tags: input.tags.length ? input.tags : existing.tags, source: input.source, confidence: input.confidence, pinned: existing.pinned || input.pinned, updatedAt: at };
      this.memories.set(existing.id, next);
      return { ...next };
    }
    const memory: MailCopilotMemory = { ...input, id: newMailMemoryId(), uses: 0, lastUsedAt: null, createdAt: at, updatedAt: at };
    this.memories.set(memory.id, memory);
    return { ...memory };
  }
  async updateMemory(owner: string, id: string, patch: MailMemoryPatch) {
    const memory = this.memories.get(id);
    if (!memory || memory.ownerUserId !== owner) return null;
    const next = { ...memory, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)), updatedAt: this.now() } as MailCopilotMemory;
    this.memories.set(id, next);
    return { ...next };
  }
  async deleteMemory(owner: string, id: string) { const memory = this.memories.get(id); if (!memory || memory.ownerUserId !== owner) return false; this.memories.delete(id); return true; }
  async touchMemories(owner: string, ids: string[]) {
    const at = this.now();
    for (const id of ids) { const memory = this.memories.get(id); if (memory && memory.ownerUserId === owner) this.memories.set(id, { ...memory, uses: memory.uses + 1, lastUsedAt: at }); }
  }
  async createEvent(input: MailEventCreate) {
    // One MAIL_RECEIVED row per message of an account: a second sync of the same message returns the first row.
    if (input.type === "MAIL_RECEIVED" && input.messageId) {
      const existing = this.events.find((event) => event.type === "MAIL_RECEIVED" && event.ownerUserId === input.ownerUserId && event.accountEmail === input.accountEmail && event.messageId === input.messageId);
      if (existing) return { ...existing };
    }
    const event: MailCopilotEvent = { ...input, payload: input.payload ?? {}, id: newMailEventId(), createdAt: this.now() };
    this.events.push(event);
    return { ...event };
  }
  async listEvents(owner: string, filter: MailEventFilter) {
    return this.events.filter((event) => event.ownerUserId === owner && (!filter.paneId || event.paneId === filter.paneId) && (!filter.threadId || event.threadId === filter.threadId)
      && (!filter.accountEmail || event.accountEmail === filter.accountEmail) && (!filter.types?.length || filter.types.includes(event.type)) && (!filter.status?.length || (event.status !== null && filter.status.includes(event.status)))
      && (!filter.since || event.createdAt > filter.since))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)).slice(0, filter.limit).map((event) => ({ ...event }));
  }
  async getEvent(owner: string, id: string) { const event = this.events.find((entry) => entry.id === id && entry.ownerUserId === owner); return event ? { ...event } : null; }
  async takeNextItem(owner: string, paneId: string, staleMs: number) {
    const at = this.now();
    const stale = new Date(Date.parse(at) - staleMs).toISOString();
    const ready = (event: MailCopilotEvent) => event.ownerUserId === owner && (event.status === "PENDING" || (event.status === "TAKEN" && String(event.payload.takenAt ?? "") < stale));
    const fix = this.events.findIndex((event) => ready(event) && event.type === "FIX_REQUESTED");
    const index = fix >= 0 ? fix : this.events.findIndex(ready);
    if (index < 0) return null;
    const taken = { ...this.events[index]!, status: "TAKEN" as const, payload: { ...this.events[index]!.payload, takenAt: at, takenByPaneId: paneId } };
    this.events[index] = taken;
    return { ...taken };
  }
  async countPendingItems(owner: string) { return this.events.filter((event) => event.ownerUserId === owner && event.status === "PENDING").length; }
  async setItemStatus(owner: string, id: string, status: "PENDING" | "TAKEN" | "DONE") {
    const index = this.events.findIndex((event) => event.id === id && event.ownerUserId === owner);
    if (index < 0) return null;
    this.events[index] = { ...this.events[index]!, status };
    return { ...this.events[index]! };
  }
  async getActiveRun(paneId: string) { const run = [...this.runs.values()].find((entry) => entry.paneId === paneId && entry.status !== "STOPPED"); return run ? { ...run } : null; }
  async createRun(input: { ownerUserId: string; paneId: string; status: "RUNNING" | "PAUSED" }) {
    const at = this.now();
    const run: MailCopilotRun = { id: newMailRunId(), ownerUserId: input.ownerUserId, paneId: input.paneId, status: input.status, counters: { ...emptyCounters }, currentEventId: null, kickoffSentAt: null,
      startedAt: at, pausedAt: null, stoppedAt: null, lastActivityAt: at, createdAt: at, updatedAt: at };
    this.runs.set(run.id, run);
    return { ...run };
  }
  async updateRun(owner: string, id: string, patch: MailRunPatch) {
    const run = this.runs.get(id);
    if (!run || run.ownerUserId !== owner) return null;
    const next = { ...run, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)), updatedAt: this.now() } as MailCopilotRun;
    this.runs.set(id, next);
    return { ...next };
  }
  private rules = new Map<string, MailRule>();
  private sync = new Map<string, MailCopilotSyncState>();
  async listRules(owner: string, filter: { status?: MailRule["status"][]; accountEmail?: string | null } = {}) {
    return [...this.rules.values()].filter((rule) => rule.ownerUserId === owner && (!filter.status?.length || filter.status.includes(rule.status))
      && (!filter.accountEmail || rule.accountEmail === null || rule.accountEmail === filter.accountEmail))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)).map((rule) => ({ ...rule }));
  }
  async getRule(owner: string, id: string) { const rule = this.rules.get(id); return rule && rule.ownerUserId === owner ? { ...rule } : null; }
  async createRule(input: MailRuleCreate) {
    const at = this.now();
    const rule: MailRule = { ...input, id: newMailRuleId(), decidedAt: input.status === "APPROVED" ? at : null, appliedCount: 0, lastAppliedAt: null, createdAt: at, updatedAt: at };
    this.rules.set(rule.id, rule);
    return { ...rule };
  }
  async updateRule(owner: string, id: string, patch: MailRulePatch) {
    const rule = this.rules.get(id);
    if (!rule || rule.ownerUserId !== owner) return null;
    const next = { ...rule, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)), updatedAt: this.now() } as MailRule;
    this.rules.set(id, next);
    return { ...next };
  }
  async getSyncState(owner: string, accountEmail: string) { const state = this.sync.get(`${owner}|${accountEmail}`); return state ? { ...state } : null; }
  async setSyncState(owner: string, accountEmail: string, patch: MailSyncPatch) {
    const current = this.sync.get(`${owner}|${accountEmail}`) ?? { ownerUserId: owner, accountEmail, historyId: null, lastSyncedAt: null, lastError: null, consecutiveFailures: 0, backfillPageToken: null, backfillDoneAt: null, updatedAt: this.now() };
    const next = { ...current, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)), updatedAt: this.now() } as MailCopilotSyncState;
    this.sync.set(`${owner}|${accountEmail}`, next);
    return { ...next };
  }
  private actions: MailActionRecord[] = [];
  async recordAction(input: MailActionCreate) {
    const action: MailActionRecord = { ...input, id: newMailActionId(), occurredAt: input.occurredAt ?? this.now() };
    this.actions.push(action);
    return { ...action };
  }
  async listActions(owner: string, filter: MailActionFilter) {
    return this.actions.filter((action) => action.ownerUserId === owner && (!filter.accountEmail || action.accountEmail === filter.accountEmail) && (!filter.threadId || action.threadId === filter.threadId)
      && (!filter.fromAddress || action.fromAddress === filter.fromAddress) && (!filter.fromDomain || action.fromDomain === filter.fromDomain)
      && (!filter.actions?.length || filter.actions.includes(action.action)) && (!filter.actors?.length || filter.actors.includes(action.actor)) && (!filter.sources?.length || filter.sources.includes(action.source))
      && (!filter.since || action.occurredAt > filter.since))
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt) || right.id.localeCompare(left.id)).slice(0, filter.limit).map((action) => ({ ...action, labelIds: [...action.labelIds] }));
  }
  async deleteActions(owner: string, ids: string[]) {
    const before = this.actions.length;
    this.actions = this.actions.filter((action) => action.ownerUserId !== owner || !ids.includes(action.id));
    return before - this.actions.length;
  }
  async pruneActions(before: string) {
    const count = this.actions.length;
    this.actions = this.actions.filter((action) => action.occurredAt >= before);
    return count - this.actions.length;
  }
  async dispose() {}
}

const memoryColumns = `id, owner_user_id AS "ownerUserId", kind, key, text, contact_email AS "contactEmail", domain, account_email AS "accountEmail", tags, source, confidence, uses, pinned,
  last_used_at AS "lastUsedAt", created_at AS "createdAt", updated_at AS "updatedAt"`;
const eventColumns = `id, owner_user_id AS "ownerUserId", pane_id AS "paneId", run_id AS "runId", account_email AS "accountEmail", thread_id AS "threadId", message_id AS "messageId", type, status, message, payload, created_at AS "createdAt"`;
const runColumns = `id, owner_user_id AS "ownerUserId", pane_id AS "paneId", status, counters, current_event_id AS "currentEventId", kickoff_sent_at AS "kickoffSentAt", started_at AS "startedAt",
  paused_at AS "pausedAt", stopped_at AS "stoppedAt", last_activity_at AS "lastActivityAt", created_at AS "createdAt", updated_at AS "updatedAt"`;
const iso = (value: unknown): string | null => value === null || value === undefined ? null : value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
const memoryRow = (row: Record<string, unknown>): MailCopilotMemory => ({ ...(row as unknown as MailCopilotMemory), tags: Array.isArray(row.tags) ? row.tags as string[] : [], confidence: Number(row.confidence), uses: Number(row.uses),
  lastUsedAt: iso(row.lastUsedAt), createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)! });
const eventRow = (row: Record<string, unknown>): MailCopilotEvent => ({ ...(row as unknown as MailCopilotEvent), payload: row.payload && typeof row.payload === "object" ? row.payload as Record<string, unknown> : {}, createdAt: iso(row.createdAt)! });
const runRow = (row: Record<string, unknown>): MailCopilotRun => ({ ...(row as unknown as MailCopilotRun), counters: { ...emptyCounters, ...(row.counters && typeof row.counters === "object" ? row.counters as Record<string, number> : {}) },
  kickoffSentAt: iso(row.kickoffSentAt), startedAt: iso(row.startedAt)!, pausedAt: iso(row.pausedAt), stoppedAt: iso(row.stoppedAt), lastActivityAt: iso(row.lastActivityAt)!, createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)! });
/** `websearch_to_tsquery` accepts free operator text safely; an empty query matches nothing. */
function searchText(query: string | null | undefined): string | null {
  const text = (query ?? "").replace(/[^\p{L}\p{N}\s'"@.-]+/gu, " ").trim();
  return text.length > 0 ? text.slice(0, 500) : null;
}

export class PostgresMailCopilotRepository implements MailCopilotRepository {
  constructor(private pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresMailCopilotRepository(createSpacePgPool(url, { max: 2 })); }
  async listMemory(owner: string, query: MailCopilotMemoryQuery) {
    const text = searchText(query.query);
    const rows = (await this.pool.query<Record<string, unknown>>(`SELECT ${memoryColumns}, CASE WHEN $2::text IS NULL THEN 0 ELSE ts_rank(search, websearch_to_tsquery('simple', $2)) END AS rank
      FROM mail_copilot_memory WHERE owner_user_id=$1 AND ($3::text[] IS NULL OR kind = ANY($3::text[]))
        AND ($4::text IS NULL OR contact_email IS NULL OR lower(contact_email)=$4) AND ($5::text IS NULL OR domain IS NULL OR domain=$5) AND (NOT $6::boolean OR pinned)
        AND ($2::text IS NULL OR search @@ websearch_to_tsquery('simple', $2))
      ORDER BY pinned DESC, rank DESC, (contact_email IS NOT NULL) DESC, uses DESC, updated_at DESC LIMIT $7`,
      [owner, text, query.kinds?.length ? query.kinds : null, query.contactEmail ?? null, query.domain ?? null, query.pinnedOnly === true, query.limit])).rows;
    return rows.map(({ rank: _rank, ...row }) => memoryRow(row));
  }
  async getMemory(owner: string, id: string) {
    const row = (await this.pool.query<Record<string, unknown>>(`SELECT ${memoryColumns} FROM mail_copilot_memory WHERE owner_user_id=$1 AND id=$2`, [owner, id])).rows[0];
    return row ? memoryRow(row) : null;
  }
  async upsertMemory(input: MailMemoryCreate) {
    const row = (await this.pool.query<Record<string, unknown>>(`INSERT INTO mail_copilot_memory(id, owner_user_id, kind, key, text, contact_email, domain, account_email, tags, source, confidence, pinned)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::text[],$10,$11,$12)
      ON CONFLICT (owner_user_id, kind, key, scope) WHERE key IS NOT NULL DO UPDATE SET text = EXCLUDED.text,
        tags = CASE WHEN cardinality(EXCLUDED.tags) > 0 THEN EXCLUDED.tags ELSE mail_copilot_memory.tags END, source = EXCLUDED.source, confidence = EXCLUDED.confidence,
        pinned = mail_copilot_memory.pinned OR EXCLUDED.pinned, updated_at = now()
      RETURNING ${memoryColumns}`,
      [newMailMemoryId(), input.ownerUserId, input.kind, input.key, input.text, input.contactEmail, input.domain, input.accountEmail, input.tags, input.source, input.confidence, input.pinned])).rows[0]!;
    return memoryRow(row);
  }
  async updateMemory(owner: string, id: string, patch: MailMemoryPatch) {
    const has = (key: keyof MailMemoryPatch) => Object.hasOwn(patch, key) && patch[key] !== undefined;
    const row = (await this.pool.query<Record<string, unknown>>(`UPDATE mail_copilot_memory SET kind = CASE WHEN $3 THEN $4 ELSE kind END, key = CASE WHEN $5 THEN $6 ELSE key END,
        text = CASE WHEN $7 THEN $8 ELSE text END, tags = CASE WHEN $9 THEN $10::text[] ELSE tags END, confidence = CASE WHEN $11 THEN $12 ELSE confidence END,
        pinned = CASE WHEN $13 THEN $14 ELSE pinned END, updated_at = now() WHERE owner_user_id=$1 AND id=$2 RETURNING ${memoryColumns}`,
      [owner, id, has("kind"), patch.kind ?? null, has("key"), patch.key ?? null, has("text"), patch.text ?? null, has("tags"), patch.tags ?? null, has("confidence"), patch.confidence ?? null, has("pinned"), patch.pinned ?? null])).rows[0];
    return row ? memoryRow(row) : null;
  }
  async deleteMemory(owner: string, id: string) {
    return ((await this.pool.query("DELETE FROM mail_copilot_memory WHERE owner_user_id=$1 AND id=$2", [owner, id])) as { rowCount?: number | null }).rowCount! > 0;
  }
  async touchMemories(owner: string, ids: string[]) {
    if (ids.length) await this.pool.query("UPDATE mail_copilot_memory SET uses = uses + 1, last_used_at = now() WHERE owner_user_id=$1 AND id = ANY($2::text[])", [owner, ids]);
  }
  async createEvent(input: MailEventCreate) {
    const row = (await this.pool.query<Record<string, unknown>>(`INSERT INTO mail_copilot_events(id, owner_user_id, pane_id, run_id, account_email, thread_id, message_id, type, status, message, payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) ON CONFLICT DO NOTHING RETURNING ${eventColumns}`,
      [newMailEventId(), input.ownerUserId, input.paneId, input.runId, input.accountEmail, input.threadId, input.messageId, input.type, input.status, input.message, JSON.stringify(input.payload ?? {})])).rows[0];
    if (row) return eventRow(row);
    // A MAIL_RECEIVED row for the same message already exists: return it.
    const existing = (await this.pool.query<Record<string, unknown>>(`SELECT ${eventColumns} FROM mail_copilot_events WHERE owner_user_id=$1 AND account_email=$2 AND message_id=$3 AND type='MAIL_RECEIVED'`,
      [input.ownerUserId, input.accountEmail, input.messageId])).rows[0];
    return eventRow(existing!);
  }
  async listEvents(owner: string, filter: MailEventFilter) {
    const rows = (await this.pool.query<Record<string, unknown>>(`SELECT ${eventColumns} FROM mail_copilot_events WHERE owner_user_id=$1
        AND ($2::text IS NULL OR pane_id=$2) AND ($3::text IS NULL OR thread_id=$3) AND ($4::text IS NULL OR account_email=$4)
        AND ($5::text[] IS NULL OR type = ANY($5::text[])) AND ($6::text[] IS NULL OR status = ANY($6::text[])) AND ($7::timestamptz IS NULL OR date_trunc('milliseconds', created_at) > $7)
      ORDER BY created_at DESC, id DESC LIMIT $8`,
      [owner, filter.paneId ?? null, filter.threadId ?? null, filter.accountEmail ?? null, filter.types?.length ? filter.types : null, filter.status?.length ? filter.status : null, filter.since ?? null, filter.limit])).rows;
    return rows.map(eventRow);
  }
  async getEvent(owner: string, id: string) {
    const row = (await this.pool.query<Record<string, unknown>>(`SELECT ${eventColumns} FROM mail_copilot_events WHERE owner_user_id=$1 AND id=$2`, [owner, id])).rows[0];
    return row ? eventRow(row) : null;
  }
  async takeNextItem(owner: string, paneId: string, staleMs: number) {
    const row = (await this.pool.query<Record<string, unknown>>(`UPDATE mail_copilot_events SET status='TAKEN', taken_by_pane_id=$2, taken_at=now(),
        payload = payload || jsonb_build_object('takenAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'takenByPaneId', $2::text)
      WHERE id = (SELECT id FROM mail_copilot_events WHERE owner_user_id=$1 AND (status='PENDING' OR (status='TAKEN' AND taken_at < now() - ($3::int * interval '1 millisecond')))
        ORDER BY (type = 'FIX_REQUESTED') DESC, created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING ${eventColumns}`, [owner, paneId, staleMs])).rows[0];
    return row ? eventRow(row) : null;
  }
  async countPendingItems(owner: string) {
    const row = (await this.pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM mail_copilot_events WHERE owner_user_id=$1 AND status='PENDING'`, [owner])).rows[0];
    return Number.parseInt(row?.count ?? "0", 10);
  }
  async setItemStatus(owner: string, id: string, status: "PENDING" | "TAKEN" | "DONE") {
    const row = (await this.pool.query<Record<string, unknown>>(`UPDATE mail_copilot_events SET status=$3 WHERE owner_user_id=$1 AND id=$2 RETURNING ${eventColumns}`, [owner, id, status])).rows[0];
    return row ? eventRow(row) : null;
  }
  async getActiveRun(paneId: string) {
    const row = (await this.pool.query<Record<string, unknown>>(`SELECT ${runColumns} FROM mail_copilot_runs WHERE pane_id=$1 AND status IN ('RUNNING','PAUSED') ORDER BY created_at DESC LIMIT 1`, [paneId])).rows[0];
    return row ? runRow(row) : null;
  }
  async createRun(input: { ownerUserId: string; paneId: string; status: "RUNNING" | "PAUSED" }) {
    const row = (await this.pool.query<Record<string, unknown>>(`INSERT INTO mail_copilot_runs(id, owner_user_id, pane_id, status, counters) VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING ${runColumns}`,
      [newMailRunId(), input.ownerUserId, input.paneId, input.status, JSON.stringify(emptyCounters)])).rows[0]!;
    return runRow(row);
  }
  async updateRun(owner: string, id: string, patch: MailRunPatch) {
    const has = (key: keyof MailRunPatch) => Object.hasOwn(patch, key) && patch[key] !== undefined;
    const row = (await this.pool.query<Record<string, unknown>>(`UPDATE mail_copilot_runs SET status = CASE WHEN $3 THEN $4 ELSE status END, counters = CASE WHEN $5 THEN $6::jsonb ELSE counters END,
        current_event_id = CASE WHEN $7 THEN $8 ELSE current_event_id END, kickoff_sent_at = CASE WHEN $9 THEN $10 ELSE kickoff_sent_at END, paused_at = CASE WHEN $11 THEN $12 ELSE paused_at END,
        stopped_at = CASE WHEN $13 THEN $14 ELSE stopped_at END, last_activity_at = CASE WHEN $15 THEN $16 ELSE last_activity_at END, updated_at = now()
      WHERE owner_user_id=$1 AND id=$2 RETURNING ${runColumns}`,
      [owner, id, has("status"), patch.status ?? null, has("counters"), JSON.stringify(patch.counters ?? {}), has("currentEventId"), patch.currentEventId ?? null, has("kickoffSentAt"), patch.kickoffSentAt ?? null,
        has("pausedAt"), patch.pausedAt ?? null, has("stoppedAt"), patch.stoppedAt ?? null, has("lastActivityAt"), patch.lastActivityAt ?? null])).rows[0];
    return row ? runRow(row) : null;
  }
  async listRules(owner: string, filter: { status?: MailRule["status"][]; accountEmail?: string | null } = {}) {
    const rows = await this.pool.query<Record<string, unknown>>(`SELECT ${ruleColumns} FROM mail_copilot_rules WHERE owner_user_id=$1 AND ($2::text[] IS NULL OR status = ANY($2))
      AND ($3::text IS NULL OR account_email IS NULL OR account_email = $3) ORDER BY created_at DESC LIMIT 500`, [owner, filter.status?.length ? filter.status : null, filter.accountEmail ?? null]);
    return rows.rows.map(ruleRow);
  }
  async getRule(owner: string, id: string) {
    const row = (await this.pool.query<Record<string, unknown>>(`SELECT ${ruleColumns} FROM mail_copilot_rules WHERE owner_user_id=$1 AND id=$2`, [owner, id])).rows[0];
    return row ? ruleRow(row) : null;
  }
  async createRule(input: MailRuleCreate) {
    const row = (await this.pool.query<Record<string, unknown>>(`INSERT INTO mail_copilot_rules(id, owner_user_id, account_email, name, condition, action, status, confidence, evidence, proposed_by, decided_at)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9::jsonb,$10, CASE WHEN $7 = 'APPROVED' THEN now() ELSE NULL END) RETURNING ${ruleColumns}`,
      [newMailRuleId(), input.ownerUserId, input.accountEmail, input.name, JSON.stringify(input.condition), JSON.stringify(input.action), input.status, input.confidence, JSON.stringify(input.evidence), input.proposedBy])).rows[0]!;
    return ruleRow(row);
  }
  async updateRule(owner: string, id: string, patch: MailRulePatch) {
    const has = (key: keyof MailRulePatch) => Object.hasOwn(patch, key) && patch[key] !== undefined;
    const row = (await this.pool.query<Record<string, unknown>>(`UPDATE mail_copilot_rules SET status = CASE WHEN $3 THEN $4 ELSE status END, decided_at = CASE WHEN $5 THEN $6 ELSE decided_at END,
        applied_count = CASE WHEN $7 THEN $8 ELSE applied_count END, last_applied_at = CASE WHEN $9 THEN $10 ELSE last_applied_at END, updated_at = now()
      WHERE owner_user_id=$1 AND id=$2 RETURNING ${ruleColumns}`,
      [owner, id, has("status"), patch.status ?? null, has("decidedAt"), patch.decidedAt ?? null, has("appliedCount"), patch.appliedCount ?? 0, has("lastAppliedAt"), patch.lastAppliedAt ?? null])).rows[0];
    return row ? ruleRow(row) : null;
  }
  async getSyncState(owner: string, accountEmail: string) {
    const row = (await this.pool.query<Record<string, unknown>>(`SELECT ${syncColumns} FROM mail_copilot_sync WHERE owner_user_id=$1 AND account_email=$2`, [owner, accountEmail])).rows[0];
    return row ? syncRow(row) : null;
  }
  async setSyncState(owner: string, accountEmail: string, patch: MailSyncPatch) {
    const has = (key: keyof MailSyncPatch) => Object.hasOwn(patch, key) && patch[key] !== undefined;
    const row = (await this.pool.query<Record<string, unknown>>(`INSERT INTO mail_copilot_sync(owner_user_id, account_email, history_id, last_synced_at, last_error, consecutive_failures, backfill_page_token, backfill_done_at)
      VALUES ($1,$2,$4,$6,$8,COALESCE($10, 0),$12,$14)
      ON CONFLICT (owner_user_id, account_email) DO UPDATE SET history_id = CASE WHEN $3 THEN $4 ELSE mail_copilot_sync.history_id END, last_synced_at = CASE WHEN $5 THEN $6 ELSE mail_copilot_sync.last_synced_at END,
        last_error = CASE WHEN $7 THEN $8 ELSE mail_copilot_sync.last_error END, consecutive_failures = CASE WHEN $9 THEN $10 ELSE mail_copilot_sync.consecutive_failures END,
        backfill_page_token = CASE WHEN $11 THEN $12 ELSE mail_copilot_sync.backfill_page_token END, backfill_done_at = CASE WHEN $13 THEN $14::timestamptz ELSE mail_copilot_sync.backfill_done_at END, updated_at = now()
      RETURNING ${syncColumns}`,
      [owner, accountEmail, has("historyId"), patch.historyId ?? null, has("lastSyncedAt"), patch.lastSyncedAt ?? null, has("lastError"), patch.lastError ?? null, has("consecutiveFailures"), patch.consecutiveFailures ?? null,
        has("backfillPageToken"), patch.backfillPageToken ?? null, has("backfillDoneAt"), patch.backfillDoneAt ?? null])).rows[0]!;
    return syncRow(row);
  }
  async recordAction(input: MailActionCreate) {
    const row = (await this.pool.query<Record<string, unknown>>(`INSERT INTO mail_copilot_actions(id, owner_user_id, account_email, thread_id, message_id, action, label_ids, from_address, from_domain, subject, subject_key, actor, source, rule_id, occurred_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7::text[],$8,$9,$10,$11,$12,$13,$14, COALESCE($15::timestamptz, now())) RETURNING ${actionColumns}`,
      [newMailActionId(), input.ownerUserId, input.accountEmail, input.threadId, input.messageId, input.action, input.labelIds, input.fromAddress, input.fromDomain, input.subject, input.subjectKey,
        input.actor, input.source, input.ruleId, input.occurredAt ?? null])).rows[0]!;
    return actionRow(row);
  }
  async listActions(owner: string, filter: MailActionFilter) {
    const rows = await this.pool.query<Record<string, unknown>>(`SELECT ${actionColumns} FROM mail_copilot_actions WHERE owner_user_id=$1
        AND ($2::text IS NULL OR account_email=$2) AND ($3::text IS NULL OR thread_id=$3) AND ($4::text IS NULL OR from_address=$4) AND ($5::text IS NULL OR from_domain=$5)
        AND ($6::text[] IS NULL OR action = ANY($6::text[])) AND ($7::text[] IS NULL OR actor = ANY($7::text[])) AND ($8::timestamptz IS NULL OR occurred_at > $8)
        AND ($10::text[] IS NULL OR source = ANY($10::text[]))
      ORDER BY occurred_at DESC, id DESC LIMIT $9`,
      [owner, filter.accountEmail ?? null, filter.threadId ?? null, filter.fromAddress ?? null, filter.fromDomain ?? null, filter.actions?.length ? filter.actions : null,
        filter.actors?.length ? filter.actors : null, filter.since ?? null, filter.limit, filter.sources?.length ? filter.sources : null]);
    return rows.rows.map(actionRow);
  }
  async deleteActions(owner: string, ids: string[]) {
    if (!ids.length) return 0;
    return ((await this.pool.query("DELETE FROM mail_copilot_actions WHERE owner_user_id=$1 AND id = ANY($2::text[])", [owner, ids])) as { rowCount?: number | null }).rowCount ?? 0;
  }
  async pruneActions(before: string) {
    return ((await this.pool.query("DELETE FROM mail_copilot_actions WHERE occurred_at < $1", [before])) as { rowCount?: number | null }).rowCount ?? 0;
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}

const actionColumns = `id, owner_user_id AS "ownerUserId", account_email AS "accountEmail", thread_id AS "threadId", message_id AS "messageId", action, label_ids AS "labelIds",
  from_address AS "fromAddress", from_domain AS "fromDomain", subject, subject_key AS "subjectKey", actor, source, rule_id AS "ruleId", occurred_at AS "occurredAt"`;
function actionRow(row: Record<string, unknown>): MailActionRecord {
  return { ...(row as unknown as MailActionRecord), labelIds: Array.isArray(row.labelIds) ? row.labelIds as string[] : [], occurredAt: iso(row.occurredAt)! };
}

const ruleColumns = `id, owner_user_id AS "ownerUserId", account_email AS "accountEmail", name, condition, action, status, confidence, evidence, proposed_by AS "proposedBy", decided_at AS "decidedAt",
  applied_count AS "appliedCount", last_applied_at AS "lastAppliedAt", created_at AS "createdAt", updated_at AS "updatedAt"`;
const syncColumns = `owner_user_id AS "ownerUserId", account_email AS "accountEmail", history_id AS "historyId", last_synced_at AS "lastSyncedAt", last_error AS "lastError", consecutive_failures AS "consecutiveFailures",
  backfill_page_token AS "backfillPageToken", backfill_done_at AS "backfillDoneAt", updated_at AS "updatedAt"`;
function ruleRow(row: Record<string, unknown>): MailRule {
  return { ...(row as unknown as MailRule), confidence: Number(row.confidence), decidedAt: iso(row.decidedAt), lastAppliedAt: iso(row.lastAppliedAt), createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)! };
}
function syncRow(row: Record<string, unknown>): MailCopilotSyncState {
  return { ...(row as unknown as MailCopilotSyncState), lastSyncedAt: iso(row.lastSyncedAt), backfillDoneAt: iso(row.backfillDoneAt), updatedAt: iso(row.updatedAt)! };
}
