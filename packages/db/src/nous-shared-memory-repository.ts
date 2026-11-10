import { createHash, randomUUID } from "node:crypto";
import type { SharedMemoryContent, SharedMemoryEntry, SharedMemoryPolicy, SharedMemorySeedEntry } from "@space/contracts";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

export interface NewSharedMemory extends SharedMemoryContent {
  source: SharedMemoryEntry["source"]; status: SharedMemoryEntry["status"]; actor: string; introducedVersion: string;
}
export type SharedMemoryPatch = Partial<SharedMemoryContent & Pick<SharedMemoryEntry, "status">>;
export interface NousSharedMemoryRepository {
  list(team: string): Promise<SharedMemoryEntry[]>;
  get(team: string, id: string): Promise<SharedMemoryEntry | null>;
  create(team: string, input: NewSharedMemory): Promise<SharedMemoryEntry>;
  update(team: string, id: string, revision: number, patch: SharedMemoryPatch, actor: string): Promise<SharedMemoryEntry | null>;
  remove(team: string, id: string, revision: number, actor: string): Promise<boolean>;
  policy(team: string): Promise<SharedMemoryPolicy>;
  savePolicy(team: string, patch: Partial<Pick<SharedMemoryPolicy, "autoApprove" | "dailyUpgrade">>): Promise<SharedMemoryPolicy>;
  claimDay(team: string, day: string): Promise<boolean>;
  mergeSeed(team: string, version: string, entries: SharedMemorySeedEntry[]): Promise<void>;
  dispose(): Promise<void>;
}
const hash = (entry: SharedMemoryContent) => createHash("sha256").update(JSON.stringify([entry.title, entry.body, [...entry.tags].sort()])).digest("hex");
const defaults = (): SharedMemoryPolicy => ({ autoApprove: false, dailyUpgrade: true, lastDailyDay: null });
const makeEntry = (teamId: string, input: NewSharedMemory): SharedMemoryEntry => ({
  id: `nous_shared:${randomUUID()}`, teamId, title: input.title, body: input.body, tags: [...input.tags],
  source: input.source, status: input.status, introducedVersion: input.introducedVersion, seedKey: null, seedHash: null,
  adminModified: false, deleted: false, createdBy: input.actor, updatedBy: input.actor,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), revision: 1
});

export class InMemoryNousSharedMemoryRepository implements NousSharedMemoryRepository {
  private entries = new Map<string, SharedMemoryEntry>();
  private policies = new Map<string, SharedMemoryPolicy>();
  async list(team: string) { return structuredClone([...this.entries.values()].filter((row) => row.teamId === team && !row.deleted).sort((a, b) => a.id.localeCompare(b.id))); }
  async get(team: string, id: string) { const row = this.entries.get(id); return row?.teamId === team && !row.deleted ? structuredClone(row) : null; }
  async create(team: string, input: NewSharedMemory) {
    const existing = [...this.entries.values()].find((row) => row.teamId === team && row.seedKey === null && hash(row) === hash(input));
    if (existing) return structuredClone(existing);
    const row = makeEntry(team, input); this.entries.set(row.id, row); return structuredClone(row);
  }
  async update(team: string, id: string, revision: number, patch: SharedMemoryPatch, actor: string) {
    const row = this.entries.get(id); if (!row || row.teamId !== team || row.deleted || row.revision !== revision) return null;
    const next = structuredClone({ ...row, ...patch, adminModified: true, updatedBy: actor, updatedAt: new Date().toISOString(), revision: revision + 1 });
    if (next.seedKey === null && [...this.entries.values()].some((other) => other.teamId === team && other.id !== id && other.seedKey === null && hash(other) === hash(next))) return null;
    this.entries.set(id, next); return structuredClone(next);
  }
  async remove(team: string, id: string, revision: number, actor: string) {
    const row = this.entries.get(id);
    if (!row || row.teamId !== team || row.deleted || row.revision !== revision) return false;
    this.entries.set(id, { ...row, status: "RETIRED", deleted: true, adminModified: true, updatedBy: actor, updatedAt: new Date().toISOString(), revision: revision + 1 }); return true;
  }
  async policy(team: string) { return structuredClone(this.policies.get(team) ?? defaults()); }
  async savePolicy(team: string, patch: Partial<Pick<SharedMemoryPolicy, "autoApprove" | "dailyUpgrade">>) {
    const next = { ...(this.policies.get(team) ?? defaults()), ...patch }; this.policies.set(team, next); return structuredClone(next);
  }
  async claimDay(team: string, day: string) {
    const policy = this.policies.get(team) ?? defaults();
    if (policy.lastDailyDay && policy.lastDailyDay >= day) return false;
    this.policies.set(team, { ...policy, lastDailyDay: day }); return true;
  }
  async mergeSeed(team: string, version: string, entries: SharedMemorySeedEntry[]) {
    for (const input of entries) {
      const old = [...this.entries.values()].find((row) => row.teamId === team && row.seedKey === input.key);
      if (old && (old.adminModified || old.deleted || old.status !== "ACTIVE" || old.seedHash === hash(input))) continue;
      const next = old ? { ...old, title: input.title, body: input.body, tags: input.tags, seedHash: hash(input), updatedAt: new Date().toISOString(), revision: old.revision + 1 }
        : { ...makeEntry(team, { ...input, source: "SEED", status: "ACTIVE", actor: "seed", introducedVersion: version }), seedKey: input.key, seedHash: hash(input) };
      this.entries.set(next.id, next);
    }
  }
  async dispose() {}
}

const columns = `id, team_id AS "teamId", title, body, tags, source, status, introduced_version AS "introducedVersion", seed_key AS "seedKey", seed_hash AS "seedHash",
  admin_modified AS "adminModified", deleted, created_by AS "createdBy", updated_by AS "updatedBy", created_at AS "createdAt", updated_at AS "updatedAt", revision`;
type Row = Omit<SharedMemoryEntry, "createdAt" | "updatedAt"> & { createdAt: string | Date; updatedAt: string | Date };
const mapped = (row: Row): SharedMemoryEntry => ({ ...row, createdAt: new Date(row.createdAt).toISOString(), updatedAt: new Date(row.updatedAt).toISOString() });
export class PostgresNousSharedMemoryRepository implements NousSharedMemoryRepository {
  constructor(private pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresNousSharedMemoryRepository(createSpacePgPool(url, { max: 1 })); }
  async list(team: string) { return (await this.pool.query<Row>(`SELECT ${columns} FROM nous_shared_memory WHERE team_id=$1 AND NOT deleted ORDER BY id`, [team])).rows.map(mapped); }
  async get(team: string, id: string) { const row = (await this.pool.query<Row>(`SELECT ${columns} FROM nous_shared_memory WHERE team_id=$1 AND id=$2 AND NOT deleted`, [team, id])).rows[0]; return row ? mapped(row) : null; }
  async create(team: string, input: NewSharedMemory) {
    const row = makeEntry(team, input);
    return mapped((await this.pool.query<Row>(`INSERT INTO nous_shared_memory(id, team_id, title, body, tags, source, status, introduced_version, created_by, updated_by, content_hash)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$9,$10)
      ON CONFLICT (team_id, content_hash) WHERE seed_key IS NULL DO UPDATE SET id=nous_shared_memory.id RETURNING ${columns}`,
      [row.id, team, row.title, row.body, JSON.stringify(row.tags), row.source, row.status, row.introducedVersion, input.actor, hash(input)])).rows[0]!);
  }
  async update(team: string, id: string, revision: number, patch: SharedMemoryPatch, actor: string) {
    const row = await this.get(team, id); if (!row || row.revision !== revision) return null;
    const next = { ...row, ...patch };
    try {
      const result = await this.pool.query<Row>(`UPDATE nous_shared_memory SET title=$4, body=$5, tags=$6::jsonb, status=$7, content_hash=$8,
        admin_modified=TRUE, updated_by=$9, updated_at=now(), revision=revision+1 WHERE team_id=$1 AND id=$2 AND revision=$3 AND NOT deleted RETURNING ${columns}`,
        [team, id, revision, next.title, next.body, JSON.stringify(next.tags), next.status, hash(next), actor]);
      return result.rows[0] ? mapped(result.rows[0]) : null;
    } catch (error) {
      if ((error as { code?: string; constraint?: string }).code === "23505" && (error as { constraint?: string }).constraint === "nous_shared_memory_content") return null;
      throw error;
    }
  }
  async remove(team: string, id: string, revision: number, actor: string) {
    return (await this.pool.query(`UPDATE nous_shared_memory SET deleted=TRUE, status='RETIRED', admin_modified=TRUE, updated_by=$4, updated_at=now(), revision=revision+1
      WHERE team_id=$1 AND id=$2 AND revision=$3 AND NOT deleted`, [team, id, revision, actor])).rowCount === 1;
  }
  async policy(team: string) { return (await this.pool.query<SharedMemoryPolicy>(`SELECT auto_approve AS "autoApprove", daily_upgrade AS "dailyUpgrade", last_daily_day AS "lastDailyDay" FROM nous_shared_memory_policy WHERE team_id=$1`, [team])).rows[0] ?? defaults(); }
  async savePolicy(team: string, patch: Partial<Pick<SharedMemoryPolicy, "autoApprove" | "dailyUpgrade">>) {
    await this.pool.query(`INSERT INTO nous_shared_memory_policy(team_id,auto_approve,daily_upgrade) VALUES ($1,COALESCE($2,FALSE),COALESCE($3,TRUE))
      ON CONFLICT(team_id) DO UPDATE SET auto_approve=COALESCE($2,nous_shared_memory_policy.auto_approve), daily_upgrade=COALESCE($3,nous_shared_memory_policy.daily_upgrade)`, [team, patch.autoApprove ?? null, patch.dailyUpgrade ?? null]);
    return this.policy(team);
  }
  async claimDay(team: string, day: string) {
    return (await this.pool.query(`INSERT INTO nous_shared_memory_policy(team_id,last_daily_day) VALUES ($1,$2) ON CONFLICT(team_id) DO UPDATE SET last_daily_day=$2
      WHERE nous_shared_memory_policy.last_daily_day IS NULL OR nous_shared_memory_policy.last_daily_day < $2`, [team, day])).rowCount === 1;
  }
  async mergeSeed(team: string, version: string, entries: SharedMemorySeedEntry[]) {
    for (const entry of entries) await this.pool.query(`INSERT INTO nous_shared_memory(id, team_id, title, body, tags, source, status, introduced_version, created_by, updated_by, content_hash, seed_key, seed_hash)
      VALUES ($1,$2,$3,$4,$5::jsonb,'SEED','ACTIVE',$6,'seed','seed',$7,$8,$7) ON CONFLICT(team_id,seed_key) DO UPDATE
      SET title=EXCLUDED.title, body=EXCLUDED.body, tags=EXCLUDED.tags, seed_hash=EXCLUDED.seed_hash, content_hash=EXCLUDED.content_hash, updated_at=now(), revision=nous_shared_memory.revision+1
      WHERE NOT nous_shared_memory.admin_modified AND NOT nous_shared_memory.deleted AND nous_shared_memory.status='ACTIVE' AND nous_shared_memory.seed_hash IS DISTINCT FROM EXCLUDED.seed_hash`,
      [`nous_shared:${randomUUID()}`, team, entry.title, entry.body, JSON.stringify(entry.tags), version, hash(entry), entry.key]);
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
