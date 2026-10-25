import { extractLinks, matches, sourceToText, type MailboxMessageSummary, type MailboxReader, type MailboxSearchFilter } from "./mailbox.js";

// Job Copilot reads the Gmail of its Google account through the owner's Google connector: the API
// holds the token, scans the newest messages and hands the agent codes, links and short snippets,
// exactly as with an IMAP mailbox.
const gmailApi = "https://gmail.googleapis.com/gmail/v1/users/me";
/** Newest messages looked at per read (IMAP scans the newest 80 of the inbox); `since` narrows further. */
const SCAN_LIMIT = 30;
const MAX_RAW_CHARS = 2_000_000;

export class GmailMailboxError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
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

export function openGmailMailbox(input: { accessToken: string; fetchImpl?: typeof fetch; scanLimit?: number }): MailboxReader {
  const fetchImpl = input.fetchImpl ?? fetch;
  async function get(path: string): Promise<Record<string, unknown>> {
    const response = await fetchImpl(`${gmailApi}${path}`, {
      headers: { authorization: `Bearer ${input.accessToken}`, accept: "application/json" }, signal: AbortSignal.timeout(20_000)
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      throw new GmailMailboxError(response.status, response.status === 401 ? "Google access to Gmail expired."
        : response.status === 403 ? "Gmail refused the request: the Gmail API may be off for this server's Google project, or read access was not allowed."
          : `Gmail request failed (${response.status}).`);
    }
    return body;
  }
  type Entry = { receivedAtMs: number; summary: MailboxMessageSummary };
  async function scan(filter: MailboxSearchFilter & { limit: number }): Promise<Entry[]> {
    const query = new URLSearchParams({ q: gmailScanQuery(filter.since), maxResults: String(input.scanLimit ?? SCAN_LIMIT) });
    const list = await get(`/messages?${query}`);
    const ids = ((list.messages as Array<{ id?: unknown }> | undefined) ?? []).map((message) => message.id).filter((id): id is string => typeof id === "string");
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
      .sort((left, right) => right.receivedAtMs - left.receivedAtMs).slice(0, filter.limit);
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

/** Every message matching a Gmail search (pages of 100, at most `max`), with sender, subject, snippet and receipt time. */
export async function searchGmail(input: { accessToken: string; query: string; max: number; fetchImpl?: typeof fetch }): Promise<GmailSearchHit[]> {
  const fetchImpl = input.fetchImpl ?? fetch;
  async function get(path: string): Promise<Record<string, unknown>> {
    const response = await fetchImpl(`${gmailApi}${path}`, {
      headers: { authorization: `Bearer ${input.accessToken}`, accept: "application/json" }, signal: AbortSignal.timeout(20_000)
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new GmailMailboxError(response.status, response.status === 401 ? "Google access to Gmail expired." : `Gmail request failed (${response.status}).`);
    return body;
  }
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ q: input.query, maxResults: String(Math.min(100, input.max - ids.length)), ...(pageToken ? { pageToken } : {}) });
    const page = await get(`/messages?${params}`);
    for (const message of (page.messages as Array<{ id?: unknown }> | undefined) ?? []) if (typeof message.id === "string") ids.push(message.id);
    pageToken = typeof page.nextPageToken === "string" ? page.nextPageToken : undefined;
  } while (pageToken && ids.length < input.max);
  return mapLimited(ids, 8, async (id): Promise<GmailSearchHit> => {
    const message = await get(`/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`);
    const headers = (message.payload as { headers?: unknown } | undefined)?.headers;
    const received = Number(message.internalDate);
    return { messageId: id, from: header(headers, "from"), subject: header(headers, "subject"),
      snippet: decodeEntities(typeof message.snippet === "string" ? message.snippet : ""), receivedAt: Number.isFinite(received) && received > 0 ? new Date(received).toISOString() : null };
  });
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
