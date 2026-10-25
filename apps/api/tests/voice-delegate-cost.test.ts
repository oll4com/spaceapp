import { afterEach, describe, expect, it, vi } from "vitest";
import { getApiConfig } from "../src/config.js";
import { createVoiceDelegateResponse } from "../src/voice-transcription.js";

// No test may read the installation's real credential files.
vi.mock("node:fs/promises", async (original) => ({
  ...await original<typeof import("node:fs/promises")>(),
  readFile: vi.fn(async () => { throw new Error("No fixture credential file"); })
}));
afterEach(() => { vi.unstubAllGlobals(); });

function fixture(usage: unknown, models?: unknown[]) {
  const model = { id: "fixture-small", provider: "vercel", protocol: "responses",
    inputUsdPer1kTokens: 1, outputUsdPer1kTokens: 2 };
  const config = getApiConfig({
    AI_GATEWAY_API_KEY: "fixture-only-key",
    SPACE_VERCEL_VOICE_BASE_URL: "https://gateway.example.invalid",
    SPACE_LIVE_MODEL_POLICY_JSON: JSON.stringify(models ?? [model])
  });
  const request = vi.fn(async () => new Response(JSON.stringify({
    usage, choices: [{ message: { content: "Fixture reply" } }]
  }), { status: 200 }));
  vi.stubGlobal("fetch", request);
  return { config, request };
}

describe("Voice delegate cost evidence", () => {
  it("does not call a provider after speculative delegation was cancelled", async () => {
    const { config, request } = fixture({});
    const abort = new AbortController(); abort.abort();
    await createVoiceDelegateResponse(config, { query: "Fixture" }, abort.signal);
    expect(request).not.toHaveBeenCalled();
  });
  it.each([undefined, {}, { prompt_tokens: 10 }, { completion_tokens: 10 },
    { prompt_tokens: "10", completion_tokens: 2 },
    { prompt_tokens: -1, completion_tokens: 2 },
    { prompt_tokens: 1.5, completion_tokens: 2 }
  ])("keeps incomplete or malformed usage unknown: %j", async usage => {
    const { config } = fixture(usage);
    const result = await createVoiceDelegateResponse(config, { query: "Fixture" });
    expect(result.telemetry).toMatchObject({ provider: "vercel", estimatedCostUsd: null });
  });

  it("identifies a configured gateway independently of its hostname", async () => {
    const { config, request } = fixture({ prompt_tokens: 100, completion_tokens: 25 });
    const result = await createVoiceDelegateResponse(config, { query: "Fixture" });
    expect(result.telemetry).toMatchObject({ provider: "vercel", model: "fixture-small" });
    expect(result.telemetry?.estimatedCostUsd).toBeCloseTo(0.15, 12);
    expect(request).toHaveBeenCalledOnce();
  });

  it("does not use another provider's price for a matching model ID", async () => {
    const { config } = fixture({ prompt_tokens: 100, completion_tokens: 25 }, [
      { id: "fixture-small", provider: "google", protocol: "responses", inputUsdPer1kTokens: 900, outputUsdPer1kTokens: 900 },
      { id: "fixture-small", provider: "vercel", protocol: "responses" }
    ]);
    const result = await createVoiceDelegateResponse(config, { query: "Fixture" });
    expect(result.telemetry?.estimatedCostUsd).toBeNull();
  });

  it("accepts explicit zero usage as evidence, unlike missing usage", async () => {
    const { config } = fixture({ input_tokens: 0, output_tokens: 0 });
    const result = await createVoiceDelegateResponse(config, { query: "Fixture" });
    expect(result.telemetry?.estimatedCostUsd).toBe(0);
  });
});
