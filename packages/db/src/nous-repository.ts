import { randomUUID } from "node:crypto";
import {
  nousDecisionSchema, nousMessageSchema, nousTurnFactsError, nousTurnFactsSchema, nousTurnOutcomeSchema, withoutAccountFacts,
  type NousDecision, type NousDecisionStatus, type NousMessage, type NousMessageKind, type NousMessageStatus, type NousTurnFacts, type NousTurnOutcome
} from "@space/contracts";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

// Nous, the mind of SpaceApp (migration 0211): its conversation, the critical decisions it asks the operator and its
// own notes; its turn facts (migration 0212). The API's Nous service is the only writer. Postgres on the live instances, in-memory for tests.

/** `createdAt`: when the key was first written; null for notes written before 4/11 (migration 0294). */
export interface NousNote { key: string; text: string; updatedAt: string; createdAt?: string | null }
export interface NewNousMessage {
  ownerUserId: string; turnId: string | null; kind: NousMessageKind; status: NousMessageStatus; content: string; meta?: Record<string, unknown>;
}
export type NewNousDecision = Omit<NousDecision, "id" | "status" | "answer" | "outcome" | "createdAt" | "answeredAt" | "couldHaveDecided">;
/** A final answer that covers operator messages: the ones it names (`replyTo`) and, before replyTo existed, all written before its turn began. */
/** `interim`: a space_reply_now reply of an operator turn (it reaches the chat but covers nothing; the Score's first answer reads it). */
export interface NousAnswerLink { turnId: string | null; createdAt: string; startedAt: string; replyTo: string[]; interim?: true }
export type NousTurnOutcomes = { turnId: string; endedAt: string; outcomes: NousTurnOutcome[] };
/** A page further back (rows older than the `before` message), or the dock's latest page (`sinceClear`: after the owner's last Clear). */
export interface NousMessagePage { before?: string; sinceClear?: boolean }

export interface NousRepository {
  addMessage(message: NewNousMessage): Promise<NousMessage>;
  updateMessage(owner: string, id: string, patch: { status?: NousMessageStatus; content?: string; meta?: Record<string, unknown> }): Promise<NousMessage | null>;
  /**
   * The newest `limit` dialogue messages (every kind but TOOL) and the newest `tools` TOOL rows from the oldest of those on,
   * oldest first. Tool rows never push the dialogue out (30/10: 175 of the newest 200 rows were tool steps of 11 minutes).
   * Every row counts, Clear conversation or not, unless the page asks `sinceClear`.
   */
  listMessages(owner: string, limit: number, tools?: number, page?: NousMessagePage): Promise<NousMessage[]>;
  /** Every OPERATOR message, cleared ones too, oldest first (the dock's "Go to my last message" walks them past the loaded page). */
  /** `person`: a person wrote it (meta.person), not a proof or automation session; a copilot's operatorOrder needs it. */
  listOperatorMessageRefs(owner: string): Promise<Array<{ id: string; createdAt: string; person: boolean }>>;
  /** The OPERATOR message a client stored under its outbox id (meta.clientId), or null. */
  operatorMessageByClientId(owner: string, clientId: string): Promise<NousMessage | null>;
  /** The Requests tab (plan clipboard:2NOOFNJDUIMO): OPERATOR messages newest first, older than the `before` message; Clear never hides them. */
  /** `since`: only the messages written then or later. */
  listOperatorMessages(owner: string, options: { before?: string; since?: string; limit: number }): Promise<NousMessage[]>;
  /** The final answers of operator turns (and the /goal reply) written at or after `since`, oldest first: only their links. */
  listAnswerLinks(owner: string, since: string): Promise<NousAnswerLink[]>;
  /** The turns that ended at or after `since` and reported outcomes (space_nous_outcome), oldest first. */
  listTurnOutcomes(owner: string, since: string): Promise<NousTurnOutcomes[]>;
  /** A goal's work history (plan clipboard:jNDx8l-vMEl9): the DONE tool rows of those turns whose tool is one of `names`, written at or after `since`, oldest first. */
  listTurnTools(owner: string, turnIds: string[], names: string[], since: string): Promise<NousMessage[]>;
  /**
   * Clear conversation moves the owner's mark (migration 0270) and touches no row: operator 31/10 «clear the window, never the database».
   * Answers how many rows the dock's latest page now leaves out.
   */
  clearMessages(owner: string): Promise<number>;
  /** When the owner last cleared the conversation (null: never); the dock hides the decisions asked before it too. */
  conversationClearedAt(owner: string): Promise<string | null>;
  createDecision(decision: NewNousDecision): Promise<NousDecision>;
  getDecision(owner: string, id: string): Promise<NousDecision | null>;
  /** Newest first; without `limit` every match (the dock lists every OPEN decision, however old). */
  /** `before`: only decisions asked before that time (the dock pages older answered decisions with it). */
  listDecisions(owner: string, options: { statuses?: NousDecisionStatus[]; limit?: number; before?: string }): Promise<NousDecision[]>;
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
  latestServedTurn(owner: string): Promise<NousTurnFacts | null>;
  /** Goal 7365014c-e: one row per operator answer to a decision or needs-you card; rows older than 180 days go (class B). */
  appendLedger(row: NewNousLedgerRow): Promise<void>;
  /** The owner's ledger rows at or after `since`, newest first. */
  listLedger(owner: string, since: string): Promise<NousLedgerRow[]>;
  /** Plan clipboard:RQSrp1EczBbV: shares an Agent File to the Nous app until `expiresAt`; sharing it again renews the one share. Expired shares go (class B). */
  addFileShare(share: NewNousFileShare): Promise<NousFileShare>;
  /** The owner's unexpired shares, newest first. */
  listFileShares(owner: string): Promise<NousFileShare[]>;
  /** Removes only the share, never the Agent File; false when the owner has no such share. */
  removeFileShare(owner: string, id: string): Promise<boolean>;
  /**
   * Plan clipboard:f4SH36t3fJ6c (migration 0273): one minute of the Load tab and the HOUR and DAY sums it adds to; a minute already
   * stored adds nothing (false). Minute rows past 30 days go (class B); the sums stay (the averages come from them).
   */
  addLoadMinute(minute: NousLoadMinute): Promise<boolean>;
  /** Minutes at or after `minutes`, HOUR buckets at or after `hours` and DAY buckets at or after `days`, each oldest first. */
  listLoad(owner: string, since: { minutes: string; hours: string; days: string }): Promise<NousLoadHistory>;
  /**
   * Plan clipboard:1NF6u6gcCwtj (migration 0292): one Score snapshot (every 10 minutes) with each tile's points; a snapshot already stored
   * adds nothing (false). Rows past 30 days go (class B).
   */
  addScoreSnapshot(snapshot: NousScoreSnapshot): Promise<boolean>;
  /** The owner's snapshots at or after `since`, oldest first. */
  listScoreSnapshots(owner: string, since: string): Promise<Array<{ at: string; score: number; parts: Record<string, number> }>>;
  dispose(): Promise<void>;
}

/** `hour`: the UTC hour bucket ('2026-10-31T07'); `day`: the owner's local date ('2026-10-31'). */
export interface NousLoadMinute { ownerUserId: string; at: string; overall: number; parts: Record<string, number | null>; hour: string; day: string }
export interface NousLoadBucket { bucket: string; total: number; samples: number; peak: number }
export interface NousLoadHistory { minutes: Array<{ at: string; overall: number }>; hours: NousLoadBucket[]; days: NousLoadBucket[] }
const LOAD_MINUTES_KEEP_MS = 30 * 86_400_000;
export interface NousScoreSnapshot { ownerUserId: string; at: string; score: number; parts: Record<string, number> }
const SCORE_KEEP_MS = 30 * 86_400_000;

export interface NewNousFileShare { ownerUserId: string; artifactId: string; note: string | null; sharedBy: string; sharedAt: string; expiresAt: string }
export interface NousFileShare extends NewNousFileShare { id: string }

export interface NewNousLedgerRow { ownerUserId: string; source: string; kind: string; title: string; predicted: string | null; answer: string; match: boolean | null; ref: string | null }
export interface NousLedgerRow extends NewNousLedgerRow { at: string }
const LEDGER_KEEP_MS = 180 * 86_400_000;
const ledgerRow = (row: NewNousLedgerRow): NewNousLedgerRow => ({ ...row, source: clip(row.source, 60), kind: clip(row.kind, 2_000), title: clip(row.title.trim() || "(untitled)", 300),
  predicted: row.predicted === null ? null : clip(row.predicted, 200), answer: clip(row.answer.trim() || "(no text)", 500), ref: row.ref === null ? null : clip(row.ref, 200) });

/** Tool rows kept beside the dialogue window: a long turn records hundreds, and the dock polls the list every 1.5 s while Nous writes. */
const NOUS_TOOL_ROWS = 1_500;
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

const replyIds = (value: unknown) => Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
const fromOperatorTurn = (meta: Record<string, unknown>) => meta.reason === undefined || meta.reason === "OPERATOR";

export class InMemoryNousRepository implements NousRepository {
  private readonly messages: NousMessage[] = [];
  private readonly decisions = new Map<string, NousDecision>();
  private readonly notes = new Map<string, NousNote>();
  private readonly turns: NousTurnFacts[] = [];
  private ledger: NousLedgerRow[] = [];
  /** Clear conversation: per owner, how many rows (of every owner, in order) came before it. */
  private readonly cleared = new Map<string, number>();
  private readonly clearedTimes = new Map<string, string>();
  private shares: NousFileShare[] = [];
  private loadMinutes: Array<{ ownerUserId: string; at: string; overall: number }> = [];
  private readonly loadSums = new Map<string, NousLoadBucket>();
  private scores: NousScoreSnapshot[] = [];

  async addMessage(input: NewNousMessage) {
    const at = now();
    const message = nousMessageSchema.parse({ ...input, id: newId("nous_msg"), content: input.content, meta: input.meta ?? {}, createdAt: at, updatedAt: at });
    this.messages.push(message);
    return structuredClone(message);
  }
  async updateMessage(owner: string, id: string, patch: { status?: NousMessageStatus; content?: string; meta?: Record<string, unknown> }) {
    const message = this.messages.find((entry) => entry.id === id && entry.ownerUserId === owner);
    if (!message) return null;
    Object.assign(message, { ...patch, ...(patch.content !== undefined ? { content: patch.content } : {}), updatedAt: now() });
    return structuredClone(message);
  }
  async listMessages(owner: string, limit: number, tools = NOUS_TOOL_ROWS, page: NousMessagePage = {}) {
    const mark = page.sinceClear ? this.cleared.get(owner) ?? 0 : 0;
    const all = this.messages.filter((message, index) => message.ownerUserId === owner && index >= mark);
    const cut = page.before === undefined ? all.length : all.findIndex((message) => message.id === page.before);
    const mine = all.slice(0, Math.max(cut, 0));
    const dialogue = mine.filter((message) => message.kind !== "TOOL").slice(-limit);
    const from = dialogue[0] ? mine.indexOf(dialogue[0]) : 0;
    const kept = new Set([...dialogue, ...(tools > 0 ? mine.slice(from).filter((message) => message.kind === "TOOL").slice(-tools) : [])]);
    return structuredClone(mine.filter((message) => kept.has(message)).map((message) => {
      const turn = message.kind === "ANSWER" && !message.meta.model && !message.meta.interim
        ? this.turns.find((turn) => turn.ownerUserId === owner && turn.turnId === message.turnId && turn.status === "DONE") : null;
      return turn?.model ? { ...message, meta: { ...message.meta, model: turn.model, effort: turn.effort } } : message;
    }));
  }
  async operatorMessageByClientId(owner: string, clientId: string) {
    const found = this.messages.find((message) => message.ownerUserId === owner && message.kind === "OPERATOR" && message.meta.clientId === clientId);
    return found ? structuredClone(found) : null;
  }
  async listOperatorMessageRefs(owner: string) {
    return this.messages.filter((message) => message.ownerUserId === owner && message.kind === "OPERATOR").map(({ id, createdAt, meta }) => ({ id, createdAt, person: meta.person === true }));
  }
  async listOperatorMessages(owner: string, options: { before?: string; since?: string; limit: number }) {
    const mine = this.messages.filter((message) => message.ownerUserId === owner && message.kind === "OPERATOR" && (options.since === undefined || message.createdAt >= options.since));
    const cut = options.before === undefined ? mine.length : mine.findIndex((message) => message.id === options.before);
    return structuredClone(mine.slice(0, Math.max(cut, 0)).reverse().slice(0, options.limit));
  }
  async listAnswerLinks(owner: string, since: string) {
    return this.messages.filter((message) => message.ownerUserId === owner && message.kind === "ANSWER" && message.createdAt >= since && fromOperatorTurn(message.meta))
      .map((message) => ({ turnId: message.turnId, createdAt: message.createdAt, startedAt: typeof message.meta.startedAt === "string" ? message.meta.startedAt : message.createdAt,
        replyTo: replyIds(message.meta.replyTo), ...(message.meta.interim === true ? { interim: true as const } : {}) }));
  }
  async listTurnOutcomes(owner: string, since: string) {
    return structuredClone(this.turns.filter((turn) => turn.ownerUserId === owner && turn.endedAt >= since && turn.outcomes.length)
      .sort((left, right) => left.endedAt.localeCompare(right.endedAt)).map(({ turnId, endedAt, outcomes }) => ({ turnId, endedAt, outcomes })));
  }
  async listTurnTools(owner: string, turnIds: string[], names: string[], since: string) {
    return structuredClone(this.messages.filter((message) => message.ownerUserId === owner && message.kind === "TOOL" && message.status === "DONE" && message.createdAt >= since
      && message.turnId !== null && turnIds.includes(message.turnId) && names.includes(String(message.meta.name))));
  }
  async clearMessages(owner: string) {
    this.cleared.set(owner, this.messages.length);
    this.clearedTimes.set(owner, now());
    return this.messages.filter((message) => message.ownerUserId === owner).length;
  }
  async conversationClearedAt(owner: string) {
    return this.clearedTimes.get(owner) ?? null;
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
  async listDecisions(owner: string, options: { statuses?: NousDecisionStatus[]; limit?: number; before?: string }) {
    return structuredClone([...this.decisions.values()]
      .filter((decision) => decision.ownerUserId === owner && (!options.statuses || options.statuses.includes(decision.status)) && (!options.before || decision.createdAt < options.before))
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
    else { const at = now(); this.notes.set(`${owner}\u0000${key}`, { key, text, updatedAt: at, createdAt: this.notes.get(`${owner}\u0000${key}`)?.createdAt ?? at }); }
  }
  async failRunning(note: string) {
    let count = 0;
    for (const message of this.messages) {
      if (message.status === "RUNNING") { Object.assign(message, { status: "FAILED", content: `${message.content}\n${note}`, updatedAt: now() }); count += 1; }
    }
    return count;
  }
  async addTurnFacts(facts: NousTurnFacts) {
    const turn = nousTurnFactsSchema.parse(facts);
    this.turns.push({ ...turn, error: nousTurnFactsError(turn) });
  }
  async latestServedTurn(owner: string) {
    return structuredClone(this.turns.filter((turn) => turn.ownerUserId === owner && turn.status === "DONE" && turn.model)
      .sort((a, b) => b.endedAt.localeCompare(a.endedAt))[0] ?? null);
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
  async addFileShare(input: NewNousFileShare) {
    const renewed = this.shares.find((share) => share.ownerUserId === input.ownerUserId && share.artifactId === input.artifactId && share.expiresAt > now());
    this.shares = this.shares.filter((share) => share.ownerUserId !== input.ownerUserId || (share.artifactId !== input.artifactId && share.expiresAt > now()));
    const share = { id: renewed?.id ?? newId("nous_share"), ...input };
    this.shares.push(share);
    return { ...share };
  }
  async listFileShares(owner: string) {
    const at = now();
    return this.shares.filter((share) => share.ownerUserId === owner && share.expiresAt > at).sort((a, b) => b.sharedAt.localeCompare(a.sharedAt)).map((share) => ({ ...share }));
  }
  async removeFileShare(owner: string, id: string) {
    const before = this.shares.length;
    this.shares = this.shares.filter((share) => share.ownerUserId !== owner || share.id !== id);
    return this.shares.length < before;
  }
  async addLoadMinute(minute: NousLoadMinute) {
    const at = iso(minute.at);
    if (this.loadMinutes.some((row) => row.ownerUserId === minute.ownerUserId && row.at === at)) return false;
    this.loadMinutes = this.loadMinutes.filter((row) => Date.parse(row.at) >= Date.parse(at) - LOAD_MINUTES_KEEP_MS);
    this.loadMinutes.push({ ownerUserId: minute.ownerUserId, at, overall: minute.overall });
    for (const [period, bucket] of [["HOUR", minute.hour], ["DAY", minute.day]] as const) {
      const key = `${minute.ownerUserId} ${period} ${bucket}`;
      const sum = this.loadSums.get(key);
      this.loadSums.set(key, sum ? { bucket, total: sum.total + minute.overall, samples: sum.samples + 1, peak: Math.max(sum.peak, minute.overall) }
        : { bucket, total: minute.overall, samples: 1, peak: minute.overall });
    }
    return true;
  }
  async addScoreSnapshot(snapshot: NousScoreSnapshot) {
    const at = iso(snapshot.at);
    if (this.scores.some((row) => row.ownerUserId === snapshot.ownerUserId && row.at === at)) return false;
    this.scores = [...this.scores.filter((row) => row.ownerUserId !== snapshot.ownerUserId || Date.parse(row.at) >= Date.parse(at) - SCORE_KEEP_MS),
      { ownerUserId: snapshot.ownerUserId, at, score: snapshot.score, parts: { ...snapshot.parts } }];
    return true;
  }
  async listScoreSnapshots(owner: string, since: string) {
    return this.scores.filter((row) => row.ownerUserId === owner && row.at >= iso(since)).sort((a, b) => a.at.localeCompare(b.at)).map(({ at, score, parts }) => ({ at, score, parts: { ...parts } }));
  }
  async listLoad(owner: string, since: { minutes: string; hours: string; days: string }) {
    const sums = (period: string, from: string) => [...this.loadSums].filter(([key, sum]) => key.startsWith(`${owner} ${period} `) && sum.bucket >= from)
      .map(([, sum]) => ({ ...sum })).sort((a, b) => a.bucket.localeCompare(b.bucket));
    return { minutes: this.loadMinutes.filter((row) => row.ownerUserId === owner && row.at >= since.minutes).sort((a, b) => a.at.localeCompare(b.at))
      .map(({ at, overall }) => ({ at, overall })), hours: sums("HOUR", since.hours), days: sums("DAY", since.days) };
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
const decisionOf = (row: DecisionRow) => nousDecisionSchema.parse({ ...row, body: withoutAccountFacts(row.body), createdAt: iso(row.createdAt), answeredAt: row.answeredAt === null ? null : iso(row.answeredAt) });
interface TurnFactsRow extends Omit<NousTurnFacts, "startedAt" | "endedAt"> { startedAt: Date | string; endedAt: Date | string }
const turnFactsColumns = `turn_id AS "turnId", owner_user_id AS "ownerUserId", reason, status, tools, plan_points AS "planPoints", outcomes,
  started_at AS "startedAt", ended_at AS "endedAt", model, effort, cost_usd::float8 AS "costUsd", tokens, goal_id AS "goalId", error`;
interface FileShareRow extends Omit<NousFileShare, "sharedAt" | "expiresAt"> { sharedAt: Date | string; expiresAt: Date | string }
const fileShareColumns = `id, owner_user_id AS "ownerUserId", artifact_id AS "artifactId", note, shared_by AS "sharedBy", shared_at AS "sharedAt", expires_at AS "expiresAt"`;
const fileShareOf = (row: FileShareRow): NousFileShare => ({ ...row, sharedAt: iso(row.sharedAt), expiresAt: iso(row.expiresAt) });
const rowCount = (result: unknown) => (result as { rowCount?: number | null }).rowCount ?? 0;
// One array schema for every row (CPU report 12/11: building it per row tripled the Requests derive's 2,765 outcome parses).
const turnOutcomesSchema = nousTurnOutcomeSchema.array();
const outcomesOf = (value: unknown) => turnOutcomesSchema.safeParse(value).data ?? [];

export class PostgresNousRepository implements NousRepository {
  constructor(private readonly pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresNousRepository(createSpacePgPool(url, { max: 2 })); }

  async addMessage(input: NewNousMessage) {
    const result = await this.pool.query<MessageRow>(`INSERT INTO nous_messages (id, owner_user_id, turn_id, kind, status, content, meta)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING ${messageColumns}`,
    [newId("nous_msg"), input.ownerUserId, input.turnId, input.kind, input.status, input.content, metaJson(input.meta ?? {})]);
    return messageOf(result.rows[0]!);
  }
  async updateMessage(owner: string, id: string, patch: { status?: NousMessageStatus; content?: string; meta?: Record<string, unknown> }) {
    const result = await this.pool.query<MessageRow>(`UPDATE nous_messages SET status = COALESCE($3, status), content = COALESCE($4, content),
      meta = COALESCE($5::jsonb, meta), updated_at = now() WHERE owner_user_id = $1 AND id = $2 RETURNING ${messageColumns}`,
    [owner, id, patch.status ?? null, patch.content === undefined ? null : patch.content, patch.meta === undefined ? null : metaJson(patch.meta)]);
    return result.rows[0] ? messageOf(result.rows[0]) : null;
  }
  async listMessages(owner: string, limit: number, tools = NOUS_TOOL_ROWS, page: NousMessagePage = {}) {
    // $4: the cursor row (an unknown id matches nothing); $5: only rows after the owner's last Clear conversation.
    const shown = `owner_user_id = $1 AND ($4::text IS NULL OR (created_at, id) < (SELECT created_at, id FROM nous_messages WHERE owner_user_id = $1 AND id = $4))
      AND (NOT $5 OR created_at > COALESCE((SELECT cleared_at FROM nous_conversation_marks WHERE owner_user_id = $1), '-infinity'))`;
    const result = await this.pool.query<MessageRow>(`WITH dialogue AS (SELECT ${messageColumns} FROM nous_messages WHERE ${shown} AND kind <> 'TOOL'
      ORDER BY created_at DESC, id DESC LIMIT $2), tools AS (SELECT ${messageColumns} FROM nous_messages WHERE ${shown} AND kind = 'TOOL'
      AND created_at >= COALESCE((SELECT min("createdAt") FROM dialogue), '-infinity') ORDER BY created_at DESC, id DESC LIMIT $3)
      SELECT * FROM (SELECT * FROM dialogue UNION ALL SELECT * FROM tools) newest ORDER BY "createdAt" ASC, id ASC`,
    [owner, limit, tools, page.before ?? null, Boolean(page.sinceClear)]);
    const messages = result.rows.map(messageOf);
    // Older final answers predate message-level provenance; recover only their exact completed turn, never an interim from a failed attempt.
    const ids = messages.filter((message) => message.kind === "ANSWER" && !message.meta.model && !message.meta.interim && message.turnId).map((message) => message.turnId!);
    if (ids.length) {
      const facts = await this.pool.query<{ turnId: string; model: string; effort: string | null }>(
        `SELECT turn_id AS "turnId", model, effort FROM nous_turn_facts WHERE owner_user_id = $1 AND turn_id = ANY($2::text[]) AND status = 'DONE' AND model IS NOT NULL`, [owner, ids]);
      const byTurn = new Map(facts.rows.map((turn) => [turn.turnId, turn]));
      for (const message of messages) {
        const turn = message.turnId && ids.includes(message.turnId) && !message.meta.model && !message.meta.interim ? byTurn.get(message.turnId) : null;
        if (turn) message.meta = { ...message.meta, model: turn.model, effort: turn.effort };
      }
    }
    return messages;
  }
  async operatorMessageByClientId(owner: string, clientId: string) {
    const result = await this.pool.query<MessageRow>(`SELECT ${messageColumns} FROM nous_messages WHERE owner_user_id = $1 AND kind = 'OPERATOR'
      AND meta->>'clientId' = $2 ORDER BY created_at, id LIMIT 1`, [owner, clientId]);
    return result.rows[0] ? messageOf(result.rows[0]) : null;
  }
  async listOperatorMessageRefs(owner: string) {
    const result = await this.pool.query<{ id: string; createdAt: Date | string; person: boolean }>(`SELECT id, created_at AS "createdAt",
      COALESCE(meta->>'person', 'false') = 'true' AS person FROM nous_messages WHERE owner_user_id = $1 AND kind = 'OPERATOR' ORDER BY created_at, id`, [owner]);
    return result.rows.map((row) => ({ id: row.id, createdAt: iso(row.createdAt), person: row.person }));
  }
  async listOperatorMessages(owner: string, options: { before?: string; since?: string; limit: number }) {
    const result = await this.pool.query<MessageRow>(`SELECT ${messageColumns} FROM nous_messages WHERE owner_user_id = $1 AND kind = 'OPERATOR'
      AND ($2::text IS NULL OR (created_at, id) < (SELECT created_at, id FROM nous_messages WHERE owner_user_id = $1 AND id = $2))
      AND ($4::timestamptz IS NULL OR created_at >= $4) ORDER BY created_at DESC, id DESC LIMIT $3`, [owner, options.before ?? null, options.limit, options.since ?? null]);
    return result.rows.map(messageOf);
  }
  async listAnswerLinks(owner: string, since: string) {
    // The answers of operator turns or with no reason (the /goal reply); the finals are those operatorMessagesToAnswer counts, interim ones are flagged.
    const result = await this.pool.query<{ turnId: string | null; createdAt: Date | string; startedAt: string | null; replyTo: unknown; interim: boolean }>(`SELECT turn_id AS "turnId",
      created_at AS "createdAt", meta->>'startedAt' AS "startedAt", meta->'replyTo' AS "replyTo", COALESCE(meta->>'interim', 'false') = 'true' AS interim
      FROM nous_messages WHERE owner_user_id = $1 AND kind = 'ANSWER' AND created_at >= $2 AND COALESCE(meta->>'reason', 'OPERATOR') = 'OPERATOR' ORDER BY created_at, id`, [owner, since]);
    return result.rows.map((row) => ({ turnId: row.turnId, createdAt: iso(row.createdAt), startedAt: row.startedAt ? iso(row.startedAt) : iso(row.createdAt), replyTo: replyIds(row.replyTo),
      ...(row.interim ? { interim: true as const } : {}) }));
  }
  async listTurnOutcomes(owner: string, since: string) {
    const result = await this.pool.query<{ turnId: string; endedAt: Date | string; outcomes: unknown }>(`SELECT turn_id AS "turnId", ended_at AS "endedAt", outcomes
      FROM nous_turn_facts WHERE owner_user_id = $1 AND ended_at >= $2 AND outcomes <> '[]'::jsonb ORDER BY ended_at, turn_id`, [owner, since]);
    return result.rows.map((row) => ({ turnId: row.turnId, endedAt: iso(row.endedAt), outcomes: outcomesOf(row.outcomes) }));
  }
  async listTurnTools(owner: string, turnIds: string[], names: string[], since: string) {
    if (!turnIds.length || !names.length) return [];
    // created_at first: nous_messages has no turn index, the owner's (owner_user_id, created_at) one narrows it to the goal's lifetime.
    const result = await this.pool.query<MessageRow>(`SELECT ${messageColumns} FROM nous_messages WHERE owner_user_id = $1 AND created_at >= $4 AND kind = 'TOOL'
      AND status = 'DONE' AND turn_id = ANY($2::text[]) AND meta->>'name' = ANY($3::text[]) ORDER BY created_at, id`, [owner, turnIds, names, since]);
    return result.rows.map(messageOf);
  }
  async clearMessages(owner: string) {
    const result = await this.pool.query<{ count: number }>(`WITH mark AS (INSERT INTO nous_conversation_marks (owner_user_id) VALUES ($1)
      ON CONFLICT (owner_user_id) DO UPDATE SET cleared_at = now() RETURNING cleared_at)
      SELECT count(*)::int AS count FROM nous_messages WHERE owner_user_id = $1 AND created_at <= (SELECT cleared_at FROM mark)`, [owner]);
    return result.rows[0]?.count ?? 0;
  }
  async conversationClearedAt(owner: string) {
    const result = await this.pool.query<{ clearedAt: Date | string }>(`SELECT cleared_at AS "clearedAt" FROM nous_conversation_marks WHERE owner_user_id = $1`, [owner]);
    return result.rows[0] ? iso(result.rows[0].clearedAt) : null;
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
  async listDecisions(owner: string, options: { statuses?: NousDecisionStatus[]; limit?: number; before?: string }) {
    const result = await this.pool.query<DecisionRow>(`SELECT ${decisionColumns} FROM nous_decisions WHERE owner_user_id = $1
      AND ($2::text[] IS NULL OR status = ANY($2::text[])) AND ($4::timestamptz IS NULL OR created_at < $4) ORDER BY created_at DESC, id DESC LIMIT $3`,
      [owner, options.statuses ?? null, options.limit ?? null, options.before ?? null]);
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
    const result = await this.pool.query<{ key: string; text: string; updatedAt: Date | string; createdAt: Date | string | null }>(
      `SELECT key, text, updated_at AS "updatedAt", created_at AS "createdAt" FROM nous_notes WHERE owner_user_id = $1 ORDER BY key`, [owner]);
    return result.rows.map((row) => ({ key: row.key, text: row.text, updatedAt: iso(row.updatedAt), createdAt: row.createdAt === null ? null : iso(row.createdAt) }));
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
    await this.pool.query(`INSERT INTO nous_turn_facts (turn_id, owner_user_id, reason, status, tools, plan_points, outcomes, started_at, ended_at, model, effort, cost_usd, tokens, goal_id, error)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9, $10, $11, $12, $13::jsonb, $14, $15) ON CONFLICT (turn_id) DO NOTHING`,
    [turn.turnId, turn.ownerUserId, turn.reason, turn.status, JSON.stringify(turn.tools), turn.planPoints, JSON.stringify(turn.outcomes), turn.startedAt, turn.endedAt,
      turn.model, turn.effort, turn.costUsd, turn.tokens === null ? null : JSON.stringify(turn.tokens), turn.goalId, nousTurnFactsError(turn)]);
  }
  async latestServedTurn(owner: string) {
    const result = await this.pool.query<TurnFactsRow>(`SELECT ${turnFactsColumns} FROM nous_turn_facts
      WHERE owner_user_id = $1 AND status = 'DONE' AND model IS NOT NULL ORDER BY ended_at DESC, turn_id DESC LIMIT 1`, [owner]);
    const row = result.rows[0];
    return row ? nousTurnFactsSchema.parse({ ...row, startedAt: iso(row.startedAt), endedAt: iso(row.endedAt) }) : null;
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
  async addFileShare(input: NewNousFileShare) {
    await this.pool.query("DELETE FROM nous_file_shares WHERE owner_user_id = $1 AND expires_at <= now()", [input.ownerUserId]);
    const result = await this.pool.query<FileShareRow>(`INSERT INTO nous_file_shares (id, owner_user_id, artifact_id, note, shared_by, shared_at, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (owner_user_id, artifact_id) DO UPDATE SET note = EXCLUDED.note, shared_by = EXCLUDED.shared_by,
      shared_at = EXCLUDED.shared_at, expires_at = EXCLUDED.expires_at RETURNING ${fileShareColumns}`,
    [newId("nous_share"), input.ownerUserId, input.artifactId, input.note, input.sharedBy, input.sharedAt, input.expiresAt]);
    return fileShareOf(result.rows[0]!);
  }
  async listFileShares(owner: string) {
    const result = await this.pool.query<FileShareRow>(`SELECT ${fileShareColumns} FROM nous_file_shares WHERE owner_user_id = $1 AND expires_at > now()
      ORDER BY shared_at DESC, id DESC`, [owner]);
    return result.rows.map(fileShareOf);
  }
  async removeFileShare(owner: string, id: string) {
    return rowCount(await this.pool.query("DELETE FROM nous_file_shares WHERE owner_user_id = $1 AND id = $2", [owner, id])) > 0;
  }
  async addLoadMinute(minute: NousLoadMinute) {
    // One statement: the sums grow only when the minute row is new, so a retried write never counts twice.
    const added = await this.pool.query(`WITH added AS (INSERT INTO nous_load_samples (owner_user_id, at, overall, parts) VALUES ($1, $2, $3, $4::jsonb)
      ON CONFLICT DO NOTHING RETURNING overall)
      INSERT INTO nous_load_rollups (owner_user_id, period, bucket, total, samples, peak)
      SELECT $1, bucket.period, bucket.name, added.overall, 1, added.overall FROM added, (VALUES ('HOUR', $5), ('DAY', $6)) AS bucket (period, name)
      ON CONFLICT (owner_user_id, period, bucket) DO UPDATE SET total = nous_load_rollups.total + EXCLUDED.total,
        samples = nous_load_rollups.samples + 1, peak = GREATEST(nous_load_rollups.peak, EXCLUDED.peak)`,
    [minute.ownerUserId, minute.at, minute.overall, JSON.stringify(minute.parts), minute.hour, minute.day]);
    // Class B: minute rows past 30 days, pruned once an hour.
    if (new Date(minute.at).getUTCMinutes() === 0) {
      await this.pool.query("DELETE FROM nous_load_samples WHERE owner_user_id = $1 AND at < $2::timestamptz - interval '30 days'", [minute.ownerUserId, minute.at]);
    }
    return rowCount(added) > 0;
  }
  async addScoreSnapshot(snapshot: NousScoreSnapshot) {
    const added = await this.pool.query("INSERT INTO nous_score_snapshots (owner_user_id, at, score, parts) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT DO NOTHING",
      [snapshot.ownerUserId, snapshot.at, snapshot.score, JSON.stringify(snapshot.parts)]);
    // Class B: snapshots past 30 days.
    await this.pool.query("DELETE FROM nous_score_snapshots WHERE owner_user_id = $1 AND at < $2::timestamptz - interval '30 days'", [snapshot.ownerUserId, snapshot.at]);
    return rowCount(added) > 0;
  }
  async listScoreSnapshots(owner: string, since: string) {
    const rows = await this.pool.query<{ at: Date | string; score: number; parts: Record<string, number> | null }>(
      "SELECT at, score, parts FROM nous_score_snapshots WHERE owner_user_id = $1 AND at >= $2 ORDER BY at", [owner, since]);
    return rows.rows.map((row) => ({ at: iso(row.at), score: Number(row.score), parts: row.parts ?? {} }));
  }
  async listLoad(owner: string, since: { minutes: string; hours: string; days: string }) {
    const [minutes, sums] = await Promise.all([
      this.pool.query<{ at: Date | string; overall: number }>("SELECT at, overall FROM nous_load_samples WHERE owner_user_id = $1 AND at >= $2 ORDER BY at", [owner, since.minutes]),
      this.pool.query<NousLoadBucket & { period: string }>(`SELECT period, bucket, total, samples, peak FROM nous_load_rollups WHERE owner_user_id = $1
        AND ((period = 'HOUR' AND bucket >= $2) OR (period = 'DAY' AND bucket >= $3)) ORDER BY bucket`, [owner, since.hours, since.days])
    ]);
    const of = (period: string) => sums.rows.filter((row) => row.period === period).map(({ bucket, total, samples, peak }) => ({ bucket, total: Number(total), samples, peak: Number(peak) }));
    return { minutes: minutes.rows.map((row) => ({ at: iso(row.at), overall: Number(row.overall) })), hours: of("HOUR"), days: of("DAY") };
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
