import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { CLOUD_CREDIT_ROUTES, GATEWAY_FREE_ROUTES, NOUS_SPACE_ROUTES, nousRouteModel, nousSpaceModel, type GatewayProviderRoute, type GatewaySettings } from "@space/contracts";
import { PACE_CAP } from "../../router/balancer.js";
import { isClaudeCodeRequest } from "../claude/api-key.js";
import { chatRequestOf, messagesResponseOf, messagesStreamOf } from "./messages-to-chat.js";

/**
 * Space Gateway's Space provider for every client (operator nous_msg:4783c7f2 / 6814c9ea, plan clipboard:52W5YTibb65k):
 * `/pools/space/v1/{messages,responses,chat/completions}` takes a `<route>:<model>` id (or an auto tier) in the client's own
 * protocol and hands the request over loopback to the native route that already serves it, so the client's key, its limits,
 * the request log and each provider's account fill-first apply unchanged. An explicit route never changes; auto follows the
 * Gateway's provider order among the routes that speak the client's protocol, and moves on only before the client got a byte.
 */
export type SpaceProtocol = "messages" | "responses" | "chat";
export type SpaceRefusalKind = "budget" | "quota" | "throttle" | "key_limit" | "unavailable" | "unknown" | "auth" | "other";
/** Whose limit refused: the API budget (day / month), the provider's whole account pool or its credit, the provider's rate, the client's own key (cap / per minute). */
export type SpaceLimitScope = "api_budget_daily" | "api_budget_monthly" | "provider_pool" | "provider_credit" | "provider_rate" | "gateway_key" | "gateway_key_rate";

const POOL = "/pools/space/v1";
/** Each route's native paths by protocol; Antigravity has no gateway-key protocol (it serves Gemini CLI and Nous's own loop). */
export const SPACE_ROUTE_PATHS: Record<GatewayProviderRoute, Partial<Record<SpaceProtocol | "models", string>>> = {
  CLAUDE: { messages: "/v1/messages", models: "/v1/models" },
  CODEX: { responses: "/v1/responses", chat: "/v1/chat/completions", models: "/v1/models" },
  CLAUDE_OPENCODE: { messages: "/v1/messages", models: "/v1/models" },
  ANTIGRAVITY: {},
  ANTIGRAVITY_FLASH: {},
  ANTIGRAVITY_CLAUDE: {},
  // Claude on cloud credits: Messages only, and only while the credit is recorded and under 90% spent (key-pools.ts).
  BEDROCK: { messages: "/pools/bedrock/v1/messages", models: "/pools/bedrock/v1/models" },
  VERTEX: { messages: "/pools/vertex/v1/messages", models: "/pools/vertex/v1/models" }
};
/** A free route serves a Messages request through its Chat path, translated (messages-to-chat.ts); a paid route never does, so Claude-format requests never spend it. */
const isTranslated = (route: GatewayProviderRoute, protocol: SpaceProtocol) => protocol === "messages" && !SPACE_ROUTE_PATHS[route].messages && GATEWAY_FREE_ROUTES.has(route) && Boolean(SPACE_ROUTE_PATHS[route].chat);
const pathFor = (route: GatewayProviderRoute, protocol: SpaceProtocol) => (isTranslated(route, protocol) ? SPACE_ROUTE_PATHS[route].chat : SPACE_ROUTE_PATHS[route][protocol]);
const protocolsOf = (route: GatewayProviderRoute) => (["messages", "responses", "chat"] as const).filter((protocol) => pathFor(route, protocol));
const isFreeOpenRouterModel = (model: string) => model.endsWith(":free");
const FORWARDED_OUT = new Set(["host", "content-length", "connection", "transfer-encoding", "x-space-internal-token", "x-space-gateway-route", "accept-encoding"]);
const MODELS_TTL_MS = 5 * 60_000;
/** OpenCode v1's output ceiling (OUTPUT_TOKEN_MAX), which v2 no longer applies to a listed limit. */
const OPENCODE_OUTPUT_MAX = 32_000;
type ModelLimits = { context_length?: number; max_output_tokens?: number };
const positive = (value: unknown) => ((typeof value === "number" || typeof value === "string") && Number(value) > 0 ? Number(value) : undefined);
/**
 * A native catalog row's window and output cap, in the /models fields (Bifrost's) that OpenCode's model discovery reads, so OpenCode asks no more
 * than a model takes (Cleo's audit 7/11: Cloudflare's Llama 3.3 70B refused OpenCode's default 32,000 output tokens in its 24,000 window).
 */
export function limitsOf(row: Record<string, unknown>): ModelLimits {
  const context = positive(row.context_window ?? row.context_length ?? row.max_input_tokens);
  if (!context) return {};
  const top = row.top_provider && typeof row.top_provider === "object" ? (row.top_provider as Record<string, unknown>) : {};
  // shortcut: a quarter of the window when the provider names no output cap (Cloudflare, most of OpenRouter), so the prompt fits beside it; use the provider's cap once it lists one.
  const output = positive(row.max_completion_tokens ?? row.max_output_tokens ?? row.max_output_length ?? top.max_completion_tokens) ?? Math.floor(context / 4);
  // OpenCode v2 asks the whole limit (7/11: Inception refused 250,000 > its 131,072; Adaption names 1M output in a 1M window): at most OpenCode v1's own 32,000.
  return { context_length: context, max_output_tokens: Math.min(output, OPENCODE_OUTPUT_MAX) };
}
/**
 * The request again with its output cap cut to what the window leaves, when a vLLM-style 400 names both (Free.ai's qwen3-8b 7/11: "maximum context
 * length is 32768 tokens. However, you requested 32000 output tokens and your prompt contains at least 769 input tokens"); its catalog lists no
 * window, so OpenCode asked its default 32,000. Null when the error is another one or the cap already fits.
 */
export function fittedOutput(payload: Record<string, unknown>, error: string): Record<string, unknown> | null {
  const window = Number(/maximum context length is (\d+) tokens/.exec(error)?.[1]);
  const input = Number(/(\d+) input tokens|\((\d+) in the messages/.exec(error)?.slice(1).find(Boolean));
  const key = ["max_tokens", "max_completion_tokens", "max_output_tokens"].find((name) => typeof payload[name] === "number");
  return key && input > 0 && window - input > 0 && window - input < (payload[key] as number) ? { ...payload, [key]: window - input } : null;
}
const MAX_ERROR_BODY = 64 * 1024;

export interface SpacePoolOptions {
  settings: () => Promise<GatewaySettings>;
  /** This gateway's own loopback listener, e.g. http://127.0.0.1:4920. */
  selfBaseUrl: string;
  internalToken: string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** A free pool's dead model (model-checks.ts), left out of the cached catalogs at once; the free routes are named as their providers. */
  isDead?: (route: GatewayProviderRoute, model: string) => boolean;
}

export interface SpaceRefusal { route: GatewayProviderRoute; model: string | null; status: number; kind: SpaceRefusalKind; scope: SpaceLimitScope | null; code: string;
  message: string; resets_at: string | null }

/**
 * What a native refusal means. One account's exhaustion never reaches here (its pool moves to the next account); a pool whose every
 * account is spent is `quota`/`provider_pool`. The client's own key limits apply on every route, so they are `key_limit` and never fail over.
 */
export function spaceRefusalOf(status: number, code: string, message = ""): { kind: SpaceRefusalKind; scope: SpaceLimitScope | null } {
  if (code === "DAILY_ALLOWANCE_REACHED") return { kind: "budget", scope: "api_budget_daily" };
  if (code === "MONTHLY_BUDGET_REACHED") return { kind: "budget", scope: "api_budget_monthly" };
  if (code === "usage_limit_reached") return { kind: "quota", scope: "provider_pool" };
  if (code === "insufficient_quota" || status === 402) return { kind: "quota", scope: "provider_credit" };
  if (code === "rate_limit_exceeded" && /^This API key sent too many requests/.test(message)) return { kind: "key_limit", scope: "gateway_key_rate" };
  if (code === "rate_limit_exceeded" && /^API key \w+ \w+ limit exceeded/.test(message)) return { kind: "key_limit", scope: "gateway_key" };
  if (status === 429) return { kind: "throttle", scope: "provider_rate" };
  if (status === 401 || status === 403) return { kind: "auth", scope: null };
  // An end-of-life model (NVIDIA, Cloudflare: 410) or one the provider lists but does not serve this key (NVIDIA: 404): that model only,
  // so auto tries the next route once; an explicit id gets the provider's answer.
  if (status === 410 || status === 404) return { kind: "unavailable", scope: null };
  if (code === "no_accounts") return { kind: "unavailable", scope: "provider_pool" };
  if (code === "route_unreachable" || code === "models_unavailable") return { kind: "unknown", scope: null };
  if (status >= 500) return { kind: "unavailable", scope: null };
  return { kind: "other", scope: null };
}
/**
 * Auto's model on a free key pool: their catalogs hold models that answer 404 to the key (NVIDIA: 41 of 56 chat models on 5/11), speech
 * and TTS models (Groq) and retired ones, so the class pick of `nousRouteModel` could land on any of them.
 * shortcut: one model per route that answered 200 on 5/11 (the class is not used); pick per class from a probe when the free routes carry real auto traffic.
 */
export const SPACE_FREE_AUTO_MODEL: Partial<Record<GatewayProviderRoute, string>> = {};
const FAILS_OVER: ReadonlySet<SpaceRefusalKind> = new Set(["budget", "quota", "throttle", "unavailable", "unknown"]);
/** The refusals an auto request passed on its way, for the client of the route that served (no messages: header-safe ASCII). */
const fallbackHeader = (refusals: SpaceRefusal[]) => JSON.stringify(refusals.map(({ route, model, kind, scope, code, resets_at }) => ({ route, model, kind, scope, code, resets_at })));

const idOf = (route: GatewayProviderRoute, model: string) => `${NOUS_SPACE_ROUTES[route].prefix}:${model}`;

/** The client's protocol error envelope with the Space fields: Anthropic `{type:"error",error}`, OpenAI `{error}`. */
export function spaceError(protocol: SpaceProtocol, status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  const type = status === 429 ? "rate_limit_error" : status === 401 || status === 403 ? "authentication_error" : status >= 500 ? "api_error" : "invalid_request_error";
  const error = { type, code, message, ...extra };
  return protocol === "messages" ? { type: "error", error } : { error };
}

export function registerSpacePoolRoutes(app: FastifyInstance, options: SpacePoolOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const base = options.selfBaseUrl.replace(/\/+$/, "");
  const modelCache = new Map<string, { at: number; ids: string[]; limits: Record<string, ModelLimits> }>();

  const forwardHeaders = (request: FastifyRequest, route: GatewayProviderRoute) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined || FORWARDED_OUT.has(name)) continue;
      headers[name] = Array.isArray(value) ? value.join(", ") : value;
    }
    if (route === "CLAUDE_OPENCODE" && options.internalToken) Object.assign(headers, { "x-space-internal-token": options.internalToken, "x-space-gateway-route": "CLAUDE_API_KEY" });
    if (route === "CLAUDE" || route === "CLAUDE_OPENCODE") headers["anthropic-version"] ??= "2023-06-01";
    return headers;
  };

  /** A route's model ids for this caller (its key may narrow them); a short cache spares the native catalogs. */
  async function routeModels(request: FastifyRequest, route: GatewayProviderRoute): Promise<{ ids: string[]; limits: Record<string, ModelLimits> } | { status: number; message: string }> {
    const path = SPACE_ROUTE_PATHS[route].models;
    if (!path) return { status: 404, message: "This route has no gateway-key protocol." };
    const auth = createHash("sha256").update(`${request.headers.authorization ?? ""}\0${request.headers["x-api-key"] ?? ""}`).digest("hex");
    const cacheKey = `${route}\0${auth}`;
    const cached = modelCache.get(cacheKey);
    const alive = (ids: string[]) => (options.isDead ? ids.filter((id) => !options.isDead!(route, id)) : ids);
    if (cached && now() - cached.at < MODELS_TTL_MS) return { ids: alive(cached.ids), limits: cached.limits };
    const headers = forwardHeaders(request, route);
    if (route !== "CLAUDE" && route !== "CLAUDE_OPENCODE") delete headers["anthropic-version"];
    try {
      const response = await fetchImpl(`${base}${path}`, { method: "GET", headers, redirect: "error" });
      if (!response.ok) return { status: response.status, message: (await response.text()).slice(0, 300) };
      const data = (await response.json() as { data?: Array<Record<string, unknown>> }).data ?? [];
      const listed = data.filter((item): item is Record<string, unknown> & { id: string } => typeof item?.id === "string");
      const ids = listed.map((item) => item.id);
      const limits = Object.fromEntries(listed.map((item) => [item.id, limitsOf(item)]));
      modelCache.set(cacheKey, { at: now(), ids, limits });
      return { ids: alive(ids), limits };
    } catch (error) {
      return { status: 502, message: error instanceof Error ? error.message : "unreachable" };
    }
  }

  async function refusal(route: GatewayProviderRoute, model: string | null, response: Response): Promise<SpaceRefusal> {
    const text = (await response.text()).slice(0, MAX_ERROR_BODY);
    let code = "";
    let message = text.trim().slice(0, 500);
    try {
      const error = (JSON.parse(text) as { error?: { code?: unknown; message?: unknown; type?: unknown } }).error ?? {};
      code = typeof error.code === "string" ? error.code : typeof error.type === "string" ? error.type : "";
      if (typeof error.message === "string") message = error.message;
    } catch { /* not JSON */ }
    const seconds = Number(response.headers.get("retry-after"));
    // A reset only when the upstream says it (Retry-After); otherwise unknown, never guessed.
    const resetsAt = Number.isFinite(seconds) && seconds > 0 ? new Date(now() + seconds * 1000).toISOString() : null;
    return { route, model: model === null ? null : idOf(route, model), status: response.status, ...spaceRefusalOf(response.status, code, message), code: code || `http_${response.status}`,
      message, resets_at: resetsAt };
  }

  async function send(reply: FastifyReply, response: Response, route: GatewayProviderRoute, model: string, passed: SpaceRefusal[] = [], translated = false) {
    if (passed.length) reply.header("x-space-fallback", fallbackHeader(passed));
    reply.code(response.status).header("content-type", response.headers.get("content-type") ?? "application/json")
      .header("x-space-route", route).header("x-space-model", idOf(route, model));
    const requestId = response.headers.get("x-request-id");
    if (requestId) reply.header("x-request-id", requestId);
    if (translated) {
      const streamed = (response.headers.get("content-type") ?? "").includes("text/event-stream");
      if (streamed && response.body) return reply.header("content-type", "text/event-stream").send(Readable.from(messagesStreamOf(response.body, idOf(route, model))));
      return reply.header("content-type", "application/json").send(messagesResponseOf(await response.json().catch(() => null), idOf(route, model)));
    }
    return reply.send(response.body ? Readable.fromWeb(response.body as import("node:stream/web").ReadableStream) : "");
  }

  async function serve(request: FastifyRequest, reply: FastifyReply, protocol: SpaceProtocol) {
    const body = request.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) return reply.code(400).send(spaceError(protocol, 400, "invalid_request", "A JSON body is required."));
    const asked = (body as { model?: unknown }).model;
    const parsed = typeof asked === "string" ? nousSpaceModel(asked) : null;
    if (!parsed) return reply.code(400).send(spaceError(protocol, 400, "model_not_found",
      "Name a Space model: <route>:<model> (claude:, codex:, opencode-claude:, openai:, openrouter:, openrouter-free:, deepseek:, groq:, nvidia:, cloudflare:, google:, adaption:, amd:, inception:, agentrouter:, freeai:, azure:, zai:, siliconflow:, ovh:, mistral:, bedrock:, vertex:) or auto, auto-balanced, auto-light. GET /pools/space/v1/models lists them."));
    const order = (await options.settings()).providerOrder;
    const controller = new AbortController();
    request.raw.once("close", () => { if (!reply.raw.writableEnded) controller.abort(); });

    const attempt = async (route: GatewayProviderRoute, model: string): Promise<Response | SpaceRefusal> => {
      // Without the internal token the API-key route would quietly become the subscription route: refused instead.
      if (route === "CLAUDE_OPENCODE" && !options.internalToken) return { route, model: idOf(route, model), status: 503, kind: "unavailable", scope: null, code: "route_not_configured",
        message: "The Claude API-key route needs the gateway's internal token.", resets_at: null };
      const translated = isTranslated(route, protocol);
      const headers = forwardHeaders(request, route);
      if (translated) { delete headers["anthropic-version"]; delete headers["anthropic-beta"]; }
      // A translated request keeps max_tokens within the model's own output cap (its catalog row, cached), named as Azure's GPT-5 models want it.
      const listed = translated ? await routeModels(request, route) : null;
      const maxOutput = listed && "limits" in listed ? listed.limits[model]?.max_output_tokens : undefined;
      const payload = translated ? chatRequestOf({ ...body, model }, { maxOutput }) : { ...body, model };
      const post = (sent: Record<string, unknown>) => fetchImpl(`${base}${pathFor(route, protocol)}`, { method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(sent), signal: controller.signal, redirect: "error" });
      try {
        const response = await post(payload);
        // Once: a model whose window the catalog does not list says it in its refusal.
        const fitted = response.status === 400 ? fittedOutput(payload, (await response.clone().text()).slice(0, MAX_ERROR_BODY)) : null;
        return fitted ? await post(fitted) : response;
      } catch (error) {
        return { route, model: idOf(route, model), status: 502, kind: "unknown", scope: null, code: "route_unreachable", message: error instanceof Error ? error.message : "unreachable", resets_at: null };
      }
    };

    if (!("auto" in parsed)) {
      const { route, model } = parsed;
      const entry = order.find((item) => item.route === route);
      if (!pathFor(route, protocol)) return reply.code(400).send(spaceError(protocol, 400, "route_protocol_mismatch",
        `${NOUS_SPACE_ROUTES[route].name} does not serve this protocol through Space Gateway; use ${protocolsOf(route).map((key) => `${POOL}/${key === "messages" ? "messages" : key === "chat" ? "chat/completions" : "responses"}`).join(" or ") || "another route"}.`,
        { route, model: asked }));
      if (!entry?.enabled) return reply.code(403).send(spaceError(protocol, 403, "route_disabled", `${NOUS_SPACE_ROUTES[route].name} is off in Space Gateway's provider order.`, { route, model: asked }));
      const outcome = await attempt(route, model);
      if (outcome instanceof Response) {
        if (outcome.ok) return send(reply, outcome, route, model, [], isTranslated(route, protocol));
        const refused = await refusal(route, model, outcome);
        // An explicit model never changes: the client learns why, in its protocol, with the reset when it is known.
        if (FAILS_OVER.has(refused.kind) || refused.kind === "auth" || refused.kind === "key_limit") return reply.code(refused.status).header("x-space-route", route)
          .send(spaceError(protocol, refused.status, refused.code, `${NOUS_SPACE_ROUTES[route].name}: ${refused.message}`, { route, model: refused.model, kind: refused.kind, scope: refused.scope, resets_at: refused.resets_at }));
        return reply.code(refused.status).header("content-type", "application/json").header("x-space-route", route).send(spaceError(protocol, refused.status, refused.code, refused.message, { route, model: refused.model }));
      }
      return reply.code(outcome.status).send(spaceError(protocol, outcome.status, outcome.code, outcome.message, { route, model: outcome.model, kind: outcome.kind, scope: outcome.scope, resets_at: null }));
    }

    const refusals: SpaceRefusal[] = [];
    for (const { route, enabled } of order) {
      if (!enabled || !pathFor(route, protocol)) continue;
      // Plan clipboard:DotwYXVD2N3n step 6: what the pace cap holds is not a shortage, so the paid Claude API key never takes it.
      if (route === "CLAUDE_OPENCODE" && refusals.some((item) => item.code === PACE_CAP)) continue;
      // The cloud credits never serve Claude Code (operator 7/11, nous_msg:21ec89e5); its pool would refuse it with a 403 that ends auto.
      if (CLOUD_CREDIT_ROUTES.has(route) && isClaudeCodeRequest(request.headers)) continue;
      const models = await routeModels(request, route);
      if (!("ids" in models)) {
        if (spaceRefusalOf(models.status, "").kind === "auth") return reply.code(models.status).send(spaceError(protocol, models.status, "invalid_api_key", models.message, { route }));
        refusals.push({ route, model: null, status: models.status, kind: "unknown", scope: null, code: "models_unavailable", message: models.message, resets_at: null });
        continue;
      }
      const fixed = SPACE_FREE_AUTO_MODEL[route];
      const model = fixed && models.ids.includes(fixed) ? fixed : nousRouteModel(models.ids.map((id) => ({ id })), parsed.auto)?.id;
      if (!model) { refusals.push({ route, model: null, status: 404, kind: "unavailable", scope: null, code: "no_model", message: "No model on this route for this key.", resets_at: null }); continue; }
      const outcome = await attempt(route, model);
      const translated = isTranslated(route, protocol);
      if (outcome instanceof Response && outcome.ok) return send(reply, outcome, route, model, refusals, translated);
      const refused = outcome instanceof Response ? await refusal(route, model, outcome) : outcome;
      // Auth and request errors stop here: no other route is used to get around a refused key or a bad request. A translated free route's
      // request error is its own limit (max_tokens, Groq's 413 per-minute tokens) on a request the Claude route took, so the next route tries.
      if (!FAILS_OVER.has(refused.kind) && !(translated && refused.kind === "other")) return reply.code(refused.status).header("x-space-route", route)
        .send(spaceError(protocol, refused.status, refused.code, refused.message, { route, model: refused.model, kind: refused.kind, scope: refused.scope }));
      refusals.push(refused);
    }
    const status = refusals.some((item) => item.kind !== "unavailable" && item.kind !== "unknown") ? 429 : 503;
    const known = refusals.map((item) => item.resets_at).filter((at): at is string => Boolean(at)).sort();
    return reply.code(status).send(spaceError(protocol, status, "space_routes_exhausted",
      refusals.length ? `Every enabled Space route for this protocol refused: ${refusals.map((item) => `${NOUS_SPACE_ROUTES[item.route].name} (${item.kind}: ${item.code})`).join("; ")}.`
        : "No enabled route in Space Gateway's provider order serves this protocol.",
      { kind: "exhausted", resets_at: known[0] ?? null, attempts: refusals }));
  }

  app.post(`${POOL}/messages`, (request, reply) => serve(request, reply, "messages"));
  app.post(`${POOL}/responses`, (request, reply) => serve(request, reply, "responses"));
  app.post(`${POOL}/chat/completions`, (request, reply) => serve(request, reply, "chat"));
  app.get(`${POOL}/models`, async (request, reply) => {
    const order = (await options.settings()).providerOrder;
    const routes = [];
    const data = [];
    for (const { route, enabled } of order) {
      const protocols = protocolsOf(route);
      if (!protocols.length) { routes.push({ route, name: NOUS_SPACE_ROUTES[route].name, enabled, available: false, protocols, reason: "No gateway-key protocol (Gemini CLI and Nous only)." }); continue; }
      if (!enabled) { routes.push({ route, name: NOUS_SPACE_ROUTES[route].name, enabled, available: false, protocols, reason: "Off in Space Gateway's provider order." }); continue; }
      const models = await routeModels(request, route);
      if (!("ids" in models) && spaceRefusalOf(models.status, "").kind === "auth") return reply.code(models.status).send(spaceError("chat", models.status, "invalid_api_key", "Invalid or missing gateway key."));
      routes.push({ route, name: NOUS_SPACE_ROUTES[route].name, enabled, available: "ids" in models, protocols, reason: "ids" in models ? null : `Models unavailable (${models.status}).` });
      if ("ids" in models) for (const id of models.ids) data.push({ id: idOf(route, id), object: "model", created: 0, owned_by: "space", route, protocols, ...models.limits[id] });
    }
    const auto = ["auto", "auto-balanced", "auto-light"].map((id) => ({ id, object: "model", created: 0, owned_by: "space", route: null, protocols: ["messages", "responses", "chat"] }));
    return { object: "list", data: [...auto, ...data], routes };
  });
}
