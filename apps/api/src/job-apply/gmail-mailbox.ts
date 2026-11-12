import { extractLinks, matches, sourceToText, type MailboxMessageSummary, type MailboxReader, type MailboxSearchFilter } from "./mailbox.js";
import { maskPasswordResetJson } from "../password-reset-mask.js";

// Job Copilot reads the Gmail of its Google account through the owner's Google connector: the API
// holds the token, scans the newest messages and hands the agent codes, links and short snippets,
// exactly as with an IMAP mailbox.
const gmailApi = "https://gmail.googleapis.com/gmail/v1/users/me";
/** Technical: Gmail lists at most 500 message ids a page. */
const GMAIL_PAGE = 500;
const MAX_RAW_CHARS = 2_000_000;

export class GmailMailboxError extends Error {
  /** `rateLimited`: Gmail's rate or quota limit, still answered after the retries. */
  constructor(readonly status: number, message: string, readonly rateLimited = false) { super(message); }
}

function header(headers: unknown, name: string): string {
  const found = Array.isArray(headers) ? headers.find((item: { name?: string }) => item?.name?.toLowerCase() === name) as { value?: string } | undefined : undefined;
  return found?.value ?? "";
}
/** `Name <address>` becomes the address, as IMAP envelopes report it. */
function address(from: string): string {
  return (from.match(/<([^>]+)>/)?.[1] ?? from).trim();
}
/** Gmail's `snippet` field is HTML-escaped ("You&#39;re"); this gives back the text. */
export function decodeEntities(text: string): string {
  return text.replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}
async function mapLimited<T, R>(items: T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await map(items[index]!);
    }
  }));
  return results;
}

/** Everything except sent mail, drafts and chats (Gmail leaves spam and trash out by itself), from a minute before `since`. */
export function gmailScanQuery(since?: string | null): string {
  const at = since ? Date.parse(since) : Number.NaN;
  return ["-in:sent", "-in:drafts", "-in:chats", ...(Number.isFinite(at) ? [`after:${Math.floor(at / 1000) - 60}`] : [])].join(" ");
}

export function openGmailMailbox(input: { accessToken: string; fetchImpl?: typeof fetch }): MailboxReader {
  const fetchImpl = input.fetchImpl ?? fetch;
  async function get(path: string): Promise<Record<string, unknown>> {
    const response = await fetchImpl(`${gmailApi}${path}`, {
      headers: { authorization: `Bearer ${input.accessToken}`, accept: "application/json" }, signal: AbortSignal.timeout(20_000)
    });
    const body = maskPasswordResetJson(await response.json().catch(() => ({})) as Record<string, unknown>);
    if (!response.ok) {
      throw new GmailMailboxError(response.status, response.status === 401 ? "Google access to Gmail expired."
        : response.status === 403 ? "Gmail refused the request: the Gmail API may be off for this server's Google project, or read access was not allowed."
          : `Gmail request failed (${response.status}).`);
    }
    return body;
  }
  type Entry = { receivedAtMs: number; summary: MailboxMessageSummary };
  async function scan(filter: MailboxSearchFilter & { limit?: number }): Promise<Entry[]> {
    const limit = filter.limit ?? Infinity;
    // Gmail searches the whole mailbox for the sender and subject, page by page, until `limit` messages are found (until 31/10 the
    // newest 30 messages were read and filtered here, so an older match was never seen).
    const words = (field: string, value: string | null | undefined) => value?.trim() ? [`${field}:"${value.trim().replace(/"/g, "")}"`] : [];
    const q = [gmailScanQuery(filter.since), ...words("from", filter.fromContains), ...words("subject", filter.subjectContains)].join(" ");
    const ids: string[] = [];
    for (let pageToken: string | undefined; ids.length < limit; ) {
      const list = await get(`/messages?${new URLSearchParams({ q, maxResults: String(Math.min(GMAIL_PAGE, limit - ids.length)), ...(pageToken ? { pageToken } : {}) })}`);
      ids.push(...((list.messages as Array<{ id?: unknown }> | undefined) ?? []).map((message) => message.id).filter((id): id is string => typeof id === "string"));
      pageToken = typeof list.nextPageToken === "string" ? list.nextPageToken : undefined;
      if (!pageToken) break;
    }
    const since = filter.since ? Date.parse(filter.since) : Number.NaN;
    const entries = await mapLimited(ids, 5, async (id): Promise<Entry> => {
      const message = await get(`/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`);
      const headers = (message.payload as { headers?: unknown } | undefined)?.headers;
      const receivedAtMs = Number(message.internalDate);
      return { receivedAtMs: Number.isFinite(receivedAtMs) ? receivedAtMs : 0, summary: {
        messageId: id, from: address(header(headers, "from")), subject: header(headers, "subject"),
        receivedAt: Number.isFinite(receivedAtMs) && receivedAtMs > 0 ? new Date(receivedAtMs).toISOString() : null,
        snippet: decodeEntities(typeof message.snippet === "string" ? message.snippet : "").slice(0, 300)
      } };
    });
    return entries.filter((entry) => (!Number.isFinite(since) || entry.receivedAtMs >= since) && matches(entry.summary, filter))
      .sort((left, right) => right.receivedAtMs - left.receivedAtMs).slice(0, filter.limit ?? undefined);
  }
  return {
    async recent(filter) {
      return (await scan(filter)).map((entry) => entry.summary);
    },
    async texts(filter) {
      return mapLimited(await scan(filter), 5, async ({ summary }) => {
        const message = await get(`/messages/${encodeURIComponent(summary.messageId!)}?format=raw`);
        const source = Buffer.from(typeof message.raw === "string" ? message.raw : "", "base64url").toString("utf8").slice(0, MAX_RAW_CHARS);
        const text = sourceToText(source);
        return { ...summary, snippet: text.slice(0, 300), text: `${text}\n${extractLinks(source).join("\n")}` };
      });
    },
    async close() { /* nothing to release: every read is one HTTPS request */ }
  };
}

export interface GmailSearchHit { messageId: string; from: string; subject: string; snippet: string; receivedAt: string | null }
/** The hits a search could read, and how many message reads still failed after their retries (with the last error). */
export interface GmailSearchResult { hits: GmailSearchHit[]; failed: number; failedError: GmailMailboxError | null }

// Gmail's per-user quota (15,000 units a minute; a list or a get costs 5) is shared with every Space job on the account:
// a search paces itself at 100 units a second and waits out a rate limit (31/10: a burst of gets answered 403
// "Quota exceeded ... per minute per user" and the whole account's search was lost).
const GMAIL_UNIT_COST = 5;
const GMAIL_UNITS_PER_SECOND = 100;
const GMAIL_RETRIES = 4;
const GMAIL_MAX_WAIT_MS = 60_000;

/** A 429, or a 403 whose error names a rate or quota limit (not a permission error). */
export function gmailRateLimited(status: number, body: unknown): boolean {
  if (status === 429) return true;
  if (status !== 403) return false;
  const error = (body as { error?: { errors?: Array<{ reason?: unknown }>; message?: unknown; status?: unknown } } | null)?.error;
  return Boolean(error?.errors?.some((item) => /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/.test(String(item?.reason ?? "")))
    || /quota exceeded|rate limit/i.test(String(error?.message ?? "")) || error?.status === "RESOURCE_EXHAUSTED");
}
/** Retry-After in seconds or as an HTTP date, in milliseconds from `nowMs`. */
function retryAfterMs(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}
const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Every message matching a Gmail search (pages of 100, at most `max`), with sender, subject, snippet and receipt time.
 * Requests are paced per search and a rate-limited one is retried (Retry-After, else 2, 4, 8, 16 s). A listing page that
 * still fails throws; a message that still fails is counted in `failed`, so the caller knows the hits are incomplete.
 */
export async function searchGmail(input: { accessToken: string; query: string; max: number; fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>; unitsPerSecond?: number }): Promise<GmailSearchResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleep = input.sleep ?? realSleep;
  const spacingMs = GMAIL_UNIT_COST * 1000 / (input.unitsPerSecond ?? GMAIL_UNITS_PER_SECOND);
  let nextSlot = 0;
  async function paced(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, nextSlot);
    nextSlot = at + spacingMs;
    if (at > now) await sleep(at - now);
  }
  async function get(path: string): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt += 1) {
      await paced();
      const response = await fetchImpl(`${gmailApi}${path}`, {
        headers: { authorization: `Bearer ${input.accessToken}`, accept: "application/json" }, signal: AbortSignal.timeout(20_000)
      });
      const body = maskPasswordResetJson(await response.json().catch(() => ({})) as Record<string, unknown>);
      if (response.ok) return body;
      if (gmailRateLimited(response.status, body) && attempt < GMAIL_RETRIES) {
        const wait = retryAfterMs(response.headers.get("retry-after"), Date.now()) ?? 2000 * 2 ** attempt;
        const until = Date.now() + Math.min(wait, GMAIL_MAX_WAIT_MS);
        nextSlot = Math.max(nextSlot, until);  // the other reads of this search wait too
        await sleep(until - Date.now());
        continue;
      }
      const limited = gmailRateLimited(response.status, body);
      throw new GmailMailboxError(response.status, response.status === 401 ? "Google access to Gmail expired."
        : limited ? `Gmail rate limit (${response.status}) after ${GMAIL_RETRIES} retries.` : `Gmail request failed (${response.status}).`, limited);
    }
  }
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ q: input.query, maxResults: String(Math.min(100, input.max - ids.length)), ...(pageToken ? { pageToken } : {}) });
    const page = await get(`/messages?${params}`);
    for (const message of (page.messages as Array<{ id?: unknown }> | undefined) ?? []) if (typeof message.id === "string") ids.push(message.id);
    pageToken = typeof page.nextPageToken === "string" ? page.nextPageToken : undefined;
  } while (pageToken && ids.length < input.max);
  let failed = 0;
  let failedError: GmailMailboxError | null = null;
  const read = await mapLimited(ids, 4, async (id): Promise<GmailSearchHit | null> => {
    try {
      const message = await get(`/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`);
      const headers = (message.payload as { headers?: unknown } | undefined)?.headers;
      const received = Number(message.internalDate);
      return { messageId: id, from: header(headers, "from"), subject: header(headers, "subject"),
        snippet: decodeEntities(typeof message.snippet === "string" ? message.snippet : ""), receivedAt: Number.isFinite(received) && received > 0 ? new Date(received).toISOString() : null };
    } catch (error) {
      if (error instanceof GmailMailboxError && error.status === 401) throw error;
      failed += 1;
      failedError = error instanceof GmailMailboxError ? error : new GmailMailboxError(0, error instanceof Error ? error.message : "Gmail request failed.");
      return null;
    }
  });
  return { hits: read.filter((hit): hit is GmailSearchHit => hit !== null), failed, failedError };
}

/** Confirmation mail of applicant tracking systems and job boards, or any subject about an application (one Gmail OR group). */
export const CONFIRMATION_SEARCH_TERMS = ["from:greenhouse-mail.io", "from:greenhouse.io", "from:ashbyhq.com", "from:jobs-noreply@linkedin.com", "from:lever.co",
  "from:myworkday.com", "from:smartrecruiters.com", "from:icims.com", "from:workablemail.com", "subject:application", "subject:applying", "subject:applied"].join(" ");

const fillerWords = new Set(["and", "the", "inc", "ltd", "llc", "gmbh", "co", "corp", "limited", "pte", "plc", "ag", "sa", "hq"]);
/**
 * Letters and digits of a company name without filler words, for loose comparisons. "and" also goes from inside
 * joined tokens, so "Qube Research & Technologies" and the board token "quberesearchandtechnologies" agree.
 */
export function companyKey(text: string): string {
  return text.toLowerCase().replace(/&/g, " and ").split(/[^a-z0-9]+/).filter((word) => word && !fillerWords.has(word)).join("").replace(/and/g, "");
}
const appliedToPattern = /(?:applying (?:to|at|for)|application (?:to|at|with|for)|application was sent to|applied to|applied at|interest in)\s+(?:the\s+)?(?:[^!.,|\n]*?\s+(?:role|position) at\s+)?([^!.,|\n]{2,80})/gi;
/** The companies a confirmation email names ("Thank you for applying to Databricks", "your application was sent to Conquer AI"). */
export function confirmedCompanies(hit: Pick<GmailSearchHit, "subject" | "snippet">): string[] {
  return [...`${hit.subject}\n${hit.snippet}`.matchAll(appliedToPattern)].map((match) => companyKey(match[1]!)).filter((key) => key.length >= 4);
}
/**
 * The confirmation email of one sent application: it names the application's company (either contains the other,
 * so "SE Conquer AI" matches "Conquer AI") and arrived between two days before and seven days after it was sent.
 */
export function matchConfirmationEmail<T extends Pick<GmailSearchHit, "subject" | "snippet" | "receivedAt">>(
  application: { company: string; appliedAt: string | null }, hits: T[]): T | null {
  const key = companyKey(application.company);
  const sent = application.appliedAt ? Date.parse(application.appliedAt) : Number.NaN;
  if (key.length < 4 || !Number.isFinite(sent)) return null;
  return hits.filter((hit) => {
    const at = hit.receivedAt ? Date.parse(hit.receivedAt) : Number.NaN;
    return Number.isFinite(at) && at >= sent - 2 * 86_400_000 && at <= sent + 7 * 86_400_000
      && confirmedCompanies(hit).some((company) => key.includes(company) || company.includes(key));
  }).sort((left, right) => Date.parse(left.receivedAt!) - Date.parse(right.receivedAt!))[0] ?? null;
}
