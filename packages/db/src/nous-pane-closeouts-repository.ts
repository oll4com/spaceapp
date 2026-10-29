import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

// Nous standing orders (migration 0243, operator orders 2026-10-21): where each finished pane's close-out stands. Nous asks the
// pane to save to memory (SAVE_REQUESTED, once more SAVE_RETRIED), Space verifies the save from the pane's reports (VERIFIED,
// with the memory id), Nous closes the pane (CLOSED). One row per pane; a reopened pane starts over.

export const NOUS_CLOSEOUT_STATES = ["SAVE_REQUESTED", "SAVE_RETRIED", "VERIFIED", "CLOSED"] as const;
export type NousCloseoutState = typeof NOUS_CLOSEOUT_STATES[number];
export interface NousPaneCloseout {
  paneId: string; roomId: string; state: NousCloseoutState;
  requestedAt: string; retriedAt: string | null; verifiedMemoryId: string | null; closedAt: string | null; reason: string | null; updatedAt: string;
}

export interface NousPaneCloseoutsRepository {
  list(owner: string): Promise<NousPaneCloseout[]>;
  /** Writes the pane's row whole (insert or replace). */
  save(owner: string, row: NousPaneCloseout): Promise<void>;
  dispose(): Promise<void>;
}

export class InMemoryNousPaneCloseoutsRepository implements NousPaneCloseoutsRepository {
  private readonly rows = new Map<string, NousPaneCloseout>();
  async list(owner: string) {
    return [...this.rows.entries()].filter(([key]) => key.startsWith(`${owner}\u0000`)).map(([, row]) => ({ ...row }));
  }
  async save(owner: string, row: NousPaneCloseout) { this.rows.set(`${owner}\u0000${row.paneId}`, { ...row }); }
  async dispose() {}
}

interface Row { paneId: string; roomId: string; state: NousCloseoutState; requestedAt: Date | string; retriedAt: Date | string | null; verifiedMemoryId: string | null; closedAt: Date | string | null; reason: string | null; updatedAt: Date | string }
const iso = (value: Date | string | null) => value === null ? null : new Date(value).toISOString();
const columns = `pane_id AS "paneId", room_id AS "roomId", state, requested_at AS "requestedAt", retried_at AS "retriedAt", verified_memory_id AS "verifiedMemoryId",
  closed_at AS "closedAt", reason, updated_at AS "updatedAt"`;
const rowOf = (row: Row): NousPaneCloseout => ({ ...row, requestedAt: iso(row.requestedAt)!, retriedAt: iso(row.retriedAt), closedAt: iso(row.closedAt), updatedAt: iso(row.updatedAt)! });

export class PostgresNousPaneCloseoutsRepository implements NousPaneCloseoutsRepository {
  constructor(private readonly pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresNousPaneCloseoutsRepository(createSpacePgPool(url, { max: 1 })); }

  async list(owner: string) {
    const result = await this.pool.query<Row>(`SELECT ${columns} FROM nous_pane_closeouts WHERE owner_user_id = $1 ORDER BY updated_at DESC`, [owner]);
    return result.rows.map(rowOf);
  }
  async save(owner: string, row: NousPaneCloseout) {
    await this.pool.query(`INSERT INTO nous_pane_closeouts (owner_user_id, pane_id, room_id, state, requested_at, retried_at, verified_memory_id, closed_at, reason, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (owner_user_id, pane_id) DO UPDATE SET room_id = EXCLUDED.room_id, state = EXCLUDED.state, requested_at = EXCLUDED.requested_at,
        retried_at = EXCLUDED.retried_at, verified_memory_id = EXCLUDED.verified_memory_id, closed_at = EXCLUDED.closed_at, reason = EXCLUDED.reason, updated_at = EXCLUDED.updated_at`,
    [owner, row.paneId, row.roomId, row.state, row.requestedAt, row.retriedAt, row.verifiedMemoryId, row.closedAt, row.reason, row.updatedAt]);
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
