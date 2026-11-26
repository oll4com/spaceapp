import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemorySystemAnalyticsRepository } from "@space/db";
import { benchProviderIds, benchRefreshesInBackground, openCode2Models, openCode2VerboseModel, OpencodeModelBenchService } from "../src/opencode-model-bench.js";

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
  it("reads one day of history for the 24h range the Models tab opens with, not the 7d fallback", async () => {
    const repository = new InMemorySystemAnalyticsRepository();
    const now = new Date("2026-11-23T12:00:00.000Z");
    const since: string[] = [];
    const listModelEvents = repository.listModelEvents.bind(repository);
    repository.listModelEvents = async (from, providerIds) => { since.push(from); return listModelEvents(from, providerIds); };
    const bench = new OpencodeModelBenchService({ repository, now: () => now, execVerbose: async () => [], probeLatency: async () => ({ ok: true, latencyMs: 1 }) });
    expect(await bench.get("24h")).toMatchObject({ range: "24h" });
    expect(since).toEqual(["2026-11-22T12:00:00.000Z"]);
  });
  it("lists the providers one opencode at a time (three at once OOM-killed a 2 GB install's core, light browser step 6)", async () => {
    let running = 0;
    let most = 0;
    const execVerbose = async () => {
      most = Math.max(most, ++running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return [];
    };
    const bench = new OpencodeModelBenchService({ repository: new InMemorySystemAnalyticsRepository(), execVerbose, probeLatency: async () => ({ ok: true, latencyMs: 1 }) });
    await bench.get("7d");
    expect(most).toBe(1);
  });
});

it("runs the bench only on demand on 3 GiB or less (a 2 GB light install's cold-start OOM, light browser step 6b)", () => {
  expect(benchRefreshesInBackground(1966 * 1024 ** 2)).toBe(false); // a 2 GB VM's MemTotal
  expect(benchRefreshesInBackground(3 * 1024 ** 3)).toBe(false);
  expect(benchRefreshesInBackground(3915 * 1024 ** 2)).toBe(true); // a 4 GB VM's
});

describe("OpenCode model bench live probe (Run Benchmark now)", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it("scores and notes each model by its own live chat probe and keeps probe data out of the strict response", async () => {
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      const { model } = JSON.parse(init.body) as { model: string };
      return model === "busy"
        ? new Response(JSON.stringify({ error: { type: "FreeUsageLimitError" } }), { status: 429 })
        : new Response(JSON.stringify({ choices: [{ message: { content: "Hello" } }] }), { status: 200 });
    });
    const model = (id: string) => ({ id, providerID: "opencode", name: id, status: "active" });
    const bench = new OpencodeModelBenchService({ repository: new InMemorySystemAnalyticsRepository(),
      execVerbose: async (provider) => provider === "opencode" ? [model("good"), model("busy")] : [],
      probeLatency: async () => ({ ok: true, latencyMs: 1 }) });
    const result = await bench.get("7d", true) as { models: Array<{ modelId: string; networkStatus: string; networkScore: number; speedScore: number }>; notices: string[] };
    const byId = Object.fromEntries(result.models.map((m) => [m.modelId, m]));
    expect(byId.good).toMatchObject({ networkStatus: "ONLINE" });
    expect(byId.busy).toMatchObject({ networkStatus: "DEGRADED", networkScore: 35, speedScore: 22 });
    expect(result.notices).toContain("Live chat probe (force): 1/2 models failed — RATE_LIMIT: 1.");
  });
});
