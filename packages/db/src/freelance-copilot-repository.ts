import { randomBytes } from "node:crypto";
import type {
  FreelanceAccount, FreelanceChannel, FreelanceEvent, FreelanceLead, FreelanceLeadStatus, FreelanceMailboxConfig, FreelanceMemory, FreelanceMemoryQuery, FreelanceMessage,
  FreelanceMessageStatus, FreelanceRule, FreelanceRun
} from "@space/contracts";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

// Freelance Copilot's own storage: leads, the proposals and messages exchanged with clients (review state and
// sending evidence), platform accounts, memory with full-text recall, the activity feed whose briefs and mails are
// the agent's work items, one active run per pane, rules, and the owner's sealed IMAP mailbox. Postgres live,
// in-memory for tests. Shaped like the Marketing Copilot repository.

const newId = (prefix: string) => `${prefix}:${randomBytes(9).toString("base64url")}`;

export type FreelanceLeadCreateRecord = Omit<FreelanceLead, "id" | "createdAt" | "updatedAt">;
export type FreelanceLeadPatch = Partial<Omit<FreelanceLead, "id" | "ownerUserId" | "channel" | "createdAt" | "updatedAt">>;
export interface FreelanceLeadFilter { status?: FreelanceLeadStatus[]; channel?: FreelanceChannel; dueBefore?: string; limit: number }
export type FreelanceMessageCreateRecord = Omit<FreelanceMessage, "id" | "createdAt" | "updatedAt">;
export type FreelanceMessagePatch = Partial<Omit<FreelanceMessage, "id" | "ownerUserId" | "leadId" | "channel" | "direction" | "kind" | "createdAt" | "updatedAt">>;
export interface FreelanceMessageFilter { leadId?: string; status?: FreelanceMessageStatus[]; channel?: FreelanceChannel; limit: number }
export type FreelanceAccountPatch = Partial<Pick<FreelanceAccount, "status" | "email" | "profileUrl" | "notes">>;
export type FreelanceMemoryCreateRecord = Omit<FreelanceMemory, "id" | "uses" | "lastUsedAt" | "createdAt" | "updatedAt">;
export type FreelanceMemoryPatch = Partial<Pick<FreelanceMemory, "text" | "pinned">>;
export type FreelanceEventCreateRecord = Omit<FreelanceEvent, "id" | "createdAt">;
export interface FreelanceEventFilter { paneId?: string | null; leadId?: string | null; types?: string[]; status?: string[]; limit: number }
export type FreelanceRunPatch = Partial<Pick<FreelanceRun, "status" | "counters" | "kickoffSentAt" | "stoppedAt" | "lastActivityAt">>;
export type FreelanceRuleCreateRecord = Omit<FreelanceRule, "id" | "appliedCount" | "lastAppliedAt" | "decidedAt" | "createdAt" | "updatedAt">;
export type FreelanceRulePatch = Partial<Pick<FreelanceRule, "status" | "decidedAt" | "appliedCount" | "lastAppliedAt">>;
export interface FreelanceMailboxRecord { ownerUserId: string; config: FreelanceMailboxConfig; passwordSealed: string; lastUid: number | null; updatedAt: string }

export interface FreelanceCopilotRepository {
  listLeads(owner: string, filter: FreelanceLeadFilter): Promise<FreelanceLead[]>;
  getLead(owner: string, id: string): Promise<FreelanceLead | null>;
  /** The lead with this platform id, or else this URL, on a channel. */
  findLead(owner: string, channel: FreelanceChannel, key: { externalId?: string | null; url?: string | null }): Promise<FreelanceLead | null>;
  createLead(input: FreelanceLeadCreateRecord): Promise<FreelanceLead>;
  /** Updates a lead; with `fromStatus` only while the lead is in one of those states, else null. */
  updateLead(owner: string, id: string, patch: FreelanceLeadPatch, fromStatus?: FreelanceLeadStatus[]): Promise<FreelanceLead | null>;
  listMessages(owner: string, filter: FreelanceMessageFilter): Promise<FreelanceMessage[]>;
  getMessage(owner: string, id: string): Promise<FreelanceMessage | null>;
  createMessage(input: FreelanceMessageCreateRecord): Promise<FreelanceMessage>;
  updateMessage(owner: string, id: string, patch: FreelanceMessagePatch, fromStatus?: FreelanceMessageStatus[]): Promise<FreelanceMessage | null>;
  /** Outgoing messages on a channel since a time: SENT ones by their send time, SENDING ones in flight. */
  countSends(owner: string, channel: FreelanceChannel, since: string): Promise<number>;
  /** Connects spent since a time (SENDING and SENT proposals). */
  sumConnects(owner: string, since: string): Promise<number>;
  listAccounts(owner: string): Promise<FreelanceAccount[]>;
  upsertAccount(owner: string, channel: FreelanceChannel, patch: FreelanceAccountPatch): Promise<FreelanceAccount>;
  getMailbox(owner: string): Promise<FreelanceMailboxRecord | null>;
  setMailbox(owner: string, input: { config: FreelanceMailboxConfig; passwordSealed: string }): Promise<void>;
  deleteMailbox(owner: string): Promise<boolean>;
  setMailboxCursor(owner: string, lastUid: number): Promise<void>;
  listMemory(owner: string, query: FreelanceMemoryQuery): Promise<FreelanceMemory[]>;
  /** Inserts, or replaces the memory with the same kind, key and channel. */
  upsertMemory(input: FreelanceMemoryCreateRecord): Promise<FreelanceMemory>;
  updateMemory(owner: string, id: string, patch: FreelanceMemoryPatch): Promise<FreelanceMemory | null>;
  deleteMemory(owner: string, id: string): Promise<boolean>;
  touchMemories(owner: string, ids: string[]): Promise<void>;
  createEvent(input: FreelanceEventCreateRecord): Promise<FreelanceEvent>;
  listEvents(owner: string, filter: FreelanceEventFilter): Promise<FreelanceEvent[]>;
  /** Atomically takes the oldest PENDING brief or mail (or one TAKEN longer than `staleMs` ago). */
  takeNextWorkItem(owner: string, paneId: string, staleMs: number): Promise<FreelanceEvent | null>;
  setEventStatus(owner: string, id: string, status: "PENDING" | "TAKEN" | "DONE"): Promise<FreelanceEvent | null>;
  getActiveRun(paneId: string): Promise<FreelanceRun | null>;
  createRun(input: { ownerUserId: string; paneId: string }): Promise<FreelanceRun>;
  updateRun(owner: string, id: string, patch: FreelanceRunPatch): Promise<FreelanceRun | null>;
  listRules(owner: string, status?: FreelanceRule["status"][]): Promise<FreelanceRule[]>;
  getRule(owner: string, id: string): Promise<FreelanceRule | null>;
  createRule(input: FreelanceRuleCreateRecord): Promise<FreelanceRule>;
  updateRule(owner: string, id: string, patch: FreelanceRulePatch): Promise<FreelanceRule | null>;
  dispose(): Promise<void>;
}

const emptyCounters = { taken: 0, drafted: 0, sent: 0, failed: 0, needsUser: 0 };
const WORK_ITEM_TYPES = ["BRIEF", "MAIL"];
const defined = <T extends object>(patch: T) => Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<T>;
const byNewest = <T extends { createdAt: string; id: string }>(left: T, right: T) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
function tokens(text: string): string[] { return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 1); }

export class InMemoryFreelanceCopilotRepository implements FreelanceCopilotRepository {
  private leads = new Map<string, FreelanceLead>();
  private messages = new Map<string, FreelanceMessage>();
  private accounts = new Map<string, FreelanceAccount>();
  private mailboxes = new Map<string, FreelanceMailboxRecord>();
  private memories = new Map<string, FreelanceMemory>();
  private events: FreelanceEvent[] = [];
  private runs = new Map<string, FreelanceRun>();
  private rules = new Map<string, FreelanceRule>();
  constructor(private now: () => string = () => new Date().toISOString()) {}
  private owned<T extends { ownerUserId: string }>(map: Map<string, T>, owner: string, id: string): T | null { const row = map.get(id); return row && row.ownerUserId === owner ? row : null; }

  async listLeads(owner: string, filter: FreelanceLeadFilter) {
    return [...this.leads.values()].filter((row) => row.ownerUserId === owner && (!filter.status?.length || filter.status.includes(row.status)) && (!filter.channel || row.channel === filter.channel)
      && (!filter.dueBefore || (row.nextActionAt !== null && row.nextActionAt <= filter.dueBefore)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, filter.limit).map((row) => ({ ...row }));
  }
  async getLead(owner: string, id: string) { const row = this.owned(this.leads, owner, id); return row ? { ...row } : null; }
  async findLead(owner: string, channel: FreelanceChannel, key: { externalId?: string | null; url?: string | null }) {
    const row = [...this.leads.values()].find((lead) => lead.ownerUserId === owner && lead.channel === channel
      && ((key.externalId && lead.externalId === key.externalId) || (key.url && lead.url === key.url)));
    return row ? { ...row } : null;
  }
  async createLead(input: FreelanceLeadCreateRecord) {
    const at = this.now();
    const row: FreelanceLead = { ...input, id: newId("fllead"), createdAt: at, updatedAt: at };
    this.leads.set(row.id, row);
    return { ...row };
  }
  async updateLead(owner: string, id: string, patch: FreelanceLeadPatch, fromStatus?: FreelanceLeadStatus[]) {
    const row = this.owned(this.leads, owner, id);
    if (!row || (fromStatus && !fromStatus.includes(row.status))) return null;
    const next = { ...row, ...defined(patch), updatedAt: this.now() };
    this.leads.set(id, next);
    return { ...next };
  }
  async listMessages(owner: string, filter: FreelanceMessageFilter) {
    return [...this.messages.values()].filter((row) => row.ownerUserId === owner && (!filter.leadId || row.leadId === filter.leadId)
      && (!filter.status?.length || filter.status.includes(row.status)) && (!filter.channel || row.channel === filter.channel))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0, filter.limit).map((row) => ({ ...row }));
  }
  async getMessage(owner: string, id: string) { const row = this.owned(this.messages, owner, id); return row ? { ...row } : null; }
  async createMessage(input: FreelanceMessageCreateRecord) {
    const at = this.now();
    const row: FreelanceMessage = { ...input, id: newId("flmsg"), createdAt: at, updatedAt: at };
    this.messages.set(row.id, row);
    return { ...row };
  }
  async updateMessage(owner: string, id: string, patch: FreelanceMessagePatch, fromStatus?: FreelanceMessageStatus[]) {
    const row = this.owned(this.messages, owner, id);
    if (!row || (fromStatus && !fromStatus.includes(row.status))) return null;
    const next = { ...row, ...defined(patch), updatedAt: this.now() };
    this.messages.set(id, next);
    return { ...next };
  }
  private sent(owner: string, since: string) {
    return [...this.messages.values()].filter((row) => row.ownerUserId === owner && row.direction === "OUT"
      && (row.status === "SENDING" || (row.status === "SENT" && (row.sentAt ?? row.updatedAt) >= since)));
  }
  async countSends(owner: string, channel: FreelanceChannel, since: string) { return this.sent(owner, since).filter((row) => row.channel === channel).length; }
  async sumConnects(owner: string, since: string) { return this.sent(owner, since).reduce((sum, row) => sum + (row.connects ?? 0), 0); }
  async listAccounts(owner: string) { return [...this.accounts.values()].filter((row) => row.ownerUserId === owner).map((row) => ({ ...row })); }
  async upsertAccount(owner: string, channel: FreelanceChannel, patch: FreelanceAccountPatch) {
    const key = `${owner}|${channel}`;
    const current = this.accounts.get(key) ?? { ownerUserId: owner, channel, status: "NOT_STARTED" as const, email: null, profileUrl: null, notes: null, updatedAt: this.now() };
    const next = { ...current, ...defined(patch), updatedAt: this.now() };
    this.accounts.set(key, next);
    return { ...next };
  }
  async getMailbox(owner: string) { const row = this.mailboxes.get(owner); return row ? { ...row } : null; }
  async setMailbox(owner: string, input: { config: FreelanceMailboxConfig; passwordSealed: string }) {
    this.mailboxes.set(owner, { ownerUserId: owner, config: input.config, passwordSealed: input.passwordSealed, lastUid: null, updatedAt: this.now() });
  }
  async deleteMailbox(owner: string) { return this.mailboxes.delete(owner); }
  async setMailboxCursor(owner: string, lastUid: number) { const row = this.mailboxes.get(owner); if (row) this.mailboxes.set(owner, { ...row, lastUid, updatedAt: this.now() }); }
  async listMemory(owner: string, query: FreelanceMemoryQuery) {
    const words = tokens(query.query ?? "");
    const score = (row: FreelanceMemory) => {
      if (!words.length) return 0;
      const haystack = new Set(tokens(`${row.key ?? ""} ${row.text} ${row.tags.join(" ")}`));
      return words.filter((word) => haystack.has(word)).length / words.length;
    };
    return [...this.memories.values()].filter((row) => row.ownerUserId === owner && (!query.kinds?.length || query.kinds.includes(row.kind))
      && (!query.channel || !row.channel || row.channel === query.channel) && (!words.length || score(row) > 0))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || score(b) - score(a) || b.uses - a.uses || b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, query.limit).map((row) => ({ ...row }));
  }
  async upsertMemory(input: FreelanceMemoryCreateRecord) {
    const at = this.now();
    const existing = input.key ? [...this.memories.values()].find((row) => row.ownerUserId === input.ownerUserId && row.kind === input.kind && row.key === input.key && row.channel === input.channel) : undefined;
    if (existing) {
      const next = { ...existing, text: input.text, tags: input.tags.length ? input.tags : existing.tags, source: input.source, pinned: existing.pinned || input.pinned, updatedAt: at };
      this.memories.set(existing.id, next);
      return { ...next };
    }
    const row: FreelanceMemory = { ...input, id: newId("flmem"), uses: 0, lastUsedAt: null, createdAt: at, updatedAt: at };
    this.memories.set(row.id, row);
    return { ...row };
  }
  async updateMemory(owner: string, id: string, patch: FreelanceMemoryPatch) {
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
  async createEvent(input: FreelanceEventCreateRecord) {
    const row: FreelanceEvent = { ...input, id: newId("flevt"), createdAt: this.now() };
    this.events.push(row);
    return { ...row };
  }
  async listEvents(owner: string, filter: FreelanceEventFilter) {
    return this.events.filter((row) => row.ownerUserId === owner && (!filter.paneId || row.paneId === filter.paneId) && (!filter.leadId || row.leadId === filter.leadId)
      && (!filter.types?.length || filter.types.includes(row.type)) && (!filter.status?.length || (row.status !== null && filter.status.includes(row.status))))
      .sort(byNewest).slice(0, filter.limit).map((row) => ({ ...row }));
  }
  async takeNextWorkItem(owner: string, paneId: string, staleMs: number) {
    const at = this.now();
    const stale = new Date(Date.parse(at) - staleMs).toISOString();
    const index = this.events.findIndex((row) => row.ownerUserId === owner && WORK_ITEM_TYPES.includes(row.type) && (row.status === "PENDING" || (row.status === "TAKEN" && String(row.payload.takenAt ?? "") < stale)));
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
    const row: FreelanceRun = { id: newId("flrun"), ownerUserId: input.ownerUserId, paneId: input.paneId, status: "RUNNING", counters: { ...emptyCounters }, kickoffSentAt: null,
      startedAt: at, stoppedAt: null, lastActivityAt: at, createdAt: at, updatedAt: at };
    this.runs.set(row.id, row);
    return { ...row };
  }
  async updateRun(owner: string, id: string, patch: FreelanceRunPatch) {
    const row = this.owned(this.runs, owner, id);
    if (!row) return null;
    const next = { ...row, ...defined(patch), updatedAt: this.now() };
    this.runs.set(id, next);
    return { ...next };
  }
  async listRules(owner: string, status?: FreelanceRule["status"][]) {
    return [...this.rules.values()].filter((row) => row.ownerUserId === owner && (!status?.length || status.includes(row.status))).sort(byNewest).map((row) => ({ ...row }));
  }
  async getRule(owner: string, id: string) { const row = this.owned(this.rules, owner, id); return row ? { ...row } : null; }
  async createRule(input: FreelanceRuleCreateRecord) {
    const at = this.now();
    const row: FreelanceRule = { ...input, id: newId("flrule"), appliedCount: 0, lastAppliedAt: null, decidedAt: input.status === "APPROVED" ? at : null, createdAt: at, updatedAt: at };
    this.rules.set(row.id, row);
    return { ...row };
  }
  async updateRule(owner: string, id: string, patch: FreelanceRulePatch) {
    const row = this.owned(this.rules, owner, id);
    if (!row) return null;
    const next = { ...row, ...defined(patch), updatedAt: this.now() };
    this.rules.set(id, next);
    return { ...next };
  }
  async dispose() {}
}

// ---- Postgres ------------------------------------------------------------------------------------
const iso = (value: unknown): string | null => value === null || value === undefined ? null : value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** A JSON column's parameter; null stays SQL NULL (a nullable jsonb column such as a message's bid). */
const jsonValue = (value: unknown) => value === null ? null : JSON.stringify(value);

interface Table<T> { name: string; columns: Record<string, string>; json: ReadonlySet<string>; arrays: ReadonlySet<string>; row(raw: Record<string, unknown>): T }
const select = (table: Table<unknown>) => Object.entries(table.columns).map(([field, column]) => `${column} AS "${field}"`).join(", ");
/** `SET col = $n, ...` for the defined fields of a patch, numbering placeholders from `start`. */
function setClause(table: Table<unknown>, patch: Record<string, unknown>, start: number): { sql: string; values: unknown[] } {
  const entries = Object.entries(patch).filter(([field, value]) => value !== undefined && table.columns[field]);
  const sql = entries.map(([field], index) => `${table.columns[field]} = $${start + index}${table.json.has(field) ? "::jsonb" : table.arrays.has(field) ? "::text[]" : ""}`);
  // Tables with an updatedAt column (every one but the append-only events) stamp it.
  return { sql: [...sql, ...(table.columns.updatedAt ? ["updated_at = now()"] : [])].join(", "), values: entries.map(([field, value]) => table.json.has(field) ? jsonValue(value) : value) };
}

const leadTable: Table<FreelanceLead> = {
  name: "freelance_copilot_leads",
  columns: { id: "id", ownerUserId: "owner_user_id", paneId: "pane_id", channel: "channel", url: "url", externalId: "external_id", title: "title", client: "client", description: "description",
    budget: "budget", score: "score", status: "status", nextActionAt: "next_action_at", contractValue: "contract_value", notes: "notes", payload: "payload", createdAt: "created_at", updatedAt: "updated_at" },
  json: new Set(["payload"]), arrays: new Set(),
  row: (raw) => ({ ...(raw as unknown as FreelanceLead), score: raw.score === null || raw.score === undefined ? null : Number(raw.score), contractValue: raw.contractValue === null || raw.contractValue === undefined ? null : Number(raw.contractValue),
    payload: object(raw.payload), nextActionAt: iso(raw.nextActionAt), createdAt: iso(raw.createdAt)!, updatedAt: iso(raw.updatedAt)! })
};
const messageTable: Table<FreelanceMessage> = {
  name: "freelance_copilot_messages",
  columns: { id: "id", ownerUserId: "owner_user_id", paneId: "pane_id", leadId: "lead_id", channel: "channel", direction: "direction", kind: "kind", body: "body", bid: "bid", connects: "connects",
    status: "status", reviewNote: "review_note", ruleId: "rule_id", sentUrl: "sent_url", sentAt: "sent_at", evidence: "evidence", createdAt: "created_at", updatedAt: "updated_at" },
  json: new Set(["bid", "evidence"]), arrays: new Set(),
  row: (raw) => ({ ...(raw as unknown as FreelanceMessage), bid: raw.bid && typeof raw.bid === "object" ? raw.bid as FreelanceMessage["bid"] : null, connects: raw.connects === null || raw.connects === undefined ? null : Number(raw.connects),
    evidence: object(raw.evidence), sentAt: iso(raw.sentAt), createdAt: iso(raw.createdAt)!, updatedAt: iso(raw.updatedAt)! })
};
const accountTable: Table<FreelanceAccount> = {
  name: "freelance_copilot_accounts",
  columns: { ownerUserId: "owner_user_id", channel: "channel", status: "status", email: "email", profileUrl: "profile_url", notes: "notes", updatedAt: "updated_at" },
  json: new Set(), arrays: new Set(),
  row: (raw) => ({ ...(raw as unknown as FreelanceAccount), updatedAt: iso(raw.updatedAt)! })
};
const memoryTable: Table<FreelanceMemory> = {
  name: "freelance_copilot_memory",
  columns: { id: "id", ownerUserId: "owner_user_id", kind: "kind", key: "key", text: "text", channel: "channel", tags: "tags", source: "source", uses: "uses", pinned: "pinned", lastUsedAt: "last_used_at", createdAt: "created_at", updatedAt: "updated_at" },
  json: new Set(), arrays: new Set(["tags"]),
  row: (raw) => ({ ...(raw as unknown as FreelanceMemory), tags: (raw.tags as string[] | null) ?? [], uses: Number(raw.uses), lastUsedAt: iso(raw.lastUsedAt), createdAt: iso(raw.createdAt)!, updatedAt: iso(raw.updatedAt)! })
};
const eventTable: Table<FreelanceEvent> = {
  name: "freelance_copilot_events",
  columns: { id: "id", ownerUserId: "owner_user_id", paneId: "pane_id", runId: "run_id", leadId: "lead_id", messageId: "message_id", type: "type", status: "status", message: "message", payload: "payload", createdAt: "created_at" },
  json: new Set(["payload"]), arrays: new Set(),
  row: (raw) => ({ ...(raw as unknown as FreelanceEvent), payload: object(raw.payload), createdAt: iso(raw.createdAt)! })
};
const runTable: Table<FreelanceRun> = {
  name: "freelance_copilot_runs",
  columns: { id: "id", ownerUserId: "owner_user_id", paneId: "pane_id", status: "status", counters: "counters", kickoffSentAt: "kickoff_sent_at", startedAt: "started_at", stoppedAt: "stopped_at", lastActivityAt: "last_activity_at", createdAt: "created_at", updatedAt: "updated_at" },
  json: new Set(["counters"]), arrays: new Set(),
  row: (raw) => ({ ...(raw as unknown as FreelanceRun), counters: { ...emptyCounters, ...object(raw.counters) as Record<string, number> }, kickoffSentAt: iso(raw.kickoffSentAt), startedAt: iso(raw.startedAt)!,
    stoppedAt: iso(raw.stoppedAt), lastActivityAt: iso(raw.lastActivityAt)!, createdAt: iso(raw.createdAt)!, updatedAt: iso(raw.updatedAt)! })
};
const ruleTable: Table<FreelanceRule> = {
  name: "freelance_copilot_rules",
  columns: { id: "id", ownerUserId: "owner_user_id", name: "name", channel: "channel", kinds: "kinds", status: "status", evidence: "evidence", proposedBy: "proposed_by",
    appliedCount: "applied_count", lastAppliedAt: "last_applied_at", decidedAt: "decided_at", createdAt: "created_at", updatedAt: "updated_at" },
  json: new Set(), arrays: new Set(["kinds", "evidence"]),
  row: (raw) => ({ ...(raw as unknown as FreelanceRule), kinds: (raw.kinds as FreelanceRule["kinds"] | null) ?? [], evidence: (raw.evidence as string[] | null) ?? [], appliedCount: Number(raw.appliedCount),
    lastAppliedAt: iso(raw.lastAppliedAt), decidedAt: iso(raw.decidedAt), createdAt: iso(raw.createdAt)!, updatedAt: iso(raw.updatedAt)! })
};
/** `websearch_to_tsquery` accepts free text safely; an empty query matches everything. */
function searchText(query: string | null | undefined): string | null {
  const text = (query ?? "").replace(/[^\p{L}\p{N}\s'"@.-]+/gu, " ").trim();
  return text.length > 0 ? text.slice(0, 500) : null;
}

export class PostgresFreelanceCopilotRepository implements FreelanceCopilotRepository {
  constructor(private pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresFreelanceCopilotRepository(createSpacePgPool(url, { max: 2 })); }
  private async insert<T>(table: Table<T>, values: Record<string, unknown>): Promise<T> {
    const fields = Object.keys(values).filter((field) => table.columns[field]);
    const placeholders = fields.map((field, index) => `$${index + 1}${table.json.has(field) ? "::jsonb" : table.arrays.has(field) ? "::text[]" : ""}`);
    const row = (await this.pool.query<Record<string, unknown>>(`INSERT INTO ${table.name}(${fields.map((field) => table.columns[field]).join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING ${select(table)}`,
      fields.map((field) => table.json.has(field) ? jsonValue(values[field]) : values[field]))).rows[0]!;
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

  async listLeads(owner: string, filter: FreelanceLeadFilter) {
    return (await this.pool.query<Record<string, unknown>>(`SELECT ${select(leadTable)} FROM freelance_copilot_leads WHERE owner_user_id=$1 AND ($2::text[] IS NULL OR status = ANY($2))
      AND ($3::text IS NULL OR channel=$3) AND ($4::timestamptz IS NULL OR (next_action_at IS NOT NULL AND next_action_at <= $4)) ORDER BY updated_at DESC LIMIT $5`,
      [owner, filter.status?.length ? filter.status : null, filter.channel ?? null, filter.dueBefore ?? null, filter.limit])).rows.map(leadTable.row);
  }
  getLead(owner: string, id: string) { return this.one(leadTable, owner, id); }
  async findLead(owner: string, channel: FreelanceChannel, key: { externalId?: string | null; url?: string | null }) {
    if (!key.externalId && !key.url) return null;
    const row = (await this.pool.query<Record<string, unknown>>(`SELECT ${select(leadTable)} FROM freelance_copilot_leads WHERE owner_user_id=$1 AND channel=$2
      AND (($3::text IS NOT NULL AND external_id=$3) OR ($4::text IS NOT NULL AND url=$4)) ORDER BY created_at ASC LIMIT 1`, [owner, channel, key.externalId ?? null, key.url ?? null])).rows[0];
    return row ? leadTable.row(row) : null;
  }
  createLead(input: FreelanceLeadCreateRecord) { return this.insert(leadTable, { ...input, id: newId("fllead") }); }
  updateLead(owner: string, id: string, patch: FreelanceLeadPatch, fromStatus?: FreelanceLeadStatus[]) {
    return fromStatus ? this.update(leadTable, owner, id, patch, "AND status = ANY($3::text[])", [fromStatus]) : this.update(leadTable, owner, id, patch);
  }
  async listMessages(owner: string, filter: FreelanceMessageFilter) {
    return (await this.pool.query<Record<string, unknown>>(`SELECT ${select(messageTable)} FROM freelance_copilot_messages WHERE owner_user_id=$1 AND ($2::text IS NULL OR lead_id=$2)
      AND ($3::text[] IS NULL OR status = ANY($3)) AND ($4::text IS NULL OR channel=$4) ORDER BY created_at DESC, id DESC LIMIT $5`,
      [owner, filter.leadId ?? null, filter.status?.length ? filter.status : null, filter.channel ?? null, filter.limit])).rows.map(messageTable.row);
  }
  getMessage(owner: string, id: string) { return this.one(messageTable, owner, id); }
  createMessage(input: FreelanceMessageCreateRecord) { return this.insert(messageTable, { ...input, id: newId("flmsg") }); }
  updateMessage(owner: string, id: string, patch: FreelanceMessagePatch, fromStatus?: FreelanceMessageStatus[]) {
    return fromStatus ? this.update(messageTable, owner, id, patch, "AND status = ANY($3::text[])", [fromStatus]) : this.update(messageTable, owner, id, patch);
  }
  async countSends(owner: string, channel: FreelanceChannel, since: string) {
    const row = (await this.pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM freelance_copilot_messages WHERE owner_user_id=$1 AND channel=$2 AND direction='OUT'
      AND (status='SENDING' OR (status='SENT' AND coalesce(sent_at, updated_at) >= $3))`, [owner, channel, since])).rows[0];
    return Number.parseInt(row?.count ?? "0", 10);
  }
  async sumConnects(owner: string, since: string) {
    const row = (await this.pool.query<{ total: string }>(`SELECT coalesce(sum(connects), 0)::text AS total FROM freelance_copilot_messages WHERE owner_user_id=$1 AND direction='OUT'
      AND (status='SENDING' OR (status='SENT' AND coalesce(sent_at, updated_at) >= $2))`, [owner, since])).rows[0];
    return Number.parseInt(row?.total ?? "0", 10);
  }
  async listAccounts(owner: string) {
    return (await this.pool.query<Record<string, unknown>>(`SELECT ${select(accountTable)} FROM freelance_copilot_accounts WHERE owner_user_id=$1 ORDER BY channel`, [owner])).rows.map(accountTable.row);
  }
  async upsertAccount(owner: string, channel: FreelanceChannel, patch: FreelanceAccountPatch) {
    const row = (await this.pool.query<Record<string, unknown>>(`INSERT INTO freelance_copilot_accounts(owner_user_id, channel, status, email, profile_url, notes)
      VALUES ($1, $2, coalesce($3, 'NOT_STARTED'), $4, $5, $6)
      ON CONFLICT (owner_user_id, channel) DO UPDATE SET status = coalesce($3, freelance_copilot_accounts.status),
        email = CASE WHEN $7 THEN $4 ELSE freelance_copilot_accounts.email END, profile_url = CASE WHEN $8 THEN $5 ELSE freelance_copilot_accounts.profile_url END,
        notes = CASE WHEN $9 THEN $6 ELSE freelance_copilot_accounts.notes END, updated_at = now()
      RETURNING ${select(accountTable)}`,
      [owner, channel, patch.status ?? null, patch.email ?? null, patch.profileUrl ?? null, patch.notes ?? null, patch.email !== undefined, patch.profileUrl !== undefined, patch.notes !== undefined])).rows[0]!;
    return accountTable.row(row);
  }
  async getMailbox(owner: string) {
    const row = (await this.pool.query<Record<string, unknown>>(`SELECT owner_user_id AS "ownerUserId", config, password_sealed AS "passwordSealed", last_uid AS "lastUid", updated_at AS "updatedAt"
      FROM freelance_copilot_mailboxes WHERE owner_user_id=$1`, [owner])).rows[0];
    return row ? { ownerUserId: String(row.ownerUserId), config: object(row.config) as unknown as FreelanceMailboxConfig, passwordSealed: String(row.passwordSealed),
      lastUid: row.lastUid === null || row.lastUid === undefined ? null : Number(row.lastUid), updatedAt: iso(row.updatedAt)! } : null;
  }
  async setMailbox(owner: string, input: { config: FreelanceMailboxConfig; passwordSealed: string }) {
    await this.pool.query(`INSERT INTO freelance_copilot_mailboxes(owner_user_id, config, password_sealed) VALUES ($1, $2::jsonb, $3)
      ON CONFLICT (owner_user_id) DO UPDATE SET config = EXCLUDED.config, password_sealed = EXCLUDED.password_sealed, last_uid = NULL, updated_at = now()`, [owner, JSON.stringify(input.config), input.passwordSealed]);
  }
  async deleteMailbox(owner: string) {
    return ((await this.pool.query("DELETE FROM freelance_copilot_mailboxes WHERE owner_user_id=$1", [owner])) as { rowCount?: number | null }).rowCount! > 0;
  }
  async setMailboxCursor(owner: string, lastUid: number) {
    await this.pool.query("UPDATE freelance_copilot_mailboxes SET last_uid=$2, updated_at=now() WHERE owner_user_id=$1", [owner, lastUid]);
  }
  async listMemory(owner: string, query: FreelanceMemoryQuery) {
    const text = searchText(query.query);
    return (await this.pool.query<Record<string, unknown>>(`SELECT ${select(memoryTable)} FROM freelance_copilot_memory WHERE owner_user_id=$1 AND ($3::text[] IS NULL OR kind = ANY($3::text[]))
        AND ($4::text IS NULL OR channel IS NULL OR channel=$4) AND ($2::text IS NULL OR search @@ websearch_to_tsquery('simple', $2))
      ORDER BY pinned DESC, CASE WHEN $2::text IS NULL THEN 0 ELSE ts_rank(search, websearch_to_tsquery('simple', $2)) END DESC, uses DESC, updated_at DESC LIMIT $5`,
      [owner, text, query.kinds?.length ? query.kinds : null, query.channel ?? null, query.limit])).rows.map(memoryTable.row);
  }
  async upsertMemory(input: FreelanceMemoryCreateRecord) {
    const row = (await this.pool.query<Record<string, unknown>>(`INSERT INTO freelance_copilot_memory(id, owner_user_id, kind, key, text, channel, tags, source, pinned)
      VALUES ($1,$2,$3,$4,$5,$6,$7::text[],$8,$9)
      ON CONFLICT (owner_user_id, kind, key, scope) WHERE key IS NOT NULL DO UPDATE SET text = EXCLUDED.text,
        tags = CASE WHEN cardinality(EXCLUDED.tags) > 0 THEN EXCLUDED.tags ELSE freelance_copilot_memory.tags END, source = EXCLUDED.source,
        pinned = freelance_copilot_memory.pinned OR EXCLUDED.pinned, updated_at = now()
      RETURNING ${select(memoryTable)}`,
      [newId("flmem"), input.ownerUserId, input.kind, input.key, input.text, input.channel, input.tags, input.source, input.pinned])).rows[0]!;
    return memoryTable.row(row);
  }
  updateMemory(owner: string, id: string, patch: FreelanceMemoryPatch) { return this.update(memoryTable, owner, id, patch); }
  async deleteMemory(owner: string, id: string) {
    return ((await this.pool.query("DELETE FROM freelance_copilot_memory WHERE owner_user_id=$1 AND id=$2", [owner, id])) as { rowCount?: number | null }).rowCount! > 0;
  }
  async touchMemories(owner: string, ids: string[]) {
    if (ids.length) await this.pool.query("UPDATE freelance_copilot_memory SET uses = uses + 1, last_used_at = now() WHERE owner_user_id=$1 AND id = ANY($2::text[])", [owner, ids]);
  }
  createEvent(input: FreelanceEventCreateRecord) { return this.insert(eventTable, { ...input, id: newId("flevt") }); }
  async listEvents(owner: string, filter: FreelanceEventFilter) {
    return (await this.pool.query<Record<string, unknown>>(`SELECT ${select(eventTable)} FROM freelance_copilot_events WHERE owner_user_id=$1 AND ($2::text IS NULL OR pane_id=$2)
        AND ($3::text IS NULL OR lead_id=$3) AND ($4::text[] IS NULL OR type = ANY($4::text[])) AND ($5::text[] IS NULL OR status = ANY($5::text[]))
      ORDER BY created_at DESC, id DESC LIMIT $6`,
      [owner, filter.paneId ?? null, filter.leadId ?? null, filter.types?.length ? filter.types : null, filter.status?.length ? filter.status : null, filter.limit])).rows.map(eventTable.row);
  }
  async takeNextWorkItem(owner: string, paneId: string, staleMs: number) {
    const row = (await this.pool.query<Record<string, unknown>>(`UPDATE freelance_copilot_events SET status='TAKEN',
        payload = payload || jsonb_build_object('takenAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'takenByPaneId', $2::text)
      WHERE id = (SELECT id FROM freelance_copilot_events WHERE owner_user_id=$1 AND type IN ('BRIEF','MAIL')
        AND (status='PENDING' OR (status='TAKEN' AND (payload->>'takenAt')::timestamptz < now() - ($3::int * interval '1 millisecond')))
        ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING ${select(eventTable)}`, [owner, paneId, staleMs])).rows[0];
    return row ? eventTable.row(row) : null;
  }
  setEventStatus(owner: string, id: string, status: "PENDING" | "TAKEN" | "DONE") { return this.update(eventTable, owner, id, { status }); }
  async getActiveRun(paneId: string) {
    const row = (await this.pool.query<Record<string, unknown>>(`SELECT ${select(runTable)} FROM freelance_copilot_runs WHERE pane_id=$1 AND status IN ('RUNNING','PAUSED') ORDER BY created_at DESC LIMIT 1`, [paneId])).rows[0];
    return row ? runTable.row(row) : null;
  }
  createRun(input: { ownerUserId: string; paneId: string }) { return this.insert(runTable, { ...input, id: newId("flrun"), status: "RUNNING", counters: emptyCounters }); }
  updateRun(owner: string, id: string, patch: FreelanceRunPatch) { return this.update(runTable, owner, id, patch); }
  async listRules(owner: string, status?: FreelanceRule["status"][]) {
    return (await this.pool.query<Record<string, unknown>>(`SELECT ${select(ruleTable)} FROM freelance_copilot_rules WHERE owner_user_id=$1 AND ($2::text[] IS NULL OR status = ANY($2))
      ORDER BY created_at DESC LIMIT 500`, [owner, status?.length ? status : null])).rows.map(ruleTable.row);
  }
  getRule(owner: string, id: string) { return this.one(ruleTable, owner, id); }
  createRule(input: FreelanceRuleCreateRecord) {
    return this.insert(ruleTable, { ...input, id: newId("flrule"), ...(input.status === "APPROVED" ? { decidedAt: new Date().toISOString() } : {}) });
  }
  updateRule(owner: string, id: string, patch: FreelanceRulePatch) { return this.update(ruleTable, owner, id, patch); }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
