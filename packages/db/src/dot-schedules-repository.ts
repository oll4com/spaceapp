import { randomUUID } from "node:crypto";
import { dotScheduleSchema, type DotSchedule, type DotScheduleRecurrence } from "@space/contracts";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

/** Dot schedules (Space Dots Stage 4). Occurrences are claimed with compare-and-set on next_run_at. */
export interface DotSchedulesRepository {
  create(input: { dotId: string; ownerUserId: string; roomId: string; sessionId: string; title: string; prompt: string;
    recurrence: DotScheduleRecurrence; timeZone: string; createdBy: "USER" | "DOT"; nextRunAt: string | null }): Promise<DotSchedule>;
  get(scheduleId: string): Promise<DotSchedule | null>;
  getOwned(owner: string, dotId: string, scheduleId: string): Promise<DotSchedule | null>;
  list(owner: string, dotId: string): Promise<DotSchedule[]>;
  due(nowIso: string, limit: number): Promise<DotSchedule[]>;
  /** Moves an occurrence only if nobody else has (next_run_at still equals `expected`). */
  claim(scheduleId: string, expected: string, next: { nextRunAt: string | null; status: DotSchedule["status"]; outcome: string; ran: boolean }): Promise<boolean>;
  setStatus(scheduleId: string, from: DotSchedule["status"][], to: DotSchedule["status"], nextRunAt?: string | null): Promise<DotSchedule | null>;
  dispose(): Promise<void>;
}
const select = `SELECT schedule_id AS "scheduleId", dot_id AS "dotId", owner_user_id AS "ownerUserId", room_id AS "roomId", session_id AS "sessionId",
  title, prompt, recurrence, time_zone AS "timeZone", status, created_by AS "createdBy", next_run_at AS "nextRunAt", last_run_at AS "lastRunAt",
  last_outcome AS "lastOutcome", created_at AS "createdAt", updated_at AS "updatedAt" FROM dot_schedules`;
function schedule(row: Record<string, unknown>): DotSchedule {
  const iso = (value: unknown) => value === null || value === undefined ? null : new Date(value as string).toISOString();
  return dotScheduleSchema.parse({ ...row, nextRunAt: iso(row.nextRunAt), lastRunAt: iso(row.lastRunAt), createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) });
}
export class PostgresDotSchedulesRepository implements DotSchedulesRepository {
  constructor(private pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresDotSchedulesRepository(createSpacePgPool(url, { max: 2 })); }
  private async rows(sql: string, params: unknown[]) { return (await this.pool.query<Record<string, unknown>>(sql, params)).rows.map(schedule); }
  async create(input: Parameters<DotSchedulesRepository["create"]>[0]) {
    const scheduleId = `dot_schedule:${randomUUID().replace(/-/g, "")}`;
    const status = input.createdBy === "DOT" ? "PENDING_CONFIRMATION" : input.nextRunAt ? "ACTIVE" : "COMPLETED";
    await this.pool.query(`INSERT INTO dot_schedules(schedule_id,dot_id,owner_user_id,room_id,session_id,title,prompt,recurrence,time_zone,status,created_by,next_run_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12)`, [scheduleId, input.dotId, input.ownerUserId, input.roomId, input.sessionId,
      input.title, input.prompt, JSON.stringify(input.recurrence), input.timeZone, status, input.createdBy, input.nextRunAt]);
    return (await this.get(scheduleId))!;
  }
  async get(scheduleId: string) { return (await this.rows(`${select} WHERE schedule_id=$1`, [scheduleId]))[0] ?? null; }
  async getOwned(owner: string, dotId: string, scheduleId: string) {
    return (await this.rows(`${select} s WHERE s.schedule_id=$3 AND s.owner_user_id=$1 AND s.dot_id=$2
      AND EXISTS (SELECT 1 FROM rooms r WHERE r.id=s.room_id AND r.owner_user_id=$1)`, [owner, dotId, scheduleId]))[0] ?? null;
  }
  list(owner: string, dotId: string) {
    return this.rows(`${select} s WHERE s.owner_user_id=$1 AND s.dot_id=$2 AND EXISTS (SELECT 1 FROM rooms r WHERE r.id=s.room_id AND r.owner_user_id=$1)
      ORDER BY (s.status IN ('ACTIVE','PENDING_CONFIRMATION','PAUSED')) DESC, s.next_run_at NULLS LAST, s.updated_at DESC LIMIT 50`, [owner, dotId]);
  }
  due(nowIso: string, limit: number) {
    return this.rows(`${select} WHERE status='ACTIVE' AND next_run_at <= $1 ORDER BY next_run_at LIMIT $2`, [nowIso, Math.min(50, Math.max(1, limit))]);
  }
  async claim(scheduleId: string, expected: string, next: { nextRunAt: string | null; status: DotSchedule["status"]; outcome: string; ran: boolean }) {
    const result = await this.pool.query(`UPDATE dot_schedules SET next_run_at=$3, status=$4, last_outcome=$5,
      last_run_at=CASE WHEN $6 THEN now() ELSE last_run_at END WHERE schedule_id=$1 AND status='ACTIVE' AND next_run_at=$2 RETURNING schedule_id`,
      [scheduleId, expected, next.nextRunAt, next.status, next.outcome.slice(0, 500), next.ran]);
    return result.rows.length === 1;
  }
  async setStatus(scheduleId: string, from: DotSchedule["status"][], to: DotSchedule["status"], nextRunAt?: string | null) {
    const result = await this.pool.query(`UPDATE dot_schedules SET status=$3, next_run_at=CASE WHEN $5 THEN $4::timestamptz ELSE next_run_at END
      WHERE schedule_id=$1 AND status = ANY($2::text[]) RETURNING schedule_id`, [scheduleId, from, to, nextRunAt ?? null, nextRunAt !== undefined]);
    return result.rows.length ? this.get(scheduleId) : null;
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
