import { randomBytes } from "node:crypto";
import type {
  MarketingBookmark, MarketingCampaign, MarketingChannel, MarketingEvent, MarketingMemory, MarketingMemoryQuery, MarketingMetric, MarketingPost, MarketingPostStatus, MarketingRule, MarketingRun
} from "@space/contracts";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

// Marketing Copilot's own storage: campaigns, posts (review state and publication evidence), memory with
// full-text recall, the activity feed whose operator briefs are the agent's work items, one active run per
// pane, and the rules RULES autonomy publishes under. Postgres live, in-memory for tests.

const newId = (prefix: string) => `${prefix}:${randomBytes(9).toString("base64url")}`;

export type MarketingCampaignCreateRecord = Omit<MarketingCampaign, "id" | "createdAt" | "updatedAt">;
export type MarketingCampaignPatch = Partial<Pick<MarketingCampaign, "name" | "goal" | "channels" | "status" | "startsAt" | "endsAt" | "payload">>;
export type MarketingPostCreateRecord = Omit<MarketingPost, "id" | "createdAt" | "updatedAt">;
export type MarketingPostPatch = Partial<Omit<MarketingPost, "id" | "ownerUserId" | "channel" | "kind" | "createdAt" | "updatedAt">>;
export interface MarketingPostFilter { status?: MarketingPostStatus[]; channel?: MarketingChannel; campaignId?: string; limit: number }
export type MarketingMemoryCreateRecord = Omit<MarketingMemory, "id" | "uses" | "lastUsedAt" | "createdAt" | "updatedAt">;
export type MarketingMemoryPatch = Partial<Pick<MarketingMemory, "text" | "pinned">>;
export type MarketingEventCreateRecord = Omit<MarketingEvent, "id" | "createdAt">;
export interface MarketingEventFilter { paneId?: string | null; postId?: string | null; types?: string[]; status?: string[]; limit: number }
export type MarketingRunPatch = Partial<Pick<MarketingRun, "status" | "counters" | "kickoffSentAt" | "stoppedAt" | "lastActivityAt">>;
export type MarketingRuleCreateRecord = Omit<MarketingRule, "id" | "appliedCount" | "lastAppliedAt" | "decidedAt" | "createdAt" | "updatedAt">;
export type MarketingRulePatch = Partial<Pick<MarketingRule, "status" | "decidedAt" | "appliedCount" | "lastAppliedAt">>;
export type MarketingBookmarkCreateRecord = Omit<MarketingBookmark, "id" | "createdAt">;

export interface MarketingCopilotRepository {
  listCampaigns(owner: string, status?: MarketingCampaign["status"][]): Promise<MarketingCampaign[]>;
  getCampaign(owner: string, id: string): Promise<MarketingCampaign | null>;
  createCampaign(input: MarketingCampaignCreateRecord): Promise<MarketingCampaign>;
  updateCampaign(owner: string, id: string, patch: MarketingCampaignPatch): Promise<MarketingCampaign | null>;
  listPosts(owner: string, filter: MarketingPostFilter): Promise<MarketingPost[]>;
  getPost(owner: string, id: string): Promise<MarketingPost | null>;
  createPost(input: MarketingPostCreateRecord): Promise<MarketingPost>;
  /** Updates a post; with `fromStatus` only while the post is in one of those states (an atomic transition), else null. */
  updatePost(owner: string, id: string, patch: MarketingPostPatch, fromStatus?: MarketingPostStatus[]): Promise<MarketingPost | null>;
  /** Publications on a channel since a time: PUBLISHED ones by their publication time, PUBLISHING ones in flight. */
  countPublications(owner: string, channel: MarketingChannel, since: string): Promise<number>;
  listMemory(owner: string, query: MarketingMemoryQuery): Promise<MarketingMemory[]>;
  /** Inserts, or replaces the memory with the same kind, key and channel. */
  upsertMemory(input: MarketingMemoryCreateRecord): Promise<MarketingMemory>;
  updateMemory(owner: string, id: string, patch: MarketingMemoryPatch): Promise<MarketingMemory | null>;
  deleteMemory(owner: string, id: string): Promise<boolean>;
  touchMemories(owner: string, ids: string[]): Promise<void>;
  createEvent(input: MarketingEventCreateRecord): Promise<MarketingEvent>;
  listEvents(owner: string, filter: MarketingEventFilter): Promise<MarketingEvent[]>;
  /** Atomically takes the oldest PENDING brief (or one TAKEN longer than `staleMs` ago). */
  takeNextBrief(owner: string, paneId: string, staleMs: number): Promise<MarketingEvent | null>;
  setEventStatus(owner: string, id: string, status: "PENDING" | "TAKEN" | "DONE"): Promise<MarketingEvent | null>;
  getActiveRun(paneId: string): Promise<MarketingRun | null>;
  createRun(input: { ownerUserId: string; paneId: string }): Promise<MarketingRun>;
  updateRun(owner: string, id: string, patch: MarketingRunPatch): Promise<MarketingRun | null>;
  listRules(owner: string, status?: MarketingRule["status"][]): Promise<MarketingRule[]>;
  getRule(owner: string, id: string): Promise<MarketingRule | null>;
  createRule(input: MarketingRuleCreateRecord): Promise<MarketingRule>;
  updateRule(owner: string, id: string, patch: MarketingRulePatch): Promise<MarketingRule | null>;
  /** Records the day's values (a second recording of the same day replaces them). */
  recordMetrics(owner: string, metrics: MarketingMetric[]): Promise<void>;
  /** Values since a day (YYYY-MM-DD), oldest first. */
  listMetrics(owner: string, sinceDay: string): Promise<MarketingMetric[]>;
  /** Oldest first, the order the operator added them. */
  listBookmarks(owner: string): Promise<MarketingBookmark[]>;
  getBookmark(owner: string, id: string): Promise<MarketingBookmark | null>;
  createBookmark(input: MarketingBookmarkCreateRecord): Promise<MarketingBookmark>;
  deleteBookmark(owner: string, id: string): Promise<boolean>;
  dispose(): Promise<void>;
}

const emptyCounters = { taken: 0, drafted: 0, published: 0, failed: 0, needsUser: 0 };
const defined = <T extends object>(patch: T) => Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<T>;
const byNewest = <T extends { createdAt: string; id: string }>(left: T, right: T) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
function tokens(text: string): string[] { return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 1); }

export class InMemoryMarketingCopilotRepository implements MarketingCopilotRepository {
  private campaigns = new Map<string, MarketingCampaign>();
  private posts = new Map<string, MarketingPost>();
  private memories = new Map<string, MarketingMemory>();
  private events: MarketingEvent[] = [];
  private runs = new Map<string, MarketingRun>();
  private rules = new Map<string, MarketingRule>();
  constructor(private now: () => string = () => new Date().toISOString()) {}
  private owned<T extends { ownerUserId: string }>(map: Map<string, T>, owner: string, id: string): T | null { const row = map.get(id); return row && row.ownerUserId === owner ? row : null; }

  async listCampaigns(owner: string, status?: MarketingCampaign["status"][]) {
    return [...this.campaigns.values()].filter((row) => row.ownerUserId === owner && (!status?.length || status.includes(row.status))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((row) => ({ ...row }));
  }
  async getCampaign(owner: string, id: string) { const row = this.owned(this.campaigns, owner, id); return row ? { ...row } : null; }
  async createCampaign(input: MarketingCampaignCreateRecord) {
    const at = this.now();
    const row: MarketingCampaign = { ...input, id: newId("mktcamp"), createdAt: at, updatedAt: at };
    this.campaigns.set(row.id, row);
    return { ...row };
  }
  async updateCampaign(owner: string, id: string, patch: MarketingCampaignPatch) {
    const row = this.owned(this.campaigns, owner, id);
    if (!row) return null;
    const next = { ...row, ...defined(patch), updatedAt: this.now() };
    this.campaigns.set(id, next);
    return { ...next };
  }
  async listPosts(owner: string, filter: MarketingPostFilter) {
    return [...this.posts.values()].filter((row) => row.ownerUserId === owner && (!filter.status?.length || filter.status.includes(row.status))
      && (!filter.channel || row.channel === filter.channel) && (!filter.campaignId || row.campaignId === filter.campaignId))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, filter.limit).map((row) => ({ ...row }));
  }
  async getPost(owner: string, id: string) { const row = this.owned(this.posts, owner, id); return row ? { ...row } : null; }
  async createPost(input: MarketingPostCreateRecord) {
    const at = this.now();
    const row: MarketingPost = { ...input, id: newId("mktpost"), createdAt: at, updatedAt: at };
    this.posts.set(row.id, row);
    return { ...row };
  }
  async updatePost(owner: string, id: string, patch: MarketingPostPatch, fromStatus?: MarketingPostStatus[]) {
    const row = this.owned(this.posts, owner, id);
    if (!row || (fromStatus && !fromStatus.includes(row.status))) return null;
    const next = { ...row, ...defined(patch), updatedAt: this.now() };
    this.posts.set(id, next);
    return { ...next };
  }
  async countPublications(owner: string, channel: MarketingChannel, since: string) {
    return [...this.posts.values()].filter((row) => row.ownerUserId === owner && row.channel === channel
      && (row.status === "PUBLISHING" || (row.status === "PUBLISHED" && (row.publishedAt ?? row.updatedAt) >= since))).length;
  }
  async listMemory(owner: string, query: MarketingMemoryQuery) {
    const words = tokens(query.query ?? "");
    const score = (row: MarketingMemory) => {
      if (!words.length) return 0;
      const haystack = new Set(tokens(`${row.key ?? ""} ${row.text} ${row.tags.join(" ")}`));
      return words.filter((word) => haystack.has(word)).length / words.length;
    };
    return [...this.memories.values()].filter((row) => row.ownerUserId === owner && (!query.kinds?.length || query.kinds.includes(row.kind))
      && (!query.channel || !row.channel || row.channel === query.channel) && (!words.length || score(row) > 0))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || score(b) - score(a) || b.uses - a.uses || b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, query.limit).map((row) => ({ ...row }));
  }
  async upsertMemory(input: MarketingMemoryCreateRecord) {
    const at = this.now();
    const existing = input.key ? [...this.memories.values()].find((row) => row.ownerUserId === input.ownerUserId && row.kind === input.kind && row.key === input.key && row.channel === input.channel) : undefined;
    if (existing) {
      const next = { ...existing, text: input.text, tags: input.tags.length ? input.tags : existing.tags, source: input.source, pinned: existing.pinned || input.pinned, updatedAt: at };
      this.memories.set(existing.id, next);
      return { ...next };
    }
    const row: MarketingMemory = { ...input, id: newId("mktmem"), uses: 0, lastUsedAt: null, createdAt: at, updatedAt: at };
    this.memories.set(row.id, row);
    return { ...row };
  }
  async updateMemory(owner: string, id: string, patch: MarketingMemoryPatch) {
    const row = this.owned(this.memories, owner, id);
    if (!row) return null;
    const next = { ...row, ...defined(patch), updatedAt: this.now() };
    this.memories.set(id, next);
    return { ...next };
  }
  async deleteMemory(owner: string, id: string) { return this.owned(this.memories, owner, id) ? this.memories.delete(id) : false; }
  async touchMemories(owner: string, ids: string[]) {
    for (const id of ids) { const row = this.owned(this.memories, owner, id); if (row) this.memories.set(id, { ...row, uses: row.uses + 1, lastUsedAt: this.now() }); }
  }
  async createEvent(input: MarketingEventCreateRecord) {
    const row: MarketingEvent = { ...input, id: newId("mktevt"), createdAt: this.now() };
    this.events.push(row);
    return { ...row };
  }
  async listEvents(owner: string, filter: MarketingEventFilter) {
    return this.events.filter((row) => row.ownerUserId === owner && (!filter.paneId || row.paneId === filter.paneId) && (!filter.postId || row.postId === filter.postId)
      && (!filter.types?.length || filter.types.includes(row.type)) && (!filter.status?.length || (row.status !== null && filter.status.includes(row.status))))
      .sort(byNewest).slice(0, filter.limit).map((row) => ({ ...row }));
  }
  async takeNextBrief(owner: string, paneId: string, staleMs: number) {
    const at = this.now();
    const stale = new Date(Date.parse(at) - staleMs).toISOString();
    const index = this.events.findIndex((row) => row.ownerUserId === owner && row.type === "BRIEF" && (!row.paneId || row.paneId === paneId) && (row.status === "PENDING" || (row.status === "TAKEN" && String(row.payload.takenAt ?? "") < stale)));
    if (index < 0) return null;
    const taken = { ...this.events[index]!, status: "TAKEN" as const, payload: { ...this.events[index]!.payload, takenAt: at, takenByPaneId: paneId } };
    this.events[index] = taken;
    return { ...taken };
  }
  async setEventStatus(owner: string, id: string, status: "PENDING" | "TAKEN" | "DONE") {
    const index = this.events.findIndex((row) => row.id === id && row.ownerUserId === owner);
    if (index < 0) return null;
    this.events[index] = { ...this.events[index]!, status };
    return { ...this.events[index]! };
  }
  async getActiveRun(paneId: string) { const row = [...this.runs.values()].find((run) => run.paneId === paneId && run.status !== "STOPPED"); return row ? { ...row } : null; }
  async createRun(input: { ownerUserId: string; paneId: string }) {
    const at = this.now();
    const row: MarketingRun = { id: newId("mktrun"), ownerUserId: input.ownerUserId, paneId: input.paneId, status: "RUNNING", counters: { ...emptyCounters }, kickoffSentAt: null,
      startedAt: at, stoppedAt: null, lastActivityAt: at, createdAt: at, updatedAt: at };
    this.runs.set(row.id, row);
    return { ...row };
  }
  async updateRun(owner: string, id: string, patch: MarketingRunPatch) {
    const row = this.owned(this.runs, owner, id);
    if (!row) return null;
    const next = { ...row, ...defined(patch), updatedAt: this.now() };
    this.runs.set(id, next);
    return { ...next };
  }
  async listRules(owner: string, status?: MarketingRule["status"][]) {
    return [...this.rules.values()].filter((row) => row.ownerUserId === owner && (!status?.length || status.includes(row.status))).sort(byNewest).map((row) => ({ ...row }));
  }
  async getRule(owner: string, id: string) { const row = this.owned(this.rules, owner, id); return row ? { ...row } : null; }
  async createRule(input: MarketingRuleCreateRecord) {
    const at = this.now();
    const row: MarketingRule = { ...input, id: newId("mktrule"), appliedCount: 0, lastAppliedAt: null, decidedAt: input.status === "APPROVED" ? at : null, createdAt: at, updatedAt: at };
    this.rules.set(row.id, row);
    return { ...row };
  }
  async updateRule(owner: string, id: string, patch: MarketingRulePatch) {
    const row = this.owned(this.rules, owner, id);
    if (!row) return null;
    const next = { ...row, ...defined(patch), updatedAt: this.now() };
    this.rules.set(id, next);
    return { ...next };
  }
  private metrics = new Map<string, MarketingMetric & { owner: string }>();
  async recordMetrics(owner: string, metrics: MarketingMetric[]) {
    for (const metric of metrics) this.metrics.set(`${owner}|${metric.day}|${metric.source}|${metric.key}`, { ...metric, owner });
  }
  async listMetrics(owner: string, sinceDay: string) {
    return [...this.metrics.values()].filter((row) => row.owner === owner && row.day >= sinceDay)
      .sort((a, b) => a.day.localeCompare(b.day) || a.source.localeCompare(b.source) || a.key.localeCompare(b.key)).map((row) => ({ day: row.day, source: row.source, key: row.key, value: row.value }));
  }
  private bookmarks = new Map<string, MarketingBookmark>();
  async listBookmarks(owner: string) { return [...this.bookmarks.values()].filter((row) => row.ownerUserId === owner).map((row) => ({ ...row })); }
  async getBookmark(owner: string, id: string) { const row = this.owned(this.bookmarks, owner, id); return row ? { ...row } : null; }
  async createBookmark(input: MarketingBookmarkCreateRecord) {
    const row: MarketingBookmark = { ...input, id: newId("mktbm"), createdAt: this.now() };
    this.bookmarks.set(row.id, row);
    return { ...row };
  }
  async deleteBookmark(owner: string, id: string) { return this.owned(this.bookmarks, owner, id) ? this.bookmarks.delete(id) : false; }
  async dispose() {}
}

// ---- Postgres ------------------------------------------------------------------------------------
const iso = (value: unknown): string | null => value === null || value === undefined ? null : value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

interface Table<T> { name: string; columns: Record<string, string>; json: ReadonlySet<string>; arrays: ReadonlySet<string>; row(raw: Record<string, unknown>): T }
const select = (table: Table<unknown>) => Object.entries(table.columns).map(([field, column]) => `${column} AS "${field}"`).join(", ");
/** `SET col = $n, ...` for the defined fields of a patch, numbering placeholders from `start`. */
function setClause(table: Table<unknown>, patch: Record<string, unknown>, start: number): { sql: string; values: unknown[] } {
  const entries = Object.entries(patch).filter(([field, value]) => value !== undefined && table.columns[field]);
  const sql = entries.map(([field], index) => `${table.columns[field]} = $${start + index}${table.json.has(field) ? "::jsonb" : table.arrays.has(field) ? "::text[]" : ""}`);
  // Tables with an updatedAt column (every one but the append-only events) stamp it.
  return { sql: [...sql, ...(table.columns.updatedAt ? ["updated_at = now()"] : [])].join(", "), values: entries.map(([field, value]) => table.json.has(field) ? JSON.stringify(value) : value) };
}

const campaignTable: Table<MarketingCampaign> = {
  name: "marketing_copilot_campaigns",
  columns: { id: "id", ownerUserId: "owner_user_id", name: "name", goal: "goal", channels: "channels", status: "status", startsAt: "starts_at", endsAt: "ends_at", proposedBy: "proposed_by", payload: "payload", createdAt: "created_at", updatedAt: "updated_at" },
  json: new Set(["payload"]), arrays: new Set(["channels"]),
  row: (raw) => ({ ...(raw as unknown as MarketingCampaign), channels: (raw.channels as MarketingChannel[] | null) ?? [], payload: object(raw.payload), startsAt: iso(raw.startsAt), endsAt: iso(raw.endsAt), createdAt: iso(raw.createdAt)!, updatedAt: iso(raw.updatedAt)! })
};
const postTable: Table<MarketingPost> = {
  name: "marketing_copilot_posts",
  columns: { id: "id", ownerUserId: "owner_user_id", paneId: "pane_id", campaignId: "campaign_id", channel: "channel", kind: "kind", target: "target", title: "title", body: "body", assets: "assets", status: "status",
    scheduledAt: "scheduled_at", reviewNote: "review_note", ruleId: "rule_id", publishedUrl: "published_url", publishedAt: "published_at", evidence: "evidence", metrics: "metrics", createdAt: "created_at", updatedAt: "updated_at" },
  json: new Set(["assets", "evidence", "metrics"]), arrays: new Set(),
  row: (raw) => ({ ...(raw as unknown as MarketingPost), assets: Array.isArray(raw.assets) ? raw.assets as MarketingPost["assets"] : [], evidence: object(raw.evidence), metrics: object(raw.metrics) as Record<string, number>,
    scheduledAt: iso(raw.scheduledAt), publishedAt: iso(raw.publishedAt), createdAt: iso(raw.createdAt)!, updatedAt: iso(raw.updatedAt)! })
};
const memoryTable: Table<MarketingMemory> = {
  name: "marketing_copilot_memory",
  columns: { id: "id", ownerUserId: "owner_user_id", kind: "kind", key: "key", text: "text", channel: "channel", tags: "tags", source: "source", uses: "uses", pinned: "pinned", lastUsedAt: "last_used_at", createdAt: "created_at", updatedAt: "updated_at" },
  json: new Set(), arrays: new Set(["tags"]),
  row: (raw) => ({ ...(raw as unknown as MarketingMemory), tags: (raw.tags as string[] | null) ?? [], uses: Number(raw.uses), lastUsedAt: iso(raw.lastUsedAt), createdAt: iso(raw.createdAt)!, updatedAt: iso(raw.updatedAt)! })
};
const eventTable: Table<MarketingEvent> = {
  name: "marketing_copilot_events",
  columns: { id: "id", ownerUserId: "owner_user_id", paneId: "pane_id", runId: "run_id", postId: "post_id", campaignId: "campaign_id", type: "type", status: "status", message: "message", payload: "payload", createdAt: "created_at" },
  json: new Set(["payload"]), arrays: new Set(),
  row: (raw) => ({ ...(raw as unknown as MarketingEvent), payload: object(raw.payload), createdAt: iso(raw.createdAt)! })
};
const runTable: Table<MarketingRun> = {
  name: "marketing_copilot_runs",
  columns: { id: "id", ownerUserId: "owner_user_id", paneId: "pane_id", status: "status", counters: "counters", kickoffSentAt: "kickoff_sent_at", startedAt: "started_at", stoppedAt: "stopped_at", lastActivityAt: "last_activity_at", createdAt: "created_at", updatedAt: "updated_at" },
  json: new Set(["counters"]), arrays: new Set(),
  row: (raw) => ({ ...(raw as unknown as MarketingRun), counters: { ...emptyCounters, ...object(raw.counters) as Record<string, number> }, kickoffSentAt: iso(raw.kickoffSentAt), startedAt: iso(raw.startedAt)!,
    stoppedAt: iso(raw.stoppedAt), lastActivityAt: iso(raw.lastActivityAt)!, createdAt: iso(raw.createdAt)!, updatedAt: iso(raw.updatedAt)! })
};
const ruleTable: Table<MarketingRule> = {
  name: "marketing_copilot_rules",
  columns: { id: "id", ownerUserId: "owner_user_id", name: "name", channel: "channel", kinds: "kinds", campaignId: "campaign_id", status: "status", evidence: "evidence", proposedBy: "proposed_by",
    appliedCount: "applied_count", lastAppliedAt: "last_applied_at", decidedAt: "decided_at", createdAt: "created_at", updatedAt: "updated_at" },
  json: new Set(), arrays: new Set(["kinds", "evidence"]),
  row: (raw) => ({ ...(raw as unknown as MarketingRule), kinds: (raw.kinds as MarketingRule["kinds"] | null) ?? [], evidence: (raw.evidence as string[] | null) ?? [], appliedCount: Number(raw.appliedCount),
    lastAppliedAt: iso(raw.lastAppliedAt), decidedAt: iso(raw.decidedAt), createdAt: iso(raw.createdAt)!, updatedAt: iso(raw.updatedAt)! })
};
const bookmarkTable: Table<MarketingBookmark> = {
  name: "marketing_copilot_bookmarks",
  columns: { id: "id", ownerUserId: "owner_user_id", title: "title", url: "url", profileId: "profile_id", accountLabel: "account_label", createdAt: "created_at" },
  json: new Set(), arrays: new Set(),
  row: (raw) => ({ ...(raw as unknown as MarketingBookmark), createdAt: iso(raw.createdAt)! })
};
/** `websearch_to_tsquery` accepts free text safely; an empty query matches everything. */
function searchText(query: string | null | undefined): string | null {
  const text = (query ?? "").replace(/[^\p{L}\p{N}\s'"@.-]+/gu, " ").trim();
  return text.length > 0 ? text.slice(0, 500) : null;
}

export class PostgresMarketingCopilotRepository implements MarketingCopilotRepository {
  constructor(private pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresMarketingCopilotRepository(createSpacePgPool(url, { max: 2 })); }
  private async insert<T>(table: Table<T>, values: Record<string, unknown>): Promise<T> {
    const fields = Object.keys(values).filter((field) => table.columns[field]);
    const placeholders = fields.map((field, index) => `$${index + 1}${table.json.has(field) ? "::jsonb" : table.arrays.has(field) ? "::text[]" : ""}`);
    const row = (await this.pool.query<Record<string, unknown>>(`INSERT INTO ${table.name}(${fields.map((field) => table.columns[field]).join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING ${select(table)}`,
      fields.map((field) => table.json.has(field) ? JSON.stringify(values[field]) : values[field]))).rows[0]!;
    return table.row(row);
  }
  private async update<T>(table: Table<T>, owner: string, id: string, patch: Record<string, unknown>, extraWhere = "", extraValues: unknown[] = []): Promise<T | null> {
    const { sql, values } = setClause(table as Table<unknown>, patch, 3 + extraValues.length);
    const row = (await this.pool.query<Record<string, unknown>>(`UPDATE ${table.name} SET ${sql} WHERE owner_user_id=$1 AND id=$2 ${extraWhere} RETURNING ${select(table)}`,
      [owner, id, ...extraValues, ...values])).rows[0];
    return row ? table.row(row) : null;
  }
  private async one<T>(table: Table<T>, owner: string, id: string): Promise<T | null> {
    const row = (await this.pool.query<Record<string, unknown>>(`SELECT ${select(table)} FROM ${table.name} WHERE owner_user_id=$1 AND id=$2`, [owner, id])).rows[0];
    return row ? table.row(row) : null;
  }

  async listCampaigns(owner: string, status?: MarketingCampaign["status"][]) {
    return (await this.pool.query<Record<string, unknown>>(`SELECT ${select(campaignTable)} FROM marketing_copilot_campaigns WHERE owner_user_id=$1 AND ($2::text[] IS NULL OR status = ANY($2))
      ORDER BY updated_at DESC LIMIT 200`, [owner, status?.length ? status : null])).rows.map(campaignTable.row);
  }
  getCampaign(owner: string, id: string) { return this.one(campaignTable, owner, id); }
  createCampaign(input: MarketingCampaignCreateRecord) { return this.insert(campaignTable, { ...input, id: newId("mktcamp") }); }
  updateCampaign(owner: string, id: string, patch: MarketingCampaignPatch) { return this.update(campaignTable, owner, id, patch); }
  async listPosts(owner: string, filter: MarketingPostFilter) {
    return (await this.pool.query<Record<string, unknown>>(`SELECT ${select(postTable)} FROM marketing_copilot_posts WHERE owner_user_id=$1 AND ($2::text[] IS NULL OR status = ANY($2))
      AND ($3::text IS NULL OR channel=$3) AND ($4::text IS NULL OR campaign_id=$4) ORDER BY updated_at DESC LIMIT $5`,
      [owner, filter.status?.length ? filter.status : null, filter.channel ?? null, filter.campaignId ?? null, filter.limit])).rows.map(postTable.row);
  }
  getPost(owner: string, id: string) { return this.one(postTable, owner, id); }
  createPost(input: MarketingPostCreateRecord) { return this.insert(postTable, { ...input, id: newId("mktpost") }); }
  updatePost(owner: string, id: string, patch: MarketingPostPatch, fromStatus?: MarketingPostStatus[]) {
    return fromStatus ? this.update(postTable, owner, id, patch, "AND status = ANY($3::text[])", [fromStatus]) : this.update(postTable, owner, id, patch);
  }
  async countPublications(owner: string, channel: MarketingChannel, since: string) {
    const row = (await this.pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM marketing_copilot_posts WHERE owner_user_id=$1 AND channel=$2
      AND (status='PUBLISHING' OR (status='PUBLISHED' AND coalesce(published_at, updated_at) >= $3))`, [owner, channel, since])).rows[0];
    return Number.parseInt(row?.count ?? "0", 10);
  }
  async listMemory(owner: string, query: MarketingMemoryQuery) {
    const text = searchText(query.query);
    return (await this.pool.query<Record<string, unknown>>(`SELECT ${select(memoryTable)} FROM marketing_copilot_memory WHERE owner_user_id=$1 AND ($3::text[] IS NULL OR kind = ANY($3::text[]))
        AND ($4::text IS NULL OR channel IS NULL OR channel=$4) AND ($2::text IS NULL OR search @@ websearch_to_tsquery('simple', $2))
      ORDER BY pinned DESC, CASE WHEN $2::text IS NULL THEN 0 ELSE ts_rank(search, websearch_to_tsquery('simple', $2)) END DESC, uses DESC, updated_at DESC LIMIT $5`,
      [owner, text, query.kinds?.length ? query.kinds : null, query.channel ?? null, query.limit])).rows.map(memoryTable.row);
  }
  async upsertMemory(input: MarketingMemoryCreateRecord) {
    const row = (await this.pool.query<Record<string, unknown>>(`INSERT INTO marketing_copilot_memory(id, owner_user_id, kind, key, text, channel, tags, source, pinned)
      VALUES ($1,$2,$3,$4,$5,$6,$7::text[],$8,$9)
      ON CONFLICT (owner_user_id, kind, key, scope) WHERE key IS NOT NULL DO UPDATE SET text = EXCLUDED.text,
        tags = CASE WHEN cardinality(EXCLUDED.tags) > 0 THEN EXCLUDED.tags ELSE marketing_copilot_memory.tags END, source = EXCLUDED.source,
        pinned = marketing_copilot_memory.pinned OR EXCLUDED.pinned, updated_at = now()
      RETURNING ${select(memoryTable)}`,
      [newId("mktmem"), input.ownerUserId, input.kind, input.key, input.text, input.channel, input.tags, input.source, input.pinned])).rows[0]!;
    return memoryTable.row(row);
  }
  updateMemory(owner: string, id: string, patch: MarketingMemoryPatch) { return this.update(memoryTable, owner, id, patch); }
  async deleteMemory(owner: string, id: string) {
    return ((await this.pool.query("DELETE FROM marketing_copilot_memory WHERE owner_user_id=$1 AND id=$2", [owner, id])) as { rowCount?: number | null }).rowCount! > 0;
  }
  async touchMemories(owner: string, ids: string[]) {
    if (ids.length) await this.pool.query("UPDATE marketing_copilot_memory SET uses = uses + 1, last_used_at = now() WHERE owner_user_id=$1 AND id = ANY($2::text[])", [owner, ids]);
  }
  createEvent(input: MarketingEventCreateRecord) { return this.insert(eventTable, { ...input, id: newId("mktevt") }); }
  async listEvents(owner: string, filter: MarketingEventFilter) {
    return (await this.pool.query<Record<string, unknown>>(`SELECT ${select(eventTable)} FROM marketing_copilot_events WHERE owner_user_id=$1 AND ($2::text IS NULL OR pane_id=$2)
        AND ($3::text IS NULL OR post_id=$3) AND ($4::text[] IS NULL OR type = ANY($4::text[])) AND ($5::text[] IS NULL OR status = ANY($5::text[]))
      ORDER BY created_at DESC, id DESC LIMIT $6`,
      [owner, filter.paneId ?? null, filter.postId ?? null, filter.types?.length ? filter.types : null, filter.status?.length ? filter.status : null, filter.limit])).rows.map(eventTable.row);
  }
  async takeNextBrief(owner: string, paneId: string, staleMs: number) {
    const row = (await this.pool.query<Record<string, unknown>>(`UPDATE marketing_copilot_events SET status='TAKEN',
        payload = payload || jsonb_build_object('takenAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'takenByPaneId', $2::text)
      WHERE id = (SELECT id FROM marketing_copilot_events WHERE owner_user_id=$1 AND type='BRIEF' AND (pane_id IS NULL OR pane_id=$2::text)
        AND (status='PENDING' OR (status='TAKEN' AND (payload->>'takenAt')::timestamptz < now() - ($3::int * interval '1 millisecond')))
        ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING ${select(eventTable)}`, [owner, paneId, staleMs])).rows[0];
    return row ? eventTable.row(row) : null;
  }
  setEventStatus(owner: string, id: string, status: "PENDING" | "TAKEN" | "DONE") { return this.update(eventTable, owner, id, { status }); }
  async getActiveRun(paneId: string) {
    const row = (await this.pool.query<Record<string, unknown>>(`SELECT ${select(runTable)} FROM marketing_copilot_runs WHERE pane_id=$1 AND status IN ('RUNNING','PAUSED') ORDER BY created_at DESC LIMIT 1`, [paneId])).rows[0];
    return row ? runTable.row(row) : null;
  }
  createRun(input: { ownerUserId: string; paneId: string }) { return this.insert(runTable, { ...input, id: newId("mktrun"), status: "RUNNING", counters: emptyCounters }); }
  updateRun(owner: string, id: string, patch: MarketingRunPatch) { return this.update(runTable, owner, id, patch); }
  async listRules(owner: string, status?: MarketingRule["status"][]) {
    return (await this.pool.query<Record<string, unknown>>(`SELECT ${select(ruleTable)} FROM marketing_copilot_rules WHERE owner_user_id=$1 AND ($2::text[] IS NULL OR status = ANY($2))
      ORDER BY created_at DESC LIMIT 500`, [owner, status?.length ? status : null])).rows.map(ruleTable.row);
  }
  getRule(owner: string, id: string) { return this.one(ruleTable, owner, id); }
  createRule(input: MarketingRuleCreateRecord) {
    return this.insert(ruleTable, { ...input, id: newId("mktrule"), ...(input.status === "APPROVED" ? { decidedAt: new Date().toISOString() } : {}) });
  }
  updateRule(owner: string, id: string, patch: MarketingRulePatch) { return this.update(ruleTable, owner, id, patch); }
  async recordMetrics(owner: string, metrics: MarketingMetric[]) {
    for (const metric of metrics) {
      await this.pool.query(`INSERT INTO marketing_copilot_metrics(owner_user_id, day, source, key, value) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (owner_user_id, day, source, key) DO UPDATE SET value = EXCLUDED.value, recorded_at = now()`, [owner, metric.day, metric.source, metric.key, metric.value]);
    }
  }
  async listMetrics(owner: string, sinceDay: string) {
    // to_char: pg turns a date into a local-midnight Date, which shifts the day east of UTC.
    return (await this.pool.query<{ day: string; source: string; key: string; value: unknown }>(`SELECT to_char(day, 'YYYY-MM-DD') AS day, source, key, value FROM marketing_copilot_metrics
      WHERE owner_user_id=$1 AND day >= $2 ORDER BY day, source, key LIMIT 5000`, [owner, sinceDay])).rows
      .map((row) => ({ day: row.day, source: row.source, key: row.key, value: Number(row.value) }));
  }
  async listBookmarks(owner: string) {
    return (await this.pool.query<Record<string, unknown>>(`SELECT ${select(bookmarkTable)} FROM marketing_copilot_bookmarks WHERE owner_user_id=$1 ORDER BY created_at, id LIMIT 500`, [owner])).rows.map(bookmarkTable.row);
  }
  getBookmark(owner: string, id: string) { return this.one(bookmarkTable, owner, id); }
  createBookmark(input: MarketingBookmarkCreateRecord) { return this.insert(bookmarkTable, { ...input, id: newId("mktbm") }); }
  async deleteBookmark(owner: string, id: string) {
    return ((await this.pool.query("DELETE FROM marketing_copilot_bookmarks WHERE owner_user_id=$1 AND id=$2", [owner, id])) as { rowCount?: number | null }).rowCount! > 0;
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
