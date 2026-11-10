import { randomUUID } from "node:crypto";
import { appointmentInputSchema, appointmentUpdateSchema, type Appointment, type AppointmentInput, type AppointmentUpdate } from "@space/contracts";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

// The operator's appointments (migration 0283, class A): cancelling is a status, never a delete.
export interface AppointmentsRepository {
  /** The owner's UPCOMING appointments whatever their time, and the others that end (or start, without an end) at or after `since`, soonest first. */
  list(owner: string, since: string): Promise<Appointment[]>;
  get(owner: string, id: string): Promise<Appointment | null>;
  /** Every owner's UPCOMING appointments that start after `now`: what the reminder tick reads. */
  upcoming(now: string): Promise<Appointment[]>;
  create(owner: string, input: AppointmentInput & { timeZone: string }, at?: string): Promise<Appointment>;
  /** A new start time clears the reminders sent, so the new time is reminded again. */
  update(owner: string, id: string, patch: AppointmentUpdate, at?: string): Promise<Appointment | null>;
  /** One appointment per source: creates it, or updates the one the source made (a cancelled one stays cancelled). */
  upsertBySource(owner: string, input: AppointmentInput & { sourceRef: string; timeZone: string }, at?: string): Promise<Appointment>;
  markReminded(id: string, leads: number[]): Promise<void>;
  dispose(): Promise<void>;
}

const newId = () => `appointment:${randomUUID().replace(/-/g, "").slice(0, 16)}`;
const iso = (value: string | null | undefined) => value ? new Date(value).toISOString() : null;

function applyPatch(current: Appointment, raw: AppointmentUpdate, at: string): Appointment {
  const patch = appointmentUpdateSchema.parse(raw);
  const startsAt = patch.startsAt ? iso(patch.startsAt)! : current.startsAt;
  return { ...current, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)), startsAt,
    endsAt: patch.endsAt === undefined ? current.endsAt : iso(patch.endsAt), deadlineAt: patch.deadlineAt === undefined ? current.deadlineAt : iso(patch.deadlineAt),
    remindersSent: startsAt === current.startsAt ? current.remindersSent : [], updatedAt: at } as Appointment;
}

function fresh(owner: string, raw: AppointmentInput & { timeZone: string }, at: string): Appointment {
  const input = appointmentInputSchema.parse(raw);
  return { id: newId(), ownerUserId: owner, title: input.title, startsAt: iso(input.startsAt)!, endsAt: iso(input.endsAt), timeZone: input.timeZone ?? raw.timeZone,
    kind: input.kind, location: input.location ?? null, notes: input.notes ?? null, sourceRef: input.sourceRef ?? null,
    format: input.format ?? null, timing: input.timing ?? null, deadlineAt: iso(input.deadlineAt), status: "UPCOMING",
    remindersSent: [], createdAt: at, updatedAt: at };
}

const ends = (item: Appointment) => Date.parse(item.endsAt ?? item.startsAt);
const soonest = (a: Appointment, b: Appointment) => a.startsAt.localeCompare(b.startsAt);

export class InMemoryAppointmentsRepository implements AppointmentsRepository {
  private rows = new Map<string, Appointment>();
  async list(owner: string, since: string) { return structuredClone([...this.rows.values()].filter((row) => row.ownerUserId === owner && (row.status === "UPCOMING" || ends(row) >= Date.parse(since))).sort(soonest)); }
  async get(owner: string, id: string) { const row = this.rows.get(id); return row?.ownerUserId === owner ? structuredClone(row) : null; }
  async upcoming(now: string) { return structuredClone([...this.rows.values()].filter((row) => row.status === "UPCOMING" && Date.parse(row.startsAt) > Date.parse(now)).sort(soonest)); }
  async create(owner: string, input: AppointmentInput & { timeZone: string }, at = new Date().toISOString()) {
    const row = fresh(owner, input, at); this.rows.set(row.id, row); return structuredClone(row);
  }
  async update(owner: string, id: string, patch: AppointmentUpdate, at = new Date().toISOString()) {
    const current = await this.get(owner, id); if (!current) return null;
    const row = applyPatch(current, patch, at); this.rows.set(id, row); return structuredClone(row);
  }
  async upsertBySource(owner: string, input: AppointmentInput & { sourceRef: string; timeZone: string }, at = new Date().toISOString()) {
    const current = [...this.rows.values()].find((row) => row.ownerUserId === owner && row.sourceRef === input.sourceRef);
    if (!current) return this.create(owner, input, at);
    return (await this.update(owner, current.id, { ...input, ...(current.status === "CANCELLED" ? { status: "CANCELLED" as const } : {}) }, at))!;
  }
  async markReminded(id: string, leads: number[]) { const row = this.rows.get(id); if (row) row.remindersSent = [...new Set([...row.remindersSent, ...leads])]; }
  async dispose() {}
}

interface Row { id: string; owner_user_id: string; title: string; starts_at: Date | string; ends_at: Date | string | null; time_zone: string; kind: Appointment["kind"];
  location: string | null; notes: string | null; source_ref: string | null; status: Appointment["status"]; reminders_sent: number[]; created_at: Date | string; updated_at: Date | string;
  format: Appointment["format"]; timing: Appointment["timing"]; deadline_at: Date | string | null }
const COLUMNS = "id, owner_user_id, title, starts_at, ends_at, time_zone, kind, location, notes, source_ref, status, reminders_sent, created_at, updated_at, format, timing, deadline_at";
const at = (value: Date | string) => new Date(value).toISOString();
const fromRow = (row: Row): Appointment => ({ id: row.id, ownerUserId: row.owner_user_id, title: row.title, startsAt: at(row.starts_at), endsAt: row.ends_at ? at(row.ends_at) : null,
  timeZone: row.time_zone, kind: row.kind, location: row.location, notes: row.notes, sourceRef: row.source_ref, status: row.status,
  remindersSent: row.reminders_sent ?? [], createdAt: at(row.created_at), updatedAt: at(row.updated_at),
  format: row.format ?? null, timing: row.timing ?? null, deadlineAt: row.deadline_at ? at(row.deadline_at) : null });
const values = (row: Appointment) => [row.id, row.ownerUserId, row.title, row.startsAt, row.endsAt, row.timeZone, row.kind, row.location, row.notes, row.sourceRef,
  row.status, row.remindersSent, row.createdAt, row.updatedAt, row.format, row.timing, row.deadlineAt];

export class PostgresAppointmentsRepository implements AppointmentsRepository {
  constructor(private readonly pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresAppointmentsRepository(createSpacePgPool(url, { max: 2 })); }
  async list(owner: string, since: string) {
    return (await this.pool.query<Row>(`SELECT ${COLUMNS} FROM appointments WHERE owner_user_id = $1 AND (status = 'UPCOMING' OR coalesce(ends_at, starts_at) >= $2) ORDER BY starts_at`, [owner, since])).rows.map(fromRow);
  }
  async get(owner: string, id: string) {
    const row = (await this.pool.query<Row>(`SELECT ${COLUMNS} FROM appointments WHERE owner_user_id = $1 AND id = $2`, [owner, id])).rows[0];
    return row ? fromRow(row) : null;
  }
  async upcoming(now: string) {
    return (await this.pool.query<Row>(`SELECT ${COLUMNS} FROM appointments WHERE status = 'UPCOMING' AND starts_at > $1 ORDER BY starts_at`, [now])).rows.map(fromRow);
  }
  private async write(row: Appointment) {
    await this.pool.query(`INSERT INTO appointments (${COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, time_zone = EXCLUDED.time_zone,
        kind = EXCLUDED.kind, location = EXCLUDED.location, notes = EXCLUDED.notes, source_ref = EXCLUDED.source_ref, status = EXCLUDED.status,
        reminders_sent = EXCLUDED.reminders_sent, updated_at = EXCLUDED.updated_at, format = EXCLUDED.format, timing = EXCLUDED.timing, deadline_at = EXCLUDED.deadline_at`, values(row));
    return row;
  }
  async create(owner: string, input: AppointmentInput & { timeZone: string }, now = new Date().toISOString()) { return this.write(fresh(owner, input, now)); }
  async update(owner: string, id: string, patch: AppointmentUpdate, now = new Date().toISOString()) {
    const current = await this.get(owner, id);
    return current ? this.write(applyPatch(current, patch, now)) : null;
  }
  async upsertBySource(owner: string, input: AppointmentInput & { sourceRef: string; timeZone: string }, now = new Date().toISOString()) {
    const row = (await this.pool.query<Row>(`SELECT ${COLUMNS} FROM appointments WHERE owner_user_id = $1 AND source_ref = $2`, [owner, input.sourceRef])).rows[0];
    if (!row) return this.create(owner, input, now);
    const current = fromRow(row);
    return this.write(applyPatch(current, { ...input, ...(current.status === "CANCELLED" ? { status: "CANCELLED" as const } : {}) }, now));
  }
  async markReminded(id: string, leads: number[]) {
    await this.pool.query("UPDATE appointments SET reminders_sent = ARRAY(SELECT DISTINCT unnest(reminders_sent || $2::integer[])) WHERE id = $1", [id, leads]);
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
