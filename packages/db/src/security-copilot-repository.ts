import { randomBytes } from "node:crypto";
import type {
  SecurityAction, SecurityActionStatus, SecurityEvent, SecurityEventStatus, SecurityEventType, SecurityFinding, SecurityFindingStatus, SecurityHost,
  SecurityInventory, SecurityMemory, SecurityPriority
} from "@space/contracts";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

// Security Copilot storage (migration 0246): the fleet's hosts with their latest inventory, findings, the action log (the gate's
// audit, never deleted), the copilot's own memory and one feed per pane. Postgres live, in-memory for tests.

const newId = (prefix: string) => `${prefix}:${randomBytes(9).toString("base64url")}`;
const OPEN: SecurityFindingStatus[] = ["NEW", "TRIAGING", "FIXING", "FAILED"];
const PRIORITY_RANK: Record<SecurityPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

export interface SecurityHostRecord {
  ownerUserId: string; alias: string; label: string; reach: SecurityHost["reach"]; osFamily: SecurityHost["osFamily"]; osVersion: string; kernel: string;
  status: SecurityHost["status"]; note: string | null;
}
export type SecurityFindingRecord = Pick<SecurityFinding, "ownerUserId" | "hostId" | "advisoryId" | "advisory" | "package" | "installedVersion" | "fixedVersion" | "priority">;
export interface SecurityFindingFilter { hostId?: string; status?: SecurityFindingStatus[]; limit: number }
export type SecurityActionCreateRecord = Omit<SecurityAction, "id" | "startedAt" | "finishedAt" | "verification" | "reviewEventId"> & { reviewEventId?: string | null };
export type SecurityActionPatch = Partial<Pick<SecurityAction, "status" | "verification" | "reviewEventId" | "finishedAt">>;
export type SecurityMemoryCreateRecord = Omit<SecurityMemory, "id" | "uses" | "lastUsedAt" | "createdAt" | "updatedAt">;
export type SecurityMemoryPatch = Partial<Pick<SecurityMemory, "text" | "tags" | "pinned">>;
export interface SecurityMemoryQuery { query?: string | null; kinds?: SecurityMemory["kind"][]; hostId?: string | null; limit: number }
export type SecurityEventCreateRecord = Omit<SecurityEvent, "id" | "createdAt" | "updatedAt">;
export interface SecurityEventFilter { types?: SecurityEventType[]; status?: SecurityEventStatus[]; limit: number }

export interface SecurityCopilotRepository {
  /** Inserts or updates the host with this alias; `inventory` replaces the stored one when given. */
  upsertHost(input: SecurityHostRecord, inventory?: SecurityInventory): Promise<SecurityHost>;
  getHost(owner: string, id: string): Promise<SecurityHost | null>;
  listHosts(owner: string): Promise<SecurityHost[]>;
  /** Every owner with a host, so the watch keeps matching while no Security pane is open. */
  listOwners(): Promise<string[]>;
  /**
   * Inserts the finding or refreshes it (last seen, advisory, fixed version, the higher priority). A FIXED finding seen again
   * reopens as NEW; MITIGATED, NOT_AFFECTED and ACCEPTED stay as the agent or operator decided.
   */
  upsertFinding(input: SecurityFindingRecord): Promise<{ finding: SecurityFinding; created: boolean; reopened: boolean }>;
  getFinding(owner: string, id: string): Promise<SecurityFinding | null>;
  /** Highest priority first, then the most recently seen. */
  listFindings(owner: string, filter: SecurityFindingFilter): Promise<SecurityFinding[]>;
  updateFinding(owner: string, id: string, patch: { status?: SecurityFindingStatus; note?: string | null; confirmedBy?: string | null }): Promise<SecurityFinding | null>;
  /** Open findings of the host from these sources whose advisory and package are not in `keep` become FIXED; returns them. */
  closeResolved(owner: string, hostId: string, sources: string[], keep: Set<string>, note: string): Promise<SecurityFinding[]>;
  createAction(input: SecurityActionCreateRecord): Promise<SecurityAction>;
  getAction(owner: string, id: string): Promise<SecurityAction | null>;
  /** Changes the action only while it is in one of `fromStatus`; null otherwise. */
  updateAction(owner: string, id: string, patch: SecurityActionPatch, fromStatus: SecurityActionStatus[]): Promise<SecurityAction | null>;
  listActions(owner: string, filter: { hostId?: string; status?: SecurityActionStatus[]; since?: string; limit: number }): Promise<SecurityAction[]>;
  listMemory(owner: string, query: SecurityMemoryQuery): Promise<SecurityMemory[]>;
  /** Inserts, or replaces the memory with the same kind, key and host. */
  upsertMemory(input: SecurityMemoryCreateRecord): Promise<SecurityMemory>;
  updateMemory(owner: string, id: string, patch: SecurityMemoryPatch): Promise<SecurityMemory | null>;
  deleteMemory(owner: string, id: string): Promise<boolean>;
  touchMemories(owner: string, ids: string[]): Promise<void>;
  createEvent(input: SecurityEventCreateRecord): Promise<SecurityEvent>;
  getEvent(owner: string, id: string): Promise<SecurityEvent | null>;
  /** Newest first. */
  listEvents(owner: string, paneId: string, filter: SecurityEventFilter): Promise<SecurityEvent[]>;
  /** Changes status and merges `payload` only while the row is in one of `fromStatus`; null otherwise. */
  updateEvent(owner: string, id: string, patch: { status: SecurityEventStatus; payload?: Record<string, unknown> }, fromStatus: SecurityEventStatus[]): Promise<SecurityEvent | null>;
  /** The oldest PENDING brief of the pane becomes TAKEN. */
  takeNextBrief(owner: string, paneId: string): Promise<SecurityEvent | null>;
  dispose(): Promise<void>;
}

const copy = <T>(row: T): T => structuredClone(row);
const byNewest = <T extends { createdAt: string; id: string }>(left: T, right: T) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
const findingOrder = (left: SecurityFinding, right: SecurityFinding) => PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority] || right.lastSeenAt.localeCompare(left.lastSeenAt);
const higher = (left: SecurityPriority, right: SecurityPriority) => PRIORITY_RANK[left] <= PRIORITY_RANK[right] ? left : right;
export const securityFindingKey = (advisoryId: string, pkg: string) => `${advisoryId}\n${pkg}`;
function tokens(text: string): string[] { return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 1); }

export class InMemorySecurityCopilotRepository implements SecurityCopilotRepository {
  private hosts = new Map<string, SecurityHost>();
  private findings = new Map<string, SecurityFinding>();
  private actions = new Map<string, SecurityAction>();
  private memories = new Map<string, SecurityMemory>();
  private events = new Map<string, SecurityEvent>();
  constructor(private now: () => string = () => new Date().toISOString()) {}

  async upsertHost(input: SecurityHostRecord, inventory?: SecurityInventory) {
    const at = this.now();
    const existing = [...this.hosts.values()].find((row) => row.ownerUserId === input.ownerUserId && row.alias === input.alias);
    const row: SecurityHost = existing
      ? { ...existing, ...input, inventory: inventory ? copy(inventory) : existing.inventory, inventoryAt: inventory ? at : existing.inventoryAt, updatedAt: at }
      : { ...input, id: newId("sechost"), inventory: inventory ? copy(inventory) : null, inventoryAt: inventory ? at : null, createdAt: at, updatedAt: at };
    this.hosts.set(row.id, row);
    return copy(row);
  }
  async getHost(owner: string, id: string) { const row = this.hosts.get(id); return row && row.ownerUserId === owner ? copy(row) : null; }
  async listHosts(owner: string) { return [...this.hosts.values()].filter((row) => row.ownerUserId === owner).sort((a, b) => a.alias.localeCompare(b.alias)).map(copy); }
  async listOwners() { return [...new Set([...this.hosts.values()].map((row) => row.ownerUserId))]; }

  async upsertFinding(input: SecurityFindingRecord) {
    const at = this.now();
    const existing = [...this.findings.values()].find((row) => row.ownerUserId === input.ownerUserId && row.hostId === input.hostId
      && row.advisoryId === input.advisoryId && row.package === input.package);
    if (!existing) {
      const row: SecurityFinding = { ...copy(input), id: newId("secfind"), status: "NEW", confirmedBy: null, note: null, firstSeenAt: at, lastSeenAt: at, closedAt: null };
      this.findings.set(row.id, row);
      return { finding: copy(row), created: true, reopened: false };
    }
    const reopened = existing.status === "FIXED";
    const row: SecurityFinding = { ...existing, advisory: copy(input.advisory), installedVersion: input.installedVersion, fixedVersion: input.fixedVersion ?? existing.fixedVersion,
      priority: higher(existing.priority, input.priority), lastSeenAt: at, ...(reopened ? { status: "NEW" as const, closedAt: null } : {}) };
    this.findings.set(row.id, row);
    return { finding: copy(row), created: false, reopened };
  }
  async getFinding(owner: string, id: string) { const row = this.findings.get(id); return row && row.ownerUserId === owner ? copy(row) : null; }
  async listFindings(owner: string, filter: SecurityFindingFilter) {
    return [...this.findings.values()].filter((row) => row.ownerUserId === owner && (!filter.hostId || row.hostId === filter.hostId)
      && (!filter.status?.length || filter.status.includes(row.status))).sort(findingOrder).slice(0, filter.limit).map(copy);
  }
  async updateFinding(owner: string, id: string, patch: { status?: SecurityFindingStatus; note?: string | null; confirmedBy?: string | null }) {
    const row = this.findings.get(id);
    if (!row || row.ownerUserId !== owner) return null;
    const status = patch.status ?? row.status;
    const next: SecurityFinding = { ...row, status, note: patch.note === undefined ? row.note : patch.note, confirmedBy: patch.confirmedBy === undefined ? row.confirmedBy : patch.confirmedBy,
      closedAt: OPEN.includes(status) ? null : (row.closedAt ?? this.now()) };
    this.findings.set(id, next);
    return copy(next);
  }
  async closeResolved(owner: string, hostId: string, sources: string[], keep: Set<string>, note: string) {
    const closed: SecurityFinding[] = [];
    for (const row of this.findings.values()) {
      if (row.ownerUserId !== owner || row.hostId !== hostId || !OPEN.includes(row.status) || keep.has(securityFindingKey(row.advisoryId, row.package))
        || !row.advisory.sources.some((source) => sources.includes(source))) continue;
      const next = { ...row, status: "FIXED" as const, note, closedAt: this.now() };
      this.findings.set(row.id, next);
      closed.push(copy(next));
    }
    return closed;
  }

  async createAction(input: SecurityActionCreateRecord) {
    const row: SecurityAction = { ...copy(input), id: newId("secact"), verification: null, reviewEventId: input.reviewEventId ?? null, startedAt: this.now(), finishedAt: null };
    this.actions.set(row.id, row);
    return copy(row);
  }
  async getAction(owner: string, id: string) { const row = this.actions.get(id); return row && row.ownerUserId === owner ? copy(row) : null; }
  async updateAction(owner: string, id: string, patch: SecurityActionPatch, fromStatus: SecurityActionStatus[]) {
    const row = this.actions.get(id);
    if (!row || row.ownerUserId !== owner || !fromStatus.includes(row.status)) return null;
    const next = { ...row, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) } as SecurityAction;
    this.actions.set(id, next);
    return copy(next);
  }
  async listActions(owner: string, filter: { hostId?: string; status?: SecurityActionStatus[]; since?: string; limit: number }) {
    return [...this.actions.values()].filter((row) => row.ownerUserId === owner && (!filter.hostId || row.hostId === filter.hostId)
      && (!filter.status?.length || filter.status.includes(row.status)) && (!filter.since || row.startedAt >= filter.since))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id)).slice(0, filter.limit).map(copy);
  }

  async listMemory(owner: string, query: SecurityMemoryQuery) {
    const words = tokens(query.query ?? "");
    const score = (row: SecurityMemory) => {
      if (!words.length) return 0;
      const haystack = new Set(tokens(`${row.key ?? ""} ${row.text} ${row.tags.join(" ")}`));
      return words.filter((word) => haystack.has(word)).length / words.length;
    };
    return [...this.memories.values()].filter((row) => row.ownerUserId === owner && (!query.kinds?.length || query.kinds.includes(row.kind))
      && (!query.hostId || !row.hostId || row.hostId === query.hostId) && (!words.length || score(row) > 0))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || score(b) - score(a) || b.uses - a.uses || b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, query.limit).map(copy);
  }
  async upsertMemory(input: SecurityMemoryCreateRecord) {
    const at = this.now();
    const existing = input.key ? [...this.memories.values()].find((row) => row.ownerUserId === input.ownerUserId && row.kind === input.kind && row.key === input.key && row.hostId === input.hostId) : undefined;
    if (existing) {
      const next = { ...existing, text: input.text, tags: input.tags.length ? input.tags : existing.tags, source: input.source, pinned: existing.pinned || input.pinned, updatedAt: at };
      this.memories.set(existing.id, next);
      return copy(next);
    }
    const row: SecurityMemory = { ...copy(input), id: newId("secmem"), uses: 0, lastUsedAt: null, createdAt: at, updatedAt: at };
    this.memories.set(row.id, row);
    return copy(row);
  }
  async updateMemory(owner: string, id: string, patch: SecurityMemoryPatch) {
    const row = this.memories.get(id);
    if (!row || row.ownerUserId !== owner) return null;
    const next = { ...row, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)), updatedAt: this.now() } as SecurityMemory;
    this.memories.set(id, next);
    return copy(next);
  }
  async deleteMemory(owner: string, id: string) { return this.memories.get(id)?.ownerUserId === owner ? this.memories.delete(id) : false; }
  async touchMemories(owner: string, ids: string[]) {
    for (const id of ids) { const row = this.memories.get(id); if (row?.ownerUserId === owner) this.memories.set(id, { ...row, uses: row.uses + 1, lastUsedAt: this.now() }); }
  }

  async createEvent(input: SecurityEventCreateRecord) {
    const at = this.now();
    const row: SecurityEvent = { ...copy(input), id: newId("secevt"), createdAt: at, updatedAt: at };
    this.events.set(row.id, row);
    return copy(row);
  }
  async getEvent(owner: string, id: string) { const row = this.events.get(id); return row && row.ownerUserId === owner ? copy(row) : null; }
  async listEvents(owner: string, paneId: string, filter: SecurityEventFilter) {
    return [...this.events.values()].filter((row) => row.ownerUserId === owner && row.paneId === paneId && (!filter.types?.length || filter.types.includes(row.type))
      && (!filter.status?.length || (row.status !== null && filter.status.includes(row.status)))).sort(byNewest).slice(0, filter.limit).map(copy);
  }
  async updateEvent(owner: string, id: string, patch: { status: SecurityEventStatus; payload?: Record<string, unknown> }, fromStatus: SecurityEventStatus[]) {
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

const HOST_COLUMNS = `id, owner_user_id AS "ownerUserId", alias, label, reach, os_family AS "osFamily", os_version AS "osVersion", kernel, status, inventory,
  inventory_at AS "inventoryAt", note, created_at AS "createdAt", updated_at AS "updatedAt"`;
const FINDING_COLUMNS = `id, owner_user_id AS "ownerUserId", host_id AS "hostId", advisory_id AS "advisoryId", advisory, package, installed_version AS "installedVersion",
  fixed_version AS "fixedVersion", priority, status, confirmed_by AS "confirmedBy", note, first_seen_at AS "firstSeenAt", last_seen_at AS "lastSeenAt", closed_at AS "closedAt"`;
const ACTION_COLUMNS = `id, owner_user_id AS "ownerUserId", pane_id AS "paneId", host_id AS "hostId", finding_ids AS "findingIds", kind, summary, commands, backup, rollback,
  gate, reason, status, verification, review_event_id AS "reviewEventId", started_at AS "startedAt", finished_at AS "finishedAt"`;
const MEMORY_COLUMNS = `id, owner_user_id AS "ownerUserId", kind, key, text, host_id AS "hostId", tags, source, pinned, uses, last_used_at AS "lastUsedAt",
  created_at AS "createdAt", updated_at AS "updatedAt"`;
const EVENT_COLUMNS = `id, owner_user_id AS "ownerUserId", pane_id AS "paneId", type, status, message, payload, created_at AS "createdAt", updated_at AS "updatedAt"`;
const hostRow = (raw: Record<string, unknown>): SecurityHost => ({ ...(raw as unknown as SecurityHost), inventory: (raw.inventory as SecurityInventory | null) ?? null,
  inventoryAt: isoOrNull(raw.inventoryAt), createdAt: iso(raw.createdAt), updatedAt: iso(raw.updatedAt) });
const findingRow = (raw: Record<string, unknown>): SecurityFinding => ({ ...(raw as unknown as SecurityFinding), advisory: object(raw.advisory) as SecurityFinding["advisory"],
  firstSeenAt: iso(raw.firstSeenAt), lastSeenAt: iso(raw.lastSeenAt), closedAt: isoOrNull(raw.closedAt) });
const actionRow = (raw: Record<string, unknown>): SecurityAction => ({ ...(raw as unknown as SecurityAction), findingIds: (raw.findingIds as string[] | null) ?? [],
  startedAt: iso(raw.startedAt), finishedAt: isoOrNull(raw.finishedAt) });
const memoryRow = (raw: Record<string, unknown>): SecurityMemory => ({ ...(raw as unknown as SecurityMemory), tags: (raw.tags as string[] | null) ?? [], uses: Number(raw.uses),
  lastUsedAt: isoOrNull(raw.lastUsedAt), createdAt: iso(raw.createdAt), updatedAt: iso(raw.updatedAt) });
const eventRow = (raw: Record<string, unknown>): SecurityEvent => ({ ...(raw as unknown as SecurityEvent), status: (raw.status as SecurityEventStatus | null) ?? null,
  payload: object(raw.payload), createdAt: iso(raw.createdAt), updatedAt: iso(raw.updatedAt) });
const PRIORITY_SQL = "CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END";

export class PostgresSecurityCopilotRepository implements SecurityCopilotRepository {
  constructor(private pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresSecurityCopilotRepository(createSpacePgPool(url, { max: 2 })); }
  private async one<T>(sql: string, values: unknown[], map: (raw: Record<string, unknown>) => T): Promise<T | null> {
    const row = (await this.pool.query<Record<string, unknown>>(sql, values)).rows[0];
    return row ? map(row) : null;
  }
  private async many<T>(sql: string, values: unknown[], map: (raw: Record<string, unknown>) => T): Promise<T[]> {
    return (await this.pool.query<Record<string, unknown>>(sql, values)).rows.map(map);
  }

  async upsertHost(input: SecurityHostRecord, inventory?: SecurityInventory) {
    return (await this.one(`INSERT INTO security_copilot_hosts(id, owner_user_id, alias, label, reach, os_family, os_version, kernel, status, note, inventory, inventory_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb, CASE WHEN $11::jsonb IS NULL THEN NULL ELSE now() END)
      ON CONFLICT (owner_user_id, alias) DO UPDATE SET label=EXCLUDED.label, reach=EXCLUDED.reach, os_family=EXCLUDED.os_family, os_version=EXCLUDED.os_version,
        kernel=EXCLUDED.kernel, status=EXCLUDED.status, note=EXCLUDED.note, inventory=coalesce(EXCLUDED.inventory, security_copilot_hosts.inventory),
        inventory_at=coalesce(EXCLUDED.inventory_at, security_copilot_hosts.inventory_at), updated_at=now()
      RETURNING ${HOST_COLUMNS}`, [newId("sechost"), input.ownerUserId, input.alias, input.label, input.reach, input.osFamily, input.osVersion, input.kernel, input.status,
      input.note, inventory ? JSON.stringify(inventory) : null], hostRow))!;
  }
  getHost(owner: string, id: string) { return this.one(`SELECT ${HOST_COLUMNS} FROM security_copilot_hosts WHERE owner_user_id=$1 AND id=$2`, [owner, id], hostRow); }
  listHosts(owner: string) { return this.many(`SELECT ${HOST_COLUMNS} FROM security_copilot_hosts WHERE owner_user_id=$1 ORDER BY alias`, [owner], hostRow); }
  listOwners() { return this.many("SELECT DISTINCT owner_user_id FROM security_copilot_hosts", [], (raw) => String(raw.owner_user_id)); }

  async upsertFinding(input: SecurityFindingRecord) {
    // xmax = 0 marks a fresh insert; the CTE reads the status the row had before the update.
    const row = (await this.pool.query<Record<string, unknown>>(`WITH previous AS (SELECT status FROM security_copilot_findings
        WHERE owner_user_id=$2 AND host_id=$3 AND advisory_id=$4 AND package=$6)
      INSERT INTO security_copilot_findings(id, owner_user_id, host_id, advisory_id, advisory, package, installed_version, fixed_version, priority, status)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,'NEW')
      ON CONFLICT (owner_user_id, host_id, advisory_id, package) DO UPDATE SET advisory=EXCLUDED.advisory, installed_version=EXCLUDED.installed_version,
        fixed_version=coalesce(EXCLUDED.fixed_version, security_copilot_findings.fixed_version), last_seen_at=now(),
        priority=CASE WHEN ${PRIORITY_SQL.replace(/priority/g, "EXCLUDED.priority")} < ${PRIORITY_SQL.replace(/priority/g, "security_copilot_findings.priority")}
          THEN EXCLUDED.priority ELSE security_copilot_findings.priority END,
        status=CASE WHEN security_copilot_findings.status='FIXED' THEN 'NEW' ELSE security_copilot_findings.status END,
        closed_at=CASE WHEN security_copilot_findings.status='FIXED' THEN NULL ELSE security_copilot_findings.closed_at END
      RETURNING ${FINDING_COLUMNS}, (xmax = 0) AS "created", (SELECT status FROM previous) AS "previousStatus"`,
    [newId("secfind"), input.ownerUserId, input.hostId, input.advisoryId, JSON.stringify(input.advisory), input.package, input.installedVersion, input.fixedVersion, input.priority])).rows[0]!;
    const { created, previousStatus, ...finding } = row;
    return { finding: findingRow(finding), created: Boolean(created), reopened: previousStatus === "FIXED" };
  }
  getFinding(owner: string, id: string) { return this.one(`SELECT ${FINDING_COLUMNS} FROM security_copilot_findings WHERE owner_user_id=$1 AND id=$2`, [owner, id], findingRow); }
  listFindings(owner: string, filter: SecurityFindingFilter) {
    return this.many(`SELECT ${FINDING_COLUMNS} FROM security_copilot_findings WHERE owner_user_id=$1 AND ($2::text IS NULL OR host_id=$2)
      AND ($3::text[] IS NULL OR status = ANY($3::text[])) ORDER BY ${PRIORITY_SQL}, last_seen_at DESC LIMIT $4`,
    [owner, filter.hostId ?? null, filter.status?.length ? filter.status : null, filter.limit], findingRow);
  }
  updateFinding(owner: string, id: string, patch: { status?: SecurityFindingStatus; note?: string | null; confirmedBy?: string | null }) {
    return this.one(`UPDATE security_copilot_findings SET status=coalesce($3, status),
        note=CASE WHEN $4::boolean THEN $5 ELSE note END, confirmed_by=CASE WHEN $6::boolean THEN $7 ELSE confirmed_by END,
        closed_at=CASE WHEN coalesce($3, status) = ANY($8::text[]) THEN NULL ELSE coalesce(closed_at, now()) END
      WHERE owner_user_id=$1 AND id=$2 RETURNING ${FINDING_COLUMNS}`,
    [owner, id, patch.status ?? null, patch.note !== undefined, patch.note ?? null, patch.confirmedBy !== undefined, patch.confirmedBy ?? null, OPEN], findingRow);
  }
  async closeResolved(owner: string, hostId: string, sources: string[], keep: Set<string>, note: string) {
    const open = await this.many(`SELECT ${FINDING_COLUMNS} FROM security_copilot_findings WHERE owner_user_id=$1 AND host_id=$2 AND status = ANY($3::text[])
      AND advisory->'sources' ?| $4::text[]`, [owner, hostId, OPEN, sources], findingRow);
    const ids = open.filter((row) => !keep.has(securityFindingKey(row.advisoryId, row.package))).map((row) => row.id);
    if (!ids.length) return [];
    return this.many(`UPDATE security_copilot_findings SET status='FIXED', note=$3, closed_at=now() WHERE owner_user_id=$1 AND id = ANY($2::text[])
      AND status = ANY($4::text[]) RETURNING ${FINDING_COLUMNS}`, [owner, ids, note, OPEN], findingRow);
  }

  async createAction(input: SecurityActionCreateRecord) {
    return (await this.one(`INSERT INTO security_copilot_actions(id, owner_user_id, pane_id, host_id, finding_ids, kind, summary, commands, backup, rollback, gate, reason, status, review_event_id)
      VALUES ($1,$2,$3,$4,$5::text[],$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING ${ACTION_COLUMNS}`,
    [newId("secact"), input.ownerUserId, input.paneId, input.hostId, input.findingIds, input.kind, input.summary, input.commands, input.backup, input.rollback,
      input.gate, input.reason, input.status, input.reviewEventId ?? null], actionRow))!;
  }
  getAction(owner: string, id: string) { return this.one(`SELECT ${ACTION_COLUMNS} FROM security_copilot_actions WHERE owner_user_id=$1 AND id=$2`, [owner, id], actionRow); }
  updateAction(owner: string, id: string, patch: SecurityActionPatch, fromStatus: SecurityActionStatus[]) {
    return this.one(`UPDATE security_copilot_actions SET status=coalesce($3, status), verification=coalesce($4, verification),
        review_event_id=coalesce($5, review_event_id), finished_at=coalesce($6::timestamptz, finished_at)
      WHERE owner_user_id=$1 AND id=$2 AND status = ANY($7::text[]) RETURNING ${ACTION_COLUMNS}`,
    [owner, id, patch.status ?? null, patch.verification ?? null, patch.reviewEventId ?? null, patch.finishedAt ?? null, fromStatus], actionRow);
  }
  listActions(owner: string, filter: { hostId?: string; status?: SecurityActionStatus[]; since?: string; limit: number }) {
    return this.many(`SELECT ${ACTION_COLUMNS} FROM security_copilot_actions WHERE owner_user_id=$1 AND ($2::text IS NULL OR host_id=$2)
      AND ($3::text[] IS NULL OR status = ANY($3::text[])) AND ($4::timestamptz IS NULL OR started_at >= $4) ORDER BY started_at DESC, id DESC LIMIT $5`,
    [owner, filter.hostId ?? null, filter.status?.length ? filter.status : null, filter.since ?? null, filter.limit], actionRow);
  }

  listMemory(owner: string, query: SecurityMemoryQuery) {
    const text = searchText(query.query);
    return this.many(`SELECT ${MEMORY_COLUMNS} FROM security_copilot_memory WHERE owner_user_id=$1 AND ($3::text[] IS NULL OR kind = ANY($3::text[]))
        AND ($4::text IS NULL OR host_id IS NULL OR host_id=$4) AND ($2::text IS NULL OR search @@ websearch_to_tsquery('simple', $2))
      ORDER BY pinned DESC, CASE WHEN $2::text IS NULL THEN 0 ELSE ts_rank(search, websearch_to_tsquery('simple', $2)) END DESC, uses DESC, updated_at DESC LIMIT $5`,
    [owner, text, query.kinds?.length ? query.kinds : null, query.hostId ?? null, query.limit], memoryRow);
  }
  async upsertMemory(input: SecurityMemoryCreateRecord) {
    return (await this.one(`INSERT INTO security_copilot_memory(id, owner_user_id, kind, key, text, host_id, tags, source, pinned) VALUES ($1,$2,$3,$4,$5,$6,$7::text[],$8,$9)
      ON CONFLICT (owner_user_id, kind, key, scope) WHERE key IS NOT NULL DO UPDATE SET text = EXCLUDED.text,
        tags = CASE WHEN cardinality(EXCLUDED.tags) > 0 THEN EXCLUDED.tags ELSE security_copilot_memory.tags END, source = EXCLUDED.source,
        pinned = security_copilot_memory.pinned OR EXCLUDED.pinned, updated_at = now()
      RETURNING ${MEMORY_COLUMNS}`, [newId("secmem"), input.ownerUserId, input.kind, input.key, input.text, input.hostId, input.tags, input.source, input.pinned], memoryRow))!;
  }
  updateMemory(owner: string, id: string, patch: SecurityMemoryPatch) {
    return this.one(`UPDATE security_copilot_memory SET text=coalesce($3, text), tags=coalesce($4::text[], tags), pinned=coalesce($5, pinned), updated_at=now()
      WHERE owner_user_id=$1 AND id=$2 RETURNING ${MEMORY_COLUMNS}`, [owner, id, patch.text ?? null, patch.tags ?? null, patch.pinned ?? null], memoryRow);
  }
  async deleteMemory(owner: string, id: string) {
    return ((await this.pool.query("DELETE FROM security_copilot_memory WHERE owner_user_id=$1 AND id=$2", [owner, id])) as { rowCount?: number | null }).rowCount! > 0;
  }
  async touchMemories(owner: string, ids: string[]) {
    if (ids.length) await this.pool.query("UPDATE security_copilot_memory SET uses = uses + 1, last_used_at = now() WHERE owner_user_id=$1 AND id = ANY($2::text[])", [owner, ids]);
  }

  async createEvent(input: SecurityEventCreateRecord) {
    return (await this.one(`INSERT INTO security_copilot_events(id, owner_user_id, pane_id, type, status, message, payload) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING ${EVENT_COLUMNS}`,
      [newId("secevt"), input.ownerUserId, input.paneId, input.type, input.status, input.message, JSON.stringify(input.payload)], eventRow))!;
  }
  getEvent(owner: string, id: string) { return this.one(`SELECT ${EVENT_COLUMNS} FROM security_copilot_events WHERE owner_user_id=$1 AND id=$2`, [owner, id], eventRow); }
  listEvents(owner: string, paneId: string, filter: SecurityEventFilter) {
    return this.many(`SELECT ${EVENT_COLUMNS} FROM security_copilot_events WHERE owner_user_id=$1 AND pane_id=$2
        AND ($3::text[] IS NULL OR type = ANY($3::text[])) AND ($4::text[] IS NULL OR status = ANY($4::text[])) ORDER BY created_at DESC, id DESC LIMIT $5`,
    [owner, paneId, filter.types?.length ? filter.types : null, filter.status?.length ? filter.status : null, filter.limit], eventRow);
  }
  updateEvent(owner: string, id: string, patch: { status: SecurityEventStatus; payload?: Record<string, unknown> }, fromStatus: SecurityEventStatus[]) {
    return this.one(`UPDATE security_copilot_events SET status=$3, payload = payload || $4::jsonb, updated_at=now()
      WHERE owner_user_id=$1 AND id=$2 AND status = ANY($5::text[]) RETURNING ${EVENT_COLUMNS}`, [owner, id, patch.status, JSON.stringify(patch.payload ?? {}), fromStatus], eventRow);
  }
  takeNextBrief(owner: string, paneId: string) {
    return this.one(`UPDATE security_copilot_events SET status='TAKEN', updated_at=now() WHERE id = (SELECT id FROM security_copilot_events
      WHERE owner_user_id=$1 AND pane_id=$2 AND type='BRIEF' AND status='PENDING' ORDER BY created_at ASC, id ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING ${EVENT_COLUMNS}`, [owner, paneId], eventRow);
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
