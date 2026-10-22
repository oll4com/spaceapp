import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

// Nous's pane board (migration 0237, plan clipboard:Y9cgKVHFaHrr): each pane's summary lines, newest first per pane. The
// newest row is the board's line; a MODEL row with a batch id counts toward the owner's daily cap of summary calls.

export type NousPaneSummaryWaitsOn = "OPERATOR" | "DATE" | "PROMOTE" | "THIRD_PARTY" | "NOUS" | "NONE";
export interface NewNousPaneSummaryRow {
  paneId: string; roomId: string; fingerprint: string; line: string; waitsOn: NousPaneSummaryWaitsOn; needsOperator: boolean;
  until: string | null; detail: string | null; model: string | null; source: "MODEL" | "FALLBACK"; batchId: string | null;
  generatedAt: string; inputReportId: string | null; tokensIn?: number | null; tokensOut?: number | null;
}
export interface NousPaneSummaryRow extends Required<NewNousPaneSummaryRow> { id: string }

export interface NousPaneSummariesRepository {
  add(owner: string, rows: NewNousPaneSummaryRow[]): Promise<NousPaneSummaryRow[]>;
  /** The newest row of each pane, and the newest MODEL row of each pane (the change check compares against it). */
  latest(owner: string): Promise<{ any: NousPaneSummaryRow[]; model: NousPaneSummaryRow[] }>;
  /** Model calls (distinct batches) since the given time. */
  batchesSince(owner: string, since: string): Promise<number>;
  /** Rows older than `before`, except each pane's newest. */
  prune(before: string): Promise<number>;
  dispose(): Promise<void>;
}

const full = (id: string, row: NewNousPaneSummaryRow): NousPaneSummaryRow => ({ tokensIn: null, tokensOut: null, ...row, id });
const newestPerPane = (rows: NousPaneSummaryRow[]) => {
  const byPane = new Map<string, NousPaneSummaryRow>();
  for (const row of rows) {
    const current = byPane.get(row.paneId);
    if (!current || row.generatedAt > current.generatedAt || (row.generatedAt === current.generatedAt && Number(row.id) > Number(current.id))) byPane.set(row.paneId, row);
  }
  return [...byPane.values()];
};

export class InMemoryNousPaneSummariesRepository implements NousPaneSummariesRepository {
  private readonly rows: Array<NousPaneSummaryRow & { owner: string }> = [];
  private next = 1;
  async add(owner: string, rows: NewNousPaneSummaryRow[]) {
    return rows.map((row) => {
      const stored = full(String(this.next++), row);
      this.rows.push({ ...stored, owner });
      return stored;
    });
  }
  async latest(owner: string) {
    const mine = this.rows.filter((row) => row.owner === owner).map(({ owner: _owner, ...row }) => row);
    return { any: newestPerPane(mine), model: newestPerPane(mine.filter((row) => row.source === "MODEL")) };
  }
  async batchesSince(owner: string, since: string) {
    return new Set(this.rows.filter((row) => row.owner === owner && row.batchId && row.generatedAt >= since).map((row) => row.batchId)).size;
  }
  async prune(before: string) {
    const owners = new Set(this.rows.map((row) => row.owner));
    const keep = new Set([...owners].flatMap((owner) => newestPerPane(this.rows.filter((row) => row.owner === owner)).map((row) => row.id)));
    const drop = this.rows.filter((row) => row.generatedAt < before && !keep.has(row.id));
    for (const row of drop) this.rows.splice(this.rows.indexOf(row), 1);
    return drop.length;
  }
  async dispose() {}
}

interface Row extends Omit<NousPaneSummaryRow, "id" | "until" | "generatedAt"> { id: string | number; until: Date | string | null; generatedAt: Date | string }
const columns = `id, pane_id AS "paneId", room_id AS "roomId", fingerprint, line, waits_on AS "waitsOn", needs_operator AS "needsOperator", until, detail, model,
  source, batch_id AS "batchId", generated_at AS "generatedAt", input_report_id AS "inputReportId", tokens_in AS "tokensIn", tokens_out AS "tokensOut"`;
const rowOf = (row: Row): NousPaneSummaryRow => ({ ...row, id: String(row.id), until: row.until === null ? null : new Date(row.until).toISOString(),
  generatedAt: new Date(row.generatedAt).toISOString() });

export class PostgresNousPaneSummariesRepository implements NousPaneSummariesRepository {
  constructor(private readonly pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresNousPaneSummariesRepository(createSpacePgPool(url, { max: 1 })); }

  async add(owner: string, rows: NewNousPaneSummaryRow[]) {
    const stored: NousPaneSummaryRow[] = [];
    for (const row of rows) {
      const result = await this.pool.query<Row>(`INSERT INTO nous_pane_summaries (owner_user_id, pane_id, room_id, fingerprint, line, waits_on, needs_operator, until,
          detail, model, source, batch_id, generated_at, input_report_id, tokens_in, tokens_out)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING ${columns}`,
      [owner, row.paneId, row.roomId, row.fingerprint, row.line, row.waitsOn, row.needsOperator, row.until, row.detail, row.model, row.source, row.batchId,
        row.generatedAt, row.inputReportId, row.tokensIn ?? null, row.tokensOut ?? null]);
      stored.push(rowOf(result.rows[0]!));
    }
    return stored;
  }
  async latest(owner: string) {
    const newest = (filter: string) => `SELECT DISTINCT ON (pane_id) ${columns} FROM nous_pane_summaries WHERE owner_user_id = $1 ${filter}
      ORDER BY pane_id, generated_at DESC, id DESC`;
    const [any, model] = await Promise.all([this.pool.query<Row>(newest(""), [owner]), this.pool.query<Row>(newest("AND source = 'MODEL'"), [owner])]);
    return { any: any.rows.map(rowOf), model: model.rows.map(rowOf) };
  }
  async batchesSince(owner: string, since: string) {
    const result = await this.pool.query<{ count: string }>(`SELECT count(DISTINCT batch_id)::text AS count FROM nous_pane_summaries
      WHERE owner_user_id = $1 AND batch_id IS NOT NULL AND generated_at >= $2`, [owner, since]);
    return Number(result.rows[0]?.count ?? 0);
  }
  async prune(before: string) {
    const result = await this.pool.query(`DELETE FROM nous_pane_summaries WHERE generated_at < $1 AND id NOT IN (
      SELECT DISTINCT ON (owner_user_id, pane_id) id FROM nous_pane_summaries ORDER BY owner_user_id, pane_id, generated_at DESC, id DESC)`, [before]);
    return result.rowCount ?? 0;
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
