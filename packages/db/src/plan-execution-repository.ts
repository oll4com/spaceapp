import { rollbackKeepingError } from "./rollback.js";
import {
  managedPlanExecutionSchema,
  type ManagedPlanExecution,
} from "@space/contracts";
import {
  applyPlanExecutionPatch,
  managedPlanProjection,
  planExecutionEvents,
  type PlanExecutionEvent,
  newPlanExecution,
  PlanExecutionConflictError,
  type CreateManagedPlanExecution,
  type ManagedPlanExecutionPatch,
  type PlanExecutionLease,
  type PlanExecutionRepository,
} from "@space/runtime";
import type { PgPoolLike, PgClientLike } from "./space-store.js";
type Row = {
  record: unknown;
  lease_owner: string | null;
  lease_epoch: number;
  lease_expires_at: Date | string | null;
};
function map(row: Row): ManagedPlanExecution {
  return managedPlanExecutionSchema.parse({
    ...(row.record as object),
    lease:
      row.lease_owner && row.lease_expires_at
        ? {
            owner: row.lease_owner,
            epoch: row.lease_epoch,
            expiresAt: new Date(row.lease_expires_at).toISOString(),
          }
        : null,
  });
}
export class PostgresPlanExecutionRepository implements PlanExecutionRepository {
  constructor(private readonly pool: PgPoolLike) {}
  private async transaction<T>(
    work: (client: PgClientLike) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    let rollbackFailed = false;
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      rollbackFailed = await rollbackKeepingError(client);
      if ((error as { code?: string }).code === "23505")
        throw new PlanExecutionConflictError(
          "An active execution already owns this pane or plan.",
        );
      throw error;
    } finally {
      client.release?.(rollbackFailed || undefined);
    }
  }
  private async project(client: PgClientLike, record: ManagedPlanExecution): Promise<void> {
        const projection = managedPlanProjection(record);
        const projected = await client.query(`UPDATE clipboard_items SET steps_json=$3::jsonb,is_completed=$4,
          execution_status=$5,progress_percentage=$6,active_agent=$7,last_progress_at=$8
          WHERE owner_user_id=$1 AND id=$2 AND source='PLAN' RETURNING id`,
          [record.ownerUserId,record.planId,JSON.stringify(projection.steps),projection.isCompleted,projection.executionStatus,
            projection.progressPercentage,projection.activeAgent,projection.lastProgressAt]);
        if (!projected.rows.length) throw new PlanExecutionConflictError("Managed PLAN is unavailable.");
  }
  async create(
    input: CreateManagedPlanExecution,
    projectToPlan = false,
  ): Promise<ManagedPlanExecution> {
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        input.ownerUserId,
      ]);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `${input.ownerUserId}:${input.requestId}`,
      ]);
      const duplicate = await client.query<Row>(
        "SELECT * FROM managed_plan_executions WHERE owner_user_id=$1 AND request_id=$2",
        [input.ownerUserId, input.requestId],
      );
      if (duplicate.rows[0]) {
        const record = map(duplicate.rows[0]);
        if (
          record.planId !== input.planId ||
          record.paneId !== input.paneId ||
          record.sessionId !== input.sessionId
        )
          throw new PlanExecutionConflictError(
            "Request id was used for a different execution.",
          );
        return record;
      }
      const record = newPlanExecution(input);
      const result = await client.query<Row>(
        "INSERT INTO managed_plan_executions(id,owner_user_id,plan_id,pane_id,session_id,request_id,status,revision,record) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING *",
        [
          record.id,
          record.ownerUserId,
          record.planId,
          record.paneId,
          record.sessionId,
          record.requestId,
          record.status,
          record.revision,
          JSON.stringify(record),
        ],
      );
      if (projectToPlan) await this.project(client,record);
      return map(result.rows[0]!);
    });
  }
  async get(owner: string, id: string): Promise<ManagedPlanExecution | null> {
    const result = await this.pool.query<Row>(
      "SELECT * FROM managed_plan_executions WHERE id=$1 AND owner_user_id=$2",
      [id, owner],
    );
    return result.rows[0] ? map(result.rows[0]) : null;
  }
  async findForPane(
    owner: string,
    paneId: string,
  ): Promise<ManagedPlanExecution | null> {
    const result = await this.pool.query<Row>(
      "SELECT * FROM managed_plan_executions WHERE owner_user_id=$1 AND pane_id=$2 ORDER BY (status NOT IN ('COMPLETED','FAILED')) DESC,created_at DESC LIMIT 1",
      [owner, paneId],
    );
    return result.rows[0] ? map(result.rows[0]) : null;
  }
  async listPendingEvents(): Promise<PlanExecutionEvent[]> {
    const result = await this.pool.query<Row>("SELECT * FROM managed_plan_executions WHERE COALESCE((record->>'eventCursor')::integer,-1)<revision ORDER BY created_at");
    return result.rows.flatMap(row => planExecutionEvents(map(row)));
  }
  async acknowledgeEvent(id: string, revision: number): Promise<void> {
    await this.transaction(async client => {
      const result = await client.query<Row>("SELECT * FROM managed_plan_executions WHERE id=$1 FOR UPDATE",[id]);
      if (!result.rows[0]) return;
      const record = map(result.rows[0]);
      if (record.eventCursor >= revision) return;
      if (planExecutionEvents(record)[0]?.revision !== revision) throw new PlanExecutionConflictError("Outbox acknowledgment is out of order.");
      await client.query("UPDATE managed_plan_executions SET record=jsonb_set(record,'{eventCursor}',$2::jsonb) WHERE id=$1",[id,JSON.stringify(revision)]);
    });
  }
  async listActive(): Promise<ManagedPlanExecution[]> {
    const result = await this.pool.query<Row>(
      "SELECT * FROM managed_plan_executions WHERE status NOT IN ('COMPLETED','FAILED') ORDER BY created_at",
    );
    return result.rows.map(map);
  }
  async update(
    owner: string,
    id: string,
    revision: number,
    patch: ManagedPlanExecutionPatch,
    lease?: PlanExecutionLease,
    projectToPlan?: boolean,
  ): Promise<ManagedPlanExecution> {
    return this.transaction(async (client) => {
      const result = await client.query<Row>(
        "SELECT * FROM managed_plan_executions WHERE id=$1 AND owner_user_id=$2 FOR UPDATE",
        [id, owner],
      );
      if (!result.rows[0])
        throw new PlanExecutionConflictError("Execution was not found.");
      const record = map(result.rows[0]);
      if (record.revision !== revision)
        throw new PlanExecutionConflictError("Execution revision is stale.");
      const next = applyPlanExecutionPatch(record, patch);
      const updated = await client.query<Row>(
        `UPDATE managed_plan_executions SET status=$3,revision=$4,record=$5::jsonb WHERE id=$1 AND owner_user_id=$2 ${lease ? "AND lease_owner=$6 AND lease_epoch=$7 AND lease_expires_at>clock_timestamp()" : ""} RETURNING *`,
        [
          id,
          owner,
          next.status,
          next.revision,
          JSON.stringify(next),
          ...(lease ? [lease.owner, lease.epoch] : []),
        ],
      );
      if (!updated.rows[0])
        throw new PlanExecutionConflictError("Controller lease is stale.");
      for (const command of [next.pendingCommand, next.interruptCommand]) if (command)
        await client.query(
          "INSERT INTO managed_plan_execution_commands(execution_id,id,record) VALUES($1,$2,$3::jsonb) ON CONFLICT(execution_id,id) DO UPDATE SET record=EXCLUDED.record",
          [id, command.id, JSON.stringify(command)],
        );
      if (projectToPlan) await this.project(client,next);
      return map(updated.rows[0]);
    });
  }
  async claim(
    id: string,
    owner: string,
    now: number,
    durationMs: number,
  ): Promise<ManagedPlanExecution | null> {
    const result = await this.pool.query<Row>(
      `UPDATE managed_plan_executions SET lease_owner=$2,lease_epoch=CASE WHEN lease_owner=$2 AND lease_expires_at>$3::timestamptz THEN lease_epoch ELSE lease_epoch+1 END,lease_expires_at=$4::timestamptz WHERE id=$1 AND status NOT IN ('COMPLETED','FAILED') AND (lease_owner IS NULL OR lease_owner=$2 OR lease_expires_at<=$3::timestamptz) RETURNING *`,
      [
        id,
        owner,
        new Date(now).toISOString(),
        new Date(now + durationMs).toISOString(),
      ],
    );
    return result.rows[0] ? map(result.rows[0]) : null;
  }
  async release(id: string, lease: PlanExecutionLease): Promise<void> {
    await this.pool.query(
      "UPDATE managed_plan_executions SET lease_expires_at=to_timestamp(0) WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3",
      [id, lease.owner, lease.epoch],
    );
  }
}
