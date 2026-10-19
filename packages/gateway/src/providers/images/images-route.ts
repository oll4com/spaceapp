import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { GatewaySettings } from "@space/contracts";
import type { GatewayAccountRecord, GatewayRepository } from "@space/db";
import type { AccountPool } from "../../accounts/account-pool.js";
import { StickyStore } from "../../accounts/sticky-store.js";
import { requestOrigin } from "../../client-detect.js";
import { gatewayError, gatewayErrors, type GatewayErrorEnvelope } from "../../errors.js";
import { checkKeyLimits, PolicyRejection } from "../../policy.js";
import { costUsd, imageCostUsd, type ImageTokenUsage } from "../../pricing/pricing.js";
import { readBounded } from "../../proxy-util.js";
import type { RequestLogWriter } from "../../request-log-writer.js";
import { selectAccount } from "../../router/balancer.js";
import type { GatewayRouteHelpers } from "../../server.js";
import { CODE_ASSIST_BASE_URL } from "../antigravity/code-assist.js";
import { createAntigravityPoolAccess } from "../antigravity/pool-access.js";
import { readGeminiUsage } from "../antigravity/stream.js";
import { parseUpstreamError, recordCodexFailure } from "../codex/codex-proxy.js";
import { buildCodexUpstreamHeaders } from "../codex/headers.js";
import type { CodexModelPlans } from "../codex/model-plans.js";
import { readResponseUsage } from "../codex/stream.js";
import { CODEX_UPSTREAM_BASE_URL } from "../codex/usage.js";

/**
 * Image generation as a Space Gateway capability (`POST /images/v1/generate`, Design pane plan 2026-10-18): Gemini image
 * models (Nano Banana) on the Antigravity pool through Code Assist `generateContent`, GPT Image on the Codex pool through
 * the Responses `image_generation` tool. One image per request; the key's model allowlist and limits apply, the cost
 * settles against the key (its daily COST_USD cap), and every call is a request log row.
 */
/** `gpt-image` is the Design pane's id for GPT Image (DESIGN_ENGINE_MODELS); `gpt-image-2` names the model the tool runs. */
export const IMAGE_MODELS = { "gemini-3.1-flash-image": "ANTIGRAVITY", "gemini-3-pro-image": "ANTIGRAVITY", "gpt-image": "CODEX", "gpt-image-2": "CODEX" } as const;
export type ImageModel = keyof typeof IMAGE_MODELS;
/** The Codex model that carries the image tool call: the cheapest the Codex accounts serve. */
export const CODEX_IMAGE_CARRIER_MODEL = "gpt-5.6-luna";
const ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] as const;
const MAX_REFERENCE_BASE64 = 10 * 1024 * 1024;
const MAX_UPSTREAM_BYTES = 64 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 240_000;

const imageRequestSchema = z.object({
  model: z.string().min(1).max(80),
  prompt: z.string().trim().min(1).max(8000),
  aspectRatio: z.enum(ASPECT_RATIOS).default("1:1"),
  imageSize: z.enum(["512", "1K", "2K", "4K"]).optional(),
  referenceImages: z.array(z.object({
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    base64: z.string().min(1).max(MAX_REFERENCE_BASE64).regex(/^[A-Za-z0-9+/]+=*$/, "base64")
  }).strict()).max(3).default([])
}).strict();
type ImageRequest = z.infer<typeof imageRequestSchema>;

interface GeneratedImage { mimeType: string; base64: string }
interface Usage { inputTokens: number | null; cachedInputTokens: number | null; outputTokens: number | null }
type Attempt = { ok: true; account: GatewayAccountRecord; image: GeneratedImage; text: string | null; usage: Usage | null; costUsd: number | null }
  | { ok: false; account: GatewayAccountRecord | null; status: number; error: GatewayErrorEnvelope | string };

export interface ImageRouteOptions {
  antigravityPool: AccountPool;
  codexPool: AccountPool;
  repository: GatewayRepository;
  logs: RequestLogWriter;
  settings: () => Promise<GatewaySettings>;
  settleKeyUsage?: (keyId: string, usage: { inputTokens: number; outputTokens: number; costMicros: number; model: string | null; at: string }) => Promise<void>;
  modelPlans?: CodexModelPlans;
  codeAssistBaseUrl?: string;
  codexBaseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  maxAccountAttempts?: number;
}

const obj = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null);
const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0);

/** The image, its revised prompt and the usage of a Codex Responses stream that ran the image tool. */
export function readCodexImageStream(text: string) {
  let image: GeneratedImage | null = null;
  let revisedPrompt: string | null = null;
  let response: Record<string, unknown> | null = null;
  let failure: { code: string; message: string } | null = null;
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data.includes("image_generation_call") && !data.includes("\"response.")) continue;
    let event: Record<string, unknown> | null = null;
    try { event = obj(JSON.parse(data)); } catch { continue; }
    const item = obj(event?.item);
    if (event?.type === "response.output_item.done" && item?.type === "image_generation_call" && typeof item.result === "string" && item.result) {
      image = { mimeType: `image/${typeof item.output_format === "string" ? item.output_format.replace("jpg", "jpeg") : "png"}`, base64: item.result };
      revisedPrompt = typeof item.revised_prompt === "string" ? item.revised_prompt : null;
    } else if (event?.type === "response.completed" || event?.type === "response.failed" || event?.type === "response.incomplete") {
      response = obj(event.response);
      const error = obj(response?.error);
      if (event.type !== "response.completed") failure = { code: String(error?.code ?? event.type), message: String(error?.message ?? "The image call did not complete.") };
    } else if (event?.type === "error") {
      const error = obj(event.error) ?? event;
      failure = { code: String(error.code ?? "upstream_error"), message: String(error.message ?? "The image call failed.") };
    }
  }
  const tool = obj(obj(response?.tool_usage)?.image_gen);
  const toolUsage: ImageTokenUsage | null = tool ? { textInputTokens: count(obj(tool.input_tokens_details)?.text_tokens),
    imageInputTokens: count(obj(tool.input_tokens_details)?.image_tokens), outputTokens: count(tool.output_tokens) } : null;
  const toolModel = (Array.isArray(response?.tools) ? response.tools.map(obj) : []).find((entry) => entry?.type === "image_generation")?.model;
  return { image, revisedPrompt, failure, carrierUsage: readResponseUsage(response), toolUsage,
    toolModel: typeof toolModel === "string" ? toolModel : "gpt-image-2" };
}

/** The Codex tool's size for an aspect ratio (the closest of the three GPT Image sizes; the Design pane composes the exact format). */
function codexSize(aspectRatio: string): string {
  const [width, height] = aspectRatio.split(":").map(Number) as [number, number];
  return width / height > 1.15 ? "1536x1024" : width / height < 0.87 ? "1024x1536" : "1024x1024";
}

export function registerImageRoutes(app: FastifyInstance, helpers: GatewayRouteHelpers, options: ImageRouteOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const maxAttempts = options.maxAccountAttempts ?? 3;
  const codeAssistUrl = `${(options.codeAssistBaseUrl ?? CODE_ASSIST_BASE_URL).replace(/\/+$/, "")}/v1internal:generateContent`;
  const codexUrl = `${(options.codexBaseUrl ?? CODEX_UPSTREAM_BASE_URL).replace(/\/+$/, "")}/codex/responses`;
  // Image calls carry no session, so the sticky store is never read; the pool access only needs one.
  const antigravity = createAntigravityPoolAccess({ pool: options.antigravityPool, repository: options.repository, now,
    sticky: new StickyStore({ provider: "ANTIGRAVITY", kind: "PROMPT_CACHE" }) });

  /** Accounts outside the key's scope count as already tried. */
  async function outOfScope(pool: AccountPool, scope: Set<string> | null): Promise<Set<string>> {
    return new Set(scope ? (await pool.accounts()).filter((account) => !scope.has(account.id)).map((account) => account.id) : []);
  }

  async function gemini(input: ImageRequest, settings: GatewaySettings, scope: Set<string> | null): Promise<Attempt> {
    const tried = await outOfScope(options.antigravityPool, scope);
    let last: Attempt | null = null;
    let retryWith: GatewayAccountRecord | null | undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const account = retryWith ?? await antigravity.pick("gemini", tried, null, settings);
      if (retryWith) attempt -= 1;
      retryWith = undefined;
      if (!account) break;
      tried.add(account.id);
      let upstream: Response;
      try {
        const credentials = await options.antigravityPool.credentials(account);
        // The shape of Antigravity's own image call, so the pooled sign-in is used as agy uses it.
        upstream = await fetchImpl(codeAssistUrl, { method: "POST", signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          headers: { authorization: `Bearer ${credentials.accessToken}`, "content-type": "application/json", "user-agent": "antigravity" },
          body: JSON.stringify({ model: input.model, project: credentials.upstreamAccountId, requestId: `img-${randomUUID()}`, userAgent: "antigravity", requestType: "agent",
            request: { contents: [{ role: "user", parts: [...input.referenceImages.map((image) => ({ inlineData: { mimeType: image.mimeType, data: image.base64 } })), { text: input.prompt }] }],
              generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: input.aspectRatio, ...(input.imageSize ? { imageSize: input.imageSize } : {}) } } } }) });
      } catch {
        options.antigravityPool.markTransientError(account.id);
        last = { ok: false, account, status: 502, error: gatewayError("upstream_unavailable", "Code Assist is unreachable.") };
        continue;
      }
      const text = await readBounded(upstream, MAX_UPSTREAM_BYTES);
      if (!upstream.ok) {
        last = { ok: false, account, status: upstream.status, error: text };
        const outcome = await antigravity.recordFailure(account, "gemini", upstream.status, text);
        retryWith = outcome.retryWith;
        if (outcome.failover) continue;
        break;
      }
      let response: Record<string, unknown> | null = null;
      try { const body = obj(JSON.parse(text)); response = obj(body?.response) ?? body; } catch { /* reported below */ }
      const candidate = obj((Array.isArray(response?.candidates) ? response.candidates : [])[0]);
      const parts = (Array.isArray(obj(candidate?.content)?.parts) ? obj(candidate?.content)!.parts as unknown[] : []).map(obj);
      const inline = parts.map((part) => obj(part?.inlineData)).find((data) => typeof data?.data === "string" && data.data);
      const said = parts.map((part) => (typeof part?.text === "string" ? part.text : "")).join("").trim() || null;
      void options.antigravityPool.touch(account.id, new Date().toISOString()).catch(() => undefined);
      const usage = readGeminiUsage(response);
      const logged = usage ? { inputTokens: usage.promptTokens, cachedInputTokens: usage.cachedTokens, outputTokens: usage.outputTokens } : null;
      if (!inline) {
        // A refusal (safety, recitation) is about the prompt, not the account: no other account is tried.
        const reason = typeof candidate?.finishReason === "string" ? candidate.finishReason : "NO_IMAGE";
        return { ok: false, account, status: 422, error: gatewayError("image_not_generated", `The model returned no image (${reason})${said ? `: ${said.slice(0, 300)}` : "."}`, "invalid_request_error") };
      }
      void options.antigravityPool.markSuccess(account.id).catch(() => undefined);
      // shortcut: the per-image list price only (the prompt's input tokens cost under $0.001), upgrade if prompts grow large.
      return { ok: true, account, image: { mimeType: String(inline.mimeType ?? "image/png"), base64: String(inline.data) }, text: said, usage: logged,
        costUsd: imageCostUsd(input.model, { imageSize: input.imageSize ?? "1K" }) };
    }
    return last ?? { ok: false, account: null, status: 503, error: gatewayErrors.noAccounts() };
  }

  async function pickCodex(settings: GatewaySettings, tried: Set<string>) {
    const free = (await options.codexPool.accounts()).filter((account) => !tried.has(account.id));
    const accounts = options.modelPlans ? options.modelPlans.eligible(free, CODEX_IMAGE_CARRIER_MODEL) : free;
    const states = accounts.map((account) => options.codexPool.toBalancerState(account));
    const result = selectAccount(states, { now: now() / 1000, routingStrategy: settings.routingStrategy, planPriority: settings.planPriority,
      preferEarlierReset: settings.preferEarlierReset });
    for (const state of states) options.codexPool.absorb(state);
    return result.account ? accounts.find((account) => account.id === result.account!.accountId) : undefined;
  }

  async function codex(input: ImageRequest, settings: GatewaySettings, scope: Set<string> | null): Promise<Attempt> {
    const tried = await outOfScope(options.codexPool, scope);
    let last: Attempt | null = null;
    let retryWith: GatewayAccountRecord | null = null;
    const body = JSON.stringify({ model: CODEX_IMAGE_CARRIER_MODEL, instructions: "Generate the requested image with the image_generation tool. Do not ask questions.",
      input: [{ role: "user", content: [...input.referenceImages.map((image) => ({ type: "input_image", image_url: `data:${image.mimeType};base64,${image.base64}` })),
        { type: "input_text", text: input.prompt }] }],
      tools: [{ type: "image_generation", size: codexSize(input.aspectRatio), output_format: "png" }], tool_choice: { type: "image_generation" },
      reasoning: { effort: "low" }, stream: true, store: false });
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const account = retryWith ?? await pickCodex(settings, tried);
      if (retryWith) attempt -= 1;
      retryWith = null;
      if (!account) break;
      tried.add(account.id);
      let upstream: Response;
      try {
        const credentials = await options.codexPool.credentials(account);
        upstream = await fetchImpl(codexUrl, { method: "POST", body, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          headers: buildCodexUpstreamHeaders({}, credentials.accessToken, credentials.upstreamAccountId) });
      } catch {
        options.codexPool.markTransientError(account.id);
        last = { ok: false, account, status: 502, error: gatewayError("upstream_unavailable", "ChatGPT is unreachable.") };
        continue;
      }
      const text = await readBounded(upstream, MAX_UPSTREAM_BYTES);
      const read = upstream.ok ? readCodexImageStream(text) : null;
      const failure = !upstream.ok ? parseUpstreamError(text, upstream.status)
        : read!.failure ? parseUpstreamError(JSON.stringify({ error: read!.failure }), 200) : null;
      if (failure) {
        last = { ok: false, account, status: failure.status >= 400 ? failure.status : 502,
          error: failure.body && !upstream.ok ? failure.body : gatewayError(failure.code, failure.message) };
        if (failure.kind === "surface") break;
        retryWith = await recordCodexFailure(options.codexPool, account, failure);
        continue;
      }
      void options.codexPool.touch(account.id, new Date().toISOString()).catch(() => undefined);
      const { image, revisedPrompt, carrierUsage, toolUsage, toolModel } = read!;
      if (!image) return { ok: false, account, status: 422, error: gatewayError("image_not_generated", "The model returned no image.", "invalid_request_error") };
      void options.codexPool.markSuccess(account.id).catch(() => undefined);
      const toolCost = imageCostUsd(toolModel, { tokens: toolUsage });
      // The carrier model's own tokens count too when it has a price; an unpriced image tool leaves the whole call unpriced.
      const cost = toolCost === null ? null : toolCost + (costUsd(carrierUsage, CODEX_IMAGE_CARRIER_MODEL, null) ?? 0);
      return { ok: true, account, image, text: revisedPrompt, costUsd: cost,
        usage: toolUsage ? { inputTokens: toolUsage.textInputTokens + toolUsage.imageInputTokens, cachedInputTokens: null, outputTokens: toolUsage.outputTokens } : null };
    }
    return last ?? { ok: false, account: null, status: 503, error: gatewayErrors.noAccounts() };
  }

  async function generate(request: FastifyRequest, reply: FastifyReply) {
    if (!(await helpers.authenticate(request, reply))) return reply;
    const key = request.gatewayApiKey!;
    const startedAt = now();
    const parsed = imageRequestSchema.safeParse({ ...(obj(request.body) ?? {}), ...(key.enforcedModel ? { model: key.enforcedModel } : {}) });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return reply.code(400).send(gatewayError("invalid_request", `Invalid image request: ${issue?.path.join(".") || "body"} ${issue?.message ?? ""}`.trim(), "invalid_request_error"));
    }
    const input = parsed.data;
    const provider = IMAGE_MODELS[input.model as ImageModel];
    if (!provider) {
      return reply.code(400).send(gatewayError("model_not_supported", `'${input.model}' is not an image model. Use one of: ${Object.keys(IMAGE_MODELS).join(", ")}.`,
        "invalid_request_error"));
    }
    try {
      if (key.allowedModels.length > 0 && !key.allowedModels.includes(input.model)) {
        throw new PolicyRejection(403, gatewayError("model_not_allowed", `This API key does not have access to model '${input.model}'`, "invalid_request_error"));
      }
      checkKeyLimits(key, input.model, new Date(startedAt).toISOString());
    } catch (error) {
      if (error instanceof PolicyRejection) return reply.code(error.statusCode).send(error.envelope);
      throw error;
    }
    const settings = await options.settings();
    const scope = key.accountScopeEnabled ? new Set(key.accountIds) : null;
    const requestId = `req_${randomUUID().replace(/-/g, "")}`;
    const result = provider === "ANTIGRAVITY" ? await gemini(input, settings, scope) : await codex(input, settings, scope);
    const errorText = result.ok ? null : typeof result.error === "string" ? result.error : result.error.error.message;
    options.logs.add({
      requestId, requestedAt: new Date(startedAt).toISOString(), provider, accountId: result.account?.id ?? null, apiKeyId: key.id, model: input.model,
      reasoningEffort: null, serviceTier: null, transport: "http", upstreamTransport: "http", status: result.ok ? "success" : "error",
      errorCode: result.ok ? null : typeof result.error === "string" ? `http_${result.status}` : result.error.error.code,
      errorMessage: errorText ? errorText.slice(0, 500) : null, latencyMs: now() - startedAt, firstTokenMs: null,
      inputTokens: result.ok ? result.usage?.inputTokens ?? null : null, cachedInputTokens: result.ok ? result.usage?.cachedInputTokens ?? null : null,
      outputTokens: result.ok ? result.usage?.outputTokens ?? null : null, reasoningTokens: null, costUsd: result.ok ? result.costUsd : null,
      compressionTokensSaved: null, stickyKind: null, stickyKeyHash: null, planType: result.account?.planType ?? null, ...requestOrigin(request)
    });
    if (!result.ok) {
      reply.code(result.status).header("x-request-id", requestId);
      return typeof result.error === "string" ? reply.header("content-type", "application/json").send(result.error) : reply.send(result.error);
    }
    if (options.settleKeyUsage) {
      void options.settleKeyUsage(key.id, { inputTokens: result.usage?.inputTokens ?? 0, outputTokens: result.usage?.outputTokens ?? 0,
        costMicros: Math.round((result.costUsd ?? 0) * 1e6), model: input.model, at: new Date(startedAt).toISOString() }).catch(() => undefined);
    }
    return reply.header("x-request-id", requestId).send({ images: [result.image], model: input.model, ...(result.text ? { text: result.text } : {}) });
  }

  app.post("/images/v1/generate", { bodyLimit: 48 * 1024 * 1024 }, generate);
}
