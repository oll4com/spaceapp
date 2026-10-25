import { agentRunLedgerSchema, autoRouteShadowSchema, type AutoRouteShadowRun } from "@space/contracts";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

/** Chat tasks that carry an Auto shadow decision (Space Dots Stage 7). Reads only routing facts, never content. */
export interface AutoRouteShadowRepository {
  recent(sinceIso: string, limit: number): Promise<AutoRouteShadowRun[]>;
  dispose(): Promise<void>;
}
export class PostgresAutoRouteShadowRepository implements AutoRouteShadowRepository {
  constructor(private pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresAutoRouteShadowRepository(createSpacePgPool(url, { max: 1 })); }
  async recent(sinceIso: string, limit: number) {
    const rows = (await this.pool.query<{ autoRoute: unknown; status: string; runtimeModelAtStart: string | null; ledger: unknown }>(
      `SELECT execution_context->'autoRoute' AS "autoRoute", status, runtime_model_at_start AS "runtimeModelAtStart", task_ledger AS ledger
       FROM space_agent_runs WHERE created_at >= $1 AND execution_context ? 'autoRoute' ORDER BY created_at DESC LIMIT $2`,
      [sinceIso, Math.min(20_000, Math.max(1, limit))])).rows;
    return rows.flatMap((row) => {
      const autoRoute = autoRouteShadowSchema.safeParse(row.autoRoute);
      if (!autoRoute.success) return [];
      const ledger = row.ledger ? agentRunLedgerSchema.safeParse(row.ledger) : null;
      return [{ autoRoute: autoRoute.data, status: row.status, runtimeModelAtStart: row.runtimeModelAtStart,
        ledger: ledger?.success ? ledger.data : null }];
    });
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
