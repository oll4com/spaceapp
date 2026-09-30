import type { LiveTranscriptItem } from "./live-session.js";
export interface PersistedLiveTurn extends LiveTranscriptItem { sessionId: string; roomId: string; createdAtMs: number; revision: number }
export interface LiveHistorySnapshot { ownerId?: string; items: PersistedLiveTurn[]; epochs: Record<string, number> }
/** Idempotent owner-scoped outbox. A server room epoch fences writes after clear. */
export function createLiveHistorySync(deps: {
  load: () => Promise<LiveHistorySnapshot>;
  save: (turns: Array<{ item: PersistedLiveTurn; epoch: number }>, expectedOwnerId: string) => Promise<{ receipts: Array<{ id: string; sessionId: string; accepted: boolean }> }>;
  clear: (roomId: string) => Promise<{ ok: boolean; epoch?: number }>;
  storage?: Pick<Storage, "getItem" | "setItem">;
  onError?: (message: string) => void;
}) {
  let ownerId = "", sessionId = "", disposed = false, generation = 0;
  let epochs: Record<string, number> = {};
  let pending = new Map<string, { item: PersistedLiveTurn; epoch: number }>();
  let revisions = new Map<string, number>();
  const clearedIds = new Set<string>();
  const clearingRooms = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sending = false;
  const key = () => `space.live.outbox.v1:${ownerId}`;
  const persist = () => { if (ownerId) try { deps.storage?.setItem(key(), JSON.stringify({ sessionId, epochs, pending: [...pending.values()] })); } catch {} };
  const schedule = (delay = 750) => { if (!timer && !disposed && pending.size) timer = setTimeout(() => { timer = null; void flush(); }, delay); };
  const flush = async () => {
    if (sending || disposed || !ownerId || !pending.size) return;
    const version = generation, batch = [...pending.values()].filter(turn => !clearingRooms.has(turn.item.roomId)).slice(0, 50);
    if (!batch.length) return;
    sending = true;
    let failed = false;
    try {
      const response = await deps.save(batch, ownerId);
      if (disposed || version !== generation) return;
      for (const receipt of response.receipts) {
        const sent = batch.find(turn => turn.item.id === receipt.id && turn.item.sessionId === receipt.sessionId);
        if (!sent) continue;
        const current = pending.get(receipt.id);
        if (current?.item.revision === sent.item.revision || !receipt.accepted) pending.delete(receipt.id);
        if (!receipt.accepted) clearedIds.add(receipt.id);
      }
      persist();
    } catch { failed = true; if (version === generation) deps.onError?.("Conversation sync is temporarily unavailable. Pending turns remain on this device."); }
    finally { if (version === generation) { sending = false; schedule(failed ? 5000 : 750); } }
  };
  return {
    async setOwner(owner: string): Promise<LiveTranscriptItem[]> {
      generation++; disposed = false; sending = false;
      if (timer) clearTimeout(timer); timer = null;
      ownerId = owner; pending = new Map(); revisions = new Map(); epochs = {}; clearedIds.clear(); clearingRooms.clear(); sessionId = crypto.randomUUID();
      const version = generation;
      try {
        const saved = JSON.parse(deps.storage?.getItem(key()) || "{}");
        if (typeof saved.sessionId === "string") sessionId = saved.sessionId;
        for (const turn of Array.isArray(saved.pending) ? saved.pending.slice(-500) : []) {
          if (typeof turn?.item?.id === "string" && typeof turn.item.roomId === "string" && typeof turn.item.text === "string" && Number.isInteger(turn.item.revision) && Number.isInteger(turn.epoch)) {
            pending.set(turn.item.id, turn); revisions.set(turn.item.id, turn.item.revision);
          }
        }
      } catch {}
      if (!owner) return [];
      try {
        const snapshot = await deps.load();
        if (disposed || generation !== version) return [];
        if (snapshot.ownerId && snapshot.ownerId !== ownerId) throw new Error("Live owner changed.");
        epochs = snapshot.epochs;
        for (const [id, turn] of pending) if (turn.epoch !== (epochs[turn.item.roomId] ?? 0)) { pending.delete(id); clearedIds.add(id); }
        const items = new Map(snapshot.items.map(item => [item.id, item]));
        for (const turn of pending.values()) items.set(turn.item.id, turn.item);
        persist(); schedule();
        return [...items.values()].sort((a, b) => a.createdAtMs - b.createdAtMs).slice(-200);
      } catch {
        deps.onError?.("Conversation history is unavailable. Pending turns remain on this device.");
        // Do not invent a new room epoch or rewrite cleared history on failure.
        schedule(5000); return [...pending.values()].map(turn => turn.item);
      }
    },
    enqueue(item: LiveTranscriptItem) {
      if (!ownerId || disposed || !item.roomId || clearingRooms.has(item.roomId) || clearedIds.has(item.id)) return;
      const revision = (revisions.get(item.id) ?? 0) + 1; revisions.set(item.id, revision);
      const turn: PersistedLiveTurn = { id: item.id, role: item.role, text: item.text.slice(0, 32000), timestamp: item.timestamp,
        roomId: item.roomId, roomName: item.roomName, createdAtMs: item.createdAtMs ?? Date.now(), sessionId, revision };
      pending.set(item.id, { item: turn, epoch: epochs[item.roomId] ?? 0 }); persist(); schedule();
    },
    async persistNotification(item: LiveTranscriptItem) {
      if (!ownerId || !item.roomId || disposed || clearingRooms.has(item.roomId) || clearedIds.has(item.id)) return false;
      const version = generation, epoch = epochs[item.roomId] ?? 0;
      const turn: PersistedLiveTurn = { id: item.id, sessionId: "live-notifications", roomId: item.roomId, roomName: item.roomName,
        role: item.role, text: item.text, timestamp: item.timestamp, createdAtMs: item.createdAtMs ?? Date.now(), revision: 1 };
      const result = await deps.save([{ item: turn, epoch }], ownerId);
      return version === generation && !disposed && !clearingRooms.has(item.roomId) && epoch === (epochs[item.roomId] ?? 0)
        && result.receipts.some(receipt => receipt.id === item.id && receipt.sessionId === turn.sessionId && receipt.accepted);
    },
    async clearRoom(roomId: string, ids: string[]) {
      const version = generation; clearingRooms.add(roomId);
      try {
        const result = await deps.clear(roomId);
        if (!result.ok || result.epoch === undefined) throw new Error("Conversation could not be cleared. Please try again.");
        if (generation !== version || disposed) return;
        epochs[roomId] = result.epoch;
        for (const id of ids) clearedIds.add(id);
        for (const [id, turn] of pending) if (turn.item.roomId === roomId) { clearedIds.add(id); pending.delete(id); }
        persist();
      } finally { if (generation === version) clearingRooms.delete(roomId); }
    },
    flush,
    dispose() { persist(); disposed = true; generation++; if (timer) clearTimeout(timer); timer = null; }
  };
}
