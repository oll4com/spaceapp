import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

// Nous Away mode (migration 0225, plan clipboard:B7eTUHTJYg3X): one open away session per owner and the log of what Nous did
// while the operator was away.

export type NousAwayEndReason = "RETURN" | "UNTIL" | "SWITCH" | "NOUS";
export interface NousAwaySession {
  id: string; ownerUserId: string; startedAt: string; until: string | null; endedAt: string | null; endReason: NousAwayEndReason | null;
  reason: string; mandate: string; grant: string[]; operatorMessageId: string | null; operatorQuote: string | null;
}
export type NewNousAwaySession = Omit<NousAwaySession, "endedAt" | "endReason">;
export interface NousAwayLogEntry { at: string; source: string; what: string; result: string }

export interface NousAwayRepository {
  /** Null when the owner already has an open session. */
  start(input: NewNousAwaySession): Promise<NousAwaySession | null>;
  open(owner: string): Promise<NousAwaySession | null>;
  /** Every owner's open session, for the until-time check. */
  listOpen(): Promise<NousAwaySession[]>;
  setGrant(owner: string, id: string, grant: string[]): Promise<NousAwaySession | null>;
  /** Null when the session is not open any more. */
  end(owner: string, id: string, reason: NousAwayEndReason, at: string): Promise<NousAwaySession | null>;
  log(awayId: string, entry: NousAwayLogEntry): Promise<void>;
  listLog(awayId: string, limit: number): Promise<NousAwayLogEntry[]>;
  dispose(): Promise<void>;
}

export class InMemoryNousAwayRepository implements NousAwayRepository {
  private readonly sessions = new Map<string, NousAwaySession>();
  private readonly logs = new Map<string, NousAwayLogEntry[]>();
  async start(input: NewNousAwaySession) {
    if (await this.open(input.ownerUserId)) return null;
    const session: NousAwaySession = { ...input, grant: [...input.grant], endedAt: null, endReason: null };
    this.sessions.set(session.id, session);
    return { ...session };
  }
  async open(owner: string) {
    const session = [...this.sessions.values()].find((entry) => entry.ownerUserId === owner && !entry.endedAt);
    return session ? { ...session } : null;
  }
  async listOpen() { return [...this.sessions.values()].filter((entry) => !entry.endedAt).map((entry) => ({ ...entry })); }
  async setGrant(owner: string, id: string, grant: string[]) {
    const session = this.sessions.get(id);
    if (!session || session.ownerUserId !== owner || session.endedAt) return null;
    session.grant = [...grant];
    return { ...session };
  }
  async end(owner: string, id: string, reason: NousAwayEndReason, at: string) {
    const session = this.sessions.get(id);
    if (!session || session.ownerUserId !== owner || session.endedAt) return null;
    Object.assign(session, { endedAt: at, endReason: reason });
    return { ...session };
  }
  async log(awayId: string, entry: NousAwayLogEntry) { this.logs.set(awayId, [...(this.logs.get(awayId) ?? []), { ...entry }]); }
  async listLog(awayId: string, limit: number) { return (this.logs.get(awayId) ?? []).slice(-limit).map((entry) => ({ ...entry })); }
  async dispose() {}
}

interface SessionRow {
  id: string; ownerUserId: string; startedAt: Date | string; until: Date | string | null; endedAt: Date | string | null; endReason: NousAwayEndReason | null;
  reason: string; mandate: string; grant: string[]; operatorMessageId: string | null; operatorQuote: string | null;
}
const iso = (value: Date | string | null) => value === null ? null : new Date(value).toISOString();
const sessionColumns = `id, owner_user_id AS "ownerUserId", started_at AS "startedAt", until_at AS "until", ended_at AS "endedAt", end_reason AS "endReason",
  reason, mandate, grant_categories AS "grant", operator_message_id AS "operatorMessageId", operator_quote AS "operatorQuote"`;
const sessionOf = (row: SessionRow): NousAwaySession => ({ ...row, startedAt: iso(row.startedAt)!, until: iso(row.until), endedAt: iso(row.endedAt) });

export class PostgresNousAwayRepository implements NousAwayRepository {
  constructor(private readonly pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresNousAwayRepository(createSpacePgPool(url, { max: 1 })); }

  async start(input: NewNousAwaySession) {
    // The partial unique index keeps one open session per owner; a second start is refused, never a second row.
    const result = await this.pool.query<SessionRow>(
      `INSERT INTO nous_away_sessions (id, owner_user_id, started_at, until_at, reason, mandate, grant_categories, operator_message_id, operator_quote)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9) ON CONFLICT (owner_user_id) WHERE ended_at IS NULL DO NOTHING RETURNING ${sessionColumns}`,
      [input.id, input.ownerUserId, input.startedAt, input.until, input.reason, input.mandate, JSON.stringify(input.grant), input.operatorMessageId, input.operatorQuote]);
    return result.rows[0] ? sessionOf(result.rows[0]) : null;
  }
  async open(owner: string) {
    const result = await this.pool.query<SessionRow>(`SELECT ${sessionColumns} FROM nous_away_sessions WHERE owner_user_id = $1 AND ended_at IS NULL`, [owner]);
    return result.rows[0] ? sessionOf(result.rows[0]) : null;
  }
  async listOpen() {
    return (await this.pool.query<SessionRow>(`SELECT ${sessionColumns} FROM nous_away_sessions WHERE ended_at IS NULL`)).rows.map(sessionOf);
  }
  async setGrant(owner: string, id: string, grant: string[]) {
    const result = await this.pool.query<SessionRow>(
      `UPDATE nous_away_sessions SET grant_categories = $3::jsonb WHERE id = $1 AND owner_user_id = $2 AND ended_at IS NULL RETURNING ${sessionColumns}`,
      [id, owner, JSON.stringify(grant)]);
    return result.rows[0] ? sessionOf(result.rows[0]) : null;
  }
  async end(owner: string, id: string, reason: NousAwayEndReason, at: string) {
    const result = await this.pool.query<SessionRow>(
      `UPDATE nous_away_sessions SET ended_at = $4, end_reason = $3 WHERE id = $1 AND owner_user_id = $2 AND ended_at IS NULL RETURNING ${sessionColumns}`,
      [id, owner, reason, at]);
    return result.rows[0] ? sessionOf(result.rows[0]) : null;
  }
  async log(awayId: string, entry: NousAwayLogEntry) {
    await this.pool.query(`INSERT INTO nous_away_log (away_id, at, source, what, result) VALUES ($1, $2, $3, $4, $5)`,
      [awayId, entry.at, entry.source, entry.what, entry.result]);
  }
  async listLog(awayId: string, limit: number) {
    const result = await this.pool.query<{ at: Date | string; source: string; what: string; result: string }>(
      `SELECT at, source, what, result FROM (SELECT id, at, source, what, result FROM nous_away_log WHERE away_id = $1 ORDER BY id DESC LIMIT $2) newest ORDER BY id`,
      [awayId, limit]);
    return result.rows.map((row) => ({ ...row, at: iso(row.at)! }));
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
