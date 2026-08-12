import type { StreamingBotMemoryEntry } from "@space/contracts";

export const BOT_MEMORY_ROOM_ID = "streaming-bot";
export const BOT_MEMORY_PROVENANCE = "streaming-bot";

export interface BotMemoryEntryRecord {
  id: string;
  title: string;
  body: string;
  createdAt: string;
}

export interface BotMemoryStore {
  ensureBotRoom(): Promise<void>;
  saveMemory(input: { title: string; body: string; tags?: string[] }): Promise<BotMemoryEntryRecord>;
  searchMemory(query: string, limit?: number): Promise<BotMemoryEntryRecord[]>;
  listMemory(limit?: number): Promise<BotMemoryEntryRecord[]>;
  countMemory(): Promise<number>;
  clearMemory(): Promise<number>;
}

export function toPublicMemoryEntry(entry: BotMemoryEntryRecord): StreamingBotMemoryEntry {
  return { id: entry.id, title: entry.title, body: entry.body, createdAt: entry.createdAt };
}