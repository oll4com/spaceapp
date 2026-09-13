import { randomUUID } from "node:crypto";
import {
  taskTitleSettingsSchema,
  type TaskTitleSettings,
  type TaskTitleState,
} from "@space/contracts";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

export interface TaskTitleLease {
  state: TaskTitleState;
  leaseId: string;
}
export interface TaskTitleRepository {
  get(key: string): Promise<TaskTitleState | null>;
  enqueue(state: TaskTitleState, expectedVersion: number): Promise<boolean>;
  claim(now: string): Promise<TaskTitleLease | null>;
  finish(lease: TaskTitleLease, state: TaskTitleState): Promise<boolean>;
  reserveAttempt(
    key: string,
    candidateId: string,
    now: string,
    policy: TaskTitleSettings,
    batchId?: string,
  ): Promise<boolean>;
  latestAttempt(key: string): Promise<string | null>;
  getSettings(): Promise<TaskTitleSettings>;
  setSettings(settings: TaskTitleSettings): Promise<TaskTitleSettings>;
  cooldown(candidateId: string, until: string): Promise<void>;
  cooldowns(now: string): Promise<Record<string, string>>;
  dispose(): Promise<void>;
}

export class InMemoryTaskTitleRepository implements TaskTitleRepository {
  private states = new Map<string, TaskTitleState>();
  private leases = new Map<string, { id: string; until: number }>();
  private attempts: {
    key: string;
    at: number;
    batchId: string;
    candidateId: string;
  }[] = [];
  private paused = new Map<string, string>();
  private settings = taskTitleSettingsSchema.parse({});
  async get(key: string) {
    return structuredClone(this.states.get(key) ?? null);
  }
  async enqueue(state: TaskTitleState, expectedVersion: number) {
    if ((this.states.get(state.key)?.version ?? 0) !== expectedVersion)
      return false;
    this.states.set(state.key, structuredClone(state));
    return true;
  }
  async claim(now: string): Promise<TaskTitleLease | null> {
    for (const state of [...this.states.values()].sort((a, b) =>
      (a.dueAt ?? "").localeCompare(b.dueAt ?? ""),
    )) {
      if (
        !state.dueAt ||
        state.dueAt > now ||
        (this.leases.get(state.key)?.until ?? 0) > Date.parse(now)
      )
        continue;
      const leaseId = randomUUID();
      this.leases.set(state.key, {
        id: leaseId,
        until: Date.parse(now) + 120_000,
      });
      return { state: structuredClone(state), leaseId };
    }
    return null;
  }
  async finish(lease: TaskTitleLease, state: TaskTitleState) {
    if (this.leases.get(state.key)?.id !== lease.leaseId) return false;
    this.leases.delete(state.key);
    if (this.states.get(state.key)?.version !== lease.state.version)
      return false;
    this.states.set(state.key, structuredClone(state));
    return true;
  }
  async latestAttempt(key: string) {
    const latest = this.attempts.filter((a) => a.key === key).at(-1);
    return latest ? new Date(latest.at).toISOString() : null;
  }
  async reserveAttempt(
    key: string,
    candidateId: string,
    now: string,
    policy: TaskTitleSettings,
    batchId = randomUUID(),
  ) {
    const at = Date.parse(now);
    this.attempts = this.attempts.filter((a) => a.at > at - 86_400_000);
    const batch = this.attempts.filter(
      (a) => a.key === key && a.batchId === batchId,
    );
    if (
      batch.length >= 2 ||
      batch.some((a) => a.candidateId === candidateId) ||
      this.attempts.some(
        (a) => a.key === key && a.at > at - 60_000 && a.batchId !== batchId,
      )
    )
      return false;
    if (
      this.attempts.length >= policy.globalDayAttempts ||
      this.attempts.filter((a) => a.key === key).length >=
        policy.perTaskDayAttempts ||
      this.attempts.filter((a) => a.key === key && a.at > at - 3_600_000)
        .length >= policy.perTaskHourAttempts
    )
      return false;
    this.attempts.push({ key, at, batchId, candidateId });
    return true;
  }
  async getSettings() {
    return structuredClone(this.settings);
  }
  async setSettings(value: TaskTitleSettings) {
    this.settings = taskTitleSettingsSchema.parse(value);
    return this.getSettings();
  }
  async cooldown(id: string, until: string) {
    this.paused.set(id, until);
  }
  async cooldowns(now: string) {
    return Object.fromEntries(
      [...this.paused].filter(([, until]) => until > now),
    );
  }
  async dispose() {}
}

export class PostgresTaskTitleRepository implements TaskTitleRepository {
  constructor(private pool: PgPoolLike) {}
  static fromConnectionString(url: string) {
    return new PostgresTaskTitleRepository(createSpacePgPool(url, { max: 2 }));
  }
  async get(key: string) {
    const result = await this.pool.query<{ state: TaskTitleState }>(
      "SELECT state FROM task_title_states WHERE task_key=$1",
      [key],
    );
    return result.rows[0]?.state ?? null;
  }
  async enqueue(state: TaskTitleState, expectedVersion: number) {
    const result = await this.pool.query<{ task_key: string }>(
      `INSERT INTO task_title_states(task_key,version,state,due_at)
      SELECT $1,$2,$3::jsonb,$4::timestamptz WHERE $5=0
      ON CONFLICT(task_key) DO NOTHING RETURNING task_key`,
      [
        state.key,
        state.version,
        JSON.stringify(state),
        state.dueAt,
        expectedVersion,
      ],
    );
    if (result.rows.length) return true;
    const update = await this.pool.query<{ task_key: string }>(
      `UPDATE task_title_states SET version=$2,state=$3::jsonb,due_at=$4::timestamptz
      WHERE task_key=$1 AND version=$5 RETURNING task_key`,
      [
        state.key,
        state.version,
        JSON.stringify(state),
        state.dueAt,
        expectedVersion,
      ],
    );
    return update.rows.length === 1;
  }
  async claim(now: string): Promise<TaskTitleLease | null> {
    const leaseId = randomUUID();
    const result = await this.pool.query<{ state: TaskTitleState }>(
      `WITH due AS (
      SELECT task_key FROM task_title_states WHERE due_at <= $1::timestamptz
      AND (lease_until IS NULL OR lease_until <= $1::timestamptz) ORDER BY due_at FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE task_title_states s SET lease_id=$2,lease_until=$1::timestamptz + interval '120 seconds'
      FROM due WHERE s.task_key=due.task_key RETURNING s.state`,
      [now, leaseId],
    );
    return result.rows[0] ? { state: result.rows[0].state, leaseId } : null;
  }
  async finish(lease: TaskTitleLease, state: TaskTitleState) {
    const result = await this.pool.query<{ version: string }>(
      `UPDATE task_title_states SET
      state=CASE WHEN version=$3 THEN $4::jsonb ELSE state END,
      due_at=CASE WHEN version=$3 THEN $5::timestamptz ELSE due_at END,
      lease_id=NULL,lease_until=NULL WHERE task_key=$1 AND lease_id=$2 RETURNING version`,
      [
        state.key,
        lease.leaseId,
        lease.state.version,
        JSON.stringify(state),
        state.dueAt,
      ],
    );
    return Number(result.rows[0]?.version) === lease.state.version;
  }
  async latestAttempt(key: string) {
    const result = await this.pool.query<{ at: Date | null }>(
      "SELECT max(attempted_at) AS at FROM task_title_attempts WHERE task_key=$1",
      [key],
    );
    return result.rows[0]?.at?.toISOString() ?? null;
  }
  async reserveAttempt(
    key: string,
    candidateId: string,
    now: string,
    policy: TaskTitleSettings,
    batchId = randomUUID(),
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // One transaction-wide lock makes global/accounting limits race-safe across API processes.
      await client.query("SELECT pg_advisory_xact_lock(728461902)");
      await client.query(
        "DELETE FROM task_title_attempts WHERE attempted_at <= $1::timestamptz - interval '1 day'",
        [now],
      );
      const result = await client.query<{
        global: number;
        day: number;
        hour: number;
        recent: number;
        batch: number;
        duplicate: number;
      }>(
        `SELECT count(*)::int AS global,
        count(*) FILTER(WHERE task_key=$1)::int AS day,
        count(*) FILTER(WHERE task_key=$1 AND attempted_at > $2::timestamptz - interval '1 hour')::int AS hour,
        count(*) FILTER(WHERE task_key=$1 AND attempted_at > $2::timestamptz - interval '1 minute' AND batch_id<>$3)::int AS recent,
        count(*) FILTER(WHERE task_key=$1 AND batch_id=$3)::int AS batch,
        count(*) FILTER(WHERE task_key=$1 AND batch_id=$3 AND candidate_id=$4)::int AS duplicate
        FROM task_title_attempts`,
        [key, now, batchId, candidateId],
      );
      const count = result.rows[0]!;
      const allowed =
        count.recent === 0 &&
        count.batch < 2 &&
        count.duplicate === 0 &&
        count.global < policy.globalDayAttempts &&
        count.day < policy.perTaskDayAttempts &&
        count.hour < policy.perTaskHourAttempts;
      if (allowed)
        await client.query(
          "INSERT INTO task_title_attempts(task_key,candidate_id,attempted_at,batch_id) VALUES($1,$2,$3,$4)",
          [key, candidateId, now, batchId],
        );
      await client.query("COMMIT");
      return allowed;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release?.();
    }
  }
  async getSettings() {
    const result = await this.pool.query<{ settings: unknown }>(
      "SELECT settings FROM task_title_settings WHERE id=true",
    );
    return taskTitleSettingsSchema.parse(result.rows[0]?.settings ?? {});
  }
  async setSettings(settings: TaskTitleSettings) {
    const parsed = taskTitleSettingsSchema.parse(settings);
    await this.pool.query(
      "INSERT INTO task_title_settings(id,settings) VALUES(true,$1::jsonb) ON CONFLICT(id) DO UPDATE SET settings=EXCLUDED.settings",
      [JSON.stringify(parsed)],
    );
    return parsed;
  }
  async cooldown(id: string, until: string) {
    await this.pool.query(
      "INSERT INTO task_title_cooldowns(candidate_id,until_at) VALUES($1,$2) ON CONFLICT(candidate_id) DO UPDATE SET until_at=GREATEST(task_title_cooldowns.until_at,EXCLUDED.until_at)",
      [id, until],
    );
  }
  async cooldowns(now: string) {
    const result = await this.pool.query<{
      candidate_id: string;
      until_at: Date;
    }>(
      "SELECT candidate_id,until_at FROM task_title_cooldowns WHERE until_at>$1",
      [now],
    );
    return Object.fromEntries(
      result.rows.map((row) => [row.candidate_id, row.until_at.toISOString()]),
    );
  }
  async dispose() {
    await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.();
  }
}
