/**
 * Google AI (Gemini API) key accounts for `/v1/embeddings` (Space Memory plan clipboard:o7SATwaOHqca): the gateway turns
 * an OpenAI embeddings request into Gemini `batchEmbedContents` and answers in the OpenAI shape, so Space Memory changes
 * only its model id. The key goes in the `x-goog-api-key` header, never in a URL, so it cannot reach a log line.
 */
export const GOOGLE_AI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
export const GOOGLE_AI_KEY_PATTERN = /^AIza[0-9A-Za-z_-]{35}$/;
/** Gemini embedding models served on Google AI key accounts; every other model stays on the OpenAI keys. */
export const GEMINI_EMBEDDING_MODELS = new Set(["gemini-embedding-001"]);
export const GEMINI_TASK_TYPES = new Set(["RETRIEVAL_DOCUMENT", "RETRIEVAL_QUERY", "SEMANTIC_SIMILARITY", "CLASSIFICATION", "CLUSTERING"]);
/** gemini-embedding-001 output sizes; below the full 3072 Google asks callers to normalize the vectors. */
const FULL_DIMENSIONS = 3072;
const MAX_BATCH = 100;

/** Whether a key works: listing one model needs a valid key but spends nothing. */
export async function checkGoogleAiKey(apiKey: string, fetchImpl: typeof fetch = fetch, baseUrl = GOOGLE_AI_BASE_URL): Promise<{ ok: boolean; status: number }> {
  try {
    const response = await fetchImpl(`${baseUrl}/models?pageSize=1`, { headers: { "x-goog-api-key": apiKey }, signal: AbortSignal.timeout(15_000) });
    await response.body?.cancel().catch(() => undefined);
    return { ok: response.ok, status: response.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

export type GeminiEmbeddingRequest = { texts: string[]; dimensions: number | null; taskType: string | null };

/** The OpenAI body's input, dimensions and the gateway's `task_type` extension, or the reason it is refused. */
export function readGeminiEmbeddingRequest(body: Record<string, unknown>): GeminiEmbeddingRequest | { error: string } {
  const texts = typeof body.input === "string" ? [body.input] : Array.isArray(body.input) && body.input.every((item) => typeof item === "string") ? body.input as string[] : null;
  if (!texts || texts.length === 0 || texts.length > MAX_BATCH || texts.some((text) => !text)) return { error: `input must be a non-empty string or 1-${MAX_BATCH} non-empty strings.` };
  const dimensions = body.dimensions === undefined ? null : body.dimensions;
  if (dimensions !== null && (!Number.isInteger(dimensions) || (dimensions as number) < 128 || (dimensions as number) > FULL_DIMENSIONS)) {
    return { error: `dimensions must be a whole number from 128 to ${FULL_DIMENSIONS}.` };
  }
  const taskType = body.task_type === undefined ? null : body.task_type;
  if (taskType !== null && !GEMINI_TASK_TYPES.has(String(taskType))) return { error: `task_type must be one of ${[...GEMINI_TASK_TYPES].join(", ")}.` };
  return { texts, dimensions: dimensions as number | null, taskType: taskType as string | null };
}

const normalize = (values: number[]) => {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return norm > 0 ? values.map((value) => value / norm) : values;
};

/** One `batchEmbedContents` call: the vectors in input order (normalized below 3072 dimensions), or the upstream answer. */
export async function geminiEmbed(apiKey: string, model: string, request: GeminiEmbeddingRequest, options: { fetchImpl?: typeof fetch; baseUrl?: string } = {}):
  Promise<{ ok: true; vectors: number[][]; inputTokens: number | null } | { ok: false; status: number; text: string }> {
  const response = await (options.fetchImpl ?? fetch)(`${options.baseUrl ?? GOOGLE_AI_BASE_URL}/models/${model}:batchEmbedContents`, {
    method: "POST", signal: AbortSignal.timeout(60_000), headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({ requests: request.texts.map((text) => ({ model: `models/${model}`, content: { parts: [{ text }] },
      ...(request.taskType ? { taskType: request.taskType } : {}), ...(request.dimensions ? { outputDimensionality: request.dimensions } : {}) })) })
  });
  const text = await response.text();
  if (!response.ok) return { ok: false, status: response.status, text };
  let payload: { embeddings?: { values?: unknown }[]; usageMetadata?: { promptTokenCount?: unknown } } = {};
  try { payload = JSON.parse(text) as typeof payload; } catch { /* reported as incomplete below */ }
  const vectors = (payload.embeddings ?? []).map((entry) => entry.values);
  if (vectors.length !== request.texts.length || !vectors.every((values): values is number[] => Array.isArray(values) && values.every(Number.isFinite))) {
    return { ok: false, status: 502, text: JSON.stringify({ error: { code: 502, message: "Gemini returned an incomplete embedding batch." } }) };
  }
  const tokens = payload.usageMetadata?.promptTokenCount;
  return { ok: true, vectors: vectors.map((values) => (values.length < FULL_DIMENSIONS ? normalize(values) : values)),
    inputTokens: typeof tokens === "number" ? tokens : null };
}

/** What a failed answer says about the key: a refused key, an empty prepay or billing account, a rate limit, or a provider fault. */
export function classifyGoogleAiFailure(status: number, text: string): "rejected" | "quota" | "rate_limit" | "transient" | "surface" {
  if (status === 401 || status === 403 || /API_KEY_INVALID|API key not valid/i.test(text)) return "rejected";
  if (status === 402 || /prepayment credits|billing/i.test(text)) return "quota";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "transient";
  return "surface";
}

/**
 * How long a rate-limited Google AI key waits: until the next midnight Pacific (when Google resets daily quotas) for a
 * per-day quota, else the answer's RetryInfo delay; null when the answer names neither.
 */
export function googleRetrySeconds(text: string, nowMs = Date.now()): number | null {
  let details: { "@type"?: string; retryDelay?: string; violations?: { quotaId?: string }[] }[] = [];
  try { details = (JSON.parse(text) as { error?: { details?: typeof details } }).error?.details ?? []; } catch { return null; }
  if (details.some((detail) => detail.violations?.some((violation) => /PerDay/i.test(violation.quotaId ?? "")))) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hourCycle: "h23", hour: "numeric", minute: "numeric", second: "numeric" })
      .formatToParts(new Date(nowMs)).map((part) => [part.type, Number(part.value)]));
    return 24 * 3600 - ((parts.hour ?? 0) * 3600 + (parts.minute ?? 0) * 60 + (parts.second ?? 0)) + 60;
  }
  const delay = /^(\d+(?:\.\d+)?)s$/.exec(details.find((detail) => detail.retryDelay)?.retryDelay ?? "")?.[1];
  return delay ? Math.ceil(Number(delay)) : null;
}
