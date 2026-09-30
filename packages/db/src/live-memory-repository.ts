import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

export interface LiveMemoryRecord { revision: number; value: unknown }
export interface LiveMemoryRepository {
  get(ownerId: string): Promise<LiveMemoryRecord | null>;
  write(ownerId: string, expectedRevision: number, value: unknown, change: unknown): Promise<boolean>;
  changes(ownerId: string): Promise<Array<{ revision: number; change: unknown }>>;
  dispose(): Promise<void>;
}

export class InMemoryLiveMemoryRepository implements LiveMemoryRepository {
  private records = new Map<string, LiveMemoryRecord>();
  private journal = new Map<string, Array<{ revision: number; change: unknown }>>();
  async get(ownerId: string) { return structuredClone(this.records.get(ownerId) ?? null); }
  async write(ownerId: string, expectedRevision: number, value: unknown, change: unknown) {
    if ((this.records.get(ownerId)?.revision ?? 0) !== expectedRevision) return false;
    const revision = expectedRevision + 1;
    this.records.set(ownerId, structuredClone({ revision, value }));
    this.journal.set(ownerId, [...(this.journal.get(ownerId) ?? []), structuredClone({ revision, change })]);
    return true;
  }
  async changes(ownerId: string) { return structuredClone((this.journal.get(ownerId) ?? []).slice(-100).reverse()); }
  async dispose() {}
}

export class PostgresLiveMemoryRepository implements LiveMemoryRepository {
  constructor(private pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresLiveMemoryRepository(createSpacePgPool(url, { max: 3 })); }
  async get(ownerId: string) {
    const result = await this.pool.query<LiveMemoryRecord>("SELECT revision, value FROM live_personal_memory WHERE owner_user_id=$1", [ownerId]);
    return result.rows[0] ?? null;
  }
  async write(ownerId: string, expectedRevision: number, value: unknown, change: unknown) {
    // Head and change receipt commit atomically. A racing writer must re-read.
    const mutation = expectedRevision === 0
      ? "INSERT INTO live_personal_memory(owner_user_id,revision,value) VALUES($1,$2::integer+1,$3::jsonb) ON CONFLICT DO NOTHING RETURNING owner_user_id,revision"
      : "UPDATE live_personal_memory SET revision=revision+1,value=$3::jsonb,updated_at=now() WHERE owner_user_id=$1 AND revision=$2 RETURNING owner_user_id,revision";
    const result = await this.pool.query(
      `WITH changed AS (${mutation}) INSERT INTO live_personal_memory_changes(owner_user_id,revision,change) SELECT owner_user_id,revision,$4::jsonb FROM changed RETURNING revision`,
      [ownerId, expectedRevision, JSON.stringify(value), JSON.stringify(change)]
    );
    return result.rows.length === 1;
  }
  async changes(ownerId: string) {
    return (await this.pool.query<{ revision: number; change: unknown }>("SELECT revision,change FROM live_personal_memory_changes WHERE owner_user_id=$1 ORDER BY revision DESC LIMIT 100", [ownerId])).rows;
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
