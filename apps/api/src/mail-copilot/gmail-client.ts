import { GmailMailboxError } from "../job-apply/gmail-mailbox.js";
import { gmailErrorMessage, gmailRefusal } from "../job-apply/gmail-organize.js";

// The Gmail REST calls the mailbox needs, one client per (owner, account) access token. Every call is one
// HTTPS request with a 20 s timeout; rate limits (429, or 403 with a rate-limit reason) and 5xx answers are retried a few times with backoff.
const gmailApi = "https://gmail.googleapis.com/gmail/v1/users/me";
const RETRIES = 3;

export type GmailJson = Record<string, unknown>;

export interface GmailClient {
  profile(): Promise<{ emailAddress: string; historyId: string }>;
  labels(): Promise<Array<{ id: string; name: string; type: string }>>;
  labelUnread(id: string): Promise<number | null>;
  listThreads(input: { labelIds?: string[]; q?: string; pageToken?: string; maxResults: number }): Promise<{ ids: string[]; nextPageToken: string | null }>;
  thread(id: string, format: "metadata" | "full"): Promise<GmailJson>;
  message(id: string, format: "metadata" | "full" | "raw"): Promise<GmailJson>;
  modifyThread(id: string, change: { addLabelIds: string[]; removeLabelIds: string[] }): Promise<void>;
  modifyMessage(id: string, change: { addLabelIds: string[]; removeLabelIds: string[] }): Promise<void>;
  trashThread(id: string, restore: boolean): Promise<void>;
  send(raw: string, threadId?: string): Promise<{ id: string; threadId: string }>;
  createDraft(raw: string, threadId?: string): Promise<{ id: string; messageId: string }>;
  attachment(messageId: string, attachmentId: string): Promise<Buffer>;
  history(input: { startHistoryId: string; historyTypes?: readonly string[]; labelId?: string; pageToken?: string }): Promise<GmailJson>;
}

export async function mapLimited<T, R>(items: T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createGmailClient(input: { accessToken: string; fetchImpl?: typeof fetch; retryDelayMs?: number }): GmailClient {
  const fetchImpl = input.fetchImpl ?? fetch;
  const retryDelay = input.retryDelayMs ?? 400;
  async function call(path: string, init: { method?: string; body?: unknown } = {}): Promise<GmailJson> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetchImpl(`${gmailApi}${path}`, {
        method: init.method ?? "GET",
        headers: { authorization: `Bearer ${input.accessToken}`, accept: "application/json", ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(20_000)
      });
      const text = await response.text();
      const body = (text ? JSON.parse(text) : {}) as GmailJson;
      if (response.ok) return body;
      const refusal = gmailRefusal(response.status, body);
      if ((refusal === "RATE_LIMIT" || response.status >= 500) && attempt < RETRIES) { await sleep(retryDelay * 2 ** attempt); continue; }
      // Only a scope refusal is a missing grant: Gmail answers its per-user rate limits with 403 too.
      throw new GmailMailboxError(response.status, refusal === "SCOPE" ? "Gmail refused the request: the mailbox needs full Gmail access (Allow full Gmail access in Setup → Accounts)."
        : response.status === 404 ? "Gmail no longer has that message or thread." : gmailErrorMessage(response.status, body));
    }
  }
  const labelIds = (change: { addLabelIds: string[]; removeLabelIds: string[] }) => ({ addLabelIds: change.addLabelIds, removeLabelIds: change.removeLabelIds });
  return {
    async profile() {
      const body = await call("/profile");
      return { emailAddress: String(body.emailAddress ?? ""), historyId: String(body.historyId ?? "") };
    },
    async labels() {
      return ((await call("/labels")).labels as Array<{ id?: string; name?: string; type?: string }> | undefined ?? [])
        .filter((label) => label.id && label.name).map((label) => ({ id: label.id!, name: label.name!, type: label.type ?? "user" }));
    },
    async labelUnread(id) {
      const body = await call(`/labels/${encodeURIComponent(id)}`).catch(() => null);
      const unread = Number(body?.threadsUnread ?? body?.messagesUnread);
      return body && Number.isFinite(unread) ? unread : null;
    },
    async listThreads({ labelIds: labels, q, pageToken, maxResults }) {
      const params = new URLSearchParams({ maxResults: String(maxResults) });
      for (const label of labels ?? []) params.append("labelIds", label);
      if (q) params.set("q", q);
      if (pageToken) params.set("pageToken", pageToken);
      const body = await call(`/threads?${params}`);
      return { ids: ((body.threads as Array<{ id?: unknown }> | undefined) ?? []).map((thread) => thread.id).filter((id): id is string => typeof id === "string"),
        nextPageToken: typeof body.nextPageToken === "string" ? body.nextPageToken : null };
    },
    thread: (id, format) => call(`/threads/${encodeURIComponent(id)}?format=${format}${format === "metadata" ? "&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date" : ""}`),
    message: (id, format) => call(`/messages/${encodeURIComponent(id)}?format=${format}${format === "metadata" ? "&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date" : ""}`),
    async modifyThread(id, change) { await call(`/threads/${encodeURIComponent(id)}/modify`, { method: "POST", body: labelIds(change) }); },
    async modifyMessage(id, change) { await call(`/messages/${encodeURIComponent(id)}/modify`, { method: "POST", body: labelIds(change) }); },
    async trashThread(id, restore) { await call(`/threads/${encodeURIComponent(id)}/${restore ? "untrash" : "trash"}`, { method: "POST" }); },
    async send(raw, threadId) {
      const body = await call("/messages/send", { method: "POST", body: { raw, ...(threadId ? { threadId } : {}) } });
      return { id: String(body.id ?? ""), threadId: String(body.threadId ?? threadId ?? "") };
    },
    async createDraft(raw, threadId) {
      const body = await call("/drafts", { method: "POST", body: { message: { raw, ...(threadId ? { threadId } : {}) } } });
      return { id: String(body.id ?? ""), messageId: String((body.message as { id?: string } | undefined)?.id ?? "") };
    },
    async attachment(messageId, attachmentId) {
      const body = await call(`/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`);
      return Buffer.from(typeof body.data === "string" ? body.data : "", "base64url");
    },
    history({ startHistoryId, historyTypes = ["messageAdded"], labelId, pageToken }) {
      const params = new URLSearchParams({ startHistoryId, maxResults: "500" });
      for (const type of historyTypes) params.append("historyTypes", type);
      if (labelId) params.set("labelId", labelId);
      if (pageToken) params.set("pageToken", pageToken);
      return call(`/history?${params}`);
    }
  };
}
