/**
 * ChatGPT usage windows (`/backend-api/wham/usage`), ported from codex-lb `app/core/clients/usage.py` and
 * `app/core/usage/models.py` (MIT, Soju06/codex-lb). Primary = 5h window, secondary = weekly (or monthly).
 */
export const CODEX_UPSTREAM_BASE_URL = "https://chatgpt.com/backend-api";
const USAGE_FETCH_TIMEOUT_MS = 10_000;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const RETRY_START_SECONDS = 0.5;
const RETRY_MAX_SECONDS = 2;

export interface CodexUsageWindow {
  usedPercent: number | null;
  resetAt: number | null;
  limitWindowSeconds: number | null;
  resetAfterSeconds: number | null;
}

export interface CodexUsage {
  planType: string | null;
  workspaceId: string | null;
  workspaceLabel: string | null;
  seatType: string | null;
  primary: CodexUsageWindow | null;
  secondary: CodexUsageWindow | null;
  credits: { hasCredits: boolean | null; unlimited: boolean | null; balance: string | null } | null;
  resetCreditsAvailable: number | null;
  additional: { limitName: string; meteredFeature: string; primary: CodexUsageWindow | null; secondary: CodexUsageWindow | null }[];
}

export class CodexUsageError extends Error {
  constructor(readonly statusCode: number, message: string, readonly code: string | null = null) {
    super(message);
  }
}

type JsonObject = Record<string, unknown>;
const obj = (value: unknown): JsonObject | null => (value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const int = (value: unknown): number | null => { const parsed = num(value); return parsed === null ? null : Math.trunc(parsed); };
const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

function window(value: unknown): CodexUsageWindow | null {
  const record = obj(value);
  if (!record) return null;
  return {
    usedPercent: num(record.used_percent),
    resetAt: int(record.reset_at),
    limitWindowSeconds: int(record.limit_window_seconds),
    resetAfterSeconds: int(record.reset_after_seconds)
  };
}

/**
 * A plan with only a weekly limit (prolite) reports it as the primary window; it goes in the weekly (secondary) slot, so routing
 * and displays never read the week as five hours (niggmopai, 2026-10-27).
 */
export const codexLoneWeek = (primaryMinutes: number | null | undefined, hasSecondary: boolean): boolean => !hasSecondary && (primaryMinutes ?? 0) >= 24 * 60;

export function parseCodexUsage(payload: unknown): CodexUsage {
  const record = obj(payload) ?? {};
  const rateLimit = obj(record.rate_limit);
  const primary = window(rateLimit?.primary_window);
  const secondary = window(rateLimit?.secondary_window);
  const loneWeek = codexLoneWeek(primary?.limitWindowSeconds === null || primary?.limitWindowSeconds === undefined ? null : primary.limitWindowSeconds / 60, Boolean(secondary));
  const credits = obj(record.credits);
  const additional = Array.isArray(record.additional_rate_limits) ? record.additional_rate_limits : [];
  return {
    planType: str(record.plan_type),
    workspaceId: str(record.workspace_id),
    workspaceLabel: str(record.workspace_label),
    seatType: str(record.seat_type),
    primary: loneWeek ? null : primary,
    secondary: loneWeek ? primary : secondary,
    credits: credits ? { hasCredits: bool(credits.has_credits), unlimited: bool(credits.unlimited), balance: str(credits.balance) } : null,
    resetCreditsAvailable: int(obj(record.rate_limit_reset_credits)?.available_count),
    additional: additional.map(obj).filter((item): item is JsonObject => Boolean(item && str(item.limit_name) && str(item.metered_feature)))
      .map((item) => ({
        limitName: str(item.limit_name)!, meteredFeature: str(item.metered_feature)!,
        primary: window(obj(item.rate_limit)?.primary_window), secondary: window(obj(item.rate_limit)?.secondary_window)
      }))
  };
}

/** Headers for ChatGPT backend-api calls; synthetic `email_`/`local_` ids are not sent upstream. */
export function chatgptAuthHeaders(accessToken: string, accountId: string | null, requestId?: string): Record<string, string> {
  const headers: Record<string, string> = { authorization: `Bearer ${accessToken}`, accept: "application/json" };
  if (requestId) headers["x-request-id"] = requestId;
  if (accountId && !accountId.startsWith("email_") && !accountId.startsWith("local_")) headers["chatgpt-account-id"] = accountId;
  return headers;
}

export function codexUsageUrl(baseUrl = CODEX_UPSTREAM_BASE_URL): string {
  let normalized = baseUrl.replace(/\/+$/, "");
  if (!normalized.includes("/backend-api")) normalized = `${normalized}/backend-api`;
  return `${normalized}/wham/usage`;
}

function usageError(payload: JsonObject, status: number): CodexUsageError {
  const error = payload.error;
  const detail = obj(error);
  const message = detail ? str(detail.message) ?? str(detail.error_description)
    : typeof error === "string" ? str(payload.error_description) ?? error : str(payload.message);
  const code = detail && typeof detail.code === "string" ? detail.code.trim().toLowerCase() || null : null;
  return new CodexUsageError(status, message ?? `Usage fetch failed (${status})`, code);
}

export async function fetchCodexUsage(input: {
  accessToken: string; accountId: string | null; baseUrl?: string; maxRetries?: number;
  fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>;
}): Promise<CodexUsage> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const attempts = (input.maxRetries ?? 2) + 1;
  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(codexUsageUrl(input.baseUrl), {
        headers: chatgptAuthHeaders(input.accessToken, input.accountId), signal: AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS)
      });
    } catch (error) {
      if (attempt + 1 < attempts) { await sleep(Math.min(RETRY_MAX_SECONDS, RETRY_START_SECONDS * 2 ** attempt) * 1000); continue; }
      throw new CodexUsageError(0, `Usage fetch failed: ${error instanceof Error ? error.message : "network error"}`);
    }
    if (RETRYABLE_STATUS.has(response.status) && attempt + 1 < attempts) {
      await response.body?.cancel().catch(() => undefined);
      await sleep(Math.min(RETRY_MAX_SECONDS, RETRY_START_SECONDS * 2 ** attempt) * 1000);
      continue;
    }
    const textBody = await response.text();
    let payload: JsonObject;
    try { payload = obj(JSON.parse(textBody)) ?? {}; } catch { payload = { error: { message: textBody.trim().slice(0, 500) } }; }
    if (response.status >= 400) throw usageError(payload, response.status);
    return parseCodexUsage(payload);
  }
}

/** Remaining-percent view used by quota displays: 100 - used, clamped. */
export function remainingPercent(window: CodexUsageWindow | null): number | null {
  return window?.usedPercent === null || window?.usedPercent === undefined ? null : Math.max(0, Math.min(100, 100 - window.usedPercent));
}

export type ResetCreditOutcome = "reset" | "nothing_to_reset" | "no_credit" | "already_redeemed";

/** Spends one weekly limit reset credit (`/wham/rate-limit-reset-credits/consume`); the request id makes retries safe. */
export async function consumeResetCredit(input: {
  accessToken: string; accountId: string | null; redeemRequestId: string; baseUrl?: string; fetchImpl?: typeof fetch;
}): Promise<{ code: ResetCreditOutcome; windowsReset: number }> {
  let base = (input.baseUrl ?? CODEX_UPSTREAM_BASE_URL).replace(/\/+$/, "");
  if (!base.includes("/backend-api")) base = `${base}/backend-api`;
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(`${base}/wham/rate-limit-reset-credits/consume`, {
      method: "POST", signal: AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS), body: JSON.stringify({ redeem_request_id: input.redeemRequestId }),
      headers: { ...chatgptAuthHeaders(input.accessToken, input.accountId), "content-type": "application/json" }
    });
  } catch (error) {
    throw new CodexUsageError(0, `Reset credit request failed: ${error instanceof Error ? error.message : "network error"}`);
  }
  const text = await response.text();
  let payload: JsonObject = {};
  try { payload = obj(JSON.parse(text)) ?? {}; } catch { payload = { error: { message: text.slice(0, 300) } }; }
  if (response.status >= 400) throw usageError(payload, response.status);
  const code = str(payload.code);
  if (code !== "reset" && code !== "nothing_to_reset" && code !== "no_credit" && code !== "already_redeemed") {
    throw new CodexUsageError(502, "Invalid reset credit response.");
  }
  return { code, windowsReset: int(payload.windows_reset) ?? 0 };
}
