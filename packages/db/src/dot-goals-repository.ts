import { randomUUID } from "node:crypto";
import { dotGoalSchema, dotGoalWorkflowId, type DotGoal, type DotGoalMilestone, type DotGoalStatus } from "@space/contracts";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

/** Durable Dot Goals (Space Dots Stage 4). Every mutation is a guarded single statement. */
export interface DotGoalsRepository {
  create(input: { dotId: string; ownerUserId: string; roomId: string; sessionId: string; objective: string;
    milestones: string[]; criteria: string[]; budget: DotGoal["budget"] }): Promise<DotGoal>;
  get(goalId: string): Promise<DotGoal | null>;
  getOwned(owner: string, dotId: string, goalId: string): Promise<DotGoal | null>;
  openForSession(sessionId: string): Promise<DotGoal | null>;
  list(owner: string, dotId: string, sessionId?: string): Promise<DotGoal[]>;
  listOpen(limit: number): Promise<DotGoal[]>;
  transition(goalId: string, from: DotGoalStatus[], to: DotGoalStatus, reason: string | null): Promise<DotGoal | null>;
  /** Counts a finished step once per run id. */
  recordStep(goalId: string, runId: string, failed: boolean): Promise<DotGoal | null>;
  addSteering(goalId: string, text: string): Promise<DotGoal | null>;
  markSteeringDelivered(goalId: string, ids: string[]): Promise<void>;
  updateMilestone(goalId: string, milestoneId: string, status: "IN_PROGRESS" | "DONE", note: string | null): Promise<DotGoal | null>;
  complete(goalId: string, evidence: Array<{ criterion: string; evidence: string }>): Promise<DotGoal | null>;
  dispose(): Promise<void>;
}

const select = `SELECT goal_id AS "goalId", dot_id AS "dotId", owner_user_id AS "ownerUserId", room_id AS "roomId", session_id AS "sessionId",
  objective, milestones, criteria, budget, usage, status, status_reason AS "statusReason", steering, evidence, workflow_id AS "workflowId",
  created_at AS "createdAt", updated_at AS "updatedAt", completed_at AS "completedAt" FROM dot_goals`;
function goal(row: Record<string, unknown>): DotGoal {
  const iso = (value: unknown) => value === null || value === undefined ? null : new Date(value as string).toISOString();
  // PostgreSQL renders timestamps inside jsonb with an offset; the contract uses UTC ISO.
  const usage = row.usage as Record<string, unknown>;
  const steering = (row.steering as Array<Record<string, unknown>>).map((entry) => ({ ...entry, createdAt: iso(entry.createdAt), deliveredAt: iso(entry.deliveredAt) }));
  return dotGoalSchema.parse({ ...row, usage: { ...usage, lastStepAt: iso(usage.lastStepAt) }, steering,
    createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt), completedAt: iso(row.completedAt) });
}
const terminal = `CASE WHEN $3 IN ('COMPLETED','CANCELLED','BUDGET_EXHAUSTED','FAILED') THEN now() ELSE NULL END`;

export class PostgresDotGoalsRepository implements DotGoalsRepository {
  constructor(private pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresDotGoalsRepository(createSpacePgPool(url, { max: 3 })); }
  private async one(sql: string, params: unknown[]): Promise<DotGoal | null> {
    const row = (await this.pool.query<Record<string, unknown>>(sql, params)).rows[0];
    return row ? goal(row) : null;
  }
  async create(input: Parameters<DotGoalsRepository["create"]>[0]) {
    const goalId = `dot_goal:${randomUUID().replace(/-/g, "")}`;
    const milestones: DotGoalMilestone[] = input.milestones.map((title, index) => ({ id: `m${index + 1}`, title, status: "PENDING", note: null }));
    await this.pool.query(`INSERT INTO dot_goals(goal_id,dot_id,owner_user_id,room_id,session_id,objective,milestones,criteria,budget,status,workflow_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,'ACTIVE',$10)`,
      [goalId, input.dotId, input.ownerUserId, input.roomId, input.sessionId, input.objective, JSON.stringify(milestones),
        JSON.stringify(input.criteria), JSON.stringify(input.budget), dotGoalWorkflowId(goalId)]).catch((error: { code?: string }) => {
      if (error.code === "23505") throw Object.assign(new Error("This conversation already has an open Goal."), { code: "DOT_GOAL_OPEN" });
      throw error;
    });
    return (await this.get(goalId))!;
  }
  get(goalId: string) { return this.one(`${select} WHERE goal_id=$1`, [goalId]); }
  getOwned(owner: string, dotId: string, goalId: string) {
    return this.one(`${select} g WHERE g.goal_id=$3 AND g.owner_user_id=$1 AND g.dot_id=$2
      AND EXISTS (SELECT 1 FROM rooms r WHERE r.id=g.room_id AND r.owner_user_id=$1)`, [owner, dotId, goalId]);
  }
  openForSession(sessionId: string) { return this.one(`${select} WHERE session_id=$1 AND status IN ('ACTIVE','PAUSED','BLOCKED')`, [sessionId]); }
  async list(owner: string, dotId: string, sessionId?: string) {
    return (await this.pool.query<Record<string, unknown>>(`${select} g WHERE g.owner_user_id=$1 AND g.dot_id=$2 AND ($3::text IS NULL OR g.session_id=$3)
      AND EXISTS (SELECT 1 FROM rooms r WHERE r.id=g.room_id AND r.owner_user_id=$1) ORDER BY g.updated_at DESC, g.goal_id LIMIT 20`,
      [owner, dotId, sessionId ?? null])).rows.map(goal);
  }
  async listOpen(limit: number) {
    return (await this.pool.query<Record<string, unknown>>(`${select} WHERE status IN ('ACTIVE','PAUSED','BLOCKED') ORDER BY updated_at LIMIT $1`,
      [Math.min(500, Math.max(1, limit))])).rows.map(goal);
  }
  async transition(goalId: string, from: DotGoalStatus[], to: DotGoalStatus, reason: string | null) {
    const row = (await this.pool.query(`UPDATE dot_goals SET status=$3, status_reason=$4, completed_at=${terminal}
      WHERE goal_id=$1 AND status = ANY($2::text[]) RETURNING goal_id`, [goalId, from, to, reason?.slice(0, 1000) ?? null])).rows[0];
    return row ? this.get(goalId) : null;
  }
  async recordStep(goalId: string, runId: string, failed: boolean) {
    const row = (await this.pool.query(`UPDATE dot_goals SET usage = usage || jsonb_build_object('steps', (usage->>'steps')::int + 1,
      'lastRunId', $2::text, 'lastStepAt', now(), 'consecutiveFailures', CASE WHEN $3 THEN (usage->>'consecutiveFailures')::int + 1 ELSE 0 END)
      WHERE goal_id=$1 AND (usage->>'lastRunId') IS DISTINCT FROM $2 RETURNING goal_id`, [goalId, runId, failed])).rows[0];
    void row;
    return this.get(goalId);
  }
  async addSteering(goalId: string, text: string) {
    const entry = { id: `steer_${randomUUID().slice(0, 8)}`, text: text.slice(0, 4000), createdAt: new Date().toISOString(), deliveredAt: null };
    const row = (await this.pool.query(`UPDATE dot_goals SET steering = (steering || $2::jsonb)
      WHERE goal_id=$1 AND status IN ('ACTIVE','PAUSED','BLOCKED') AND jsonb_array_length(steering) < 50 RETURNING goal_id`, [goalId, JSON.stringify([entry])])).rows[0];
    return row ? this.get(goalId) : null;
  }
  async markSteeringDelivered(goalId: string, ids: string[]) {
    if (!ids.length) return;
    await this.pool.query(`UPDATE dot_goals SET steering = (SELECT jsonb_agg(CASE WHEN item->>'id' = ANY($2::text[]) AND item->'deliveredAt' = 'null'::jsonb
      THEN item || jsonb_build_object('deliveredAt', now()) ELSE item END) FROM jsonb_array_elements(steering) item) WHERE goal_id=$1`, [goalId, ids]);
  }
  async updateMilestone(goalId: string, milestoneId: string, status: "IN_PROGRESS" | "DONE", note: string | null) {
    const row = (await this.pool.query(`UPDATE dot_goals SET milestones = (SELECT jsonb_agg(CASE WHEN item->>'id' = $2
      THEN item || jsonb_build_object('status', $3::text, 'note', $4::text) ELSE item END) FROM jsonb_array_elements(milestones) item)
      WHERE goal_id=$1 AND status='ACTIVE' AND milestones @> jsonb_build_array(jsonb_build_object('id', $2::text)) RETURNING goal_id`,
      [goalId, milestoneId, status, note?.slice(0, 1000) ?? null])).rows[0];
    return row ? this.get(goalId) : null;
  }
  async complete(goalId: string, evidence: Array<{ criterion: string; evidence: string }>) {
    const row = (await this.pool.query(`UPDATE dot_goals SET status='COMPLETED', status_reason='Completed with evidence.', evidence=$2::jsonb,
      completed_at=now() WHERE goal_id=$1 AND status='ACTIVE' RETURNING goal_id`, [goalId, JSON.stringify(evidence.slice(0, 10))])).rows[0];
    return row ? this.get(goalId) : null;
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
