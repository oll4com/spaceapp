import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

// When each open plan's percentage last changed, as Nous observes it (migration 0217, plan clipboard:8s0ZNiO3q5ZT S4).

export interface NousPlanObservation { planId: string; percent: number; /** The first observation's time: the plan's last progress write or creation. */ since: string }

export interface NousPlanMarksRepository {
  /** Records what Nous sees now; returns when each plan's percentage last changed (a new mark starts at `since`). */
  observe(owner: string, plans: NousPlanObservation[], now?: Date): Promise<Map<string, string>>;
  dispose(): Promise<void>;
}

export class InMemoryNousPlanMarksRepository implements NousPlanMarksRepository {
  private readonly marks = new Map<string, { percent: number; changedAt: string }>();
  async observe(owner: string, plans: NousPlanObservation[], now = new Date()) {
    const changed = new Map<string, string>();
    for (const plan of plans) {
      const key = `${owner}\u0000${plan.planId}`;
      const mark = this.marks.get(key);
      const next = !mark ? { percent: plan.percent, changedAt: plan.since } : mark.percent === plan.percent ? mark : { percent: plan.percent, changedAt: now.toISOString() };
      this.marks.set(key, next);
      changed.set(plan.planId, next.changedAt);
    }
    return changed;
  }
  async dispose() {}
}

export class PostgresNousPlanMarksRepository implements NousPlanMarksRepository {
  constructor(private readonly pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresNousPlanMarksRepository(createSpacePgPool(url, { max: 1 })); }

  async observe(owner: string, plans: NousPlanObservation[], now = new Date()) {
    if (!plans.length) return new Map<string, string>();
    const result = await this.pool.query<{ planId: string; changedAt: Date | string }>(`INSERT INTO nous_plan_marks (owner_user_id, plan_id, percent, changed_at)
      SELECT $1, plan.id, plan.percent, plan.since FROM unnest($2::text[], $3::int[], $4::timestamptz[]) AS plan(id, percent, since)
      ON CONFLICT (owner_user_id, plan_id) DO UPDATE SET percent = EXCLUDED.percent,
        changed_at = CASE WHEN nous_plan_marks.percent = EXCLUDED.percent THEN nous_plan_marks.changed_at ELSE $5::timestamptz END
      RETURNING plan_id AS "planId", changed_at AS "changedAt"`,
    [owner, plans.map((plan) => plan.planId), plans.map((plan) => plan.percent), plans.map((plan) => plan.since), now.toISOString()]);
    return new Map(result.rows.map((row) => [row.planId, new Date(row.changedAt).toISOString()]));
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
