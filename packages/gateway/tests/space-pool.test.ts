import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { GATEWAY_DEFAULT_PROVIDER_ORDER, type GatewaySettings } from "@space/contracts";
import { fittedOutput, limitsOf, registerSpacePoolRoutes, spaceRefusalOf } from "../src/providers/space/space-pool.js";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const models = (...ids: string[]) => json({ object: "list", data: ids.map((id) => ({ id })) });
const allOn = GATEWAY_DEFAULT_PROVIDER_ORDER.map((entry) => ({ ...entry, enabled: entry.route !== "ANTIGRAVITY" ? true : entry.enabled }));

type Native = (path: string, headers: Headers, body: Record<string, unknown> | null) => Response | Promise<Response>;
function setup(native: Native, order = allOn, internalToken: string | null = "internal-secret") {
  const calls: Array<{ path: string; headers: Headers; body: Record<string, unknown> | null }> = [];
  let inFlight = 0;
  let peak = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    calls.push({ path, headers, body });
    inFlight += 1; peak = Math.max(peak, inFlight);
    try { await new Promise((done) => setTimeout(done, 15)); return await native(path, headers, body); } finally { inFlight -= 1; }
  }) as typeof fetch;
  const app = Fastify();
  registerSpacePoolRoutes(app, { settings: async () => ({ providerOrder: order }) as GatewaySettings, selfBaseUrl: "http://127.0.0.1:4920", internalToken, fetchImpl, now: () => Date.UTC(2026, 10, 3, 10) });
  const post = (path: string, payload: Record<string, unknown>, authorization = "Bearer sk-space-test", headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url: `/pools/space/v1/${path}`, headers: { authorization, ...headers }, payload });
  return { app, calls, post, peak: () => peak };
}

describe("Space Gateway /pools/space", () => {
  it("tells a spent budget, pool or credit from a provider's rate limit, the client's own key limits, an outage, unknown availability and a refused key", () => {
    expect(spaceRefusalOf(429, "DAILY_ALLOWANCE_REACHED")).toEqual({ kind: "budget", scope: "api_budget_daily" });
    expect(spaceRefusalOf(429, "MONTHLY_BUDGET_REACHED")).toEqual({ kind: "budget", scope: "api_budget_monthly" });
    expect(spaceRefusalOf(429, "usage_limit_reached")).toEqual({ kind: "quota", scope: "provider_pool" });
    expect(spaceRefusalOf(429, "insufficient_quota")).toEqual({ kind: "quota", scope: "provider_credit" });
    expect(spaceRefusalOf(429, "rate_limit_exceeded", "Upstream rate limited.")).toEqual({ kind: "throttle", scope: "provider_rate" });
    expect(spaceRefusalOf(429, "rate_limit_exceeded", "This API key sent too many requests this minute.")).toEqual({ kind: "key_limit", scope: "gateway_key_rate" });
    expect(spaceRefusalOf(429, "rate_limit_exceeded", "API key cost_usd daily limit exceeded")).toEqual({ kind: "key_limit", scope: "gateway_key" });
    expect(spaceRefusalOf(503, "no_accounts")).toEqual({ kind: "unavailable", scope: "provider_pool" });
    expect(spaceRefusalOf(502, "route_unreachable")).toEqual({ kind: "unknown", scope: null });
    expect(spaceRefusalOf(401, "invalid_api_key")).toEqual({ kind: "auth", scope: null });
    expect(spaceRefusalOf(400, "invalid_request")).toEqual({ kind: "other", scope: null });
    // An end-of-life model (NVIDIA, Cloudflare): that model only, never the key.
    expect(spaceRefusalOf(410, "")).toEqual({ kind: "unavailable", scope: null });
    // A model the provider lists but does not serve this key (NVIDIA "Function not found for account"): that model only.
    expect(spaceRefusalOf(404, "http_404")).toEqual({ kind: "unavailable", scope: null });
  });

  it("hands an explicit model to its native route with the client's key, and names the route that served it", async () => {
    const f = setup((path) => path === "/v1/responses" ? new Response("data: {\"type\":\"response.completed\"}\n\n", { headers: { "content-type": "text/event-stream", "x-request-id": "req:1" } }) : json({}, 500));
    const response = await f.post("responses", { model: "codex:gpt-6-astra", stream: true, input: "hi", reasoning: { effort: "high" } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-space-route"]).toBe("CODEX");
    expect(response.headers["x-space-model"]).toBe("codex:gpt-6-astra");
    expect(response.body).toContain("response.completed");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.body).toEqual({ model: "gpt-6-astra", stream: true, input: "hi", reasoning: { effort: "high" } });
    expect(f.calls[0]!.headers.get("authorization")).toBe("Bearer sk-space-test");
    expect(f.calls[0]!.headers.get("x-space-internal-token")).toBeNull();
  });

  it("never switches an explicit model: its exhaustion reaches the client in its protocol with route, model, kind and the known reset", async () => {
    const f = setup(() => json({ error: { type: "rate_limit_error", code: "usage_limit_reached", message: "All 4 Claude accounts reached their usage limit." } }, 429, { "retry-after": "600" }));
    const response = await f.post("messages", { model: "claude:claude-opus-5-5", max_tokens: 10, messages: [] });
    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({ type: "error", error: { type: "rate_limit_error", code: "usage_limit_reached", message: "Claude: All 4 Claude accounts reached their usage limit.",
      route: "CLAUDE", model: "claude:claude-opus-5-5", kind: "quota", scope: "provider_pool", resets_at: "2026-11-03T10:10:00.000Z" } });
    expect(f.calls.map((call) => call.path)).toEqual(["/v1/messages"]);
    // A route off in the order, or one that does not speak the protocol, is refused, not swapped.
    const off = setup(() => json({}), allOn.map((entry) => entry.route === "CODEX" ? { ...entry, enabled: false } : entry));
    expect((await off.post("chat/completions", { model: "codex:gpt-6-astra", messages: [] })).json()).toMatchObject({ error: { code: "route_disabled", route: "CODEX" } });
    expect((await off.post("messages", { model: "codex:gpt-6-astra", messages: [] })).json()).toMatchObject({ type: "error", error: { code: "route_protocol_mismatch" } });
    expect(off.calls).toHaveLength(0);
  });

  it("serves concurrent requests without a global lock", async () => {
    const f = setup((path) => json({ id: "x", object: "chat.completion", choices: [{ message: { role: "assistant", content: path } }] }));
    const ids = ["codex:gpt-6-astra", "codex:gpt-6.1-sol", "codex:gpt-6-luna"];
    const answers = await Promise.all(ids.map((model) => f.post("chat/completions", { model, messages: [{ role: "user", content: "hi" }] })));
    expect(f.peak()).toBe(3);
    expect(answers.map((answer) => answer.statusCode)).toEqual([200, 200, 200]);
    expect(answers.map((answer) => answer.headers["x-space-route"])).toEqual(["CODEX", "CODEX", "CODEX"]);
  });

  it("auto follows the Gateway order among routes of the client's protocol, maps the class per route, and says which route served", async () => {
    const f = setup((path, headers) => {
      if (path === "/v1/models") return models("claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5");
      if (headers.get("x-space-gateway-route") === "CLAUDE_API_KEY") return json({ type: "message", content: [{ type: "text", text: "ok" }] });
      return json({ type: "error", error: { type: "rate_limit_error", code: "usage_limit_reached", message: "pool spent" } }, 429);
    });
    const response = await f.post("messages", { model: "auto", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-space-route"]).toBe("CLAUDE_OPENCODE");
    expect(response.headers["x-space-model"]).toBe("opencode-claude:claude-opus-5-5");
    const sent = f.calls.filter((call) => call.path === "/v1/messages");
    expect(sent.map((call) => [call.body?.model, call.headers.get("x-space-gateway-route")])).toEqual([["claude-opus-5-5", null], ["claude-opus-5-5", "CLAUDE_API_KEY"]]);
    expect(sent[1]!.headers.get("x-space-internal-token")).toBe("internal-secret");
    // The client of the route that served still sees what refused before it.
    expect(JSON.parse(String(response.headers["x-space-fallback"]))).toEqual([{ route: "CLAUDE", model: "claude:claude-opus-5-5", kind: "quota", scope: "provider_pool",
      code: "usage_limit_reached", resets_at: null }]);
    // A light tier picks the light model.
    const light = await f.post("messages", { model: "auto-light", max_tokens: 10, messages: [] });
    expect(light.headers["x-space-model"]).toBe("opencode-claude:claude-haiku-5-5");
  });

  it("auto never hands what the pace cap holds to the paid Claude API key (plan clipboard:DotwYXVD2N3n step 6)", async () => {
    const f = setup((path, headers) => {
      if (path === "/v1/models") return models("claude-opus-5-5");
      if (headers.get("x-space-gateway-route") === "CLAUDE_API_KEY") return json({ type: "message", content: [{ type: "text", text: "paid" }] });
      return json({ type: "error", error: { type: "rate_limit_error", code: "PACE_CAP", message: "Space Gateway is holding background work" } }, 429);
    }, allOn.filter((entry) => entry.route === "CLAUDE" || entry.route === "CLAUDE_OPENCODE"));
    const response = await f.post("messages", { model: "auto", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
    expect(response.statusCode).toBe(429);
    expect(f.calls.some((call) => call.headers.get("x-space-gateway-route") === "CLAUDE_API_KEY")).toBe(false);
  });

  it("auto stops on a refused key and ends with one exhaustion answer naming each route's kind when every route refused", async () => {
    const denied = setup((path) => path === "/v1/models" ? models("gpt-6-astra") : json({ error: { code: "invalid_api_key", message: "Invalid API key." } }, 401));
    const refused = await denied.post("responses", { model: "auto", input: "hi" });
    expect(refused.statusCode).toBe(401);
    expect(denied.calls.filter((call) => call.path.endsWith("/responses"))).toHaveLength(1);

    const spent = setup((path) => path.endsWith("/models") ? models("gpt-6-astra", "gpt-6.1-sol")
      : path === "/v1/responses" ? json({ error: { code: "rate_limit_exceeded", message: "too many" } }, 429, { "retry-after": "30" })
        : json({ error: { code: "insufficient_quota", message: "no credit" } }, 429));
    const exhausted = await spent.post("responses", { model: "auto", input: "hi" });
    expect(exhausted.statusCode).toBe(429);
    expect(exhausted.json()).toMatchObject({ error: { code: "space_routes_exhausted", kind: "exhausted", resets_at: "2026-11-03T10:00:30.000Z",
      attempts: [{ route: "CODEX", kind: "throttle", scope: "provider_rate", code: "rate_limit_exceeded" }] } });

    // The client's own key cap applies on every route: auto stops there instead of spending the next route against it.
    const capped = setup((path) => path.endsWith("/models") ? models("gpt-6-astra") : json({ error: { code: "rate_limit_exceeded", message: "API key cost_usd daily limit exceeded" } }, 429));
    const stopped = await capped.post("responses", { model: "auto", input: "hi" });
    expect(stopped.json()).toMatchObject({ error: { code: "rate_limit_exceeded", route: "CODEX", kind: "key_limit", scope: "gateway_key" } });
    expect(capped.calls.filter((call) => call.path.endsWith("/responses"))).toHaveLength(1);
  });

  it("refuses the API-key route without the internal token instead of running it on the subscriptions", async () => {
    const f = setup(() => json({ type: "message" }), allOn, null);
    const response = await f.post("messages", { model: "opencode-claude:claude-opus-5-5", messages: [] });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: "route_not_configured", route: "CLAUDE_OPENCODE" } });
    expect(f.calls).toHaveLength(0);
  });

  it("lists auto models, every enabled route's models with their protocols, and why a route is not offered", async () => {
    const f = setup((path, headers) => path === "/v1/models" ? models(headers.get("anthropic-version") ? "claude-opus-5-5" : "gpt-6-astra")
      : json({}, 503),
      allOn.map((entry) => entry.route === "CODEX" ? { ...entry, enabled: false } : entry));
    const listed = (await f.app.inject({ method: "GET", url: "/pools/space/v1/models", headers: { authorization: "Bearer sk-space-test" } })).json();
    expect(listed.data.map((model: { id: string }) => model.id)).toEqual(["auto", "auto-balanced", "auto-light", "claude:claude-opus-5-5",
      "opencode-claude:claude-opus-5-5"]);
    expect(listed.routes.find((route: { route: string }) => route.route === "ANTIGRAVITY")).toMatchObject({ available: false, reason: expect.stringContaining("No gateway-key protocol") });
    expect(listed.routes.find((route: { route: string }) => route.route === "CODEX")).toMatchObject({ enabled: false, reason: expect.stringContaining("Off") });
  });

  it("reads a model's window and output cap from its provider's row, a quarter of the window when only the window is named", () => {
    expect(limitsOf({ id: "openai/gpt-oss-20b", context_window: 131072, max_completion_tokens: 65536 })).toEqual({ context_length: 131072, max_output_tokens: 32000 });
    expect(limitsOf({ id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", context_window: 24000 })).toEqual({ context_length: 24000, max_output_tokens: 6000 });
    expect(limitsOf({ id: "x:free", context_length: 32768, top_provider: { max_completion_tokens: 8192 } })).toEqual({ context_length: 32768, max_output_tokens: 8192 });
    expect(limitsOf({ id: "glm", max_input_tokens: 1048576, max_output_tokens: "4096" })).toEqual({ context_length: 1048576, max_output_tokens: 4096 });
    // Inception's own field; never over OpenCode v1's 32,000 (OpenCode v2 asks the whole limit: Inception refused 250,000, 7/11).
    expect(limitsOf({ id: "mercury-3", context_length: 1000000, max_output_length: 131072 })).toEqual({ context_length: 1000000, max_output_tokens: 32000 });
    expect(limitsOf({ id: "big", context_length: 1000000 })).toEqual({ context_length: 1000000, max_output_tokens: 32000 });
    expect(limitsOf({ id: "Clef", context_length: 0 })).toEqual({});
    expect(limitsOf({ id: "bare" })).toEqual({});
  });

  it("fits output cap for models when context limit is known", () => {
    const overflow = "This model's maximum context length is 32768 tokens. However, you requested 32000 output tokens and your prompt contains at least 769 input tokens, for a total of at least 32769 tokens.";
    expect(fittedOutput({ max_tokens: 32000 }, overflow)).toEqual({ max_tokens: 31999 });
    expect(fittedOutput({ max_completion_tokens: 32000 }, "maximum context length is 8192 tokens. However, you requested 32769 tokens (769 in the messages, 32000 in the completion)")).toEqual({ max_completion_tokens: 7423 });
    expect(fittedOutput({ max_tokens: 100 }, overflow)).toBeNull();
    expect(fittedOutput({}, overflow)).toBeNull();
    expect(fittedOutput({ max_tokens: 32000 }, "maximum context length is 32768 tokens; your prompt contains at least 40000 input tokens")).toBeNull();
    expect(fittedOutput({ max_tokens: 32000 }, "Invalid request")).toBeNull();
  });

  it("routes Messages requests to Bedrock when enabled", async () => {
    const f = setup((path) => {
      if (path === "/pools/bedrock/v1/models") return models("anthropic.claude-opus-5-5");
      if (path === "/pools/bedrock/v1/messages") return json({ type: "message", role: "assistant", content: [{ type: "text", text: "from bedrock" }] });
      return json({}, 500);
    }, [...allOn, { route: "BEDROCK", enabled: true }]);
    const response = await f.post("messages", { model: "bedrock:anthropic.claude-opus-5-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-space-route"]).toBe("BEDROCK");
  });
});
