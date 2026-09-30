import { createHash } from "node:crypto";
import { z } from "zod";
import type { LiveMemoryRepository } from "@space/db";
import { makeSpaceId, nowIso, SpaceConflictError } from "@space/runtime";

export const liveMemoryItemSchema = z.object({
  id: z.string().min(1).max(200), key: z.string().trim().min(1).max(200), value: z.string().trim().min(1).max(10000),
  category: z.enum(["core", "profile", "preference", "fact", "instruction", "note"]).default("profile"),
  createdAt: z.string(), updatedAt: z.string()
});
const itemsSchema = z.array(liveMemoryItemSchema).max(1000);
const stateSchema = z.object({ items: itemsSchema, legacySourceHash: z.string().optional() });
export const liveMemoryWriteSchema = liveMemoryItemSchema.pick({ key: true, value: true, category: true }).extend({
  id: z.string().min(1).max(200).optional(), expectedRevision: z.number().int().min(0).optional()
}).strict();

export function createLivePersonalMemory(options: {
  repository: LiveMemoryRepository;
  legacyOwnerId?: string;
  readLegacy?: () => Promise<string | null>;
}) {
  const { repository } = options;
  async function read(ownerId: string) {
    let record = await repository.get(ownerId);
    if (!record && ownerId === options.legacyOwnerId && options.readLegacy) {
      const source = await options.readLegacy();
      if (source !== null) {
        // Invalid or unreadable legacy data must not be overwritten with an empty file.
        const items = itemsSchema.parse(JSON.parse(source));
        const legacySourceHash = createHash("sha256").update(source).digest("hex");
        const accepted = await repository.write(ownerId, 0, { items, legacySourceHash }, { kind: "LEGACY_IMPORT", sourceHash: legacySourceHash, itemCount: items.length, at: nowIso() });
        record = await repository.get(ownerId);
        if (!accepted && !record) throw new SpaceConflictError("Legacy personal-memory import raced another owner migration; retry the read.");
      }
    }
    return { revision: record?.revision ?? 0, ...(record ? stateSchema.parse(record.value) : { items: [] }) };
  }
  async function mutate<Receipt extends Record<string, unknown>>(ownerId: string, expectedRevision: number | undefined,
    change: (state: Awaited<ReturnType<typeof read>>) => { items: z.infer<typeof itemsSchema>; receipt: Receipt }) {
    for (let attempt = 0; attempt < 16; attempt++) {
      const current = await read(ownerId);
      if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new SpaceConflictError("Personal memory changed. Reload before editing.");
      const next = change(current);
      itemsSchema.parse(next.items);
      if (await repository.write(ownerId, current.revision, { items: next.items, legacySourceHash: current.legacySourceHash }, { ...next.receipt, at: nowIso() })) {
        return { items: next.items, revision: current.revision + 1, ...next.receipt };
      }
    }
    throw new SpaceConflictError("Concurrent personal-memory updates did not settle. Please retry.");
  }
  return {
    read,
    changes: (ownerId: string) => repository.changes(ownerId),
    async review(ownerId: string) {
      const state = await read(ownerId);
      const groups = new Map<string, typeof state.items>();
      for (const item of state.items) groups.set(item.key.toLowerCase(), [...(groups.get(item.key.toLowerCase()) ?? []), item]);
      const conflicts = [...groups.entries()]
        .map(([key, items]) => ({ key, items }))
        .filter(group => new Set(group.items.map(item => `${item.value}\u0000${item.category}`)).size > 1)
        .map(group => ({ key: group.key, items: group.items.map(({ id, key: itemKey, value, category, updatedAt }) => ({ id, key: itemKey, value, category, updatedAt })) }));
      return { revision: state.revision, conflicts };
    },
    async save(ownerId: string, raw: unknown) {
      const input = liveMemoryWriteSchema.parse(raw);
      const result = await mutate(ownerId, input.expectedRevision, current => {
        const target = input.id ? current.items.find(item => item.id === input.id) : current.items.find(item => item.key.toLowerCase() === input.key.toLowerCase());
        if (input.id && !target) throw new SpaceConflictError("Personal-memory entry was not found for this user.");
        if (current.items.some(item => item.id !== target?.id && item.key.toLowerCase() === input.key.toLowerCase())) throw new SpaceConflictError("A personal-memory entry already uses this key.");
        const timestamp = nowIso();
        const item = { id: target?.id ?? makeSpaceId("live_memory"), key: input.key, value: input.value, category: input.category,
          createdAt: target?.createdAt ?? timestamp, updatedAt: timestamp };
        return { items: [...current.items.filter(entry => entry.id !== item.id), item], receipt: { kind: "USER_SAVE", itemId: item.id } };
      });
      return { item: result.items.find(item => item.id === result.itemId)!, revision: result.revision };
    },
    async delete(ownerId: string, keyOrId: string, expectedRevision?: number) {
      const result = await mutate(ownerId, expectedRevision, current => {
        const items = current.items.filter(item => item.id !== keyOrId && item.key.toLowerCase() !== keyOrId.toLowerCase());
        return { items, receipt: { kind: "USER_DELETE", deletedCount: current.items.length - items.length } };
      });
      return { ok: true, deletedCount: result.deletedCount, revision: result.revision };
    },
    async maintain(ownerId: string, expectedRevision: number) {
      return mutate(ownerId, expectedRevision, current => {
        const seen = new Set<string>();
        const items = current.items.filter(item => {
          const signature = JSON.stringify([item.key.toLowerCase(), item.value, item.category]);
          if (seen.has(signature)) return false;
          seen.add(signature); return true;
        });
        return { items, receipt: { kind: "EXACT_DEDUP", removedCount: current.items.length - items.length } };
      });
    }
  };
}
