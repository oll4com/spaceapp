import { describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createMemoryEmbeddingBackfill } from "../src/memory-embedding-backfill.js";

const vector = () => [0.6, 0.8];

function setup(options: { ready?: boolean; dotRows?: number; failAt?: number } = {}) {
  const store = new InMemorySpaceStore();
  for (let index = 0; index < 5; index += 1) {
    store.createMemoryEntry({ scope: "SYSTEM", title: `Memory ${index}`, body: `body ${index}`, provenance: "test" }, undefined,
      index < 2 ? { embedding: vector(), embeddingModel: "text-embedding-3-small" } : {});
  }
  const dotModels = new Map(Array.from({ length: options.dotRows ?? 3 }, (_, index) => [`dot_memory:${index}`, null as string | null]));
  const dotMemories = {
    listToEmbed: vi.fn(async (model: string, limit: number) => [...dotModels].filter(([, value]) => value !== model).slice(0, limit)
      .map(([memoryId]) => ({ memoryId, text: `dot ${memoryId}` }))),
    setEmbedding: vi.fn(async (memoryId: string, _embedding: number[], model: string) => { dotModels.set(memoryId, model); }),
    countEmbeddings: vi.fn()
  };
  let calls = 0;
  const embed = vi.fn(async (texts: string[]) => {
    calls += 1;
    if (options.failAt === calls) throw new Error("Space Gateway embedding request failed with HTTP 402.\nmore");
    return texts.map(vector);
  });
  const clock = { now: Date.parse("2030-01-10T00:00:00Z") };
  const backfill = createMemoryEmbeddingBackfill({ store, dotMemories, model: "gemini-embedding-001", ready: async () => options.ready ?? true, embed,
    batchSize: 2, maxPerPass: 6, now: () => clock.now });
  return { store, dotModels, embed, backfill, clock };
}

describe("Space Memory embedding backfill", () => {
  it("re-embeds every memory with the new model, rows without a vector first, in bounded and resumable passes", async () => {
    const { store, dotModels, embed, backfill } = setup();
    const first = await backfill.runOnce();
    expect(first).toMatchObject({ lastEmbedded: 6, totalEmbedded: 6, lastError: null });
    // The three rows saved without a vector went first, then the OpenAI-era ones.
    expect(embed.mock.calls[0]![0]).toEqual(["Memory 4\nbody 4", "Memory 3\nbody 3"]);
    expect(embed.mock.calls.every((call) => call[0].length <= 2)).toBe(true);
    expect(store.countMemoryRecordEmbeddings()).toEqual({ total: 5, withoutEmbedding: 0, byModel: [{ model: "gemini-embedding-001", count: 5 }] });
    expect([...dotModels.values()].filter(Boolean)).toHaveLength(1);
    const second = await backfill.runOnce();
    expect(second).toMatchObject({ lastEmbedded: 2, totalEmbedded: 8 });
    expect([...dotModels.values()].every((model) => model === "gemini-embedding-001")).toBe(true);
    expect((await backfill.runOnce()).lastEmbedded).toBe(0);
  });

  it("waits while the provider has not passed its smoke, and backs off after a failure (a free-tier limit), resuming later", async () => {
    const waiting = setup({ ready: false });
    expect(await waiting.backfill.runOnce()).toMatchObject({ lastEmbedded: 0, lastError: null });
    expect(waiting.embed).not.toHaveBeenCalled();

    const failing = setup({ failAt: 2 });
    const state = await failing.backfill.runOnce();
    expect(state).toMatchObject({ lastEmbedded: 2, lastError: "Space Gateway embedding request failed with HTTP 402.", backoffUntil: "2030-01-10T00:02:00.000Z" });
    expect(failing.embed).toHaveBeenCalledTimes(2);
    // Inside the backoff no request is made; afterwards the next pass resumes where this one stopped.
    failing.clock.now += 60_000;
    await failing.backfill.runOnce();
    expect(failing.embed).toHaveBeenCalledTimes(2);
    failing.clock.now += 61_000;
    expect(await failing.backfill.runOnce()).toMatchObject({ lastEmbedded: 6, lastError: null, backoffUntil: null });
  });
});
