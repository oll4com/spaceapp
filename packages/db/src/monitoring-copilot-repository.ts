import { randomBytes } from "node:crypto";
import type { MonitoringAction, MonitoringActionStatus, MonitoringAlert, MonitoringEvent, MonitoringEventStatus, MonitoringEventType, MonitoringMemory } from "@space/contracts";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

// Monitoring Copilot storage (migrations 0254, 0255): the collector's alerts as the watcher last saw them (one row per firing episode;
// resolved rows are history, pruned 30 days after they ended), the self-healing action log (the gate's audit, never deleted), the
// copilot's own memory and one feed per pane. Postgres live, in-memory for tests.

const newId = (prefix: string) => `${prefix}:${randomBytes(9).toString("base64url")}`;

/** What the watcher knows about one firing alert. */
export type MonitoringAlertRecord = Pick<MonitoringAlert, "ownerUserId" | "fingerprint" | "alertname" | "severity" | "source" | "instance" | "job" | "labels"
  | "summary" | "description" | "startsAt">;
export interface MonitoringAlertFilter { state?: MonitoringAlert["state"]; severity?: MonitoringAlert["severity"][]; limit: number }
export type MonitoringMemoryCreateRecord = Omit<MonitoringMemory, "id" | "uses" | "lastUsedAt" | "createdAt" | "updatedAt">;
export type MonitoringMemoryPatch = Partial<Pick<MonitoringMemory, "text" | "tags" | "pinned">>;
export interface MonitoringMemoryQuery { query?: string | null; kinds?: MonitoringMemory["kind"][]; target?: string | null; limit: number }
export type MonitoringEventCreateRecord = Omit<MonitoringEvent, "id" | "createdAt" | "updatedAt">;
export interface MonitoringEventFilter { types?: MonitoringEventType[]; status?: MonitoringEventStatus[]; limit: number }
export type MonitoringActionCreateRecord = Omit<MonitoringAction, "id" | "startedAt" | "finishedAt" | "verification" | "reviewEventId"> & { reviewEventId?: string | null };
export type MonitoringActionPatch = Partial<Pick<MonitoringAction, "status" | "verification" | "reviewEventId" | "finishedAt">>;
export interface MonitoringActionFilter { target?: string; status?: MonitoringActionStatus[]; since?: string; limit: number }

export interface MonitoringCopilotRepository {
  /** Refreshes the firing row of this fingerprint, or starts a new episode; `created` says which. */
  upsertFiring(input: MonitoringAlertRecord): Promise<{ alert: MonitoringAlert; created: boolean }>;
  /** Firing rows of the owner whose fingerprint is not in `keep` become RESOLVED; returns them. */
  resolveMissing(owner: string, keep: Set<string>): Promise<MonitoringAlert[]>;
  getAlert(owner: string, id: string): Promise<MonitoringAlert | null>;
  /** Firing first (critical, warning, info), then the most recently seen. */
  listAlerts(owner: string, filter: MonitoringAlertFilter): Promise<MonitoringAlert[]>;
  /** History: resolved alerts that ended before `before`. Returns how many went. */
  pruneResolved(before: string): Promise<number>;
  createAction(input: MonitoringActionCreateRecord): Promise<MonitoringAction>;
  getAction(owner: string, id: string): Promise<MonitoringAction | null>;
  /** Changes the action only while it is in one of `fromStatus`; null otherwise. */
  updateAction(owner: string, id: string, patch: MonitoringActionPatch, fromStatus: MonitoringActionStatus[]): Promise<MonitoringAction | null>;
  /** Newest first. */
  listActions(owner: string, filter: MonitoringActionFilter): Promise<MonitoringAction[]>;
  listMemory(owner: string, query: MonitoringMemoryQuery): Promise<MonitoringMemory[]>;
  /** Inserts, or replaces the memory with the same kind, key and target. */
  upsertMemory(input: MonitoringMemoryCreateRecord): Promise<MonitoringMemory>;
  updateMemory(owner: string, id: string, patch: MonitoringMemoryPatch): Promise<MonitoringMemory | null>;
  deleteMemory(owner: string, id: string): Promise<boolean>;
  touchMemories(owner: string, ids: string[]): Promise<void>;
  createEvent(input: MonitoringEventCreateRecord): Promise<MonitoringEvent>;
  getEvent(owner: string, id: string): Promise<MonitoringEvent | null>;
  /** Newest first. */
  listEvents(owner: string, paneId: string, filter: MonitoringEventFilter): Promise<MonitoringEvent[]>;
  /** Changes status and merges `payload` only while the row is in one of `fromStatus`; null otherwise. */
  updateEvent(owner: string, id: string, patch: { status: MonitoringEventStatus; payload?: Record<string, unknown> }, fromStatus: MonitoringEventStatus[]): Promise<MonitoringEvent | null>;
  /** The oldest PENDING brief of the pane becomes TAKEN. */
  takeNextBrief(owner: string, paneId: string): Promise<MonitoringEvent | null>;
  /** The guardian cursor the watcher resumes from: the newest GUARDIAN event's `payload.lokiNs` of the owner, or null. */
  latestGuardianCursor(owner: string): Promise<string | null>;
  dispose(): Promise<void>;
}

const copy = <T>(row: T): T => structuredClone(row);
const byNewest = <T extends { createdAt: string; id: string }>(left: T, right: T) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
const SEVERITY_RANK: Record<MonitoringAlert["severity"], number> = { CRITICAL: 0, WARNING: 1, INFO: 2 };
const alertOrder = (left: MonitoringAlert, right: MonitoringAlert) => Number(left.state === "RESOLVED") - Number(right.state === "RESOLVED")
  || SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] || right.lastSeenAt.localeCompare(left.lastSeenAt) || left.id.localeCompare(right.id);
function tokens(text: string): string[] { return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 1); }

export class InMemoryMonitoringCopilotRepository implements MonitoringCopilotRepository {
  private alerts = new Map<string, MonitoringAlert & { episode: number }>();
  private memories = new Map<string, MonitoringMemory>();
  private events = new Map<string, MonitoringEvent>();
  private actions = new Map<string, MonitoringAction>();
  constructor(private now: () => string = () => new Date().toISOString()) {}
  private strip(row: MonitoringAlert & { episode: number }): MonitoringAlert { const { episode: _episode, ...alert } = row; return copy(alert); }

  async upsertFiring(input: MonitoringAlertRecord) {
    const at = this.now();
    const rows = [...this.alerts.values()].filter((row) => row.ownerUserId === input.ownerUserId && row.fingerprint === input.fingerprint);
    const firing = rows.find((row) => row.state === "FIRING");
    if (firing) {
      const next = { ...firing, ...copy(input), startsAt: firing.startsAt, lastSeenAt: at, updatedAt: at };
      this.alerts.set(firing.id, next);
      return { alert: this.strip(next), created: false };
    }
    const row = { ...copy(input), id: newId("monalert"), state: "FIRING" as const, endsAt: null, lastSeenAt: at, createdAt: at, updatedAt: at,
      episode: Math.max(0, ...rows.map((item) => item.episode)) + 1 };
    this.alerts.set(row.id, row);
    return { alert: this.strip(row), created: true };
  }
  async resolveMissing(owner: string, keep: Set<string>) {
    const resolved: MonitoringAlert[] = [];
    for (const row of this.alerts.values()) {
      if (row.ownerUserId !== owner || row.state !== "FIRING" || keep.has(row.fingerprint)) continue;
      const at = this.now();
      const next = { ...row, state: "RESOLVED" as const, endsAt: at, updatedAt: at };
      this.alerts.set(row.id, next);
      resolved.push(this.strip(next));
    }
    return resolved;
  }
  async getAlert(owner: string, id: string) { const row = this.alerts.get(id); return row && row.ownerUserId === owner ? this.strip(row) : null; }
  async listAlerts(owner: string, filter: MonitoringAlertFilter) {
    return [...this.alerts.values()].map((row) => this.strip(row)).filter((row) => row.ownerUserId === owner && (!filter.state || row.state === filter.state)
      && (!filter.severity?.length || filter.severity.includes(row.severity))).sort(alertOrder).slice(0, filter.limit);
  }
  async pruneResolved(before: string) {
    let count = 0;
    for (const [id, row] of this.alerts) if (row.state === "RESOLVED" && row.endsAt && row.endsAt < before) { this.alerts.delete(id); count += 1; }
    return count;
  }

  async createAction(input: MonitoringActionCreateRecord) {
    const row: MonitoringAction = { ...copy(input), id: newId("monact"), verification: null, reviewEventId: input.reviewEventId ?? null, startedAt: this.now(), finishedAt: null };
    this.actions.set(row.id, row);
    return copy(row);
  }
  async getAction(owner: string, id: string) { const row = this.actions.get(id); return row && row.ownerUserId === owner ? copy(row) : null; }
  async updateAction(owner: string, id: string, patch: MonitoringActionPatch, fromStatus: MonitoringActionStatus[]) {
    const row = this.actions.get(id);
    if (!row || row.ownerUserId !== owner || !fromStatus.includes(row.status)) return null;
    const next = { ...row, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) } as MonitoringAction;
    this.actions.set(id, next);
    return copy(next);
  }
  async listActions(owner: string, filter: MonitoringActionFilter) {
    return [...this.actions.values()].filter((row) => row.ownerUserId === owner && (!filter.target || row.target === filter.target)
      && (!filter.status?.length || filter.status.includes(row.status)) && (!filter.since || row.startedAt >= filter.since))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id)).slice(0, filter.limit).map(copy);
  }

  async listMemory(owner: string, query: MonitoringMemoryQuery) {
    const words = tokens(query.query ?? "");
    const score = (row: MonitoringMemory) => {
      if (!words.length) return 0;
      const haystack = new Set(tokens(`${row.key ?? ""} ${row.text} ${row.tags.join(" ")}`));
      return words.filter((word) => haystack.has(word)).length / words.length;
    };
    return [...this.memories.values()].filter((row) => row.ownerUserId === owner && (!query.kinds?.length || query.kinds.includes(row.kind))
      && (!query.target || !row.target || row.target === query.target) && (!words.length || score(row) > 0))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || score(b) - score(a) || b.uses - a.uses || b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, query.limit).map(copy);
  }
  async upsertMemory(input: MonitoringMemoryCreateRecord) {
    const at = this.now();
    const existing = input.key ? [...this.memories.values()].find((row) => row.ownerUserId === input.ownerUserId && row.kind === input.kind && row.key === input.key && row.target === input.target) : undefined;
    if (existing) {
      const next = { ...existing, text: input.text, tags: input.tags.length ? input.tags : existing.tags, source: input.source, pinned: existing.pinned || input.pinned, updatedAt: at };
      this.memories.set(existing.id, next);
      return copy(next);
    }
    const row: MonitoringMemory = { ...copy(input), id: newId("monmem"), uses: 0, lastUsedAt: null, createdAt: at, updatedAt: at };
    this.memories.set(row.id, row);
    return copy(row);
  }
  async updateMemory(owner: string, id: string, patch: MonitoringMemoryPatch) {
    const row = this.memories.get(id);
    if (!row || row.ownerUserId !== owner) return null;
    const next = { ...row, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)), updatedAt: this.now() } as MonitoringMemory;
    this.memories.set(id, next);
    return copy(next);
  }
  async deleteMemory(owner: string, id: string) { return this.memories.get(id)?.ownerUserId === owner ? this.memories.delete(id) : false; }
  async touchMemories(owner: string, ids: string[]) {
    for (const id of ids) { const row = this.memories.get(id); if (row?.ownerUserId === owner) this.memories.set(id, { ...row, uses: row.uses + 1, lastUsedAt: this.now() }); }
  }

  async createEvent(input: MonitoringEventCreateRecord) {
    const at = this.now();
    const row: MonitoringEvent = { ...copy(input), id: newId("monevt"), createdAt: at, updatedAt: at };
    this.events.set(row.id, row);
    return copy(row);
  }
  async getEvent(owner: string, id: string) { const row = this.events.get(id); return row && row.ownerUserId === owner ? copy(row) : null; }
  async listEvents(owner: string, paneId: string, filter: MonitoringEventFilter) {
    return [...this.events.values()].filter((row) => row.ownerUserId === owner && row.paneId === paneId && (!filter.types?.length || filter.types.includes(row.type))
      && (!filter.status?.length || (row.status !== null && filter.status.includes(row.status)))).sort(byNewest).slice(0, filter.limit).map(copy);
  }
  async updateEvent(owner: string, id: string, patch: { status: MonitoringEventStatus; payload?: Record<string, unknown> }, fromStatus: MonitoringEventStatus[]) {
    const row = this.events.get(id);
    if (!row || row.ownerUserId !== owner || row.status === null || !fromStatus.includes(row.status)) return null;
    const next = { ...row, status: patch.status, payload: { ...row.payload, ...copy(patch.payload ?? {}) }, updatedAt: this.now() };
    this.events.set(id, next);
    return copy(next);
  }
  async takeNextBrief(owner: string, paneId: string) {
    const next = [...this.events.values()].filter((row) => row.ownerUserId === owner && row.paneId === paneId && row.type === "BRIEF" && row.status === "PENDING")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))[0];
    return next ? this.updateEvent(owner, next.id, { status: "TAKEN" }, ["PENDING"]) : null;
  }
  async latestGuardianCursor(owner: string) {
    const latest = [...this.events.values()].filter((row) => row.ownerUserId === owner && row.type === "GUARDIAN").sort(byNewest)[0];
    return typeof latest?.payload.lokiNs === "string" ? latest.payload.lokiNs : null;
  }
  async dispose() {}
}

// ---- Postgres ------------------------------------------------------------------------------------
const iso = (value: unknown) => value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
const isoOrNull = (value: unknown) => value === null || value === undefined ? null : iso(value);
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function searchText(query: string | null | undefined): string | null {
  const text = (query ?? "").replace(/[^\p{L}\p{N}\s'"@.-]+/gu, " ").trim();
  return text.length > 0 ? text.slice(0, 500) : null;
}

const ALERT_COLUMNS = `id, owner_user_id AS "ownerUserId", fingerprint, alertname, severity, source, instance, job, labels, summary, description, state,
  starts_at AS "startsAt", ends_at AS "endsAt", last_seen_at AS "lastSeenAt", created_at AS "createdAt", updated_at AS "updatedAt"`;
const ACTION_COLUMNS = `id, owner_user_id AS "ownerUserId", pane_id AS "paneId", target, alert_ids AS "alertIds", kind, summary, commands, backup, rollback,
  gate, reason, status, verification, review_event_id AS "reviewEventId", started_at AS "startedAt", finished_at AS "finishedAt"`;
const MEMORY_COLUMNS = `id, owner_user_id AS "ownerUserId", kind, key, text, target, tags, source, pinned, uses, last_used_at AS "lastUsedAt",
  created_at AS "createdAt", updated_at AS "updatedAt"`;
const EVENT_COLUMNS = `id, owner_user_id AS "ownerUserId", pane_id AS "paneId", type, status, message, payload, created_at AS "createdAt", updated_at AS "updatedAt"`;
const alertRow = (raw: Record<string, unknown>): MonitoringAlert => ({ ...(raw as unknown as MonitoringAlert), labels: object(raw.labels) as Record<string, string>,
  startsAt: iso(raw.startsAt), endsAt: isoOrNull(raw.endsAt), lastSeenAt: iso(raw.lastSeenAt), createdAt: iso(raw.createdAt), updatedAt: iso(raw.updatedAt) });
const actionRow = (raw: Record<string, unknown>): MonitoringAction => ({ ...(raw as unknown as MonitoringAction), alertIds: (raw.alertIds as string[] | null) ?? [],
  startedAt: iso(raw.startedAt), finishedAt: isoOrNull(raw.finishedAt) });
const memoryRow = (raw: Record<string, unknown>): MonitoringMemory => ({ ...(raw as unknown as MonitoringMemory), tags: (raw.tags as string[] | null) ?? [], uses: Number(raw.uses),
  lastUsedAt: isoOrNull(raw.lastUsedAt), createdAt: iso(raw.createdAt), updatedAt: iso(raw.updatedAt) });
const eventRow = (raw: Record<string, unknown>): MonitoringEvent => ({ ...(raw as unknown as MonitoringEvent), status: (raw.status as MonitoringEventStatus | null) ?? null,
  payload: object(raw.payload), createdAt: iso(raw.createdAt), updatedAt: iso(raw.updatedAt) });
const SEVERITY_SQL = "CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END";

export class PostgresMonitoringCopilotRepository implements MonitoringCopilotRepository {
  constructor(private pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresMonitoringCopilotRepository(createSpacePgPool(url, { max: 2 })); }
  private async one<T>(sql: string, values: unknown[], map: (raw: Record<string, unknown>) => T): Promise<T | null> {
    const row = (await this.pool.query<Record<string, unknown>>(sql, values)).rows[0];
    return row ? map(row) : null;
  }
  private async many<T>(sql: string, values: unknown[], map: (raw: Record<string, unknown>) => T): Promise<T[]> {
    return (await this.pool.query<Record<string, unknown>>(sql, values)).rows.map(map);
  }

  async upsertFiring(input: MonitoringAlertRecord) {
    const values = [input.ownerUserId, input.fingerprint, input.alertname, input.severity, input.source, input.instance, input.job, JSON.stringify(input.labels),
      input.summary, input.description];
    const refreshed = await this.one(`UPDATE monitoring_copilot_alerts SET alertname=$3, severity=$4, source=$5, instance=$6, job=$7, labels=$8::jsonb, summary=$9,
        description=$10, last_seen_at=now(), updated_at=now()
      WHERE owner_user_id=$1 AND fingerprint=$2 AND state='FIRING' RETURNING ${ALERT_COLUMNS}`, values, alertRow);
    if (refreshed) return { alert: refreshed, created: false };
    const created = (await this.one(`INSERT INTO monitoring_copilot_alerts(id, owner_user_id, fingerprint, alertname, severity, source, instance, job, labels, summary,
        description, state, starts_at, episode)
      VALUES ($11,$1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,'FIRING',$12::timestamptz,
        coalesce((SELECT max(episode) FROM monitoring_copilot_alerts WHERE owner_user_id=$1 AND fingerprint=$2), 0) + 1)
      RETURNING ${ALERT_COLUMNS}`, [...values, newId("monalert"), input.startsAt], alertRow))!;
    return { alert: created, created: true };
  }
  resolveMissing(owner: string, keep: Set<string>) {
    return this.many(`UPDATE monitoring_copilot_alerts SET state='RESOLVED', ends_at=now(), updated_at=now()
      WHERE owner_user_id=$1 AND state='FIRING' AND NOT (fingerprint = ANY($2::text[])) RETURNING ${ALERT_COLUMNS}`, [owner, [...keep]], alertRow);
  }
  getAlert(owner: string, id: string) { return this.one(`SELECT ${ALERT_COLUMNS} FROM monitoring_copilot_alerts WHERE owner_user_id=$1 AND id=$2`, [owner, id], alertRow); }
  listAlerts(owner: string, filter: MonitoringAlertFilter) {
    return this.many(`SELECT ${ALERT_COLUMNS} FROM monitoring_copilot_alerts WHERE owner_user_id=$1 AND ($2::text IS NULL OR state=$2)
        AND ($3::text[] IS NULL OR severity = ANY($3::text[]))
      ORDER BY (state='RESOLVED'), ${SEVERITY_SQL}, last_seen_at DESC, id LIMIT $4`,
    [owner, filter.state ?? null, filter.severity?.length ? filter.severity : null, filter.limit], alertRow);
  }
  async pruneResolved(before: string) {
    return ((await this.pool.query("DELETE FROM monitoring_copilot_alerts WHERE state = 'RESOLVED' AND ends_at < $1", [before])) as { rowCount?: number | null }).rowCount ?? 0;
  }

  async createAction(input: MonitoringActionCreateRecord) {
    return (await this.one(`INSERT INTO monitoring_copilot_actions(id, owner_user_id, pane_id, target, alert_ids, kind, summary, commands, backup, rollback, gate, reason, status, review_event_id)
      VALUES ($1,$2,$3,$4,$5::text[],$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING ${ACTION_COLUMNS}`,
    [newId("monact"), input.ownerUserId, input.paneId, input.target, input.alertIds, input.kind, input.summary, input.commands, input.backup, input.rollback,
      input.gate, input.reason, input.status, input.reviewEventId ?? null], actionRow))!;
  }
  getAction(owner: string, id: string) { return this.one(`SELECT ${ACTION_COLUMNS} FROM monitoring_copilot_actions WHERE owner_user_id=$1 AND id=$2`, [owner, id], actionRow); }
  updateAction(owner: string, id: string, patch: MonitoringActionPatch, fromStatus: MonitoringActionStatus[]) {
    return this.one(`UPDATE monitoring_copilot_actions SET status=coalesce($3, status), verification=coalesce($4, verification),
        review_event_id=coalesce($5, review_event_id), finished_at=coalesce($6::timestamptz, finished_at)
      WHERE owner_user_id=$1 AND id=$2 AND status = ANY($7::text[]) RETURNING ${ACTION_COLUMNS}`,
    [owner, id, patch.status ?? null, patch.verification ?? null, patch.reviewEventId ?? null, patch.finishedAt ?? null, fromStatus], actionRow);
  }
  listActions(owner: string, filter: MonitoringActionFilter) {
    return this.many(`SELECT ${ACTION_COLUMNS} FROM monitoring_copilot_actions WHERE owner_user_id=$1 AND ($2::text IS NULL OR target=$2)
      AND ($3::text[] IS NULL OR status = ANY($3::text[])) AND ($4::timestamptz IS NULL OR started_at >= $4) ORDER BY started_at DESC, id DESC LIMIT $5`,
    [owner, filter.target ?? null, filter.status?.length ? filter.status : null, filter.since ?? null, filter.limit], actionRow);
  }

  listMemory(owner: string, query: MonitoringMemoryQuery) {
    const text = searchText(query.query);
    return this.many(`SELECT ${MEMORY_COLUMNS} FROM monitoring_copilot_memory WHERE owner_user_id=$1 AND ($3::text[] IS NULL OR kind = ANY($3::text[]))
        AND ($4::text IS NULL OR target IS NULL OR target=$4) AND ($2::text IS NULL OR search @@ websearch_to_tsquery('simple', $2))
      ORDER BY pinned DESC, CASE WHEN $2::text IS NULL THEN 0 ELSE ts_rank(search, websearch_to_tsquery('simple', $2)) END DESC, uses DESC, updated_at DESC LIMIT $5`,
    [owner, text, query.kinds?.length ? query.kinds : null, query.target ?? null, query.limit], memoryRow);
  }
  async upsertMemory(input: MonitoringMemoryCreateRecord) {
    return (await this.one(`INSERT INTO monitoring_copilot_memory(id, owner_user_id, kind, key, text, target, tags, source, pinned) VALUES ($1,$2,$3,$4,$5,$6,$7::text[],$8,$9)
      ON CONFLICT (owner_user_id, kind, key, scope) WHERE key IS NOT NULL DO UPDATE SET text = EXCLUDED.text,
        tags = CASE WHEN cardinality(EXCLUDED.tags) > 0 THEN EXCLUDED.tags ELSE monitoring_copilot_memory.tags END, source = EXCLUDED.source,
        pinned = monitoring_copilot_memory.pinned OR EXCLUDED.pinned, updated_at = now()
      RETURNING ${MEMORY_COLUMNS}`, [newId("monmem"), input.ownerUserId, input.kind, input.key, input.text, input.target, input.tags, input.source, input.pinned], memoryRow))!;
  }
  updateMemory(owner: string, id: string, patch: MonitoringMemoryPatch) {
    return this.one(`UPDATE monitoring_copilot_memory SET text=coalesce($3, text), tags=coalesce($4::text[], tags), pinned=coalesce($5, pinned), updated_at=now()
      WHERE owner_user_id=$1 AND id=$2 RETURNING ${MEMORY_COLUMNS}`, [owner, id, patch.text ?? null, patch.tags ?? null, patch.pinned ?? null], memoryRow);
  }
  async deleteMemory(owner: string, id: string) {
    return ((await this.pool.query("DELETE FROM monitoring_copilot_memory WHERE owner_user_id=$1 AND id=$2", [owner, id])) as { rowCount?: number | null }).rowCount! > 0;
  }
  async touchMemories(owner: string, ids: string[]) {
    if (ids.length) await this.pool.query("UPDATE monitoring_copilot_memory SET uses = uses + 1, last_used_at = now() WHERE owner_user_id=$1 AND id = ANY($2::text[])", [owner, ids]);
  }

  async createEvent(input: MonitoringEventCreateRecord) {
    return (await this.one(`INSERT INTO monitoring_copilot_events(id, owner_user_id, pane_id, type, status, message, payload) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING ${EVENT_COLUMNS}`,
      [newId("monevt"), input.ownerUserId, input.paneId, input.type, input.status, input.message, JSON.stringify(input.payload)], eventRow))!;
  }
  getEvent(owner: string, id: string) { return this.one(`SELECT ${EVENT_COLUMNS} FROM monitoring_copilot_events WHERE owner_user_id=$1 AND id=$2`, [owner, id], eventRow); }
  listEvents(owner: string, paneId: string, filter: MonitoringEventFilter) {
    return this.many(`SELECT ${EVENT_COLUMNS} FROM monitoring_copilot_events WHERE owner_user_id=$1 AND pane_id=$2
        AND ($3::text[] IS NULL OR type = ANY($3::text[])) AND ($4::text[] IS NULL OR status = ANY($4::text[])) ORDER BY created_at DESC, id DESC LIMIT $5`,
    [owner, paneId, filter.types?.length ? filter.types : null, filter.status?.length ? filter.status : null, filter.limit], eventRow);
  }
  updateEvent(owner: string, id: string, patch: { status: MonitoringEventStatus; payload?: Record<string, unknown> }, fromStatus: MonitoringEventStatus[]) {
    return this.one(`UPDATE monitoring_copilot_events SET status=$3, payload = payload || $4::jsonb, updated_at=now()
      WHERE owner_user_id=$1 AND id=$2 AND status = ANY($5::text[]) RETURNING ${EVENT_COLUMNS}`, [owner, id, patch.status, JSON.stringify(patch.payload ?? {}), fromStatus], eventRow);
  }
  takeNextBrief(owner: string, paneId: string) {
    return this.one(`UPDATE monitoring_copilot_events SET status='TAKEN', updated_at=now() WHERE id = (SELECT id FROM monitoring_copilot_events
      WHERE owner_user_id=$1 AND pane_id=$2 AND type='BRIEF' AND status='PENDING' ORDER BY created_at ASC, id ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING ${EVENT_COLUMNS}`, [owner, paneId], eventRow);
  }
  async latestGuardianCursor(owner: string) {
    const row = (await this.pool.query<{ cursor: string | null }>(`SELECT payload->>'lokiNs' AS cursor FROM monitoring_copilot_events
      WHERE owner_user_id=$1 AND type='GUARDIAN' ORDER BY created_at DESC LIMIT 1`, [owner])).rows[0];
    return row?.cursor ?? null;
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
