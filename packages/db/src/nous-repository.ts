import { randomUUID } from "node:crypto";
import {
  nousDecisionSchema, nousMessageSchema, nousTurnFactsError, nousTurnFactsSchema, nousTurnOutcomeSchema, withoutAccountFacts,
  type NousDecision, type NousDecisionStatus, type NousMessage, type NousMessageKind, type NousMessageStatus, type NousTurnFacts, type NousTurnOutcome
} from "@space/contracts";
import { keptRead } from "./kept-read.js";
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
  /** `superior`: the link device whose superior Nous sent it (Space Link v2 step 9b). */
  listOperatorMessageRefs(owner: string): Promise<Array<{ id: string; createdAt: string; person: boolean; superior?: string }>>;
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
  /** The owner's last-read mark (nous_msg:443bb5d5, shared by the web dock and the Nous app; null: never read). */
  conversationReadUpTo(owner: string): Promise<string | null>;
  /** Moves the last-read mark forward to `at` (never back); answers the mark now. */
  markConversationRead(owner: string, at: string): Promise<string>;
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
  /** Single-key lookup without scanning the owner's full notes list on a cold cache. */
  getNote?(owner: string, key: string): Promise<NousNote | null>;
  /** Null text deletes the note. */
  setNote(owner: string, key: string, text: string | null): Promise<void>;
  /** Newest message timestamp whose meta holds a string value under `metaKey` (replaces 3,000-row JS scans). */
  latestMessageMetaAt?(owner: string, metaKey: string): Promise<string | null>;
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
  private readonly readMarks = new Map<string, string>();
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
    return this.messages.filter((message) => message.ownerUserId === owner && message.kind === "OPERATOR").map(({ id, createdAt, meta }) => ({ id, createdAt, person: meta.person === true,
      ...(typeof (meta.superior as { device?: unknown } | undefined)?.device === "string" ? { superior: (meta.superior as { device: string }).device } : {}) }));
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
  async conversationReadUpTo(owner: string) {
    return this.readMarks.get(owner) ?? null;
  }
  async markConversationRead(owner: string, at: string) {
    const mark = [this.readMarks.get(owner) ?? at, at].sort().at(-1)!;
    this.readMarks.set(owner, mark);
    return mark;
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
  async getNote(owner: string, key: string) {
    const note = this.notes.get(`${owner}\u0000${key}`);
    return note ? { ...note } : null;
  }
  async setNote(owner: string, key: string, text: string | null) {
    if (text === null) this.notes.delete(`${owner}\u0000${key}`);
    else { const at = now(); this.notes.set(`${owner}\u0000${key}`, { key, text, updatedAt: at, createdAt: this.notes.get(`${owner}\u0000${key}`)?.createdAt ?? at }); }
  }
  async latestMessageMetaAt(owner: string, metaKey: string) {
    return this.messages.filter((message) => message.ownerUserId === owner && typeof message.meta[metaKey] === "string").at(-1)?.createdAt ?? null;
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
/** A final answer saved without its model: readMessages gives it its turn's, once that turn's facts are written. */
const modelFromTurn = (message: NousMessage) => message.kind === "ANSWER" && !message.meta.model && !message.meta.interim && Boolean(message.turnId);
/** A kept conversation page (`shape`: listMessages' limit, tools, cursor) after `message` was inserted, as readMessages answers it; null where
 *  the kept rows cannot tell. */
function pageWith(rows: NousMessage[], message: NousMessage, shape: string): NousMessage[] | null {
  const [limit, tools, before] = JSON.parse(shape) as [number, number, string | null];
  // An answer that waits for its turn's model is read again after every write, as before.
  if ([...rows, message].some(modelFromTurn)) return null;
  // An older page ends before its cursor row; a read that began during the write may hold the row already.
  // shortcut: a clock set back behind the cursor row's time is not seen (its row misses an older page for the kept minute), compare with the cursor row's time then.
  if (before || rows.some((row) => row.id === message.id)) return rows;
  // The table orders by microsecond: a row of the same millisecond (or of a clock that went back) has no known place here.
  if ((rows.at(-1)?.createdAt ?? "") >= message.createdAt) return null;
  const page = [...rows, message];
  const leave = (old: NousMessage[], most: number) => { if (old.length > most) page.splice(page.indexOf(old[0]!), 1); };
  leave(page.filter((row) => row.kind !== "TOOL"), limit);
  // Tool rows older than the oldest dialogue row are not on the page.
  const first = page.findIndex((row) => row.kind !== "TOOL");
  if (first > 0 && page[first - 1]!.createdAt === page[first]!.createdAt) return null;
  if (first > 0) page.splice(0, first);
  leave(page.filter((row) => row.kind === "TOOL"), tools);
  return page;
}
/** How far before the last read a kept turn facts read looks again: six times the 20 minutes a turn may run. */
const TURN_FACTS_REREAD_MS = 2 * 3_600_000;
/** Rows the kept reads hold together (see `trim`): the dock page (1,700), a review's 6,000-row lookback and a history page (2,000) fit. */
const KEPT_ROWS_MAX = 8_000;

export class PostgresNousRepository implements NousRepository {
  // Speed audit 21/11: every setNote dropped the owner's ~4,800-row notes cache (9.08M rows/24h); patch in place via keptRead with 1 h TTL by default.
  // shortcut: a note written outside this process (a restore, manual SQL) shows after notesTtlMs; LISTEN/NOTIFY if a second writer appears.
  private readonly notesCache: ReturnType<typeof keptRead<NousNote[]>>;
  private readonly notesCachedOwners = new Set<string>();
  // The dock asks for the conversation page and the decisions every 1.5-3 s while Nous thinks: 159 page reads (127,774 rows) and 300 decision
  // reads (4.7 s of Postgres) in 150 s against 61 message writes and a few decisions an hour (stable 14/11). Kept like the notes, per owner
  // and call shape, until this instance writes that owner's messages or decisions.
  // shortcut: a row written outside this process shows after notesCacheMs; LISTEN/NOTIFY if a second writer appears.
  private readonly kept = new Map<string, { at: number; rows: Promise<object[]>; got?: object[] }>();
  // Writes in flight and writes ever started: one that no other overlapped knows the order the table took them in.
  private writing = 0;
  private writes = 0;
  constructor(private readonly pool: PgPoolLike, private readonly notesCacheMs = 60_000, private readonly keptRowsMax = KEPT_ROWS_MAX) {
    const notesTtlMs = notesCacheMs === 60_000 ? 3_600_000 : notesCacheMs;
    this.notesCache = keptRead((owner) => {
      this.notesCachedOwners.add(owner);
      return this.readNotes(owner).catch((error) => { this.notesCachedOwners.delete(owner); throw error; });
    }, notesTtlMs);
  }
  private async keep<T extends object>(key: string, read: () => Promise<T[]>): Promise<T[]> {
    let cached = this.kept.get(key);
    if (!cached || Date.now() - cached.at >= this.notesCacheMs) {
      const entry: { at: number; rows: Promise<object[]>; got?: object[] } = { at: Date.now(), rows: read() };
      const forget = () => { if (this.kept.get(key) === entry) this.kept.delete(key); };
      entry.rows.then((rows) => { entry.got = rows; this.trim(); }, forget);
      // Memory: a read nobody repeats (a 3,000-row lookback) leaves when its time is over.
      setTimeout(forget, this.notesCacheMs).unref();
      cached = entry;
    }
    // Most recently read last, so `trim` lets the longest unread one go first.
    this.kept.delete(key);
    this.kept.set(key, cached);
    // Callers sort and edit what they get.
    return ((await cached.rows) as T[]).map((row) => ({ ...row }));
  }
  /**
   * Technical memory bound (stable API out of memory 15/11 08:40Z, heap 1.5 GB): every call shape and every history cursor kept its own copy of the
   * same rows for a minute, as many as were asked (about 10 MB of heap for each 500-row history page, 6,000 rows for a review's lookback).
   * The rows held by all kept reads stay under `keptRowsMax`; the one read longest ago leaves first and is read from Postgres again if asked.
   */
  private trim() {
    let held = 0;
    for (const entry of this.kept.values()) held += entry.got?.length ?? 0;
    for (const [key, entry] of this.kept) {
      if (held <= this.keptRowsMax) return;
      held -= entry.got?.length ?? 0;
      this.kept.delete(key);
    }
  }
  /**
   * After a write (also a failed one: it may have reached the table) the kept reads under `prefix` are read again. With `patch`, a read that
   * has answered takes the written row instead (stable 14/11: the dock read its 770-row page again after each of Nous's message writes, 39
   * reads for 39 writes in 120 s), unless another write overlapped this one or `patch` cannot tell (null). Its age stays the read's.
   */
  private async wrote<T>(prefix: string, write: Promise<T>, patch?: (rows: object[], written: T, shape: string) => object[] | null): Promise<T> {
    const alone = this.writing === 0;
    const mine = ++this.writes;
    this.writing += 1;
    let written: [T] | undefined;
    try { written = [await write]; return written[0]; } finally {
      this.writing -= 1;
      for (const [key, entry] of this.kept) {
        if (!key.startsWith(prefix)) continue;
        const rows = patch && written && alone && mine === this.writes && entry.got ? patch(entry.got, written[0], key.slice(prefix.length)) : null;
        if (rows) { entry.got = rows; entry.rows = Promise.resolve(rows); } else this.kept.delete(key);
      }
    }
  }
  static fromConnectionString(url: string) { return new PostgresNousRepository(createSpacePgPool(url, { max: 2 })); }

  async addMessage(input: NewNousMessage) {
    const result = await this.wrote(`messages\n${input.ownerUserId}\n`, this.pool.query<MessageRow>(`INSERT INTO nous_messages (id, owner_user_id, turn_id, kind, status, content, meta)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING ${messageColumns}`,
    [newId("nous_msg"), input.ownerUserId, input.turnId, input.kind, input.status, input.content, metaJson(input.meta ?? {})]),
    (rows, written, shape) => pageWith(rows as NousMessage[], messageOf(written.rows[0]!), shape));
    return messageOf(result.rows[0]!);
  }
  async updateMessage(owner: string, id: string, patch: { status?: NousMessageStatus; content?: string; meta?: Record<string, unknown> }) {
    const result = await this.wrote(`messages\n${owner}\n`, this.pool.query<MessageRow>(`UPDATE nous_messages SET status = COALESCE($3, status), content = COALESCE($4, content),
      meta = COALESCE($5::jsonb, meta), updated_at = now() WHERE owner_user_id = $1 AND id = $2 RETURNING ${messageColumns}`,
    [owner, id, patch.status ?? null, patch.content === undefined ? null : patch.content, patch.meta === undefined ? null : metaJson(patch.meta)]),
    // An update moves no row: its place (created_at, id) and its kind stay.
    (rows, written) => {
      const row = written.rows[0] ? messageOf(written.rows[0]) : null;
      const page = (rows as NousMessage[]).map((old) => (row && old.id === row.id ? row : old));
      return page.some(modelFromTurn) ? null : page;
    });
    return result.rows[0] ? messageOf(result.rows[0]) : null;
  }
  listMessages(owner: string, limit: number, tools = NOUS_TOOL_ROWS, page: NousMessagePage = {}) {
    return this.keep(`messages\n${owner}\n${JSON.stringify([limit, tools, page.before ?? null, Boolean(page.sinceClear)])}`, () => this.readMessages(owner, limit, tools, page));
  }
  private async readMessages(owner: string, limit: number, tools: number, page: NousMessagePage) {
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
    const ids = messages.filter(modelFromTurn).map((message) => message.turnId!);
    if (ids.length) {
      const facts = await this.pool.query<{ turnId: string; model: string; effort: string | null }>(
        `SELECT turn_id AS "turnId", model, effort FROM nous_turn_facts WHERE owner_user_id = $1 AND turn_id = ANY($2::text[]) AND status = 'DONE' AND model IS NOT NULL`, [owner, ids]);
      const byTurn = new Map(facts.rows.map((turn) => [turn.turnId, turn]));
      for (const message of messages) {
        const turn = modelFromTurn(message) ? byTurn.get(message.turnId!) : null;
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
    const result = await this.pool.query<{ id: string; createdAt: Date | string; person: boolean; superior: string | null }>(`SELECT id, created_at AS "createdAt",
      COALESCE(meta->>'person', 'false') = 'true' AS person, meta->'superior'->>'device' AS superior FROM nous_messages WHERE owner_user_id = $1 AND kind = 'OPERATOR' ORDER BY created_at, id`, [owner]);
    return result.rows.map((row) => ({ id: row.id, createdAt: iso(row.createdAt), person: row.person, ...(row.superior ? { superior: row.superior } : {}) }));
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
    const result = await this.wrote(`messages\n${owner}\n`, this.pool.query<{ count: number }>(`WITH mark AS (INSERT INTO nous_conversation_marks (owner_user_id) VALUES ($1)
      ON CONFLICT (owner_user_id) DO UPDATE SET cleared_at = now() RETURNING cleared_at)
      SELECT count(*)::int AS count FROM nous_messages WHERE owner_user_id = $1 AND created_at <= (SELECT cleared_at FROM mark)`, [owner]));
    return result.rows[0]?.count ?? 0;
  }
  async conversationClearedAt(owner: string) {
    const result = await this.pool.query<{ clearedAt: Date | string | null }>(`SELECT cleared_at AS "clearedAt" FROM nous_conversation_marks WHERE owner_user_id = $1`, [owner]);
    return result.rows[0]?.clearedAt ? iso(result.rows[0].clearedAt) : null;
  }
  async conversationReadUpTo(owner: string) {
    const result = await this.pool.query<{ at: Date | string | null }>(`SELECT read_up_to AS at FROM nous_conversation_marks WHERE owner_user_id = $1`, [owner]);
    return result.rows[0]?.at ? iso(result.rows[0].at) : null;
  }
  async markConversationRead(owner: string, at: string) {
    // A row made here has no Clear (cleared_at NULL, migration 0420); GREATEST ignores the NULL of a row that was never read.
    const result = await this.pool.query<{ at: Date | string }>(`INSERT INTO nous_conversation_marks (owner_user_id, cleared_at, read_up_to)
      VALUES ($1, NULL, $2) ON CONFLICT (owner_user_id) DO UPDATE SET read_up_to = GREATEST(nous_conversation_marks.read_up_to, EXCLUDED.read_up_to)
      RETURNING read_up_to AS at`, [owner, at]);
    return iso(result.rows[0]!.at);
  }
  async createDecision(input: NewNousDecision) {
    const result = await this.wrote(`decisions\n${input.ownerUserId}\n`, this.pool.query<DecisionRow>(`INSERT INTO nous_decisions (id, owner_user_id, category, title, body, options, recommendation, refs, action, status)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9::jsonb, 'OPEN') RETURNING ${decisionColumns}`,
    [newId("nous_decision"), input.ownerUserId, input.category, input.title, input.body, JSON.stringify(input.options), input.recommendation,
      JSON.stringify(input.refs), input.action === null ? null : JSON.stringify(input.action)]));
    return decisionOf(result.rows[0]!);
  }
  async getDecision(owner: string, id: string) {
    const result = await this.pool.query<DecisionRow>(`SELECT ${decisionColumns} FROM nous_decisions WHERE owner_user_id = $1 AND id = $2`, [owner, id]);
    return result.rows[0] ? decisionOf(result.rows[0]) : null;
  }
  listDecisions(owner: string, options: { statuses?: NousDecisionStatus[]; limit?: number; before?: string }) {
    const asked = [owner, options.statuses ?? null, options.limit ?? null, options.before ?? null];
    return this.keep(`decisions\n${owner}\n${JSON.stringify(asked)}`, async () => (await this.pool.query<DecisionRow>(`SELECT ${decisionColumns} FROM nous_decisions WHERE owner_user_id = $1
      AND ($2::text[] IS NULL OR status = ANY($2::text[])) AND ($4::timestamptz IS NULL OR created_at < $4) ORDER BY created_at DESC, id DESC LIMIT $3`, asked)).rows.map(decisionOf));
  }
  async answerDecision(owner: string, id: string, patch: { status: Exclude<NousDecisionStatus, "OPEN">; answer: string | null }) {
    const result = await this.wrote(`decisions\n${owner}\n`, this.pool.query<DecisionRow>(`UPDATE nous_decisions SET status = $3, answer = $4, answered_at = now()
      WHERE owner_user_id = $1 AND id = $2 AND status = 'OPEN' RETURNING ${decisionColumns}`, [owner, id, patch.status, patch.answer]));
    return result.rows[0] ? decisionOf(result.rows[0]) : null;
  }
  async setDecisionOutcome(owner: string, id: string, outcome: string) {
    await this.wrote(`decisions\n${owner}\n`, this.pool.query("UPDATE nous_decisions SET outcome = $3 WHERE owner_user_id = $1 AND id = $2", [owner, id, clip(outcome, 2_000)]));
  }
  async setDecisionFeedback(owner: string, id: string, couldHaveDecided: boolean) {
    const result = await this.wrote(`decisions\n${owner}\n`, this.pool.query<DecisionRow>(`UPDATE nous_decisions SET could_have_decided = $3 WHERE owner_user_id = $1 AND id = $2 AND status <> 'OPEN'
      RETURNING ${decisionColumns}`, [owner, id, couldHaveDecided]));
    return result.rows[0] ? decisionOf(result.rows[0]) : null;
  }
  async listNotes(owner: string) {
    // Callers sort and edit what they get.
    return (await this.notesCache.get(owner)).map((note) => ({ ...note }));
  }
  async getNote(owner: string, key: string) {
    if (this.notesCachedOwners.has(owner)) {
      const hit = (await this.notesCache.get(owner)).find((note) => note.key === key);
      return hit ? { ...hit } : null;
    }
    const result = await this.pool.query<{ key: string; text: string; updatedAt: Date | string; createdAt: Date | string | null }>(
      `SELECT key, text, updated_at AS "updatedAt", created_at AS "createdAt" FROM nous_notes WHERE owner_user_id = $1 AND key = $2`, [owner, key]);
    const row = result.rows[0];
    return row ? { key: row.key, text: row.text, updatedAt: iso(row.updatedAt), createdAt: row.createdAt === null ? null : iso(row.createdAt) } : null;
  }
  private async readNotes(owner: string): Promise<NousNote[]> {
    const result = await this.pool.query<{ key: string; text: string; updatedAt: Date | string; createdAt: Date | string | null }>(
      `SELECT key, text, updated_at AS "updatedAt", created_at AS "createdAt" FROM nous_notes WHERE owner_user_id = $1 ORDER BY key`, [owner]);
    return result.rows.map((row) => ({ key: row.key, text: row.text, updatedAt: iso(row.updatedAt), createdAt: row.createdAt === null ? null : iso(row.createdAt) }));
  }
  async setNote(owner: string, key: string, text: string | null) {
    try {
      if (text === null) {
        await this.pool.query("DELETE FROM nous_notes WHERE owner_user_id = $1 AND key = $2", [owner, key]);
        this.notesCache.patch(owner, (rows) => rows.filter((note) => note.key !== key));
      } else {
        const result = await this.pool.query<{ key: string; text: string; updatedAt: Date | string; createdAt: Date | string | null }>(
          `INSERT INTO nous_notes (owner_user_id, key, text, updated_at) VALUES ($1, $2, $3, now())
           ON CONFLICT (owner_user_id, key) DO UPDATE SET text = EXCLUDED.text, updated_at = now()
           RETURNING key, text, updated_at AS "updatedAt", created_at AS "createdAt"`, [owner, key, text]);
        const returned = result.rows[0];
        this.notesCache.patch(owner, (rows) => {
          const existing = rows.find((note) => note.key === key);
          const at = new Date().toISOString();
          const next: NousNote = returned
            ? { key: returned.key, text: returned.text, updatedAt: iso(returned.updatedAt), createdAt: returned.createdAt === null ? null : iso(returned.createdAt) }
            : { key, text, updatedAt: at, createdAt: existing?.createdAt ?? at };
          // DEV3D-013: an overlapping write landed first; updated_at is now() at transaction start, so only the table knows which won.
          if (existing && existing.updatedAt > next.updatedAt) { this.notesCachedOwners.delete(owner); this.notesCache.drop(owner); return rows; }
          const filtered = rows.filter((note) => note.key !== key);
          filtered.push(next);
          return filtered.sort((left, right) => left.key.localeCompare(right.key));
        });
      }
    } catch (error) {
      // After a failure: the write may have reached the table.
      this.notesCachedOwners.delete(owner);
      this.notesCache.drop(owner);
      throw error;
    }
  }
  async latestMessageMetaAt(owner: string, metaKey: string) {
    const result = await this.pool.query<{ createdAt: Date | string }>(
      `SELECT created_at AS "createdAt" FROM nous_messages WHERE owner_user_id = $1 AND jsonb_typeof(meta->$2) = 'string'
       ORDER BY created_at DESC, id DESC LIMIT 1`, [owner, metaKey]);
    return result.rows[0] ? iso(result.rows[0].createdAt) : null;
  }
  async failRunning(note: string) {
    return rowCount(await this.wrote("messages\n", this.pool.query(`UPDATE nous_messages SET status = 'FAILED', content = left(content || E'\\n' || $1, 20000), updated_at = now()
      WHERE status = 'RUNNING'`, [note])));
  }
  async addTurnFacts(facts: NousTurnFacts) {
    const turn = nousTurnFactsSchema.parse(facts);
    await this.pool.query(`INSERT INTO nous_turn_facts (turn_id, owner_user_id, reason, status, tools, plan_points, outcomes, started_at, ended_at, model, effort, cost_usd, tokens, goal_id, error)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9, $10, $11, $12, $13::jsonb, $14, $15) ON CONFLICT (turn_id) DO NOTHING`,
    [turn.turnId, turn.ownerUserId, turn.reason, turn.status, JSON.stringify(turn.tools), turn.planPoints, JSON.stringify(turn.outcomes), turn.startedAt, turn.endedAt,
      turn.model, turn.effort, turn.costUsd, turn.tokens === null ? null : JSON.stringify(turn.tokens), turn.goalId, nousTurnFactsError(turn)]);
    // A turn older than the tail a kept read fetches again (a backfill): its owner's facts are read whole next time.
    if (Date.parse(turn.startedAt) < Date.now() - TURN_FACTS_REREAD_MS) this.turnFacts.delete(turn.ownerUserId);
  }
  async latestServedTurn(owner: string) {
    const result = await this.pool.query<TurnFactsRow>(`SELECT ${turnFactsColumns} FROM nous_turn_facts
      WHERE owner_user_id = $1 AND status = 'DONE' AND model IS NOT NULL ORDER BY ended_at DESC, turn_id DESC LIMIT 1`, [owner]);
    const row = result.rows[0];
    return row ? nousTurnFactsSchema.parse({ ...row, startedAt: iso(row.startedAt), endedAt: iso(row.endedAt) }) : null;
  }
  // Speed audit 14/11: a turn's facts never change once written (one INSERT ... ON CONFLICT DO NOTHING at its end; no update, no delete), yet the
  // Score, the Goals and the cost reads parsed their whole window again: 19 reads, 90,014 rows and 2.5 s of Postgres in 150 s on stable, every row
  // through zod on the main thread (30 days: 15,671 rows, ~17 MB of JSON). Each owner's stay here, oldest first, from the earliest `since` asked.
  // shortcut: a turn written more than TURN_FACTS_REREAD_MS after it started is missed until the API restarts (a turn is stopped at 20 minutes);
  // read by ended_at with an (owner_user_id, ended_at) index if turns may run longer.
  private readonly turnFacts = new Map<string, { since: string; readAt: number; rows: NousTurnFacts[] }>();
  async listTurnFacts(owner: string, since: string) {
    const asked = iso(since);
    const kept = this.turnFacts.get(owner);
    const covered = kept && kept.since <= asked ? kept : null;
    const readAt = Date.now();
    // A turn is written when it ends: one that started before the last read may have been written after it.
    const back = covered ? new Date(covered.readAt - TURN_FACTS_REREAD_MS).toISOString() : asked;
    const from = covered && covered.since > back ? covered.since : back;
    const result = await this.pool.query<TurnFactsRow>(`SELECT ${turnFactsColumns} FROM nous_turn_facts WHERE owner_user_id = $1 AND started_at >= $2
      ORDER BY started_at ASC, turn_id ASC`, [owner, from]);
    const read = result.rows.map((row) => nousTurnFactsSchema.parse({ ...row, startedAt: iso(row.startedAt), endedAt: iso(row.endedAt) }));
    const entry = { since: covered?.since ?? asked, readAt, rows: covered ? [...covered.rows.filter((row) => row.startedAt < from), ...read] : read };
    // A wider window read meanwhile stays: its next read fetches what this one found.
    const now = this.turnFacts.get(owner);
    if (!now || now.since >= entry.since) this.turnFacts.set(owner, entry);
    // Callers sort and edit what they get.
    return entry.rows.filter((row) => row.startedAt >= asked).map((row) => ({ ...row }));
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
