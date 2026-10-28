import { randomUUID } from "node:crypto";
import {
  nousDecisionSchema, nousMessageSchema, nousTurnFactsSchema,
  type NousDecision, type NousDecisionStatus, type NousMessage, type NousMessageKind, type NousMessageStatus, type NousTurnFacts
} from "@space/contracts";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

// Nous, the mind of SpaceApp (migration 0211): its conversation, the critical decisions it asks the operator and its
// own notes; its turn facts (migration 0212). The API's Nous service is the only writer. Postgres on the live instances, in-memory for tests.

export interface NousNote { key: string; text: string; updatedAt: string }
export interface NewNousMessage {
  ownerUserId: string; turnId: string | null; kind: NousMessageKind; status: NousMessageStatus; content: string; meta?: Record<string, unknown>;
}
export type NewNousDecision = Omit<NousDecision, "id" | "status" | "answer" | "outcome" | "createdAt" | "answeredAt" | "couldHaveDecided">;

export interface NousRepository {
  addMessage(message: NewNousMessage): Promise<NousMessage>;
  updateMessage(owner: string, id: string, patch: { status?: NousMessageStatus; content?: string; meta?: Record<string, unknown> }): Promise<NousMessage | null>;
  /** The newest `limit` messages, oldest first. */
  listMessages(owner: string, limit: number): Promise<NousMessage[]>;
  clearMessages(owner: string): Promise<number>;
  createDecision(decision: NewNousDecision): Promise<NousDecision>;
  getDecision(owner: string, id: string): Promise<NousDecision | null>;
  /** Newest first; without `limit` every match (the dock lists every OPEN decision, however old). */
  listDecisions(owner: string, options: { statuses?: NousDecisionStatus[]; limit?: number }): Promise<NousDecision[]>;
  /** Moves an OPEN decision; null when it is no longer open (answered twice, cancelled). */
  answerDecision(owner: string, id: string, patch: { status: Exclude<NousDecisionStatus, "OPEN">; answer: string | null }): Promise<NousDecision | null>;
  setDecisionOutcome(owner: string, id: string, outcome: string): Promise<void>;
  /** The operator's feedback on an answered decision; null when it does not exist or is still open. */
  setDecisionFeedback(owner: string, id: string, couldHaveDecided: boolean): Promise<NousDecision | null>;
  listNotes(owner: string): Promise<NousNote[]>;
  /** Null text deletes the note. */
  setNote(owner: string, key: string, text: string | null): Promise<void>;
  /** Turns run inside the API process: rows a stopped process left RUNNING become FAILED. */
  failRunning(note: string): Promise<number>;
  /** One row per turn; clearing the conversation keeps them. */
  addTurnFacts(facts: NousTurnFacts): Promise<void>;
  /** The owner's turns that started at or after `since`, oldest first. */
  listTurnFacts(owner: string, since: string): Promise<NousTurnFacts[]>;
  /** Goal 7365014c-e: one row per operator answer to a decision or needs-you card; rows older than 180 days go (class B). */
  appendLedger(row: NewNousLedgerRow): Promise<void>;
  /** The owner's ledger rows at or after `since`, newest first. */
  listLedger(owner: string, since: string): Promise<NousLedgerRow[]>;
  dispose(): Promise<void>;
}

export interface NewNousLedgerRow { ownerUserId: string; source: string; kind: string; title: string; predicted: string | null; answer: string; match: boolean | null; ref: string | null }
export interface NousLedgerRow extends NewNousLedgerRow { at: string }
const LEDGER_KEEP_MS = 180 * 86_400_000;
const ledgerRow = (row: NewNousLedgerRow): NewNousLedgerRow => ({ ...row, source: clip(row.source, 60), kind: clip(row.kind, 2_000), title: clip(row.title.trim() || "(untitled)", 300),
  predicted: row.predicted === null ? null : clip(row.predicted, 200), answer: clip(row.answer.trim() || "(no text)", 500), ref: row.ref === null ? null : clip(row.ref, 200) });

const newId = (prefix: string) => `${prefix}:${randomUUID().replace(/-/g, "").slice(0, 24)}`;
const now = () => new Date().toISOString();
const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
/**
 * Message meta as JSON Postgres accepts: a tool result clipped inside an emoji left half a surrogate pair, which JSON.stringify
 * writes as "\ud83d" and jsonb refuses (stable 2026-10-22: two space_notifications calls answered 500 after their work was done).
 */
const metaJson = (meta: Record<string, unknown>) => JSON.stringify(meta, (_key, value: unknown) => typeof value === "string"
  ? value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD") : value);

export class InMemoryNousRepository implements NousRepository {
  private readonly messages: NousMessage[] = [];
  private readonly decisions = new Map<string, NousDecision>();
  private readonly notes = new Map<string, NousNote>();
  private readonly turns: NousTurnFacts[] = [];
  private ledger: NousLedgerRow[] = [];

  async addMessage(input: NewNousMessage) {
    const at = now();
    const message = nousMessageSchema.parse({ ...input, id: newId("nous_msg"), content: clip(input.content, 20_000), meta: input.meta ?? {}, createdAt: at, updatedAt: at });
    this.messages.push(message);
    return structuredClone(message);
  }
  async updateMessage(owner: string, id: string, patch: { status?: NousMessageStatus; content?: string; meta?: Record<string, unknown> }) {
    const message = this.messages.find((entry) => entry.id === id && entry.ownerUserId === owner);
    if (!message) return null;
    Object.assign(message, { ...patch, ...(patch.content !== undefined ? { content: clip(patch.content, 20_000) } : {}), updatedAt: now() });
    return structuredClone(message);
  }
  async listMessages(owner: string, limit: number) {
    return structuredClone(this.messages.filter((message) => message.ownerUserId === owner).slice(-limit));
  }
  async clearMessages(owner: string) {
    const before = this.messages.length;
    for (let index = this.messages.length - 1; index >= 0; index -= 1) if (this.messages[index]!.ownerUserId === owner) this.messages.splice(index, 1);
    return before - this.messages.length;
  }
  async createDecision(input: NewNousDecision) {
    const decision = nousDecisionSchema.parse({ ...input, id: newId("nous_decision"), status: "OPEN", answer: null, outcome: null, createdAt: now(), answeredAt: null, couldHaveDecided: false });
    this.decisions.set(decision.id, decision);
    return structuredClone(decision);
  }
  async getDecision(owner: string, id: string) {
    const decision = this.decisions.get(id);
    return decision && decision.ownerUserId === owner ? structuredClone(decision) : null;
  }
  async listDecisions(owner: string, options: { statuses?: NousDecisionStatus[]; limit?: number }) {
    return structuredClone([...this.decisions.values()]
      .filter((decision) => decision.ownerUserId === owner && (!options.statuses || options.statuses.includes(decision.status)))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, options.limit));
  }
  async answerDecision(owner: string, id: string, patch: { status: Exclude<NousDecisionStatus, "OPEN">; answer: string | null }) {
    const decision = this.decisions.get(id);
    if (!decision || decision.ownerUserId !== owner || decision.status !== "OPEN") return null;
    Object.assign(decision, { status: patch.status, answer: patch.answer, answeredAt: now() });
    return structuredClone(decision);
  }
  async setDecisionOutcome(owner: string, id: string, outcome: string) {
    const decision = this.decisions.get(id);
    if (decision && decision.ownerUserId === owner) decision.outcome = clip(outcome, 2_000);
  }
  async setDecisionFeedback(owner: string, id: string, couldHaveDecided: boolean) {
    const decision = this.decisions.get(id);
    if (!decision || decision.ownerUserId !== owner || decision.status === "OPEN") return null;
    decision.couldHaveDecided = couldHaveDecided;
    return structuredClone(decision);
  }
  async listNotes(owner: string) {
    return [...this.notes.entries()].filter(([key]) => key.startsWith(`${owner}\u0000`)).map(([, note]) => ({ ...note }))
      .sort((left, right) => left.key.localeCompare(right.key));
  }
  async setNote(owner: string, key: string, text: string | null) {
    if (text === null) this.notes.delete(`${owner}\u0000${key}`);
    else this.notes.set(`${owner}\u0000${key}`, { key, text, updatedAt: now() });
  }
  async failRunning(note: string) {
    let count = 0;
    for (const message of this.messages) {
      if (message.status === "RUNNING") { Object.assign(message, { status: "FAILED", content: clip(`${message.content}\n${note}`, 20_000), updatedAt: now() }); count += 1; }
    }
    return count;
  }
  async addTurnFacts(facts: NousTurnFacts) {
    this.turns.push(nousTurnFactsSchema.parse(facts));
  }
  async listTurnFacts(owner: string, since: string) {
    return structuredClone(this.turns.filter((turn) => turn.ownerUserId === owner && turn.startedAt >= since)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt)));
  }
  async appendLedger(row: NewNousLedgerRow) {
    const keep = new Date(Date.now() - LEDGER_KEEP_MS).toISOString();
    this.ledger = [...this.ledger.filter((entry) => entry.at >= keep), { ...ledgerRow(row), at: now() }];
  }
  async listLedger(owner: string, since: string) {
    return structuredClone(this.ledger.filter((entry) => entry.ownerUserId === owner && entry.at >= since).reverse());
  }
  async dispose() {}
}

interface MessageRow {
  id: string; ownerUserId: string; turnId: string | null; kind: NousMessageKind; status: NousMessageStatus; content: string;
  meta: Record<string, unknown>; createdAt: Date | string; updatedAt: Date | string;
}
interface DecisionRow {
  id: string; ownerUserId: string; category: NousDecision["category"]; title: string; body: string; options: string[]; recommendation: string | null;
  refs: NousDecision["refs"]; action: NousDecision["action"]; status: NousDecisionStatus; answer: string | null; outcome: string | null;
  createdAt: Date | string; answeredAt: Date | string | null; couldHaveDecided: boolean;
}
const messageColumns = `id, owner_user_id AS "ownerUserId", turn_id AS "turnId", kind, status, content, meta, created_at AS "createdAt", updated_at AS "updatedAt"`;
const decisionColumns = `id, owner_user_id AS "ownerUserId", category, title, body, options, recommendation, refs, action, status, answer, outcome,
  created_at AS "createdAt", answered_at AS "answeredAt", could_have_decided AS "couldHaveDecided"`;
const messageOf = (row: MessageRow) => nousMessageSchema.parse({ ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) });
const decisionOf = (row: DecisionRow) => nousDecisionSchema.parse({ ...row, createdAt: iso(row.createdAt), answeredAt: row.answeredAt === null ? null : iso(row.answeredAt) });
interface TurnFactsRow extends Omit<NousTurnFacts, "startedAt" | "endedAt"> { startedAt: Date | string; endedAt: Date | string }
const turnFactsColumns = `turn_id AS "turnId", owner_user_id AS "ownerUserId", reason, status, tools, plan_points AS "planPoints", outcomes,
  started_at AS "startedAt", ended_at AS "endedAt", model, effort, cost_usd::float8 AS "costUsd", tokens, goal_id AS "goalId"`;
const rowCount = (result: unknown) => (result as { rowCount?: number | null }).rowCount ?? 0;

export class PostgresNousRepository implements NousRepository {
  constructor(private readonly pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresNousRepository(createSpacePgPool(url, { max: 2 })); }

  async addMessage(input: NewNousMessage) {
    const result = await this.pool.query<MessageRow>(`INSERT INTO nous_messages (id, owner_user_id, turn_id, kind, status, content, meta)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING ${messageColumns}`,
    [newId("nous_msg"), input.ownerUserId, input.turnId, input.kind, input.status, clip(input.content, 20_000), metaJson(input.meta ?? {})]);
    return messageOf(result.rows[0]!);
  }
  async updateMessage(owner: string, id: string, patch: { status?: NousMessageStatus; content?: string; meta?: Record<string, unknown> }) {
    const result = await this.pool.query<MessageRow>(`UPDATE nous_messages SET status = COALESCE($3, status), content = COALESCE($4, content),
      meta = COALESCE($5::jsonb, meta), updated_at = now() WHERE owner_user_id = $1 AND id = $2 RETURNING ${messageColumns}`,
    [owner, id, patch.status ?? null, patch.content === undefined ? null : clip(patch.content, 20_000), patch.meta === undefined ? null : metaJson(patch.meta)]);
    return result.rows[0] ? messageOf(result.rows[0]) : null;
  }
  async listMessages(owner: string, limit: number) {
    const result = await this.pool.query<MessageRow>(`SELECT * FROM (SELECT ${messageColumns} FROM nous_messages WHERE owner_user_id = $1
      ORDER BY created_at DESC, id DESC LIMIT $2) newest ORDER BY "createdAt" ASC, id ASC`, [owner, limit]);
    return result.rows.map(messageOf);
  }
  async clearMessages(owner: string) {
    return rowCount(await this.pool.query("DELETE FROM nous_messages WHERE owner_user_id = $1 AND status <> 'RUNNING'", [owner]));
  }
  async createDecision(input: NewNousDecision) {
    const result = await this.pool.query<DecisionRow>(`INSERT INTO nous_decisions (id, owner_user_id, category, title, body, options, recommendation, refs, action, status)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9::jsonb, 'OPEN') RETURNING ${decisionColumns}`,
    [newId("nous_decision"), input.ownerUserId, input.category, input.title, input.body, JSON.stringify(input.options), input.recommendation,
      JSON.stringify(input.refs), input.action === null ? null : JSON.stringify(input.action)]);
    return decisionOf(result.rows[0]!);
  }
  async getDecision(owner: string, id: string) {
    const result = await this.pool.query<DecisionRow>(`SELECT ${decisionColumns} FROM nous_decisions WHERE owner_user_id = $1 AND id = $2`, [owner, id]);
    return result.rows[0] ? decisionOf(result.rows[0]) : null;
  }
  async listDecisions(owner: string, options: { statuses?: NousDecisionStatus[]; limit?: number }) {
    const result = await this.pool.query<DecisionRow>(`SELECT ${decisionColumns} FROM nous_decisions WHERE owner_user_id = $1
      AND ($2::text[] IS NULL OR status = ANY($2::text[])) ORDER BY created_at DESC, id DESC LIMIT $3`, [owner, options.statuses ?? null, options.limit ?? null]);
    return result.rows.map(decisionOf);
  }
  async answerDecision(owner: string, id: string, patch: { status: Exclude<NousDecisionStatus, "OPEN">; answer: string | null }) {
    const result = await this.pool.query<DecisionRow>(`UPDATE nous_decisions SET status = $3, answer = $4, answered_at = now()
      WHERE owner_user_id = $1 AND id = $2 AND status = 'OPEN' RETURNING ${decisionColumns}`, [owner, id, patch.status, patch.answer]);
    return result.rows[0] ? decisionOf(result.rows[0]) : null;
  }
  async setDecisionOutcome(owner: string, id: string, outcome: string) {
    await this.pool.query("UPDATE nous_decisions SET outcome = $3 WHERE owner_user_id = $1 AND id = $2", [owner, id, clip(outcome, 2_000)]);
  }
  async setDecisionFeedback(owner: string, id: string, couldHaveDecided: boolean) {
    const result = await this.pool.query<DecisionRow>(`UPDATE nous_decisions SET could_have_decided = $3 WHERE owner_user_id = $1 AND id = $2 AND status <> 'OPEN'
      RETURNING ${decisionColumns}`, [owner, id, couldHaveDecided]);
    return result.rows[0] ? decisionOf(result.rows[0]) : null;
  }
  async listNotes(owner: string) {
    const result = await this.pool.query<{ key: string; text: string; updatedAt: Date | string }>(
      `SELECT key, text, updated_at AS "updatedAt" FROM nous_notes WHERE owner_user_id = $1 ORDER BY key`, [owner]);
    return result.rows.map((row) => ({ key: row.key, text: row.text, updatedAt: iso(row.updatedAt) }));
  }
  async setNote(owner: string, key: string, text: string | null) {
    if (text === null) await this.pool.query("DELETE FROM nous_notes WHERE owner_user_id = $1 AND key = $2", [owner, key]);
    else await this.pool.query(`INSERT INTO nous_notes (owner_user_id, key, text, updated_at) VALUES ($1, $2, $3, now())
      ON CONFLICT (owner_user_id, key) DO UPDATE SET text = EXCLUDED.text, updated_at = now()`, [owner, key, text]);
  }
  async failRunning(note: string) {
    return rowCount(await this.pool.query(`UPDATE nous_messages SET status = 'FAILED', content = left(content || E'\\n' || $1, 20000), updated_at = now()
      WHERE status = 'RUNNING'`, [note]));
  }
  async addTurnFacts(facts: NousTurnFacts) {
    const turn = nousTurnFactsSchema.parse(facts);
    await this.pool.query(`INSERT INTO nous_turn_facts (turn_id, owner_user_id, reason, status, tools, plan_points, outcomes, started_at, ended_at, model, effort, cost_usd, tokens, goal_id)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9, $10, $11, $12, $13::jsonb, $14) ON CONFLICT (turn_id) DO NOTHING`,
    [turn.turnId, turn.ownerUserId, turn.reason, turn.status, JSON.stringify(turn.tools), turn.planPoints, JSON.stringify(turn.outcomes), turn.startedAt, turn.endedAt,
      turn.model, turn.effort, turn.costUsd, turn.tokens === null ? null : JSON.stringify(turn.tokens), turn.goalId]);
  }
  async listTurnFacts(owner: string, since: string) {
    const result = await this.pool.query<TurnFactsRow>(`SELECT ${turnFactsColumns} FROM nous_turn_facts WHERE owner_user_id = $1 AND started_at >= $2
      ORDER BY started_at ASC, turn_id ASC`, [owner, since]);
    return result.rows.map((row) => nousTurnFactsSchema.parse({ ...row, startedAt: iso(row.startedAt), endedAt: iso(row.endedAt) }));
  }
  async appendLedger(row: NewNousLedgerRow) {
    const entry = ledgerRow(row);
    await this.pool.query(`INSERT INTO nous_decision_ledger (owner_user_id, source, kind, title, predicted, answer, match, ref) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [entry.ownerUserId, entry.source, entry.kind, entry.title, entry.predicted, entry.answer, entry.match, entry.ref]);
    await this.pool.query("DELETE FROM nous_decision_ledger WHERE owner_user_id = $1 AND at < now() - interval '180 days'", [entry.ownerUserId]);
  }
  async listLedger(owner: string, since: string) {
    const result = await this.pool.query<NousLedgerRow & { at: Date | string }>(`SELECT owner_user_id AS "ownerUserId", at, source, kind, title, predicted, answer, match, ref
      FROM nous_decision_ledger WHERE owner_user_id = $1 AND at >= $2 ORDER BY at DESC, id DESC LIMIT 500`, [owner, since]);
    return result.rows.map((row) => ({ ...row, at: iso(row.at) }));
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
