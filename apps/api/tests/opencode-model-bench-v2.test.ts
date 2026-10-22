import { describe, expect, it } from "vitest";
import { InMemorySystemAnalyticsRepository } from "@space/db";
import { benchProviderIds, openCode2Models, openCode2VerboseModel, OpencodeModelBenchService } from "../src/opencode-model-bench.js";

describe("OpenCode model bench on OpenCode 2", () => {
  it("reads an /api/model entry as the v1 verbose model the bench lists", () => {
    // Entry recorded from OpenCode 2.0.31 (2026-10-16).
    expect(openCode2VerboseModel({
      id: "deepseek-v4.1-flash-free", modelID: "deepseek-v4.1-flash-free", providerID: "opencode", family: "deepseek-flash",
      name: "DeepSeek V4.1 Flash Free", package: "@opencode/ai/providers/openai-compatible",
      settings: { apiKey: "public", baseURL: "https://opencode.ai/inference/openai/v1" },
      capabilities: { tools: true, input: ["text", "image"], output: ["text"], temperature: true },
      variants: [{ id: "low" }, { id: "high" }], time: { released: 1_788_998_400_000 },
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }], status: "active", enabled: true, limit: { context: 200_000, output: 32_000 }
    })).toEqual({
      id: "deepseek-v4.1-flash-free", providerID: "opencode", name: "DeepSeek V4.1 Flash Free", family: "deepseek-flash", status: "active",
      api: { id: "deepseek-v4.1-flash-free", url: "https://opencode.ai/inference/openai/v1", npm: "@opencode/ai/providers/openai-compatible" },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, limit: { context: 200_000, output: 32_000 },
      capabilities: { temperature: true, reasoning: true, toolcall: true, input: { text: true, image: true }, output: { text: true } }
    });
  });
  it("keeps one provider's models of an /api/model answer (the CLI container's on public installs)", () => {
    const stdout = JSON.stringify({ data: [{ id: "big-pickle", providerID: "opencode" }, { id: "x", providerID: "openrouter" }] });
    expect(openCode2Models(stdout, "opencode").map((model) => model.id)).toEqual(["big-pickle"]);
    expect(() => openCode2Models("not json", "opencode")).toThrow();
  });
});

describe("OpenCode model bench history", () => {
  it("reads only the bench providers' model events, not every runtime's (dev OOM 2026-10-19)", async () => {
    const repository = new InMemorySystemAnalyticsRepository();
    const now = new Date();
    const event = (providerId: string, modelId: string) => ({
      eventKey: `${providerId}:${modelId}`, source: "opencode" as const, runtimeId: "cli:opencode", providerId, modelId,
      roomId: null, paneId: null, sessionId: null, turnId: null, status: "COMPLETED" as const, coverage: "NATIVE" as const,
      turnCount: 1, startedAt: now.toISOString(), endedAt: now.toISOString(), tokensIn: 1, tokensOut: 1,
      tokensReasoning: null, ttftMs: 100, durationMs: 1000, updatedAt: now.toISOString()
    });
    await repository.upsertModelEvents([event("anthropic", "claude-opus-5-5"), event("opencode", "big-pickle")]);
    const calls: Array<readonly string[] | undefined> = [];
    const listModelEvents = repository.listModelEvents.bind(repository);
    repository.listModelEvents = async (since, providerIds) => {
      calls.push(providerIds);
      const events = await listModelEvents(since, providerIds);
      expect(events.map((item) => item.providerId)).toEqual(["opencode"]);
      return events;
    };
    const bench = new OpencodeModelBenchService({ repository, now: () => now, execVerbose: async () => [], probeLatency: async () => ({ ok: true, latencyMs: 1 }) });
    await bench.get("7d");
    expect(calls).toEqual([benchProviderIds]);
  });
});
