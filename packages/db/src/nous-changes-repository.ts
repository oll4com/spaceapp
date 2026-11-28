import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

// Nous RSI change ledger (migration 0423, plan clipboard:CCIzkVBIbPpG step 1): every change Nous made to itself with its raw counts
// before and after. Rows are never deleted.

export type NousChangeKind = "LESSON" | "PROMPT" | "CODE" | "ROUTING";
export type NousChangeVerdict = "KEPT" | "NO_EFFECT" | "WORSE" | "UNMEASURED";
export interface NousChangeCounts { count: number; turns: number }
export interface NousChange {
  ownerUserId: string; kind: NousChangeKind;
  /** What shipped it: a merge-queue ticket, a commit, a note key. One row per owner, kind and ref. */
  ref: string;
  cause: string;
  /** What must fall (rsi/ledger.ts `countMetric`); null when the change named nothing countable. */
  metric: string | null;
  deployedAt: string;
  before: NousChangeCounts | null; after: NousChangeCounts | null;
  verdict: NousChangeVerdict | null; measuredAt: string | null;
}

export interface NousChangesRepository {
  /** Keeps the first row of a ref; false when it was already there. */
  add(change: NousChange): Promise<boolean>;
  list(owner: string): Promise<NousChange[]>;
  measured(owner: string, kind: NousChangeKind, ref: string, after: NousChangeCounts, verdict: NousChangeVerdict, at?: Date): Promise<void>;
  dispose(): Promise<void>;
}

export class InMemoryNousChangesRepository implements NousChangesRepository {
  private readonly rows: NousChange[] = [];
  private find(owner: string, kind: NousChangeKind, ref: string) { return this.rows.find((row) => row.ownerUserId === owner && row.kind === kind && row.ref === ref); }
  async add(change: NousChange) {
    if (this.find(change.ownerUserId, change.kind, change.ref)) return false;
    this.rows.push({ ...change });
    return true;
  }
  async list(owner: string) { return this.rows.filter((row) => row.ownerUserId === owner).map((row) => ({ ...row })); }
  async measured(owner: string, kind: NousChangeKind, ref: string, after: NousChangeCounts, verdict: NousChangeVerdict, at = new Date()) {
    const row = this.find(owner, kind, ref);
    if (row && row.verdict === null) Object.assign(row, { after, verdict, measuredAt: at.toISOString() });
  }
  async dispose() {}
}

interface ChangeRow {
  ownerUserId: string; kind: NousChangeKind; ref: string; cause: string; metric: string | null; deployedAt: Date | string;
  beforeCount: number | null; beforeTurns: number | null; afterCount: number | null; afterTurns: number | null;
  verdict: NousChangeVerdict | null; measuredAt: Date | string | null;
}
const counts = (count: number | null, turns: number | null): NousChangeCounts | null => (count === null || turns === null ? null : { count, turns });

export class PostgresNousChangesRepository implements NousChangesRepository {
  constructor(private readonly pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresNousChangesRepository(createSpacePgPool(url, { max: 1 })); }

  async add(change: NousChange) {
    const result = await this.pool.query(`INSERT INTO nous_changes (owner_user_id, kind, ref, cause, metric, deployed_at, before_count, before_turns, after_count, after_turns, verdict, measured_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (owner_user_id, kind, ref) DO NOTHING`,
    [change.ownerUserId, change.kind, change.ref, change.cause, change.metric, change.deployedAt, change.before?.count ?? null, change.before?.turns ?? null,
      change.after?.count ?? null, change.after?.turns ?? null, change.verdict, change.measuredAt]);
    return (result.rowCount ?? 0) > 0;
  }
  async list(owner: string) {
    const result = await this.pool.query<ChangeRow>(`SELECT owner_user_id AS "ownerUserId", kind, ref, cause, metric, deployed_at AS "deployedAt", before_count AS "beforeCount",
      before_turns AS "beforeTurns", after_count AS "afterCount", after_turns AS "afterTurns", verdict, measured_at AS "measuredAt"
      FROM nous_changes WHERE owner_user_id = $1 ORDER BY deployed_at ASC, ref ASC`, [owner]);
    return result.rows.map((row): NousChange => ({ ownerUserId: row.ownerUserId, kind: row.kind, ref: row.ref, cause: row.cause, metric: row.metric,
      deployedAt: new Date(row.deployedAt).toISOString(), before: counts(row.beforeCount, row.beforeTurns), after: counts(row.afterCount, row.afterTurns),
      verdict: row.verdict, measuredAt: row.measuredAt === null ? null : new Date(row.measuredAt).toISOString() }));
  }
  async measured(owner: string, kind: NousChangeKind, ref: string, after: NousChangeCounts, verdict: NousChangeVerdict, at = new Date()) {
    await this.pool.query(`UPDATE nous_changes SET after_count = $4, after_turns = $5, verdict = $6, measured_at = $7
      WHERE owner_user_id = $1 AND kind = $2 AND ref = $3 AND verdict IS NULL`, [owner, kind, ref, after.count, after.turns, verdict, at.toISOString()]);
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
