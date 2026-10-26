import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

// When each open plan last moved, as Nous observes it (migration 0217, plan clipboard:8s0ZNiO3q5ZT S4): its percentage, and since
// 2026-10-21 (migration 0243, standing orders) its steps' statuses too, plus when a STANDING turn last nudged it.

export interface NousPlanObservation {
  planId: string; percent: number;
  /** The first observation's time: the plan's last progress write or creation. */
  since: string;
  /** The plan's status and step statuses as one string; a change counts as movement like a percentage change. */
  fingerprint?: string;
}
export interface NousPlanMark { changedAt: string; lastNudgedAt: string | null }

export interface NousPlanMarksRepository {
  /** Records what Nous sees now; returns when each plan last moved (a new mark starts at `since`) and when it was last nudged. */
  observe(owner: string, plans: NousPlanObservation[], now?: Date): Promise<Map<string, NousPlanMark>>;
  /** A STANDING turn took these plans up now. */
  nudged(owner: string, planIds: string[], at?: Date): Promise<void>;
  dispose(): Promise<void>;
}

export class InMemoryNousPlanMarksRepository implements NousPlanMarksRepository {
  private readonly marks = new Map<string, { percent: number; fingerprint: string | null; changedAt: string; lastNudgedAt: string | null }>();
  async observe(owner: string, plans: NousPlanObservation[], now = new Date()) {
    const changed = new Map<string, NousPlanMark>();
    for (const plan of plans) {
      const key = `${owner}\u0000${plan.planId}`;
      const mark = this.marks.get(key);
      const fingerprint = plan.fingerprint ?? null;
      // A mark from before fingerprints (null) takes the first fingerprint without moving the clock.
      const moved = mark && (mark.percent !== plan.percent || (mark.fingerprint !== null && fingerprint !== null && mark.fingerprint !== fingerprint));
      const next = !mark ? { percent: plan.percent, fingerprint, changedAt: plan.since, lastNudgedAt: null }
        : moved ? { percent: plan.percent, fingerprint, changedAt: now.toISOString(), lastNudgedAt: mark.lastNudgedAt } : { ...mark, fingerprint: fingerprint ?? mark.fingerprint };
      this.marks.set(key, next);
      changed.set(plan.planId, { changedAt: next.changedAt, lastNudgedAt: next.lastNudgedAt });
    }
    return changed;
  }
  async nudged(owner: string, planIds: string[], at = new Date()) {
    for (const planId of planIds) {
      const key = `${owner}\u0000${planId}`;
      const mark = this.marks.get(key);
      if (mark) this.marks.set(key, { ...mark, lastNudgedAt: at.toISOString() });
    }
  }
  async dispose() {}
}

export class PostgresNousPlanMarksRepository implements NousPlanMarksRepository {
  constructor(private readonly pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresNousPlanMarksRepository(createSpacePgPool(url, { max: 1 })); }

  async observe(owner: string, plans: NousPlanObservation[], now = new Date()) {
    if (!plans.length) return new Map<string, NousPlanMark>();
    const result = await this.pool.query<{ planId: string; changedAt: Date | string; lastNudgedAt: Date | string | null }>(`INSERT INTO nous_plan_marks (owner_user_id, plan_id, percent, changed_at, steps_fingerprint)
      SELECT $1, plan.id, plan.percent, plan.since, plan.fingerprint FROM unnest($2::text[], $3::int[], $4::timestamptz[], $5::text[]) AS plan(id, percent, since, fingerprint)
      ON CONFLICT (owner_user_id, plan_id) DO UPDATE SET percent = EXCLUDED.percent, steps_fingerprint = COALESCE(EXCLUDED.steps_fingerprint, nous_plan_marks.steps_fingerprint),
        changed_at = CASE WHEN nous_plan_marks.percent = EXCLUDED.percent
          AND (nous_plan_marks.steps_fingerprint IS NULL OR EXCLUDED.steps_fingerprint IS NULL OR nous_plan_marks.steps_fingerprint = EXCLUDED.steps_fingerprint)
          THEN nous_plan_marks.changed_at ELSE $6::timestamptz END
      RETURNING plan_id AS "planId", changed_at AS "changedAt", last_nudged_at AS "lastNudgedAt"`,
    [owner, plans.map((plan) => plan.planId), plans.map((plan) => plan.percent), plans.map((plan) => plan.since), plans.map((plan) => plan.fingerprint ?? null), now.toISOString()]);
    return new Map(result.rows.map((row) => [row.planId, { changedAt: new Date(row.changedAt).toISOString(), lastNudgedAt: row.lastNudgedAt === null ? null : new Date(row.lastNudgedAt).toISOString() }]));
  }
  async nudged(owner: string, planIds: string[], at = new Date()) {
    if (!planIds.length) return;
    await this.pool.query(`UPDATE nous_plan_marks SET last_nudged_at = $3 WHERE owner_user_id = $1 AND plan_id = ANY($2::text[])`, [owner, planIds, at.toISOString()]);
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
