import { randomUUID } from "node:crypto";
import { COUNCIL_ACTIVE_STATUSES, councilRunSchema, type CouncilRun, type CouncilRunSummary } from "@space/contracts";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

// Research Council runs, one row per question. The API's council service is the only writer of a run and saves
// the whole run after every change. Postgres on the live instances, in-memory for tests.

export class CouncilActiveRunError extends Error {
  constructor() { super("Another Council run is still open. Finish, stop or cancel it first."); }
}

export interface CouncilRepository {
  /** Throws CouncilActiveRunError when the owner already has an active run. */
  create(run: CouncilRun): Promise<CouncilRun>;
  get(owner: string, id: string): Promise<CouncilRun | null>;
  list(owner: string, limit: number): Promise<CouncilRunSummary[]>;
  /** Writes the whole run; throws CouncilActiveRunError when it would become a second active run. */
  save(run: CouncilRun): Promise<CouncilRun>;
  delete(owner: string, id: string): Promise<boolean>;
  /** Work runs inside the API process: runs a stopped process left PLANNING or RUNNING become INTERRUPTED. */
  interruptStale(note: string): Promise<number>;
  dispose(): Promise<void>;
}

export const newCouncilRunId = () => `council_run:${randomUUID().replace(/-/g, "").slice(0, 24)}`;

const summaryOf = (run: CouncilRun): CouncilRunSummary =>
  ({ id: run.id, question: run.question, status: run.status, stage: run.stage, createdAt: run.createdAt, updatedAt: run.updatedAt });
const isActive = (run: CouncilRun) => COUNCIL_ACTIVE_STATUSES.includes(run.status);

export class InMemoryCouncilRepository implements CouncilRepository {
  private readonly runs = new Map<string, CouncilRun>();
  private assertSingleActive(run: CouncilRun) {
    if (isActive(run) && [...this.runs.values()].some((other) => other.id !== run.id && other.ownerUserId === run.ownerUserId && isActive(other))) throw new CouncilActiveRunError();
  }
  async create(run: CouncilRun) { this.assertSingleActive(run); this.runs.set(run.id, structuredClone(run)); return structuredClone(run); }
  async get(owner: string, id: string) { const run = this.runs.get(id); return run && run.ownerUserId === owner ? structuredClone(run) : null; }
  async list(owner: string, limit: number) {
    return [...this.runs.values()].filter((run) => run.ownerUserId === owner).sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, limit).map(summaryOf);
  }
  async save(run: CouncilRun) { this.assertSingleActive(run); this.runs.set(run.id, structuredClone(run)); return structuredClone(run); }
  async delete(owner: string, id: string) { const run = this.runs.get(id); if (!run || run.ownerUserId !== owner) return false; this.runs.delete(id); return true; }
  async interruptStale(note: string) {
    let count = 0;
    for (const [id, run] of this.runs) {
      if (run.status === "PLANNING" || run.status === "RUNNING") { this.runs.set(id, { ...run, status: "INTERRUPTED", error: note }); count += 1; }
    }
    return count;
  }
  async dispose() {}
}

interface Row {
  id: string; ownerUserId: string; question: string; coordinatorModelId: string; status: CouncilRun["status"]; stage: CouncilRun["stage"];
  plan: CouncilRun["plan"]; data: Record<string, unknown>; error: string | null; createdAt: Date | string; updatedAt: Date | string;
}
const columns = `id, owner_user_id AS "ownerUserId", question, coordinator_model_id AS "coordinatorModelId", status, stage, plan, data, error,
  created_at AS "createdAt", updated_at AS "updatedAt"`;
const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const fromRow = (row: Row): CouncilRun => councilRunSchema.parse({
  ...row.data, id: row.id, ownerUserId: row.ownerUserId, question: row.question, coordinatorModelId: row.coordinatorModelId, status: row.status,
  stage: row.stage, plan: row.plan, error: row.error, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt)
});
/** Everything that is not a column. */
const dataOf = (run: CouncilRun) => {
  const { id: _id, ownerUserId: _owner, question: _question, coordinatorModelId: _coordinator, status: _status, stage: _stage, plan: _plan, error: _error,
    createdAt: _created, updatedAt: _updated, ...data } = run;
  return data;
};
const isUniqueViolation = (error: unknown) => (error as { code?: string }).code === "23505";

export class PostgresCouncilRepository implements CouncilRepository {
  constructor(private readonly pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresCouncilRepository(createSpacePgPool(url, { max: 2 })); }
  async create(run: CouncilRun) {
    try {
      const result = await this.pool.query<Row>(`INSERT INTO council_runs (id, owner_user_id, question, coordinator_model_id, status, stage, plan, data, error, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11) RETURNING ${columns}`,
      [run.id, run.ownerUserId, run.question, run.coordinatorModelId, run.status, run.stage, run.plan === null ? null : JSON.stringify(run.plan),
        JSON.stringify(dataOf(run)), run.error, run.createdAt, run.updatedAt]);
      return fromRow(result.rows[0]!);
    } catch (error) {
      if (isUniqueViolation(error)) throw new CouncilActiveRunError();
      throw error;
    }
  }
  async get(owner: string, id: string) {
    const result = await this.pool.query<Row>(`SELECT ${columns} FROM council_runs WHERE owner_user_id = $1 AND id = $2`, [owner, id]);
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }
  async list(owner: string, limit: number) {
    const result = await this.pool.query<Pick<Row, "id" | "question" | "status" | "stage" | "createdAt" | "updatedAt">>(
      `SELECT id, question, status, stage, created_at AS "createdAt", updated_at AS "updatedAt" FROM council_runs WHERE owner_user_id = $1
       ORDER BY created_at DESC, id DESC LIMIT $2`, [owner, limit]);
    return result.rows.map((row) => ({ ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) }));
  }
  async save(run: CouncilRun) {
    try {
      const result = await this.pool.query<Row>(`UPDATE council_runs SET status = $3, stage = $4, plan = $5::jsonb, data = $6::jsonb, error = $7, updated_at = $8
        WHERE owner_user_id = $1 AND id = $2 RETURNING ${columns}`,
      [run.ownerUserId, run.id, run.status, run.stage, run.plan === null ? null : JSON.stringify(run.plan), JSON.stringify(dataOf(run)), run.error, run.updatedAt]);
      if (!result.rows[0]) throw new Error(`Council run ${run.id} was not found.`);
      return fromRow(result.rows[0]);
    } catch (error) {
      if (isUniqueViolation(error)) throw new CouncilActiveRunError();
      throw error;
    }
  }
  async delete(owner: string, id: string) {
    const result = await this.pool.query("DELETE FROM council_runs WHERE owner_user_id = $1 AND id = $2", [owner, id]);
    return ((result as { rowCount?: number | null }).rowCount ?? 0) > 0;
  }
  async interruptStale(note: string) {
    const result = await this.pool.query("UPDATE council_runs SET status = 'INTERRUPTED', error = $1, updated_at = now() WHERE status IN ('PLANNING', 'RUNNING')", [note]);
    return (result as { rowCount?: number | null }).rowCount ?? 0;
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
