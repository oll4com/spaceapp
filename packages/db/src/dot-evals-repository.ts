import { agentRunLedgerSchema, evalAttachmentsOf, type EvalReceipt } from "@space/contracts";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

/** Evaluation runs of a frozen dataset on the real runtime (Space Dots Stage 7). */
export type DotEvalCaseStatus = "PENDING" | "RUNNING" | "DONE" | "SKIPPED" | "FAILED" | "CANCELLED";
export interface DotEvalCaseRecord {
  evalRunId: string;
  caseId: string;
  ownerUserId: string;
  dotId: string;
  roomId: string;
  datasetVersion: string;
  modelConfigId: string | null;
  position: number;
  sessionId: string | null;
  goalId: string | null;
  status: DotEvalCaseStatus;
  statusReason: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}
export interface DotEvalsRepository {
  createRun(input: { evalRunId: string; ownerUserId: string; dotId: string; roomId: string; datasetVersion: string; modelConfigId: string | null; runnerId: string;
    cases: Array<{ caseId: string; status: "PENDING" | "SKIPPED"; statusReason: string | null }> }): Promise<void>;
  /** True while the conversation runs an evaluation case. */
  isRunningSession(sessionId: string): Promise<boolean>;
  update(evalRunId: string, caseId: string, patch: Partial<Pick<DotEvalCaseRecord, "sessionId" | "goalId" | "status" | "statusReason">>): Promise<void>;
  list(owner: string, evalRunId: string): Promise<DotEvalCaseRecord[]>;
  /** Recent evaluation runs of a Dot, newest first. */
  runs(owner: string, dotId: string, limit: number): Promise<Array<{ evalRunId: string; datasetVersion: string; modelConfigId: string | null; createdAt: string;
    counts: Record<DotEvalCaseStatus, number> }>>;
  /** Closes cases left RUNNING or PENDING by API processes other than this one; returns their Goals to cancel. */
  abandon(runnerId: string, reason: string): Promise<Array<{ ownerUserId: string; dotId: string; goalId: string | null }>>;
  /** What Space recorded for each finished case's conversation. */
  receipts(owner: string, evalRunId: string): Promise<EvalReceipt[]>;
  dispose(): Promise<void>;
}
const columns = `eval_run_id AS "evalRunId", case_id AS "caseId", owner_user_id AS "ownerUserId", dot_id AS "dotId", room_id AS "roomId",
  dataset_version AS "datasetVersion", model_config_id AS "modelConfigId", position, session_id AS "sessionId", goal_id AS "goalId", status,
  status_reason AS "statusReason", started_at AS "startedAt", finished_at AS "finishedAt", created_at AS "createdAt"`;
const iso = (value: unknown) => value === null || value === undefined ? null : new Date(value as string).toISOString();

export class PostgresDotEvalsRepository implements DotEvalsRepository {
  constructor(private pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresDotEvalsRepository(createSpacePgPool(url, { max: 2 })); }
  async createRun(input: Parameters<DotEvalsRepository["createRun"]>[0]) {
    if (!input.cases.length) return;
    const values: unknown[] = [];
    const rows = input.cases.map((item, index) => {
      values.push(input.evalRunId, item.caseId, input.ownerUserId, input.dotId, input.roomId, input.datasetVersion, input.modelConfigId, index, item.status,
        item.statusReason, input.runnerId);
      const base = index * 11;
      return `(${Array.from({ length: 11 }, (_, offset) => `$${base + offset + 1}`).join(",")})`;
    });
    await this.pool.query(`INSERT INTO dot_eval_cases(eval_run_id,case_id,owner_user_id,dot_id,room_id,dataset_version,model_config_id,position,status,status_reason,runner_id)
      VALUES ${rows.join(",")}`, values);
  }
  async isRunningSession(sessionId: string) {
    return (await this.pool.query(`SELECT 1 FROM dot_eval_cases WHERE session_id=$1 AND status='RUNNING' LIMIT 1`, [sessionId])).rows.length > 0;
  }
  async update(evalRunId: string, caseId: string, patch: Parameters<DotEvalsRepository["update"]>[2]) {
    await this.pool.query(`UPDATE dot_eval_cases SET session_id=COALESCE($3,session_id), goal_id=COALESCE($4,goal_id), status=COALESCE($5,status),
      status_reason=CASE WHEN $5::text IS NULL THEN status_reason ELSE $6 END,
      started_at=CASE WHEN $5='RUNNING' THEN now() ELSE started_at END,
      finished_at=CASE WHEN $5 IN ('DONE','SKIPPED','FAILED','CANCELLED') THEN now() ELSE finished_at END
      WHERE eval_run_id=$1 AND case_id=$2 AND status NOT IN ('CANCELLED','SKIPPED')`,
      [evalRunId, caseId, patch.sessionId ?? null, patch.goalId ?? null, patch.status ?? null, patch.statusReason ?? null]);
  }
  async list(owner: string, evalRunId: string) {
    return (await this.pool.query<DotEvalCaseRecord>(`SELECT ${columns} FROM dot_eval_cases WHERE owner_user_id=$1 AND eval_run_id=$2 ORDER BY position`,
      [owner, evalRunId])).rows.map((row) => ({ ...row, startedAt: iso(row.startedAt), finishedAt: iso(row.finishedAt), createdAt: iso(row.createdAt)! }));
  }
  async runs(owner: string, dotId: string, limit: number) {
    const rows = (await this.pool.query<{ evalRunId: string; datasetVersion: string; modelConfigId: string | null; createdAt: string; status: DotEvalCaseStatus; count: string }>(
      `SELECT eval_run_id AS "evalRunId", dataset_version AS "datasetVersion", model_config_id AS "modelConfigId", min(created_at) AS "createdAt", status, count(*) AS count
       FROM dot_eval_cases WHERE owner_user_id=$1 AND dot_id=$2 GROUP BY eval_run_id, dataset_version, model_config_id, status`, [owner, dotId])).rows;
    const runs = new Map<string, { evalRunId: string; datasetVersion: string; modelConfigId: string | null; createdAt: string; counts: Record<DotEvalCaseStatus, number> }>();
    for (const row of rows) {
      const run = runs.get(row.evalRunId) ?? { evalRunId: row.evalRunId, datasetVersion: row.datasetVersion, modelConfigId: row.modelConfigId, createdAt: iso(row.createdAt)!,
        counts: { PENDING: 0, RUNNING: 0, DONE: 0, SKIPPED: 0, FAILED: 0, CANCELLED: 0 } };
      run.counts[row.status] = Number(row.count);
      if (iso(row.createdAt)! < run.createdAt) run.createdAt = iso(row.createdAt)!;
      runs.set(row.evalRunId, run);
    }
    return [...runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, Math.min(50, Math.max(1, limit)));
  }
  async abandon(runnerId: string, reason: string) {
    return (await this.pool.query<{ ownerUserId: string; dotId: string; goalId: string | null }>(`UPDATE dot_eval_cases SET status='CANCELLED',
      status_reason=$2, finished_at=now() WHERE status IN ('PENDING','RUNNING') AND runner_id<>$1
      RETURNING owner_user_id AS "ownerUserId", dot_id AS "dotId", goal_id AS "goalId"`, [runnerId, reason.slice(0, 500)])).rows;
  }
  async receipts(owner: string, evalRunId: string) {
    // A case that ran but did not finish in time counts as failed, never as not run.
    const cases = (await this.list(owner, evalRunId)).filter((item) => (item.status === "DONE" || item.status === "FAILED") && item.sessionId);
    const receipts: EvalReceipt[] = [];
    for (const item of cases) {
      const sessionId = item.sessionId!;
      const runs = (await this.pool.query<{ runId: string; status: string; execution: unknown; ledger: unknown; model: string | null }>(
        `SELECT run_id AS "runId", status, execution_context AS execution, task_ledger AS ledger, runtime_model_at_start AS model
         FROM space_agent_runs WHERE session_id=$1 ORDER BY created_at`, [sessionId])).rows;
      if (!runs.length) continue;
      const tools = (await this.pool.query<{ toolId: string; status: string }>(`SELECT tool_id AS "toolId", status FROM dot_tool_invocations
        WHERE session_id=$1 ORDER BY started_at LIMIT 200`, [sessionId])).rows;
      const answer = (await this.pool.query<{ content: string }>(`SELECT content FROM space_agent_messages WHERE session_id=$1 AND role='assistant'
        AND status='COMPLETED' ORDER BY created_at DESC LIMIT 1`, [sessionId])).rows[0]?.content ?? "";
      const goal = item.goalId ? (await this.pool.query<{ status: string }>(`SELECT status FROM dot_goals WHERE goal_id=$1`, [item.goalId])).rows[0] ?? null : null;
      const first = runs[0]!;
      const attachments = evalAttachmentsOf(first.execution);
      // A conversation's cost is known only when every run in it was priced with the same catalog.
      const costs = runs.map((run) => { const ledger = agentRunLedgerSchema.safeParse(run.ledger); return ledger.success ? ledger.data.cost : null; });
      const versions = new Set(costs.map((cost) => cost?.priceCatalogVersion ?? null));
      const known = costs.every((cost) => cost && cost.status !== "UNKNOWN") && versions.size === 1;
      receipts.push({ caseId: item.caseId, runId: runs.at(-1)!.runId, status: runs.at(-1)!.status, result: answer.slice(0, 50_000),
        ...(item.status === "FAILED" ? { unfinished: true } : {}),
        tools: tools.map((tool) => ({ toolId: tool.toolId, status: tool.status })), attachments: attachments.slice(0, 8), goal: goal ? { status: goal.status } : null,
        model: first.model,
        cost: known ? { status: costs.some((cost) => cost!.status === "ESTIMATED") ? "ESTIMATED" : "ACTUAL",
          amountUsd: Math.round(costs.reduce((sum, cost) => sum + (cost!.amountUsd ?? 0), 0) * 1_000_000) / 1_000_000, priceCatalogVersion: [...versions][0] ?? null }
          : { status: "UNKNOWN", amountUsd: null, priceCatalogVersion: null } });
    }
    return receipts;
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
