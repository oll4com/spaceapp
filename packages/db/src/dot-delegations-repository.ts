import { randomUUID } from "node:crypto";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

/** Delegations between a user's Dots (Space Dots Stage 4). */
export interface DotDelegationRecord {
  delegationId: string;
  ownerUserId: string;
  roomId: string;
  fromDotId: string;
  fromSessionId: string;
  toDotId: string;
  toSessionId: string;
  goalId: string;
  paneId: string;
  task: string;
  reportedStatus: string | null;
  createdAt: string;
}
export interface DotDelegationsRepository {
  create(input: Omit<DotDelegationRecord, "delegationId" | "reportedStatus" | "createdAt">): Promise<DotDelegationRecord>;
  /** Delegations whose Goal reached a status not yet reported to the delegating Dot. */
  unreported(limit: number): Promise<Array<DotDelegationRecord & { goalStatus: string; goalStatusReason: string | null; evidence: unknown }>>;
  /** Marks one outcome reported; false when another process reported it first. */
  markReported(delegationId: string, status: string): Promise<boolean>;
  list(owner: string, dotId: string, limit: number): Promise<Array<DotDelegationRecord & { goalStatus: string }>>;
  dispose(): Promise<void>;
}
const columns = `d.delegation_id AS "delegationId", d.owner_user_id AS "ownerUserId", d.room_id AS "roomId", d.from_dot_id AS "fromDotId",
  d.from_session_id AS "fromSessionId", d.to_dot_id AS "toDotId", d.to_session_id AS "toSessionId", d.goal_id AS "goalId", d.pane_id AS "paneId",
  d.task, d.reported_status AS "reportedStatus", d.created_at AS "createdAt"`;
const iso = <T extends { createdAt: unknown }>(row: T) => ({ ...row, createdAt: new Date(row.createdAt as string).toISOString() });
export class PostgresDotDelegationsRepository implements DotDelegationsRepository {
  constructor(private pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresDotDelegationsRepository(createSpacePgPool(url, { max: 2 })); }
  async create(input: Parameters<DotDelegationsRepository["create"]>[0]) {
    const id = `dot_delegation:${randomUUID().replace(/-/g, "")}`;
    await this.pool.query(`INSERT INTO dot_delegations(delegation_id,owner_user_id,room_id,from_dot_id,from_session_id,to_dot_id,to_session_id,goal_id,pane_id,task)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, input.ownerUserId, input.roomId, input.fromDotId, input.fromSessionId, input.toDotId,
      input.toSessionId, input.goalId, input.paneId, input.task]);
    const row = (await this.pool.query<DotDelegationRecord>(`SELECT ${columns} FROM dot_delegations d WHERE d.delegation_id=$1`, [id])).rows[0]!;
    return iso(row);
  }
  async unreported(limit: number) {
    return (await this.pool.query<DotDelegationRecord & { goalStatus: string; goalStatusReason: string | null; evidence: unknown }>(`SELECT ${columns},
      g.status AS "goalStatus", g.status_reason AS "goalStatusReason", g.evidence FROM dot_delegations d JOIN dot_goals g ON g.goal_id=d.goal_id
      WHERE g.status IN ('COMPLETED','BLOCKED','CANCELLED','BUDGET_EXHAUSTED','FAILED') AND d.reported_status IS DISTINCT FROM g.status
      ORDER BY d.created_at LIMIT $1`, [Math.min(50, Math.max(1, limit))])).rows.map(iso);
  }
  async markReported(delegationId: string, status: string) {
    return (await this.pool.query(`UPDATE dot_delegations SET reported_status=$2, reported_at=now()
      WHERE delegation_id=$1 AND reported_status IS DISTINCT FROM $2 RETURNING delegation_id`, [delegationId, status])).rows.length === 1;
  }
  async list(owner: string, dotId: string, limit: number) {
    return (await this.pool.query<DotDelegationRecord & { goalStatus: string }>(`SELECT ${columns}, g.status AS "goalStatus" FROM dot_delegations d
      JOIN dot_goals g ON g.goal_id=d.goal_id WHERE d.owner_user_id=$1 AND (d.from_dot_id=$2 OR d.to_dot_id=$2)
      ORDER BY d.created_at DESC LIMIT $3`, [owner, dotId, Math.min(100, Math.max(1, limit))])).rows.map(iso);
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
