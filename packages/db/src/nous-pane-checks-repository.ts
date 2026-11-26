import { keptRead } from "./kept-read.js";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

// Nous's pane watch (migration 0223, plan clipboard:MAongwnxq9Ro): one row per pane with Nous's last check, its verdict and
// the next check. A read records only the time; a verdict (space_pane_checked) also sets the verdict, note and next check.

// KEEP_OPEN (migration 0243, standing orders): a finished pane Nous keeps open until its next check.
export const NOUS_PANE_VERDICTS = ["OK_WORKING", "WAITING_OPERATOR", "WAITING_DATE", "NEEDS_ACTION", "BLOCKED", "OPERATOR_TEST", "KEEP_OPEN"] as const;
export type NousPaneVerdict = typeof NOUS_PANE_VERDICTS[number];
export interface NousPaneCheck { paneId: string; roomId: string; checkedAt: string; verdict: NousPaneVerdict | null; note: string | null; nextCheckAt: string | null }
/** A verdict of null clears the recorded one (a done report ends OK_WORKING). */
export interface NousPaneCheckInput { paneId: string; roomId: string; at: string; verdict?: { verdict: NousPaneVerdict | null; note: string | null; nextCheckAt: string | null } }

export interface NousPaneChecksRepository {
  record(owner: string, input: NousPaneCheckInput): Promise<NousPaneCheck>;
  list(owner: string): Promise<NousPaneCheck[]>;
  dispose(): Promise<void>;
}

export class InMemoryNousPaneChecksRepository implements NousPaneChecksRepository {
  private readonly rows = new Map<string, NousPaneCheck>();
  async record(owner: string, input: NousPaneCheckInput) {
    const key = `${owner}\u0000${input.paneId}`;
    const current = this.rows.get(key);
    const row: NousPaneCheck = { paneId: input.paneId, roomId: input.roomId, checkedAt: input.at,
      verdict: input.verdict ? input.verdict.verdict : current?.verdict ?? null, note: input.verdict ? input.verdict.note : current?.note ?? null,
      nextCheckAt: input.verdict ? input.verdict.nextCheckAt : current?.nextCheckAt ?? null };
    this.rows.set(key, row);
    return { ...row };
  }
  async list(owner: string) {
    return [...this.rows.entries()].filter(([key]) => key.startsWith(`${owner}\u0000`)).map(([, row]) => ({ ...row }));
  }
  async dispose() {}
}

interface Row { paneId: string; roomId: string; checkedAt: Date | string; verdict: NousPaneVerdict | null; note: string | null; nextCheckAt: Date | string | null }
const iso = (value: Date | string | null) => value === null ? null : new Date(value).toISOString();
const columns = `pane_id AS "paneId", room_id AS "roomId", checked_at AS "checkedAt", verdict, note, next_check_at AS "nextCheckAt"`;
const checkOf = (row: Row): NousPaneCheck => ({ ...row, checkedAt: iso(row.checkedAt)!, nextCheckAt: iso(row.nextCheckAt) });

export class PostgresNousPaneChecksRepository implements NousPaneChecksRepository {
  // Speed audit 21/11: list(owner) read 6.20M rows/24h across boardSnapshot, nous_world and paneWatch checks; keep per-owner and patch on record().
  // shortcut: a check written outside this process shows after cacheMs (default 1 h); LISTEN/NOTIFY if a second writer appears.
  private readonly checks: ReturnType<typeof keptRead<NousPaneCheck[]>>;
  constructor(private readonly pool: PgPoolLike, cacheMs = 3_600_000) {
    this.checks = keptRead((owner) => this.readList(owner), cacheMs);
  }
  static fromConnectionString(url: string) { return new PostgresNousPaneChecksRepository(createSpacePgPool(url, { max: 1 })); }

  async record(owner: string, input: NousPaneCheckInput) {
    try {
      const result = await this.pool.query<Row>(input.verdict
        ? `INSERT INTO nous_pane_checks (owner_user_id, pane_id, room_id, checked_at, verdict, note, next_check_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (owner_user_id, pane_id) DO UPDATE SET room_id = EXCLUDED.room_id, checked_at = EXCLUDED.checked_at, verdict = EXCLUDED.verdict,
             note = EXCLUDED.note, next_check_at = EXCLUDED.next_check_at RETURNING ${columns}`
        : `INSERT INTO nous_pane_checks (owner_user_id, pane_id, room_id, checked_at) VALUES ($1, $2, $3, $4)
           ON CONFLICT (owner_user_id, pane_id) DO UPDATE SET room_id = EXCLUDED.room_id, checked_at = EXCLUDED.checked_at RETURNING ${columns}`,
      input.verdict ? [owner, input.paneId, input.roomId, input.at, input.verdict.verdict, input.verdict.note, input.verdict.nextCheckAt]
        : [owner, input.paneId, input.roomId, input.at]);
      const row = checkOf(result.rows[0]!);
      this.checks.patch(owner, (rows) => {
        const index = rows.findIndex((entry) => entry.paneId === row.paneId);
        if (index < 0) return [...rows, row];
        // DEV3D-013: an overlapping write landed first; checked_at is the caller's, so only the table knows which committed last.
        if (rows[index]!.checkedAt > row.checkedAt) { this.checks.drop(owner); return rows; }
        return rows.map((entry, at) => (at === index ? row : entry));
      });
      return { ...row };
    } catch (error) {
      this.checks.drop(owner);
      throw error;
    }
  }
  private async readList(owner: string) {
    const result = await this.pool.query<Row>(`SELECT ${columns} FROM nous_pane_checks WHERE owner_user_id = $1`, [owner]);
    return result.rows.map(checkOf);
  }
  async list(owner: string) {
    return (await this.checks.get(owner)).map((row) => ({ ...row }));
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
