import { afterEach, describe, expect, it, vi } from "vitest";
import { createLiveIntentClassifier } from "../src/live-intent-classifier.js";
const input = { ownerId: "owner:a", roomId: "room:a", contextRevision: "c1", policyRevision: "p1", query: "άνοιξε δύο gemini", context: { panes: [] } };
const output = { available: true as const, model: "jev", latencyMs: 10, usage: { inputTokens: 10, outputTokens: 5, cost: 0.001 }, answers: {
  route: { choice: "shell" }, intent: { choice: "open" }, complexity: { choice: "simple" }, tool_family: { choice: "panes" }, is_ambiguous: { noul: 0.05 }
} };
afterEach(() => vi.useRealTimers());
describe("Jev voice budget and scope", () => {
  it("combines six classifications in one call and coalesces concurrent requests", async () => {
    const decide = vi.fn(async () => output); const classify = createLiveIntentClassifier(decide);
    const [a, b] = await Promise.all([classify(input), classify(input)]);
    expect(decide).toHaveBeenCalledTimes(1); expect(a).toEqual(b);
    expect(Object.keys((decide.mock.calls[0] as any)[0].questions)).toHaveLength(6);
    expect(a).toMatchObject({ intent: "open", complexity: "simple", toolFamily: "panes", ambiguous: 0.05 });
    expect(await classify(input)).toMatchObject({ cacheHit: true, latencyMs: 0 });
  });
  it("keys cache by owner, room, context, policy and explicit model", async () => {
    const decide = vi.fn(async () => output), classify = createLiveIntentClassifier(decide);
    await classify(input);
    for (const patch of [{ ownerId: "other" }, { roomId: "other" }, { contextRevision: "next" }, { policyRevision: "next" }, { explicitModel: "gemini" }]) await classify({ ...input, ...patch });
    expect(decide).toHaveBeenCalledTimes(6);
  });
  it("returns by 750 ms even for a stuck provider and aborts without retrying or caching late success", async () => {
    vi.useFakeTimers(); let resolve!: (value: typeof output) => void; let signal!: AbortSignal;
    const decide = vi.fn((_input: unknown, s: AbortSignal) => { signal = s; return new Promise<typeof output>(r => { resolve = r; }); });
    const classify = createLiveIntentClassifier(decide), pending = classify(input);
    await vi.advanceTimersByTimeAsync(750);
    expect(await pending).toMatchObject({ available: false, degraded: true }); expect(signal.aborted).toBe(true); expect(decide).toHaveBeenCalledTimes(1);
    resolve(output); await Promise.resolve(); const again = classify(input); await vi.advanceTimersByTimeAsync(750); await again;
    expect(decide).toHaveBeenCalledTimes(2);
  });
  it("rejects incomplete or unallowlisted answers without exposing invented execution claims", async () => {
    const classify = createLiveIntentClassifier(async () => ({ ...output, answers: { ...output.answers, route: { choice: "delete_everything" } } }));
    expect(await classify(input)).toMatchObject({ available: false, degraded: true });
  });
});
