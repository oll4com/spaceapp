import { describe, expect, it, vi } from "vitest";
import { liveJevReadCandidate, routeLiveDelegation } from "../src/live-jev-delegation.js";
import type { LiveIntentResult } from "../src/live-intent-classifier.js";
const tools = [{ name: "space_inspect_room", parameters: { properties: { section: { enum: ["STATE", "MODELS"] } } } }];
const read: LiveIntentResult = { available: true, route: "shell", intent: "inspect", complexity: "simple", toolFamily: "read", readSection: "MODELS", ambiguous: 0, latencyMs: 1, cacheHit: false };
const baseline = { toolCall: null, message: "baseline" };
describe("Jev bounded read delegation", () => {
  it("accepts a declared read without allowing Jev to choose action parameters", () => {
    expect(liveJevReadCandidate(read, "room:owned", tools)).toEqual({ name: "space_inspect_room", args: { roomId: "room:owned", section: "MODELS" } });
    for (const patch of [{ intent: "configure" }, { ambiguous: 0.3 }, { readSection: "NONE" }, { complexity: "multi_step" }, { available: false }]) {
      expect(liveJevReadCandidate({ ...read, ...patch } as LiveIntentResult, "room:owned", tools)).toBeNull();
    }
    expect(liveJevReadCandidate(read, "room:owned", [])).toBeNull();
    expect(liveJevReadCandidate(read, undefined, tools)).toBeNull();
  });
  it("does not wait for a slow classifier or failed classifier before returning the baseline", async () => {
    const common = { enabled: true, roomId: "room:owned", tools, delegate: async () => baseline };
    expect(await routeLiveDelegation({ ...common, classify: () => new Promise(() => {}) })).toBe(baseline);
    expect(await routeLiveDelegation({ ...common, classify: async () => { throw Error("offline"); } })).toBe(baseline);
  });
  it("cancels the speculative delegate after a valid shortcut, retaining unknown provider cost", async () => {
    let signal!: AbortSignal;
    const result = await routeLiveDelegation({ enabled: true, roomId: "room:owned", tools,
      delegate: s => { signal = s!; return new Promise(() => {}); }, classify: async () => read });
    expect(result.toolCall?.args).toEqual({ roomId: "room:owned", section: "MODELS" });
    expect(signal.aborted).toBe(true);
    expect(result.telemetry).toMatchObject({ routing: "jev-read", estimatedCostUsd: null });
  });
  it("keeps acceleration disabled until measured acceptance enables it", async () => {
    const classify = vi.fn(async () => read), delegate = vi.fn(async () => baseline);
    expect(await routeLiveDelegation({ enabled: false, roomId: "room:owned", tools, classify, delegate })).toBe(baseline);
    expect(classify).not.toHaveBeenCalled();
  });
  it("cancels unused classification when ordinary delegation finishes first", async () => {
    let signal!: AbortSignal;
    const result = await routeLiveDelegation({ enabled: true, roomId: "room:owned", tools,
      delegate: async () => baseline, classify: s => { signal = s!; return new Promise(() => {}); } });
    expect(result).toBe(baseline);
    expect(signal.aborted).toBe(true);
  });
});
