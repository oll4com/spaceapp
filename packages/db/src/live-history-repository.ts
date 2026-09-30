import { createSpacePgPool, type PgPoolLike } from "./space-store.js";
export interface LiveHistoryTurn {
  id: string; sessionId: string; roomId: string; roomName?: string;
  role: "user" | "assistant" | "system" | "tool"; text: string; timestamp: string;
  createdAtMs: number; revision: number;
}
export interface LiveHistoryRepository {
  read(owner: string, roomId?: string, limit?: number): Promise<{ items: LiveHistoryTurn[]; epochs: Record<string, number> }>;
  write(owner: string, turn: LiveHistoryTurn, epoch: number): Promise<boolean>;
  clear(owner: string, room: string): Promise<number>;
  importLegacy(owner: string, room: string, turns: LiveHistoryTurn[]): Promise<void>;
  dispose(): Promise<void>;
}
export class InMemoryLiveHistoryRepository implements LiveHistoryRepository {
  private turns = new Map<string, LiveHistoryTurn>();
  private epochs = new Map<string, number>();
  private imported = new Set<string>();
  private key(owner: string, room: string) { return JSON.stringify([owner, room]); }
  async read(owner: string, roomId?: string, limit = 200) {
    const items = [...this.turns.entries()].filter(([key, turn]) => JSON.parse(key)[0] === owner && (!roomId || turn.roomId === roomId)).map(([, item]) => structuredClone(item)).sort((a, b) => a.createdAtMs - b.createdAtMs).slice(-limit);
    const epochs: Record<string, number> = {};
    for (const [key, epoch] of this.epochs) { const [o, r] = JSON.parse(key); if (o === owner && (!roomId || roomId === r)) epochs[r] = epoch; }
    return { items, epochs };
  }
  async write(owner: string, turn: LiveHistoryTurn, epoch: number) {
    if ((this.epochs.get(this.key(owner, turn.roomId)) ?? 0) !== epoch) return false;
    const key = JSON.stringify([owner, turn.sessionId, turn.id]); const previous = this.turns.get(key);
    if (previous && previous.roomId !== turn.roomId) return false;
    if (!previous || previous.revision < turn.revision) this.turns.set(key, structuredClone(turn));
    return true;
  }
  async clear(owner: string, room: string) {
    const key = this.key(owner, room), epoch = (this.epochs.get(key) ?? 0) + 1;
    this.epochs.set(key, epoch); this.imported.add(key);
    for (const [id, turn] of this.turns) if (JSON.parse(id)[0] === owner && turn.roomId === room) this.turns.delete(id);
    return epoch;
  }
  async importLegacy(owner: string, room: string, turns: LiveHistoryTurn[]) {
    const key = this.key(owner, room); if (this.imported.has(key)) return; this.imported.add(key);
    for (const turn of turns) await this.write(owner, turn, 0);
  }
  async dispose() {}
}
export class PostgresLiveHistoryRepository implements LiveHistoryRepository {
  constructor(private pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresLiveHistoryRepository(createSpacePgPool(url, { max: 3 })); }
  async read(owner: string, roomId?: string, limit = 200) {
    const [turns, rooms] = await Promise.all([
      this.pool.query<{ item: LiveHistoryTurn }>("SELECT item FROM live_conversation_turns WHERE owner_user_id=$1 AND ($2::text IS NULL OR room_id=$2) ORDER BY created_at DESC,turn_id DESC LIMIT $3", [owner, roomId ?? null, limit]),
      this.pool.query<{ room_id: string; epoch: number }>("SELECT room_id,epoch FROM live_conversation_rooms WHERE owner_user_id=$1 AND ($2::text IS NULL OR room_id=$2)", [owner, roomId ?? null])
    ]);
    return { items: turns.rows.map(row => row.item).reverse(), epochs: Object.fromEntries(rooms.rows.map(row => [row.room_id, row.epoch])) };
  }
  async write(owner: string, turn: LiveHistoryTurn, epoch: number) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO live_conversation_rooms(owner_user_id,room_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [owner, turn.roomId]);
      const state = await client.query<{ epoch: number }>("SELECT epoch FROM live_conversation_rooms WHERE owner_user_id=$1 AND room_id=$2 FOR UPDATE", [owner, turn.roomId]);
      if (state.rows[0]?.epoch !== epoch) { await client.query("ROLLBACK"); return false; }
      await client.query("INSERT INTO live_conversation_sessions(owner_user_id,session_id) VALUES($1,$2) ON CONFLICT(owner_user_id,session_id) DO UPDATE SET updated_at=now()", [owner, turn.sessionId]);
      const result = await client.query(`INSERT INTO live_conversation_turns(owner_user_id,session_id,turn_id,room_id,revision,item,created_at)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz)
        ON CONFLICT(owner_user_id,session_id,turn_id) DO UPDATE SET revision=EXCLUDED.revision,item=EXCLUDED.item,updated_at=now()
        WHERE live_conversation_turns.room_id=EXCLUDED.room_id AND live_conversation_turns.revision < EXCLUDED.revision RETURNING turn_id`,
        [owner, turn.sessionId, turn.id, turn.roomId, turn.revision, JSON.stringify(turn), new Date(turn.createdAtMs).toISOString()]);
      // An equal/stale retry is acknowledged without overwriting newer text.
      const existing = result.rows.length ? true : (await client.query<{ room_id: string }>("SELECT room_id FROM live_conversation_turns WHERE owner_user_id=$1 AND session_id=$2 AND turn_id=$3", [owner, turn.sessionId, turn.id])).rows[0]?.room_id === turn.roomId;
      await client.query("COMMIT"); return existing;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release?.(); }
  }
  async clear(owner: string, room: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ epoch: number }>("INSERT INTO live_conversation_rooms(owner_user_id,room_id,epoch,legacy_imported) VALUES($1,$2,1,true) ON CONFLICT(owner_user_id,room_id) DO UPDATE SET epoch=live_conversation_rooms.epoch+1,legacy_imported=true RETURNING epoch", [owner, room]);
      await client.query("DELETE FROM live_conversation_turns WHERE owner_user_id=$1 AND room_id=$2", [owner, room]);
      await client.query("COMMIT"); return result.rows[0]!.epoch;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release?.(); }
  }
  async importLegacy(owner: string, room: string, turns: LiveHistoryTurn[]) {
    // Stable IDs make crash retries idempotent; the room epoch prevents resurrection after clear.
    const state = await this.pool.query<{ legacy_imported: boolean }>("SELECT legacy_imported FROM live_conversation_rooms WHERE owner_user_id=$1 AND room_id=$2", [owner, room]);
    if (state.rows[0]?.legacy_imported) return;
    for (const turn of turns) await this.write(owner, turn, 0);
    await this.pool.query("INSERT INTO live_conversation_rooms(owner_user_id,room_id,legacy_imported) VALUES($1,$2,true) ON CONFLICT(owner_user_id,room_id) DO UPDATE SET legacy_imported=true", [owner, room]);
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
