import type { NousProgram, NousProgramPage } from "@space/contracts";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

// The startup programs registry (migration 0288, class A): rows are written whole by apps/api/src/nous/programs.ts,
// which merges an upsert into the stored row; only an explicit delete removes one.
export interface NousProgramsRepository {
  /** The owner's programs, by parent then program (startup is the only page since 7/11). */
  list(owner: string, page?: NousProgramPage): Promise<NousProgram[]>;
  get(owner: string, id: string): Promise<NousProgram | null>;
  /** Stores the program whole; a stored row keeps its createdAt. */
  put(owner: string, program: NousProgram): Promise<NousProgram>;
  /** Only an explicit delete (Nous's space_programs delete, or a person's DELETE); false when the owner has no such program. */
  delete(owner: string, id: string): Promise<boolean>;
  dispose(): Promise<void>;
}

const order = (a: NousProgram, b: NousProgram) => a.parent.localeCompare(b.parent) || a.program.localeCompare(b.program) || a.id.localeCompare(b.id);

export class InMemoryNousProgramsRepository implements NousProgramsRepository {
  private rows = new Map<string, NousProgram>();
  async list(owner: string, page?: NousProgramPage) {
    return structuredClone([...this.rows.entries()].filter(([key, row]) => key.startsWith(`${owner}\n`) && (!page || row.page === page)).map(([, row]) => row).sort(order));
  }
  async get(owner: string, id: string) { const row = this.rows.get(`${owner}\n${id}`); return row ? structuredClone(row) : null; }
  async put(owner: string, program: NousProgram) {
    const key = `${owner}\n${program.id}`;
    const row = { ...structuredClone(program), createdAt: this.rows.get(key)?.createdAt ?? program.createdAt };
    this.rows.set(key, row);
    return structuredClone(row);
  }
  async delete(owner: string, id: string) { return this.rows.delete(`${owner}\n${id}`); }
  async dispose() {}
}

interface Row {
  id: string; page: string; parent: string; program: string; project: string | null; url: string | null; status: NousProgram["status"];
  status_reason: string | null; applied_at: Date | string | null; decided_at: Date | string | null; expected_reply_by: Date | string | null;
  valid_until: Date | string | null; amount: NousProgram["amount"]; commitments: string | null; account: string | null; contacts: string[];
  mails: NousProgram["mails"]; next_action: string | null; reapply: NousProgram["reapply"]; sources: string[]; notes: string | null;
  gives_money: boolean | null; tags: string[] | null; what_it_is: string | null; how_we_use: string | null; benefits: NousProgram["benefits"]; tiers: NousProgram["tiers"]; locked: string[] | null; awaiting_completion: boolean | null; created_at: Date | string; updated_at: Date | string;
}
const COLUMNS = "id, page, parent, program, project, url, status, status_reason, applied_at, decided_at, expected_reply_by, valid_until, amount, commitments, "
  + "account, contacts, mails, next_action, reapply, sources, notes, gives_money, tags, what_it_is, how_we_use, benefits, tiers, locked, awaiting_completion, created_at, updated_at";
const iso = (value: Date | string | null) => value === null ? null : new Date(value).toISOString();
const fromRow = (row: Row): NousProgram => ({
  // A row left on the removed "oll4-funding" page (migration 0288's CHECK still allows it) reads as startup and is written back so.
  id: row.id, page: "startup", parent: row.parent, program: row.program, project: row.project, url: row.url, status: row.status, statusReason: row.status_reason,
  appliedAt: iso(row.applied_at), decidedAt: iso(row.decided_at), expectedReplyBy: iso(row.expected_reply_by), validUntil: iso(row.valid_until),
  amount: row.amount, commitments: row.commitments, account: row.account, contacts: row.contacts ?? [], mails: row.mails ?? [], nextAction: row.next_action,
  reapply: row.reapply, sources: row.sources ?? [], notes: row.notes,
  givesMoney: row.gives_money ?? null, tags: row.tags ?? [], whatItIs: row.what_it_is ?? null, howWeUse: row.how_we_use ?? null,
  // Lines stored before `allocations` existed (migration 0290's first days) read with none.
  benefits: (row.benefits ?? []).map((line) => ({ ...line, allocations: line.allocations ?? [] })), tiers: row.tiers ?? [], locked: row.locked ?? [], awaitingCompletion: row.awaiting_completion ?? false, createdAt: iso(row.created_at)!, updatedAt: iso(row.updated_at)!
});

export class PostgresNousProgramsRepository implements NousProgramsRepository {
  constructor(private readonly pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresNousProgramsRepository(createSpacePgPool(url, { max: 2 })); }
  // No page filter: startup is the only page, and a row still stored on "oll4-funding" belongs to it.
  async list(owner: string) {
    const result = await this.pool.query<Row>(`SELECT ${COLUMNS} FROM nous_programs WHERE owner_user_id = $1 ORDER BY parent, program, id`, [owner]);
    // The same order as in memory (the database's collation may sort otherwise).
    return result.rows.map(fromRow).sort(order);
  }
  async get(owner: string, id: string) {
    const row = (await this.pool.query<Row>(`SELECT ${COLUMNS} FROM nous_programs WHERE owner_user_id = $1 AND id = $2`, [owner, id])).rows[0];
    return row ? fromRow(row) : null;
  }
  async put(owner: string, p: NousProgram) {
    const result = await this.pool.query<Row>(`INSERT INTO nous_programs (owner_user_id, ${COLUMNS})
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18::jsonb,$19,$20::jsonb,$21,$22,$23,$24,$25,$26,$27::jsonb,$28::jsonb,$29,$30,$31,$32)
      ON CONFLICT (owner_user_id, id) DO UPDATE SET page = EXCLUDED.page, parent = EXCLUDED.parent, program = EXCLUDED.program, project = EXCLUDED.project,
        url = EXCLUDED.url, status = EXCLUDED.status, status_reason = EXCLUDED.status_reason, applied_at = EXCLUDED.applied_at, decided_at = EXCLUDED.decided_at,
        expected_reply_by = EXCLUDED.expected_reply_by, valid_until = EXCLUDED.valid_until, amount = EXCLUDED.amount, commitments = EXCLUDED.commitments,
        account = EXCLUDED.account, contacts = EXCLUDED.contacts, mails = EXCLUDED.mails, next_action = EXCLUDED.next_action, reapply = EXCLUDED.reapply,
        sources = EXCLUDED.sources, notes = EXCLUDED.notes, gives_money = EXCLUDED.gives_money, tags = EXCLUDED.tags, what_it_is = EXCLUDED.what_it_is, how_we_use = EXCLUDED.how_we_use, benefits = EXCLUDED.benefits, tiers = EXCLUDED.tiers, locked = EXCLUDED.locked, awaiting_completion = EXCLUDED.awaiting_completion, updated_at = EXCLUDED.updated_at
      RETURNING ${COLUMNS}`,
    [owner, p.id, p.page, p.parent, p.program, p.project, p.url, p.status, p.statusReason, p.appliedAt, p.decidedAt, p.expectedReplyBy, p.validUntil,
      p.amount === null ? null : JSON.stringify(p.amount), p.commitments, p.account, p.contacts, JSON.stringify(p.mails), p.nextAction,
      p.reapply === null ? null : JSON.stringify(p.reapply), p.sources, p.notes,
      p.givesMoney ?? null, p.tags ?? [], p.whatItIs ?? null, p.howWeUse ?? null, JSON.stringify(p.benefits ?? []), JSON.stringify(p.tiers ?? []), p.locked ?? [], p.awaitingCompletion ?? false, p.createdAt, p.updatedAt]);
    return fromRow(result.rows[0]!);
  }
  async delete(owner: string, id: string) {
    return ((await this.pool.query("DELETE FROM nous_programs WHERE owner_user_id = $1 AND id = $2", [owner, id])) as { rowCount?: number | null }).rowCount === 1;
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
