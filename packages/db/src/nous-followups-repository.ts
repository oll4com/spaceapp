import { randomUUID } from "node:crypto";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

// Nous's follow-ups (migration 0216, plan clipboard:8s0ZNiO3q5ZT S3): reminders back into its inbox on a time, a
// merge-queue ticket's end or a pane's finished turn. The API's Nous service is the only writer; rows stay as the audit.

export type NousFollowupTrigger = { kind: "TIME"; dueAt: string } | { kind: "TICKET"; ticketId: string } | { kind: "PANE"; paneId: string; paneLabel: string };
export interface NousFollowup {
  id: string; ownerUserId: string; note: string; trigger: NousFollowupTrigger;
  status: "OPEN" | "FIRED" | "CANCELLED"; outcome: string | null; createdAt: string; closedAt: string | null;
}

export interface NousFollowupsRepository {
  add(input: { ownerUserId: string; note: string; trigger: NousFollowupTrigger }): Promise<NousFollowup>;
  /** Every open follow-up of the owner, newest first, then the newest `closedLimit` closed ones (operator 2026-10-27: no limit on open ones). */
  list(owner: string, closedLimit: number): Promise<NousFollowup[]>;
  /** One of the owner's follow-ups by id, open or closed; null when it is not the owner's. */
  get(owner: string, id: string): Promise<NousFollowup | null>;
  /** Every open follow-up of every owner, no limit (the tick and the pane events check them). */
  listOpen(): Promise<NousFollowup[]>;
  /** Closes an open follow-up once; null when it is not open (fired, cancelled, another owner's). */
  close(owner: string, id: string, status: "FIRED" | "CANCELLED", outcome: string): Promise<NousFollowup | null>;
  dispose(): Promise<void>;
}

const newId = () => `nous_followup:${randomUUID().replace(/-/g, "").slice(0, 24)}`;
const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const order = (left: NousFollowup, right: NousFollowup) =>
  Number(right.status === "OPEN") - Number(left.status === "OPEN") || right.createdAt.localeCompare(left.createdAt);

export class InMemoryNousFollowupsRepository implements NousFollowupsRepository {
  private readonly rows: NousFollowup[] = [];
  async add(input: { ownerUserId: string; note: string; trigger: NousFollowupTrigger }) {
    const row: NousFollowup = { id: newId(), ...input, status: "OPEN", outcome: null, createdAt: new Date().toISOString(), closedAt: null };
    this.rows.push(row);
    return structuredClone(row);
  }
  async list(owner: string, closedLimit: number) {
    const rows = this.rows.filter((row) => row.ownerUserId === owner).sort(order);
    return structuredClone([...rows.filter((row) => row.status === "OPEN"), ...rows.filter((row) => row.status !== "OPEN").slice(0, closedLimit)]);
  }
  async get(owner: string, id: string) {
    const row = this.rows.find((entry) => entry.id === id && entry.ownerUserId === owner);
    return row ? structuredClone(row) : null;
  }
  async listOpen() {
    return structuredClone(this.rows.filter((row) => row.status === "OPEN"));
  }
  async close(owner: string, id: string, status: "FIRED" | "CANCELLED", outcome: string) {
    const row = this.rows.find((entry) => entry.id === id && entry.ownerUserId === owner && entry.status === "OPEN");
    if (!row) return null;
    Object.assign(row, { status, outcome, closedAt: new Date().toISOString() });
    return structuredClone(row);
  }
  async dispose() {}
}

interface Row {
  id: string; ownerUserId: string; note: string; kind: NousFollowupTrigger["kind"]; dueAt: Date | string | null; ticketId: string | null;
  paneId: string | null; paneLabel: string | null; status: NousFollowup["status"]; outcome: string | null; createdAt: Date | string; closedAt: Date | string | null;
}
const columns = `id, owner_user_id AS "ownerUserId", note, trigger_kind AS kind, due_at AS "dueAt", ticket_id AS "ticketId", pane_id AS "paneId",
  pane_label AS "paneLabel", status, outcome, created_at AS "createdAt", closed_at AS "closedAt"`;
function followupOf(row: Row): NousFollowup {
  const trigger: NousFollowupTrigger = row.kind === "TIME" ? { kind: "TIME", dueAt: iso(row.dueAt!) }
    : row.kind === "TICKET" ? { kind: "TICKET", ticketId: row.ticketId! } : { kind: "PANE", paneId: row.paneId!, paneLabel: row.paneLabel ?? row.paneId! };
  return { id: row.id, ownerUserId: row.ownerUserId, note: row.note, trigger, status: row.status, outcome: row.outcome,
    createdAt: iso(row.createdAt), closedAt: row.closedAt === null ? null : iso(row.closedAt) };
}

export class PostgresNousFollowupsRepository implements NousFollowupsRepository {
  constructor(private readonly pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresNousFollowupsRepository(createSpacePgPool(url, { max: 1 })); }

  async add(input: { ownerUserId: string; note: string; trigger: NousFollowupTrigger }) {
    const { trigger } = input;
    const result = await this.pool.query<Row>(`INSERT INTO nous_followups (id, owner_user_id, note, trigger_kind, due_at, ticket_id, pane_id, pane_label, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'OPEN') RETURNING ${columns}`,
    [newId(), input.ownerUserId, input.note, trigger.kind, trigger.kind === "TIME" ? trigger.dueAt : null, trigger.kind === "TICKET" ? trigger.ticketId : null,
      trigger.kind === "PANE" ? trigger.paneId : null, trigger.kind === "PANE" ? trigger.paneLabel : null]);
    return followupOf(result.rows[0]!);
  }
  async list(owner: string, closedLimit: number) {
    const open = await this.pool.query<Row>(`SELECT ${columns} FROM nous_followups WHERE owner_user_id = $1 AND status = 'OPEN'
      ORDER BY created_at DESC, id DESC`, [owner]);
    const closed = await this.pool.query<Row>(`SELECT ${columns} FROM nous_followups WHERE owner_user_id = $1 AND status <> 'OPEN'
      ORDER BY created_at DESC, id DESC LIMIT $2`, [owner, closedLimit]);
    return [...open.rows, ...closed.rows].map(followupOf);
  }
  async get(owner: string, id: string) {
    const result = await this.pool.query<Row>(`SELECT ${columns} FROM nous_followups WHERE owner_user_id = $1 AND id = $2`, [owner, id]);
    return result.rows[0] ? followupOf(result.rows[0]) : null;
  }
  async listOpen() {
    const result = await this.pool.query<Row>(`SELECT ${columns} FROM nous_followups WHERE status = 'OPEN' ORDER BY created_at ASC`);
    return result.rows.map(followupOf);
  }
  async close(owner: string, id: string, status: "FIRED" | "CANCELLED", outcome: string) {
    const result = await this.pool.query<Row>(`UPDATE nous_followups SET status = $3, outcome = $4, closed_at = now()
      WHERE owner_user_id = $1 AND id = $2 AND status = 'OPEN' RETURNING ${columns}`, [owner, id, status, outcome.slice(0, 1_000)]);
    return result.rows[0] ? followupOf(result.rows[0]) : null;
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
