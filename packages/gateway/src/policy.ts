import type { GatewayApiKeyRecord } from "@space/db";
import { gatewayError, type GatewayErrorEnvelope } from "./errors.js";

/**
 * API-key request policy, after codex-lb `app/modules/proxy/request_policy.py` (MIT, Soju06/codex-lb):
 * enforced model and reasoning effort, model allowlist, allowed reasoning efforts (`ultra` goes upstream as `max`)
 * and the fast speed tier sent upstream as `priority`.
 */
export class PolicyRejection extends Error {
  constructor(readonly statusCode: number, readonly envelope: GatewayErrorEnvelope) {
    super(envelope.error.message);
  }
}

const wireEffortAliases: Record<string, string> = { ultra: "max" };
const omittedServiceTiers = new Set(["auto", "default"]);

type Body = Record<string, unknown>;

function reasoningOf(body: Body): Record<string, unknown> | null {
  return body.reasoning && typeof body.reasoning === "object" && !Array.isArray(body.reasoning) ? body.reasoning as Record<string, unknown> : null;
}

export interface PolicyResult {
  body: Body;
  model: string | null;
  /** The effort the client chose (before wire aliasing), for logs and limits. */
  reasoningEffort: string | null;
  requestedServiceTier: string | null;
  serviceTier: string | null;
}

export function applyRequestPolicy(input: Body, key: GatewayApiKeyRecord | null, options: { fastTier?: string } = {}): PolicyResult {
  const body: Body = { ...input };
  if (key?.enforcedModel) body.model = key.enforcedModel;
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : null;
  assertModelAllowed(key, model);

  let reasoning = reasoningOf(body);
  if (key?.enforcedReasoningEffort) {
    reasoning = { ...(reasoning ?? {}), effort: key.enforcedReasoningEffort };
  }
  const requestedEffort = typeof reasoning?.effort === "string" && reasoning.effort.trim() ? reasoning.effort.trim().toLowerCase() : null;
  if (key && requestedEffort !== null && key.allowedReasoningEfforts.length > 0 && !key.allowedReasoningEfforts.includes(requestedEffort as never)) {
    throw new PolicyRejection(403, gatewayError("reasoning_effort_not_allowed",
      `This API key does not have access to reasoning effort '${requestedEffort}'`, "invalid_request_error"));
  }
  if (reasoning && requestedEffort !== null) {
    body.reasoning = { ...reasoning, effort: wireEffortAliases[requestedEffort] ?? requestedEffort };
  } else if (reasoning) {
    body.reasoning = reasoning;
  }

  const rawTier = typeof body.service_tier === "string" ? body.service_tier.trim().toLowerCase() : null;
  let serviceTier: string | null = rawTier;
  if (rawTier === "fast") serviceTier = options.fastTier ?? "priority";
  if (serviceTier !== null && omittedServiceTiers.has(serviceTier)) serviceTier = null;
  if (serviceTier === null) delete body.service_tier;
  else body.service_tier = serviceTier;

  return { body, model, reasoningEffort: requestedEffort, requestedServiceTier: rawTier, serviceTier };
}

/** A key with a model allowlist serves only those models; a request that names no model is not an exception. */
export function assertModelAllowed(key: GatewayApiKeyRecord | null, model: string | null): void {
  if (key && key.allowedModels.length > 0 && (model === null || !key.allowedModels.includes(model))) {
    throw new PolicyRejection(403, gatewayError("model_not_allowed", model === null ? "This API key needs a model it has access to"
      : `This API key does not have access to model '${model}'`, "invalid_request_error"));
  }
}

/**
 * Usage a key has spent that its stored limits do not show yet: requests still running and settlements still being written.
 * shortcut: per gateway process (a reload's draining worker keeps its own); a DB reservation would also cover that window.
 */
const pendingByKey = new Map<string, { inFlight: number; costMicros: number; inputTokens: number; outputTokens: number }>();
const costReserveMicros = Math.max(0, Number(process.env.SPACE_GATEWAY_COST_RESERVE_MICROS ?? 200_000) || 0);

function pendingOf(keyId: string) {
  let pending = pendingByKey.get(keyId);
  if (!pending) pendingByKey.set(keyId, pending = { inFlight: 0, costMicros: 0, inputTokens: 0, outputTokens: 0 });
  return pending;
}

function dropIfIdle(keyId: string) {
  const pending = pendingByKey.get(keyId);
  if (pending && pending.inFlight <= 0 && pending.costMicros <= 0 && pending.inputTokens <= 0 && pending.outputTokens <= 0) pendingByKey.delete(keyId);
}

/** Counts a request as running until the returned release is called (once is enough; later calls do nothing). */
export function trackKeyRequest(keyId: string): () => void {
  pendingOf(keyId).inFlight += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    pendingOf(keyId).inFlight -= 1;
    dropIfIdle(keyId);
  };
}

/** Keeps a settlement's usage counted until the write that stores it has finished. */
export async function trackKeySettlement(keyId: string, usage: { inputTokens: number; outputTokens: number; costMicros: number },
  write: () => Promise<void>): Promise<void> {
  const pending = pendingOf(keyId);
  pending.costMicros += usage.costMicros; pending.inputTokens += usage.inputTokens; pending.outputTokens += usage.outputTokens;
  try {
    await write();
  } finally {
    const after = pendingOf(keyId);
    after.costMicros -= usage.costMicros; after.inputTokens -= usage.inputTokens; after.outputTokens -= usage.outputTokens;
    dropIfIdle(keyId);
  }
}

function pendingValue(limit: GatewayApiKeyRecord["limits"][number], pending: ReturnType<typeof pendingOf> | undefined): number {
  if (!pending || limit.modelFilter !== null) return 0;
  switch (limit.limitType) {
    // Every other running request holds a reserve, so parallel requests cannot all pass a nearly spent cost cap.
    case "COST_USD": return pending.costMicros + Math.max(0, pending.inFlight - 1) * costReserveMicros;
    case "TOTAL_TOKENS": return pending.inputTokens + pending.outputTokens;
    case "INPUT_TOKENS": return pending.inputTokens;
    case "OUTPUT_TOKENS": return pending.outputTokens;
    default: return 0;
  }
}

/** Rejects a request once one of the key's limits for this model is used up in its current window, pending usage included. */
export function checkKeyLimits(key: GatewayApiKeyRecord | null, model: string | null, nowIso: string): void {
  if (!key) return;
  const pending = pendingByKey.get(key.id);
  for (const limit of key.limits) {
    if (limit.modelFilter !== null && limit.modelFilter !== model) continue;
    if (limit.resetAt <= nowIso) continue;
    if (limit.currentValue + pendingValue(limit, pending) >= limit.maxValue) {
      const kind = limit.limitType.toLowerCase();
      throw new PolicyRejection(429, gatewayError("rate_limit_exceeded",
        `API key ${kind} ${limit.limitWindow.toLowerCase()} limit exceeded${limit.modelFilter ? ` for model ${limit.modelFilter}` : ""}`, "rate_limit_error"));
    }
  }
}
