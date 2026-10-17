import { createHash } from "node:crypto";

// OpenAI Live keeps working when the selected model does not (operator
// decision 2026-10-13). A delegated model counts as working only after a real
// Responses call with the session's effort and web search succeeds; otherwise
// the first fallback that succeeds is used. A failed selection is retried after
// FAILURE_TTL_MS, so it returns as soon as it works again.
export const DELEGATED_FALLBACK_MODELS = ["gpt-5.5", "gpt-5.4-mini", "gpt-5-mini"];
// gpt-live-1 first, then the GA Realtime models, newest first.
export const VOICE_FALLBACK_MODELS = ["gpt-live-1", "gpt-realtime-2.1", "gpt-realtime-2", "gpt-realtime"];
// Realtime models reject the GPT-Live-only voices (gleam, bossa, tempo).
const REALTIME_VOICES = new Set(["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"]);
const REALTIME_FALLBACK_VOICE = "marin";

const SUCCESS_TTL_MS = 6 * 60 * 60_000;
const REFRESH_AFTER_MS = 60 * 60_000;
const FAILURE_TTL_MS = 10 * 60_000;
const VERIFY_TIMEOUT_MS = 8_000;
// A session waits at most this long for the first check of its selected model (operator decision 2026-10-14);
// the check finishes in the background and decides the next session.
export const COLD_CHECK_WAIT_MS = 2_000;

export type DelegatedEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export interface LiveModelFallback { kind: "voice" | "delegated"; requested: string; used: string; reason: string }

// "minimal" asks for the fastest delegated reasoning. OpenAI rejects it for
// gpt-5.1 and later (their lowest is "none"), for o-series models and together
// with web_search, and GPT-Live then fails the whole session, so send the
// lowest effort the delegated model accepts.
export function delegatedReasoningEffort(model: string, requested: Exclude<DelegatedEffort, "none"> | undefined, webSearch: boolean): DelegatedEffort {
  const effort = requested || "minimal";
  if (effort !== "minimal") return effort;
  if (/^gpt-5\.\d/.test(model)) return "none";
  return webSearch || /^o\d/.test(model) ? "low" : "minimal";
}

export function isGptLiveModel(model: string) {
  return model.startsWith("gpt-live-") && model !== "gpt-live-transcribe";
}

/** The requested conversational model first, then the fallbacks. */
export function voiceModelCandidates(requested: string) {
  return [requested, ...VOICE_FALLBACK_MODELS.filter(model => model !== requested)];
}

export function voiceForModel(model: string, voice: string) {
  return isGptLiveModel(model) || REALTIME_VOICES.has(voice) ? voice : REALTIME_FALLBACK_VOICE;
}

/** Only an unknown, inaccessible or failing model moves to the next one; quota and request errors do not. */
export function voiceModelUnavailable(status: number, message: string) {
  if (status === 429 || /insufficient_quota|credit_balance_exhausted/.test(message)) return false;
  return status === 403 || status === 404 || status >= 500 || /model_not_found|invalid_model|does not exist|do not have access/i.test(message);
}

type Verdict = { works: boolean; reason: string; at: number };
const verdicts = new Map<string, Verdict>();
const pending = new Map<string, Promise<Verdict | null>>();

export function clearDelegatedModelVerdicts() {
  verdicts.clear();
  pending.clear();
}

async function verify(baseUrl: string, apiKey: string, model: string, effort: DelegatedEffort, webSearch: boolean, fetchImpl: typeof fetch): Promise<Verdict | null> {
  try {
    const response = await fetchImpl(`${baseUrl}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model, input: "Reply with OK.", max_output_tokens: 16, store: false,
        reasoning: { effort }, ...(webSearch ? { tools: [{ type: "web_search" }] } : {})
      }),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS)
    });
    if (response.ok) return { works: true, reason: "", at: Date.now() };
    const text = await response.text();
    let reason = `HTTP ${response.status}`;
    try { reason = (JSON.parse(text) as { error?: { message?: string } }).error?.message || reason; } catch {}
    if (response.status === 401) throw new Error(`OpenAI rejected the Live API key: ${reason}`);
    if (response.status === 429 && /insufficient_quota|credit_balance_exhausted|quota/i.test(text)) {
      throw new Error("OpenAI API quota or credit balance exhausted. Please verify API key credits in the active organization.");
    }
    // Rate limits and outages say nothing about the model; do not switch on them.
    if (response.status === 429 || response.status >= 500) return null;
    return { works: false, reason, at: Date.now() };
  } catch (error) {
    if (error instanceof Error && /^OpenAI /.test(error.message)) throw error;
    return null;
  }
}

async function works(baseUrl: string, apiKey: string, model: string, effort: DelegatedEffort, webSearch: boolean, fetchImpl: typeof fetch, waitMs?: number) {
  const key = `${createHash("sha256").update(apiKey).digest("hex").slice(0, 16)}|${model}|${effort}|${webSearch}`;
  const known = verdicts.get(key);
  const age = known ? Date.now() - known.at : Infinity;
  const check = () => {
    let running = pending.get(key);
    if (!running) {
      running = verify(baseUrl, apiKey, model, effort, webSearch, fetchImpl)
        .then(verdict => { if (verdict) verdicts.set(key, verdict); return verdict; })
        .finally(() => pending.delete(key));
      pending.set(key, running);
    }
    return running;
  };
  if (known?.works && age < SUCCESS_TTL_MS) {
    if (age > REFRESH_AFTER_MS) void check().catch(() => undefined);
    return known;
  }
  if (known && !known.works && age < FAILURE_TTL_MS) return known;
  if (waitMs === undefined) return check();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // null is "unverifiable", so the selection is used as selected.
  return Promise.race([check(), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), waitMs); })])
    .finally(() => clearTimeout(timer));
}

/**
 * Picks the delegated model and effort for a GPT-Live session: the selected
 * model when it works, else the first working fallback. An unverifiable
 * selection (timeout, outage, rate limit) is used as selected.
 */
export async function resolveDelegatedModel(input: {
  baseUrl: string; apiKey: string; model: string; effort?: Exclude<DelegatedEffort, "none">; webSearch: boolean; fetchImpl?: typeof fetch;
}): Promise<{ model: string; effort: DelegatedEffort; fallback?: LiveModelFallback }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const effort = delegatedReasoningEffort(input.model, input.effort, input.webSearch);
  const selected = await works(input.baseUrl, input.apiKey, input.model, effort, input.webSearch, fetchImpl, COLD_CHECK_WAIT_MS);
  if (!selected || selected.works) return { model: input.model, effort };
  for (const model of DELEGATED_FALLBACK_MODELS.filter(candidate => candidate !== input.model)) {
    const candidateEffort = delegatedReasoningEffort(model, input.effort, input.webSearch);
    const verdict = await works(input.baseUrl, input.apiKey, model, candidateEffort, input.webSearch, fetchImpl);
    if (verdict?.works) return { model, effort: candidateEffort, fallback: { kind: "delegated", requested: input.model, used: model, reason: selected.reason } };
  }
  return { model: input.model, effort };
}
