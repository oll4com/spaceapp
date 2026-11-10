import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { SPACE_AGENT_HOME, SPACE_INSTALL_ROOT } from "@space/contracts";
import { detectClient, requestOrigin } from "../../client-detect.js";
import { gatewayError } from "../../errors.js";
import { checkKeyLimits, PolicyRejection } from "../../policy.js";
import { readBounded } from "../../proxy-util.js";
import type { RequestLogWriter } from "../../request-log-writer.js";
import type { GatewayRouteHelpers } from "../../server.js";
import { isClaudeCodeRequest } from "../claude/api-key.js";

/**
 * Make AI through the space-ai-relay scenario (plan clipboard:F1nJVLcoWdd- step 4): Webhook -> Make AI Toolkit Ask -> Webhook response,
 * paid in Make credits. The relay takes `{token, input}` and answers 200 with the text and X-Make-Input/Output-Tokens, 401 to a wrong
 * token, 503 when Ask fails, and 200 "Accepted" without the headers while the scenario is off (Make queues the call).
 * Tokens per credit, input / output, by the model the scenario's Ask module runs (help.make.com/credits, read 4/11).
 */
export const MAKE_AI_CREDIT_RATES: Record<string, readonly [number, number]> = {
  "claude-opus-5": [180, 36], "claude-sonnet-5": [452, 90], "claude-fable-5": [90, 18], "claude-haiku-4-5": [904, 181],
  "gpt-5.6-sol": [180, 30], "gpt-5.6-terra": [452, 75], "gpt-5.6-luna": [4520, 753], small: [18080, 2260], medium: [18080, 2260], large: [3616, 452]
};

/** The plan's budget: 30K of the program's credits a month for AI through Make, so about 1,000 a day (operator rule 3/11: a daily cap that says when it is spent). */
export const MAKE_DAILY_CREDITS_DEFAULT = 1000;

/** Coding agents never spend Make credits (operator, plan step 4): the clients `detectClient` names that write code. */
const CODE_CLIENTS = new Set(["Claude Code", "Claude Code (VS Code)", "Anthropic CLI", "Codex CLI", "Cursor", "Grok Build", "Zed", "Aider", "Droid",
  "OpenCode", "Copilot", "Antigravity", "Reasonix", "Oh My Pi", "Kilo Code"]);

/** The Vault's two handles (vault_key:tOuOCRTzDKx3fq_ua-DuvA the URL, vault_key:RMgSXCywsKGSjFDAqxQKvw the token), installed for the gateway's user `space` first, the agent home's copies second. */
export async function readMakeRelayCredentials(): Promise<{ url: string; token: string } | null> {
  const read = async (name: string) => {
    for (const file of [`${SPACE_INSTALL_ROOT}/secrets/space-${name}`, `${SPACE_AGENT_HOME}/.config/space/${name}`]) {
      const value = (await readFile(file, "utf8").catch(() => "")).trim();
      if (value) return value;
    }
    return null;
  };
  const [url, token] = await Promise.all([read("make-ai-relay.url"), read("make-ai-relay.token")]);
  return url && token ? { url, token } : null;
}

const text = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map((part) => typeof part === "string" ? part : (part as { text?: unknown })?.text).filter((part) => typeof part === "string").join("\n") : "";

/** The relay takes one text: a single message as it is, a conversation as `role: text` paragraphs. */
export function makeRelayInput(messages: unknown): string {
  const list = Array.isArray(messages) ? messages as Array<{ role?: unknown; content?: unknown }> : [];
  if (list.length === 1) return text(list[0]!.content);
  return list.map((message) => `${String(message.role ?? "user")}: ${text(message.content)}`).join("\n\n");
}

const usageHeader = (value: string | null) => value !== null && /^\d{1,12}$/.test(value.trim()) ? Number(value.trim()) : null;

export function registerMakeRelayRoutes(app: FastifyInstance, helpers: GatewayRouteHelpers, options: {
  /** The model the scenario's Ask module runs (a key of MAKE_AI_CREDIT_RATES); unset, the provider is off (it ships off). */
  model: string | null; dailyCredits?: number; logs: RequestLogWriter;
  /** Make tokens the gateway logged on a UTC day, read once a day; the day's later answers are added in memory. */
  usedTokens: (day: string) => Promise<{ inputTokens: number; outputTokens: number }>;
  settleKeyUsage?: (keyId: string, usage: { inputTokens: number; outputTokens: number; costMicros: number; model: string | null; at: string }) => Promise<void>;
  credentials?: () => Promise<{ url: string; token: string } | null>; fetchImpl?: typeof fetch; now?: () => number;
}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const credentials = options.credentials ?? readMakeRelayCredentials;
  const dailyCredits = options.dailyCredits ?? MAKE_DAILY_CREDITS_DEFAULT;
  const rate = options.model ? MAKE_AI_CREDIT_RATES[options.model] : undefined;
  const model = `make/${options.model}`;
  const credits = (input: number, output: number) => input / rate![0] + output / rate![1];
  let today: { day: string; credits: number } | null = null;
  const spentToday = async (day: string) => {
    if (today?.day !== day) {
      const used = await options.usedTokens(day);
      today = { day, credits: credits(used.inputTokens, used.outputTokens) };
    }
    return today;
  };

  app.post("/pools/make/v1/chat/completions", async (request, reply) => {
    if (!(await helpers.authenticate(request, reply))) return reply;
    if (!rate) {
      return reply.code(503).send(gatewayError("make_off", options.model
        ? `Make AI is off: SPACE_GATEWAY_MAKE_MODEL names '${options.model}', which has no credit rate.`
        : "Make AI is switched off in Space Gateway (SPACE_GATEWAY_MAKE_MODEL is unset)."));
    }
    const key = request.gatewayApiKey!;
    const client = detectClient(request.headers);
    if (isClaudeCodeRequest(request.headers) || (client && CODE_CLIENTS.has(client))) {
      return reply.code(403).send(gatewayError("client_not_allowed", "Make AI serves background jobs only, never a coding agent.", "invalid_request_error"));
    }
    // BACKGROUND keys that name the model: Nous's and the free-pool keys allow any model, so they never reach Make.
    if (key.trafficClass !== "BACKGROUND" || !key.allowedModels.includes(model)) {
      return reply.code(403).send(gatewayError("key_not_allowed", `Make AI serves only BACKGROUND keys whose allowed models name '${model}'.`, "invalid_request_error"));
    }
    const body = request.body && typeof request.body === "object" && !Array.isArray(request.body) ? request.body as Record<string, unknown> : null;
    if (!body) return reply.code(400).send(gatewayError("invalid_request", "The request body must be a JSON object.", "invalid_request_error"));
    if ((key.enforcedModel ?? body.model) !== model) {
      return reply.code(400).send(gatewayError("model_not_listed", `Make AI runs only '${model}'.`, "invalid_request_error"));
    }
    if (body.stream === true || body.tools !== undefined) {
      return reply.code(400).send(gatewayError("invalid_request", "Make AI answers whole texts: no streaming and no tools.", "invalid_request_error"));
    }
    const input = makeRelayInput(body.messages);
    if (!input.trim()) return reply.code(400).send(gatewayError("invalid_request", "The messages carry no text.", "invalid_request_error"));
    const startedAt = now();
    const at = new Date(startedAt).toISOString();
    try {
      checkKeyLimits(key, model, at);
    } catch (error) {
      if (error instanceof PolicyRejection) return reply.code(error.statusCode).send(error.envelope);
      throw error;
    }
    // shortcut: calls already in flight when the cap is reached still finish and count, so a day can end a few calls past it; enough for background traffic.
    const spent = await spentToday(at.slice(0, 10));
    if (spent.credits >= dailyCredits) {
      const midnight = Date.parse(`${spent.day}T00:00:00Z`) + 86_400_000;
      return reply.code(402).header("retry-after", String(Math.ceil((midnight - startedAt) / 1000))).send(gatewayError("credit_exhausted",
        `Make AI's ${dailyCredits} credits for today are used up (${Math.round(spent.credits)} spent); it answers again after 00:00 UTC.`));
    }
    const log = (status: "success" | "error", errorCode: string | null, usage: { inputTokens: number; outputTokens: number } | null) => {
      options.logs.add({ requestId: request.id, requestedAt: at, provider: "MAKE", accountId: null, apiKeyId: key.id, model, reasoningEffort: null,
        serviceTier: null, transport: "http", upstreamTransport: "http", status, errorCode, latencyMs: now() - startedAt, firstTokenMs: null,
        inputTokens: usage?.inputTokens ?? null, cachedInputTokens: null, outputTokens: usage?.outputTokens ?? null, reasoningTokens: null, costUsd: null,
        compressionTokensSaved: null, stickyKind: null, stickyKeyHash: null, ...requestOrigin(request) });
      if (usage && options.settleKeyUsage) void options.settleKeyUsage(key.id, { ...usage, costMicros: 0, model, at }).catch(() => undefined);
    };
    const fail = (status: number, code: string, message: string) => { log("error", code, null); return reply.code(status).send(gatewayError(code, message)); };
    const relay = await credentials();
    if (!relay) return fail(503, "make_not_configured", "Make AI's relay URL and token are not installed for Space Gateway.");
    const controller = new AbortController();
    request.raw.once("close", () => { if (!reply.raw.writableEnded) controller.abort(); });
    let upstream: Response;
    try {
      upstream = await fetchImpl(relay.url, { method: "POST", signal: controller.signal, headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: relay.token, input }) });
    } catch {
      if (controller.signal.aborted) return reply;
      return fail(502, "upstream_unavailable", "Make's relay is unreachable.");
    }
    if (upstream.status === 401) {
      await readBounded(upstream);
      return fail(502, "make_relay_refused", "Make's relay refused Space Gateway's token (HTTP 401).");
    }
    if (upstream.status === 503) {
      await readBounded(upstream);
      return fail(503, "make_ai_unavailable", "Make AI did not answer (HTTP 503 from the relay).");
    }
    if (!upstream.ok) {
      await readBounded(upstream);
      return fail(502, "upstream_error", `Make's relay answered HTTP ${upstream.status}.`);
    }
    const inputTokens = usageHeader(upstream.headers.get("x-make-input-tokens"));
    const outputTokens = usageHeader(upstream.headers.get("x-make-output-tokens"));
    if (inputTokens === null || outputTokens === null) {
      await readBounded(upstream);
      return fail(503, "make_relay_no_answer", "Make's relay sent no answer: its scenario is off, and Make queued the call to run when it is on.");
    }
    const answer = await upstream.text();
    const usage = { inputTokens, outputTokens };
    spent.credits += credits(inputTokens, outputTokens);
    log("success", null, usage);
    return reply.send({ id: `chatcmpl-${request.id}`, object: "chat.completion", created: Math.floor(startedAt / 1000), model,
      choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }],
      usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens } });
  });
}
