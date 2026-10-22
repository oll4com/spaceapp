import { describe, expect, it, vi } from "vitest";
import { InMemoryGatewayRepository } from "@space/db";
import { AccountPool, type StoredCredentials } from "../src/accounts/account-pool.js";
import { generateGatewayApiKey } from "../src/api-keys.js";
import { createCredentialCipher } from "../src/credential-cipher.js";
import { costUsd, imageCostUsd } from "../src/pricing/pricing.js";
import { CODEX_IMAGE_CARRIER_MODEL, readCodexImageStream, registerImageRoutes } from "../src/providers/images/images-route.js";
import { RequestLogWriter } from "../src/request-log-writer.js";
import { createGatewayServer } from "../src/server.js";

const cipher = createCredentialCipher(Buffer.alloc(32, 5));
const nowMs = Date.parse("2030-01-10T00:00:00Z");
const PNG = Buffer.from("fake-png-bytes").toString("base64");
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const geminiImage = () => json({ response: { candidates: [{ content: { role: "model", parts: [{ inlineData: { mimeType: "image/png", data: PNG } }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 1290 }, modelVersion: "gemini-3.1-flash-image" }, traceId: "t" });
const sse = (...events: Record<string, unknown>[]) => new Response(events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
  { headers: { "content-type": "text/event-stream" } });
const codexImage = () => sse(
  { type: "response.created", response: { id: "resp_1", model: CODEX_IMAGE_CARRIER_MODEL } },
  { type: "response.output_item.done", item: { type: "image_generation_call", status: "completed", output_format: "png", result: PNG, revised_prompt: "A cyan circle." } },
  { type: "response.completed", response: { id: "resp_1", model: CODEX_IMAGE_CARRIER_MODEL, usage: { input_tokens: 2315, output_tokens: 40 },
    tool_usage: { image_gen: { input_tokens: 45, input_tokens_details: { image_tokens: 0, text_tokens: 45 }, output_tokens: 515 } },
    tools: [{ type: "image_generation", model: "gpt-image-2-codex" }] } }
);

async function setup(upstream: (call: { url: string; token: string; body: Record<string, unknown> }) => Response, key: Record<string, unknown> = {}) {
  const repository = new InMemoryGatewayRepository();
  for (const provider of ["ANTIGRAVITY", "CODEX"] as const) {
    for (const [name, used] of [["a", 10], ["b", 40]] as const) {
      const accountId = `gw_account:${(provider === "CODEX" ? "c" : "") + name.repeat(provider === "CODEX" ? 31 : 32)}`;
      const credentials: StoredCredentials = { accessToken: `${provider}-token-${name}`, refreshToken: "rt", idToken: null, upstreamAccountId: `project-${name}`, accessExpiresAtMs: null };
      await repository.upsertAccount({ accountId, provider, label: name, email: `${name}@example.com`, externalAccountId: `sub-${name}`, planType: "pro",
        credentialsEncrypted: cipher.encrypt(JSON.stringify(credentials), accountId), credentialsExpiresAt: null, source: "OAUTH", sourceRef: null, lastRefreshAt: null });
      await repository.saveUsageWindows(accountId, provider === "ANTIGRAVITY"
        ? [{ quotaKey: "gemini", window: "PRIMARY", usedPercent: used, resetAt: null, windowMinutes: 300 }]
        : [{ window: "PRIMARY", usedPercent: used, resetAt: null, windowMinutes: 300 }]);
    }
  }
  await repository.updateSettings({ routingStrategy: "USAGE_WEIGHTED", planPriority: [] });
  const refresh = vi.fn(async (credentials: StoredCredentials) => ({ ...credentials, accessToken: `${credentials.accessToken}-fresh` }));
  const pool = (provider: "ANTIGRAVITY" | "CODEX") => new AccountPool({ provider, repository, cipher: () => cipher, refresher: { needsRefresh: () => false, refresh }, now: () => nowMs });
  const { plainKey, keyHash, keyPrefix } = generateGatewayApiKey();
  const keyId = `gw_key:${"d".repeat(32)}`;
  await repository.createApiKey({ keyId, name: "space-design", keyHash, keyPrefix, trafficClass: "INTERACTIVE", allowedModels: [], enforcedModel: null,
    allowedReasoningEfforts: [], enforcedReasoningEffort: null, accountIds: [], compressionOverride: null, limits: [], expiresAt: null, createdBy: null, ...key });
  const logs = new RequestLogWriter(repository, { intervalMs: 1 });
  const calls: { url: string; token: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const call = { url, token: String((init.headers as Record<string, string>).authorization).replace("Bearer ", ""), body: JSON.parse(String(init.body)) as Record<string, unknown> };
    calls.push(call);
    return upstream(call);
  }) as unknown as typeof fetch;
  const settled: { costMicros: number }[] = [];
  const server = createGatewayServer({ repository, version: "test", credentialKeyPresent: () => true, now: () => new Date(nowMs),
    routes: (app, helpers) => registerImageRoutes(app, helpers, { antigravityPool: pool("ANTIGRAVITY"), codexPool: pool("CODEX"), repository, logs,
      settings: () => repository.getSettings(), fetchImpl, now: () => nowMs, codeAssistBaseUrl: "https://code-assist.test", codexBaseUrl: "https://codex.test",
      settleKeyUsage: async (_keyId, usage) => { settled.push(usage); } }) });
  const generate = (payload: Record<string, unknown>) => server.app.inject({ method: "POST", url: "/images/v1/generate", headers: { authorization: `Bearer ${plainKey}` }, payload });
  const text = (payload: Record<string, unknown>) => server.app.inject({ method: "POST", url: "/gemini/v1/generate", headers: { authorization: `Bearer ${plainKey}` }, payload });
  return { repository, logs, calls, generate, text, refresh, settled };
}

describe("Image route", () => {
  it("generates a Nano Banana image on the least-used Antigravity account and logs its list price", async () => {
    const { generate, calls, logs, repository, settled } = await setup(() => geminiImage());
    const response = await generate({ model: "gemini-3.1-flash-image", prompt: "A cyan circle", aspectRatio: "16:9", imageSize: "2K",
      referenceImages: [{ mimeType: "image/jpeg", base64: PNG }] });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ images: [{ mimeType: "image/png", base64: PNG }], model: "gemini-3.1-flash-image" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "https://code-assist.test/v1internal:generateContent", token: "ANTIGRAVITY-token-a", body: {
      model: "gemini-3.1-flash-image", project: "project-a", userAgent: "antigravity",
      request: { contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/jpeg", data: PNG } }, { text: "A cyan circle" }] }],
        generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "16:9", imageSize: "2K" } } } } });
    await logs.flush();
    const [log] = await repository.listRequestLogs({ limit: 5 });
    expect(log).toMatchObject({ provider: "ANTIGRAVITY", model: "gemini-3.1-flash-image", status: "success", inputTokens: 12, outputTokens: 1290, costUsd: 0.101 });
    expect(settled).toEqual([expect.objectContaining({ costMicros: 101_000, model: "gemini-3.1-flash-image" })]);
  });

  it("moves to the next account on a quota 429 and retries an account once with its refreshed token after a 401", async () => {
    const quota = await setup(({ token }) => (token === "ANTIGRAVITY-token-a"
      ? json({ error: { code: 429, message: "Individual quota reached. Resets in 1h.", status: "RESOURCE_EXHAUSTED" } }, 429) : geminiImage()));
    expect((await quota.generate({ model: "gemini-3-pro-image", prompt: "x" })).statusCode).toBe(200);
    expect(quota.calls.map((call) => call.token)).toEqual(["ANTIGRAVITY-token-a", "ANTIGRAVITY-token-b"]);

    const rejected = await setup(({ token }) => (token === "ANTIGRAVITY-token-a" ? json({ error: { code: 401, message: "expired" } }, 401) : geminiImage()));
    expect((await rejected.generate({ model: "gemini-3.1-flash-image", prompt: "x" })).statusCode).toBe(200);
    expect(rejected.refresh).toHaveBeenCalledTimes(1);
    expect(rejected.calls.map((call) => call.token)).toEqual(["ANTIGRAVITY-token-a", "ANTIGRAVITY-token-a-fresh"]);
  });

  it("tries the next upstream name on the same account when Code Assist does not know a model, and remembers the one that works", async () => {
    const notFound = () => json({ error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } }, 404);
    const { generate, calls, logs, repository } = await setup(({ body }) => (body.model === "gemini-3.1-pro-image" ? geminiImage() : notFound()));
    const response = await generate({ model: "gemini-3-pro-image", prompt: "OLL4 logo" });
    expect(response.statusCode).toBe(200);
    expect(response.json().model).toBe("gemini-3-pro-image");
    expect(calls.map((call) => [call.token, call.body.model])).toEqual([
      ["ANTIGRAVITY-token-a", "gemini-3-pro-image"], ["ANTIGRAVITY-token-a", "gemini-3-pro-image-preview"], ["ANTIGRAVITY-token-a", "gemini-3.1-pro-image"]]);
    await logs.flush();
    expect((await repository.listRequestLogs({ limit: 5 }))[0]).toMatchObject({ model: "gemini-3-pro-image", status: "success" });
    // The next call starts with the name that worked.
    expect((await generate({ model: "gemini-3-pro-image", prompt: "again" })).statusCode).toBe(200);
    expect(calls.slice(3).map((call) => call.body.model)).toEqual(["gemini-3.1-pro-image"]);

    // When no name is known upstream, the 404 still reaches the client after every candidate on one account.
    const none = await setup(() => notFound());
    const refused = await none.generate({ model: "gemini-3-pro-image", prompt: "x" });
    expect(refused.statusCode).toBe(404);
    expect(none.calls.map((call) => call.body.model)).toEqual(["gemini-3-pro-image", "gemini-3-pro-image-preview", "gemini-3.1-pro-image", "gemini-3.1-pro-image-preview", "nano-banana-pro-preview"]);
    expect(new Set(none.calls.map((call) => call.token))).toEqual(new Set(["ANTIGRAVITY-token-a"]));
    // A model without candidates is sent once, as before.
    const flash = await setup(() => notFound());
    expect((await flash.generate({ model: "gemini-3.1-flash-image", prompt: "x" })).statusCode).toBe(404);
    expect(flash.calls).toHaveLength(1);
  });

  it("generates a GPT Image through the Codex image tool and prices the tool's tokens", async () => {
    const { generate, calls, logs, repository } = await setup(() => codexImage());
    const response = await generate({ model: "gpt-image", prompt: "A cyan circle", aspectRatio: "9:16" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ images: [{ mimeType: "image/png", base64: PNG }], model: "gpt-image", text: "A cyan circle." });
    expect(calls[0]).toMatchObject({ url: "https://codex.test/codex/responses", token: "CODEX-token-a", body: { model: CODEX_IMAGE_CARRIER_MODEL, stream: true,
      store: false, tool_choice: { type: "image_generation" }, tools: [{ type: "image_generation", size: "1024x1536", output_format: "png" }] } });
    await logs.flush();
    const [log] = await repository.listRequestLogs({ limit: 5 });
    expect(log).toMatchObject({ provider: "CODEX", model: "gpt-image", status: "success", inputTokens: 45, outputTokens: 515 });
    // The image tool's tokens at GPT Image 2 prices, plus the carrier model's own tokens.
    const carrier = costUsd({ inputTokens: 2315, cachedInputTokens: null, outputTokens: 40 }, CODEX_IMAGE_CARRIER_MODEL, null)!;
    expect(carrier).toBeGreaterThan(0);
    expect(log!.costUsd).toBeCloseTo((45 * 5 + 515 * 30) / 1e6 + carrier, 12);
  });

  it("moves off a rate-limited Codex account and surfaces a failure inside the stream", async () => {
    const limited = await setup(({ token }) => (token === "CODEX-token-a" ? json({ error: { code: "rate_limit_exceeded", message: "slow down" } }, 429) : codexImage()));
    expect((await limited.generate({ model: "gpt-image-2", prompt: "x" })).statusCode).toBe(200);
    expect(limited.calls.map((call) => call.token)).toEqual(["CODEX-token-a", "CODEX-token-b"]);
    expect(readCodexImageStream(`data: ${JSON.stringify({ type: "response.failed", response: { error: { code: "content_policy", message: "no" } } })}\n\n`))
      .toMatchObject({ image: null, failure: { code: "content_policy", message: "no" } });
  });

  it("refuses non-image models, models outside the key's allowlist, and oversized requests", async () => {
    const { generate, calls } = await setup(() => geminiImage(), { allowedModels: ["gemini-3.1-flash-image"] });
    expect((await generate({ model: "gpt-5.6-luna", prompt: "x" })).json().error.code).toBe("model_not_supported");
    expect((await generate({ model: "gpt-image-2", prompt: "x" })).statusCode).toBe(403);
    const reference = { mimeType: "image/png", base64: PNG };
    expect((await generate({ model: "gemini-3.1-flash-image", prompt: "x", referenceImages: [reference, reference, reference, reference] })).statusCode).toBe(400);
    expect((await generate({ model: "gemini-3.1-flash-image", prompt: "x", referenceImages: [{ mimeType: "image/png", base64: "A".repeat(10 * 1024 * 1024 + 4) }] })).statusCode).toBe(400);
    expect((await generate({ model: "gemini-3.1-flash-image", prompt: "x".repeat(8001) })).statusCode).toBe(400);
    expect((await generate({ model: "gemini-3.1-flash-image", prompt: "x", referenceImages: [{ mimeType: "image/gif", base64: PNG }] })).statusCode).toBe(400);
    expect((await generate({ model: "gemini-3.1-flash-image", prompt: "x", aspectRatio: "7:3" })).statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("answers 422 without trying another account when the model returns no image", async () => {
    const { generate, calls } = await setup(() => json({ response: { candidates: [{ content: { parts: [{ text: "I can't make that." }] }, finishReason: "SAFETY" }] } }));
    const response = await generate({ model: "gemini-3.1-flash-image", prompt: "x" });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.message).toContain("SAFETY");
    expect(calls).toHaveLength(1);
  });
});

describe("Gemini text route", () => {
  const VIDEO = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
  const answer = (parts: Record<string, unknown>[], finishReason = "STOP") => json({ response: { candidates: [{ content: { role: "model", parts }, finishReason }],
    usageMetadata: { promptTokenCount: 6000, candidatesTokenCount: 200, thoughtsTokenCount: 50 }, modelVersion: "gemini-3.8-flash-n" }, traceId: "t" });

  it("sends the YouTube video as fileData on the least-used Antigravity account and answers the text without thoughts", async () => {
    const { text, calls, logs, repository, settled } = await setup(() => answer([{ text: "thinking", thought: true }, { text: "A man at the zoo." }]));
    const response = await text({ model: "gemini-3.8-flash-medium", prompt: "Summarize", videoUrl: VIDEO });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ text: "A man at the zoo.", model: "gemini-3.8-flash-medium" });
    expect(calls[0]).toMatchObject({ url: "https://code-assist.test/v1internal:generateContent", token: "ANTIGRAVITY-token-a", body: {
      model: "gemini-3.8-flash-medium", project: "project-a", userAgent: "antigravity", requestType: "agent",
      request: { contents: [{ role: "user", parts: [{ fileData: { fileUri: VIDEO, mimeType: "video/mp4" } }, { text: "Summarize" }] }],
        generationConfig: { mediaResolution: "MEDIA_RESOLUTION_LOW" } } } });
    await logs.flush();
    const [log] = await repository.listRequestLogs({ limit: 5 });
    expect(log).toMatchObject({ provider: "ANTIGRAVITY", model: "gemini-3.8-flash-medium", status: "success", inputTokens: 6000, outputTokens: 200 });
    expect(settled).toEqual([expect.objectContaining({ model: "gemini-3.8-flash-medium", inputTokens: 6000, outputTokens: 200 })]);
  });

  it("moves to the next account on a quota 429 and answers 422 on an empty answer without trying another", async () => {
    let first = true;
    const moved = await setup(() => { if (first) { first = false; return json({ error: { code: 429, message: "quota", status: "RESOURCE_EXHAUSTED" } }, 429); } return answer([{ text: "ok" }]); });
    expect((await moved.text({ model: "gemini-3.8-flash-medium", prompt: "x", videoUrl: VIDEO })).json().text).toBe("ok");
    expect(moved.calls.map((call) => call.token)).toEqual(["ANTIGRAVITY-token-a", "ANTIGRAVITY-token-b"]);
    const empty = await setup(() => answer([], "SAFETY"));
    const response = await empty.text({ model: "gemini-3.8-flash-medium", prompt: "x" });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.message).toContain("SAFETY");
    expect(empty.calls).toHaveLength(1);
  });

  it("refuses image and non-Gemini models, other video URLs and models outside the key's allowlist", async () => {
    const { text, calls } = await setup(() => answer([{ text: "ok" }]), { allowedModels: ["gemini-3.5-flash-lite"] });
    expect((await text({ model: "gemini-3.1-flash-image", prompt: "x" })).json().error.code).toBe("model_not_supported");
    expect((await text({ model: "gpt-5.6-luna", prompt: "x" })).statusCode).toBe(400);
    expect((await text({ model: "gemini-3.5-flash-lite", prompt: "x", videoUrl: "https://example.com/watch?v=jNQXAC9IVRw" })).statusCode).toBe(400);
    expect((await text({ model: "gemini-3.8-flash-medium", prompt: "x" })).statusCode).toBe(403);
    expect(calls).toHaveLength(0);
  });
});

describe("Image prices", () => {
  it("prices Gemini images by size and GPT Image by tokens; unknown stays null", () => {
    expect(imageCostUsd("gemini-3.1-flash-image", { imageSize: "4K" })).toBe(0.151);
    expect(imageCostUsd("gemini-3-pro-image", {})).toBe(0.134);
    expect(imageCostUsd("gemini-3-pro-image", { imageSize: "512" })).toBeNull();
    expect(imageCostUsd("gpt-image-2-codex", { tokens: { textInputTokens: 1000, imageInputTokens: 1000, outputTokens: 1000 } })).toBeCloseTo(0.043, 12);
    expect(imageCostUsd("gpt-image-2", {})).toBeNull();
    expect(imageCostUsd("dall-e-3", {})).toBeNull();
  });
});
