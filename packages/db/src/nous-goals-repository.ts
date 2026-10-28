import { randomUUID } from "node:crypto";
import { nousGoalEventSchema, nousGoalSchema, type NousGoal, type NousGoalEvent, type NousGoalStatus } from "@space/contracts";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

// Nous Goals (migration 0257, operator request 2026-10-27, plan clipboard:DR51jZJEB0j1): the operator's standing objectives. A goal
// row is durable (class A: only `remove`, the operator's explicit delete, takes one out); its events are its log (class B, pruned
// after 30 days by `pruneEvents`).

export type NousGoalPatch = Partial<Pick<NousGoal, "text" | "status" | "priority" | "progress" | "criteria" | "planIds" | "waitsOn" | "note" | "evidence"
  | "lastWorkedAt" | "nextTurnAt" | "fingerprint" | "unchangedTurns" | "achievedAt">>;
export interface NewNousGoalEvent { goalId: string; kind: NousGoalEvent["kind"]; text: string; turnId?: string | null }

export interface NousGoalsRepository {
  /** The owner's goals in priority order (then oldest first); `statuses` narrows them. */
  list(owner: string, options?: { statuses?: NousGoalStatus[] }): Promise<NousGoal[]>;
  get(owner: string, id: string): Promise<NousGoal | null>;
  /** A new ACTIVE goal, last in priority. */
  create(owner: string, text: string): Promise<NousGoal>;
  /** Null when the goal is not the owner's. */
  update(owner: string, id: string, patch: NousGoalPatch): Promise<NousGoal | null>;
  /** The listed goals take priorities 1..n in that order; the rest keep their relative order after them. */
  reorder(owner: string, ids: string[]): Promise<NousGoal[]>;
  /** The operator's explicit delete (its events go with it). */
  remove(owner: string, id: string): Promise<boolean>;
  addEvent(owner: string, event: NewNousGoalEvent): Promise<NousGoalEvent>;
  /** The newest `perGoal` events of each goal named, newest first. */
  listEvents(owner: string, goalIds: string[], perGoal: number): Promise<NousGoalEvent[]>;
  /** Class B: goal log rows older than `before`. Returns how many went. */
  pruneEvents(before: string): Promise<number>;
  dispose(): Promise<void>;
}

const newId = () => `nous_goal:${randomUUID().replace(/-/g, "").slice(0, 24)}`;
const now = () => new Date().toISOString();
const byPriority = (left: NousGoal, right: NousGoal) => left.priority - right.priority || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);

export class InMemoryNousGoalsRepository implements NousGoalsRepository {
  private readonly goals = new Map<string, NousGoal>();
  private readonly events: Array<NousGoalEvent & { ownerUserId: string }> = [];
  private eventSeq = 0;

  private mine(owner: string) { return [...this.goals.values()].filter((goal) => goal.ownerUserId === owner).sort(byPriority); }
  async list(owner: string, options: { statuses?: NousGoalStatus[] } = {}) {
    return structuredClone(this.mine(owner).filter((goal) => !options.statuses || options.statuses.includes(goal.status)));
  }
  async get(owner: string, id: string) {
    const goal = this.goals.get(id);
    return goal && goal.ownerUserId === owner ? structuredClone(goal) : null;
  }
  async create(owner: string, text: string) {
    const at = now();
    const goal = nousGoalSchema.parse({ id: newId(), ownerUserId: owner, text, status: "ACTIVE", priority: Math.max(0, ...this.mine(owner).map((entry) => entry.priority)) + 1,
      progress: 0, criteria: null, planIds: [], waitsOn: null, note: null, evidence: null, lastWorkedAt: null, nextTurnAt: null, fingerprint: null, unchangedTurns: 0,
      createdAt: at, updatedAt: at, achievedAt: null });
    this.goals.set(goal.id, goal);
    return structuredClone(goal);
  }
  async update(owner: string, id: string, patch: NousGoalPatch) {
    const goal = this.goals.get(id);
    if (!goal || goal.ownerUserId !== owner) return null;
    const next = nousGoalSchema.parse({ ...goal, ...patch, updatedAt: now() });
    this.goals.set(id, next);
    return structuredClone(next);
  }
  async reorder(owner: string, ids: string[]) {
    const mine = this.mine(owner);
    const listed = ids.filter((id) => mine.some((goal) => goal.id === id));
    const ordered = [...listed.map((id) => mine.find((goal) => goal.id === id)!), ...mine.filter((goal) => !listed.includes(goal.id))];
    ordered.forEach((goal, index) => this.goals.set(goal.id, { ...goal, priority: index + 1, updatedAt: now() }));
    return this.list(owner);
  }
  async remove(owner: string, id: string) {
    const goal = this.goals.get(id);
    if (!goal || goal.ownerUserId !== owner) return false;
    this.goals.delete(id);
    for (let index = this.events.length - 1; index >= 0; index -= 1) if (this.events[index]!.goalId === id) this.events.splice(index, 1);
    return true;
  }
  async addEvent(owner: string, event: NewNousGoalEvent) {
    this.eventSeq += 1;
    const row = nousGoalEventSchema.parse({ id: String(this.eventSeq), goalId: event.goalId, at: now(), kind: event.kind, text: event.text, turnId: event.turnId ?? null });
    this.events.push({ ...row, ownerUserId: owner });
    return structuredClone(row);
  }
  async listEvents(owner: string, goalIds: string[], perGoal: number) {
    const out: NousGoalEvent[] = [];
    for (const goalId of goalIds) {
      out.push(...this.events.filter((event) => event.ownerUserId === owner && event.goalId === goalId).slice(-perGoal).reverse().map(({ ownerUserId: _owner, ...event }) => structuredClone(event)));
    }
    return out;
  }
  async pruneEvents(before: string) {
    const kept = this.events.filter((event) => event.at >= before);
    const gone = this.events.length - kept.length;
    this.events.splice(0, this.events.length, ...kept);
    return gone;
  }
  async dispose() {}
}

interface Row extends Omit<NousGoal, "lastWorkedAt" | "nextTurnAt" | "createdAt" | "updatedAt" | "achievedAt"> {
  lastWorkedAt: Date | string | null; nextTurnAt: Date | string | null; createdAt: Date | string; updatedAt: Date | string; achievedAt: Date | string | null;
}
interface EventRow { id: string | number; goalId: string; at: Date | string; kind: NousGoalEvent["kind"]; text: string; turnId: string | null }
const iso = (value: Date | string | null) => value === null ? null : new Date(value).toISOString();
const columns = `id, owner_user_id AS "ownerUserId", text, status, priority, progress, criteria, plan_ids AS "planIds", waits_on_json AS "waitsOn", note, evidence,
  last_worked_at AS "lastWorkedAt", next_turn_at AS "nextTurnAt", fingerprint, unchanged_turns AS "unchangedTurns", created_at AS "createdAt", updated_at AS "updatedAt", achieved_at AS "achievedAt"`;
const rowOf = (row: Row): NousGoal => nousGoalSchema.parse({ ...row, lastWorkedAt: iso(row.lastWorkedAt), nextTurnAt: iso(row.nextTurnAt), createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt), achievedAt: iso(row.achievedAt) });
const eventOf = (row: EventRow): NousGoalEvent => nousGoalEventSchema.parse({ ...row, id: String(row.id), at: iso(row.at) });
const PATCH_COLUMNS: Record<keyof NousGoalPatch, string> = {
  text: "text", status: "status", priority: "priority", progress: "progress", criteria: "criteria", planIds: "plan_ids", waitsOn: "waits_on_json", note: "note", evidence: "evidence",
  lastWorkedAt: "last_worked_at", nextTurnAt: "next_turn_at", fingerprint: "fingerprint", unchangedTurns: "unchanged_turns", achievedAt: "achieved_at"
};

export class PostgresNousGoalsRepository implements NousGoalsRepository {
  constructor(private readonly pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresNousGoalsRepository(createSpacePgPool(url, { max: 1 })); }

  async list(owner: string, options: { statuses?: NousGoalStatus[] } = {}) {
    const result = options.statuses
      ? await this.pool.query<Row>(`SELECT ${columns} FROM nous_goals WHERE owner_user_id = $1 AND status = ANY($2::text[]) ORDER BY priority ASC, created_at ASC, id ASC`, [owner, options.statuses])
      : await this.pool.query<Row>(`SELECT ${columns} FROM nous_goals WHERE owner_user_id = $1 ORDER BY priority ASC, created_at ASC, id ASC`, [owner]);
    return result.rows.map(rowOf);
  }
  async get(owner: string, id: string) {
    const result = await this.pool.query<Row>(`SELECT ${columns} FROM nous_goals WHERE owner_user_id = $1 AND id = $2`, [owner, id]);
    return result.rows[0] ? rowOf(result.rows[0]) : null;
  }
  async create(owner: string, text: string) {
    const result = await this.pool.query<Row>(`INSERT INTO nous_goals (id, owner_user_id, text, status, priority)
      VALUES ($1, $2, $3, 'ACTIVE', (SELECT COALESCE(MAX(priority), 0) + 1 FROM nous_goals WHERE owner_user_id = $2)) RETURNING ${columns}`, [newId(), owner, text]);
    return rowOf(result.rows[0]!);
  }
  async update(owner: string, id: string, patch: NousGoalPatch) {
    const sets: string[] = [];
    const values: unknown[] = [owner, id];
    for (const [key, column] of Object.entries(PATCH_COLUMNS) as Array<[keyof NousGoalPatch, string]>) {
      if (patch[key] === undefined) continue;
      const value = patch[key];
      values.push(key === "planIds" || key === "waitsOn" ? (value === null ? null : JSON.stringify(value)) : value);
      sets.push(`${column} = $${values.length}${key === "planIds" || key === "waitsOn" ? "::jsonb" : ""}`);
    }
    if (!sets.length) return this.get(owner, id);
    const result = await this.pool.query<Row>(`UPDATE nous_goals SET ${sets.join(", ")}, updated_at = now() WHERE owner_user_id = $1 AND id = $2 RETURNING ${columns}`, values);
    return result.rows[0] ? rowOf(result.rows[0]) : null;
  }
  async reorder(owner: string, ids: string[]) {
    const mine = await this.list(owner);
    const listed = ids.filter((id) => mine.some((goal) => goal.id === id));
    const ordered = [...listed, ...mine.map((goal) => goal.id).filter((id) => !listed.includes(id))];
    for (const [index, id] of ordered.entries()) await this.pool.query(`UPDATE nous_goals SET priority = $3, updated_at = now() WHERE owner_user_id = $1 AND id = $2`, [owner, id, index + 1]);
    return this.list(owner);
  }
  async remove(owner: string, id: string) {
    const result = await this.pool.query(`DELETE FROM nous_goals WHERE owner_user_id = $1 AND id = $2`, [owner, id]);
    return ((result as { rowCount?: number | null }).rowCount ?? 0) > 0;
  }
  async addEvent(owner: string, event: NewNousGoalEvent) {
    const result = await this.pool.query<EventRow>(`INSERT INTO nous_goal_events (owner_user_id, goal_id, kind, text, turn_id) VALUES ($1, $2, $3, $4, $5)
      RETURNING id, goal_id AS "goalId", at, kind, text, turn_id AS "turnId"`, [owner, event.goalId, event.kind, event.text, event.turnId ?? null]);
    return eventOf(result.rows[0]!);
  }
  async listEvents(owner: string, goalIds: string[], perGoal: number) {
    if (!goalIds.length) return [];
    const result = await this.pool.query<EventRow>(`SELECT id, "goalId", at, kind, text, "turnId" FROM (
        SELECT id, goal_id AS "goalId", at, kind, text, turn_id AS "turnId", row_number() OVER (PARTITION BY goal_id ORDER BY at DESC, id DESC) AS rank
        FROM nous_goal_events WHERE owner_user_id = $1 AND goal_id = ANY($2::text[])) ranked
      WHERE rank <= $3 ORDER BY at DESC, id DESC`, [owner, goalIds, perGoal]);
    return result.rows.map(eventOf);
  }
  async pruneEvents(before: string) {
    const result = await this.pool.query(`DELETE FROM nous_goal_events WHERE at < $1`, [before]);
    return (result as { rowCount?: number | null }).rowCount ?? 0;
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
