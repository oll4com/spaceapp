import { createSpacePgPool, type PgPoolLike } from "./space-store.js";
import { keptRead, withNewest } from "./kept-read.js";

// Pane reports (migration 0226, plan clipboard:ot6-jLKOWDNC): each CLI pane's progress reports, newest first per pane.
// The service caps and redacts the text before it is stored.

export const PANE_REPORT_STATUSES = ["STARTED", "PROGRESS", "BLOCKED", "NEEDS_DECISION", "NEEDS_YOU", "WAITING", "DONE", "FAILED", "TURN_END", "TODO", "HEARTBEAT", "QUESTION"] as const;
export type PaneReportStatus = typeof PANE_REPORT_STATUSES[number];
export type PaneReportSource = "AGENT" | "AUTO";
export interface NewPaneReport {
  roomId: string; paneId: string; at: string; source: PaneReportSource; status: PaneReportStatus; summary: string;
  planId?: string | null; step?: number | null; percent?: number | null; ticket?: string | null; next?: string | null; needs?: string | null; body?: string | null;
}
export interface PaneReport extends Required<NewPaneReport> { id: string }

export interface PaneReportsRepository {
  add(owner: string, input: NewPaneReport): Promise<PaneReport>;
  /** The newest report of each of the owner's panes. */
  latest(owner: string): Promise<PaneReport[]>;
  /** One pane's reports, newest first. */
  /** No limit: every report of the pane (kept 14 days). */
  list(owner: string, paneId: string, limit?: number): Promise<PaneReport[]>;
  /** The newest report that names each plan. */
  latestPlans(owner: string): Promise<PaneReport[]>;
  /** Every report naming one of the plans, newest first (a goal's work history). */
  listForPlans(owner: string, planIds: string[]): Promise<PaneReport[]>;
  /** Every DONE or TURN_END report since `since`, oldest first, text only: the score's reviewed gate (a reused pane's next report must not hide it). */
  finishedSince(owner: string, since: string): Promise<Array<Pick<PaneReport, "at" | "summary" | "next">>>;
  prune(before: string): Promise<number>;
  dispose(): Promise<void>;
}

const full = (id: string, input: NewPaneReport): PaneReport => ({ id, planId: null, step: null, percent: null, ticket: null, next: null, needs: null, body: null, ...input });

export class InMemoryPaneReportsRepository implements PaneReportsRepository {
  private readonly rows: Array<PaneReport & { owner: string }> = [];
  private sequence = 0;
  async add(owner: string, input: NewPaneReport) {
    const row = full(String(++this.sequence), input);
    this.rows.push({ ...row, owner });
    return { ...row };
  }
  private newest(owner: string) {
    return this.rows.filter((row) => row.owner === owner).sort((left, right) => right.at.localeCompare(left.at) || Number(right.id) - Number(left.id))
      .map((stored) => { const row: Partial<typeof stored> = { ...stored }; delete row.owner; return row as PaneReport; });
  }
  async latest(owner: string) {
    const seen = new Set<string>();
    return this.newest(owner).filter((row) => !seen.has(row.paneId) && Boolean(seen.add(row.paneId)));
  }
  async list(owner: string, paneId: string, limit?: number) { return this.newest(owner).filter((row) => row.paneId === paneId).slice(0, limit); }
  async latestPlans(owner: string) {
    const seen = new Set<string>();
    return this.newest(owner).filter((row) => row.planId && !seen.has(row.planId) && Boolean(seen.add(row.planId)));
  }
  async listForPlans(owner: string, planIds: string[]) { return this.newest(owner).filter((row) => row.planId !== null && planIds.includes(row.planId)); }
  async finishedSince(owner: string, since: string) {
    return this.newest(owner).filter((row) => (row.status === "DONE" || row.status === "TURN_END") && row.at >= since).reverse()
      .map(({ at, summary, next }) => ({ at, summary, next }));
  }
  async prune(before: string) {
    const kept = this.rows.filter((row) => row.at >= before);
    const removed = this.rows.length - kept.length;
    this.rows.splice(0, this.rows.length, ...kept);
    return removed;
  }
  async dispose() {}
}

interface Row extends Omit<PaneReport, "id" | "at"> { id: string | number; at: Date | string }
const columns = `id, room_id AS "roomId", pane_id AS "paneId", at, source, status, summary, plan_id AS "planId", step, percent, ticket,
  next_step AS "next", needs, body`;
const reportOf = (row: Row): PaneReport => ({ ...row, id: String(row.id), at: new Date(row.at).toISOString() });

export class PostgresPaneReportsRepository implements PaneReportsRepository {
  // Speed audit 14/11: latest() read every report of the owner again for the newest per pane (stable: 21,298 rows, 34 MB, 220 ms on this
  // pool of 2, every 5 s). Only this instance writes them (add, prune), so the answer is kept: add puts its report in it, prune drops it.
  // Slice 25: the newest per plan too (40 ms mean, read twice per Nous world).
  private readonly newest: ReturnType<typeof keptRead<PaneReport[]>>;
  private readonly newestPlans: ReturnType<typeof keptRead<PaneReport[]>>;
  constructor(private readonly pool: PgPoolLike, keptMs?: number) {
    this.newest = keptRead(async (owner) => (await this.pool.query<Row>(`SELECT DISTINCT ON (pane_id) ${columns} FROM pane_reports WHERE owner_user_id = $1
      ORDER BY pane_id, at DESC, id DESC`, [owner])).rows.map(reportOf), keptMs);
    this.newestPlans = keptRead(async (owner) => (await this.pool.query<Row>(`SELECT DISTINCT ON (plan_id) ${columns} FROM pane_reports WHERE owner_user_id = $1 AND plan_id IS NOT NULL
      ORDER BY plan_id, at DESC, id DESC`, [owner])).rows.map(reportOf), keptMs);
  }
  static fromConnectionString(url: string) { return new PostgresPaneReportsRepository(createSpacePgPool(url, { max: 2 })); }

  async add(owner: string, input: NewPaneReport) {
    const row = full("", input);
    let stored: PaneReport | undefined;
    try {
      const result = await this.pool.query<Row>(`INSERT INTO pane_reports (owner_user_id, room_id, pane_id, at, source, status, summary, plan_id, step, percent, ticket, next_step, needs, body)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING ${columns}`,
      [owner, row.roomId, row.paneId, row.at, row.source, row.status, row.summary, row.planId, row.step, row.percent, row.ticket, row.next, row.needs, row.body]);
      stored = reportOf(result.rows[0]!);
      return { ...stored };
    } finally {
      const report = stored;
      if (!report) { this.newest.drop(owner); this.newestPlans.drop(owner); } else {
        this.newest.patch(owner, (rows) => withNewest(rows, report, (entry) => entry.paneId, (entry) => entry.at));
        if (report.planId) this.newestPlans.patch(owner, (rows) => withNewest(rows, report, (entry) => entry.planId, (entry) => entry.at));
      }
    }
  }
  // Copies: callers own what they get.
  async latest(owner: string) { return (await this.newest.get(owner)).map((report) => ({ ...report })); }
  async list(owner: string, paneId: string, limit?: number) {
    const result = await this.pool.query<Row>(`SELECT ${columns} FROM pane_reports WHERE owner_user_id = $1 AND pane_id = $2 ORDER BY at DESC, id DESC LIMIT $3`, [owner, paneId, limit ?? null]);
    return result.rows.map(reportOf);
  }
  async latestPlans(owner: string) { return (await this.newestPlans.get(owner)).map((report) => ({ ...report })); }
  async listForPlans(owner: string, planIds: string[]) {
    if (!planIds.length) return [];
    const result = await this.pool.query<Row>(`SELECT ${columns} FROM pane_reports WHERE owner_user_id = $1 AND plan_id = ANY($2::text[]) ORDER BY at DESC, id DESC`, [owner, planIds]);
    return result.rows.map(reportOf);
  }
  async finishedSince(owner: string, since: string) {
    const result = await this.pool.query<Pick<Row, "at" | "summary" | "next">>(`SELECT at, summary, next_step AS "next" FROM pane_reports
      WHERE owner_user_id = $1 AND status IN ('DONE', 'TURN_END') AND at >= $2 ORDER BY at, id`, [owner, since]);
    return result.rows.map((row) => ({ ...row, at: new Date(row.at).toISOString() }));
  }
  async prune(before: string) {
    try { return (await this.pool.query(`DELETE FROM pane_reports WHERE at < $1`, [before])).rowCount ?? 0; } finally { this.newest.drop(); this.newestPlans.drop(); }
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
