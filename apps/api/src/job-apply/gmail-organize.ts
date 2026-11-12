import { JOB_APPLY_MAIL_LABELS, JOB_APPLY_MAIL_LEGACY_OTHER_LABEL, JOB_APPLY_MAIL_ROOT_LABEL, type JobApplyMailCategory } from "@space/contracts";
import { messageText } from "../dot-connectors.js";
import { GmailMailboxError } from "./gmail-mailbox.js";
import { maskPasswordResetJson } from "../password-reset-mask.js";

// Job Copilot files application emails under Gmail labels with the gmail.modify grant (MAIL_ORGANIZE): it
// creates the "Job Applications" labels, files a whole thread under one and, for confirmations and rejections, takes
// it out of the inbox. Mail is never trashed or deleted from here.
const gmailApi = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface GmailTriageMessage {
  messageId: string;
  threadId: string;
  from: string;
  subject: string;
  snippet: string;
  receivedAt: string | null;
  labelIds: string[];
  /** The message has a List-Unsubscribe header (mailing lists, job alerts). */
  listUnsubscribe?: boolean;
}

// Gmail answers per-user rate limits with 403 as well as 429; only these reasons mean a missing grant.
const scopeReasons = new Set(["insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT", "forbidden"]);
const rateLimitReasons = new Set(["userRateLimitExceeded", "rateLimitExceeded", "RATE_LIMIT_EXCEEDED", "dailyLimitExceeded"]);

/** Gmail's own reason and message from an error body (bounded; Gmail error bodies carry no tokens). */
export function gmailErrorDetail(body: Record<string, unknown>): { reason: string | null; message: string | null } {
  const error = body.error as { message?: unknown; status?: unknown; errors?: Array<{ reason?: unknown }> } | undefined;
  const reason = [error?.errors?.[0]?.reason, error?.status].find((value) => typeof value === "string" && value) as string | undefined;
  return { reason: reason ?? null, message: typeof error?.message === "string" ? error.message.slice(0, 200) : null };
}

/** A per-user rate limit (403 or 429) or a missing grant (403 with a scope reason or none); null for anything else. */
export function gmailRefusal(status: number, body: Record<string, unknown>): "RATE_LIMIT" | "SCOPE" | null {
  const { reason } = gmailErrorDetail(body);
  if (status === 429 || (status === 403 && reason && rateLimitReasons.has(reason))) return "RATE_LIMIT";
  return status === 403 && (!reason || scopeReasons.has(reason)) ? "SCOPE" : null;
}

export function gmailErrorMessage(status: number, body: Record<string, unknown>): string {
  const { reason, message } = gmailErrorDetail(body);
  const detail = [reason, message].filter(Boolean).join(": ");
  const refusal = gmailRefusal(status, body);
  if (status === 401) return "Google access to Gmail expired.";
  if (refusal === "RATE_LIMIT") return `Gmail rate limit reached (${detail}); try again in a minute.`;
  if (refusal === "SCOPE") {
    return `Gmail refused the request: organizing mail needs the gmail.modify permission (Allow Gmail & Calendar again)${detail ? ` [${detail}]` : ""}.`;
  }
  return `Gmail request failed (${status})${detail ? `: ${detail}` : ""}.`;
}

/** One Gmail REST call with the token (one retry on a per-user rate limit). */
export function jobGmailCall(accessToken: string, fetchImpl: typeof fetch = fetch, retryDelayMs = 1500) {
  return async function call(path: string, init: { method?: string; body?: unknown } = {}): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      const response = await fetchImpl(`${gmailApi}${path}`, {
        method: init.method ?? "GET",
        headers: { authorization: `Bearer ${accessToken}`, accept: "application/json", ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(20_000)
      });
      const text = await response.text();
      let body: Record<string, unknown> = {};
      try { body = maskPasswordResetJson((text ? JSON.parse(text) : {}) as Record<string, unknown>); } catch { body = {}; }
      if (response.ok) return body;
      // One retry for a per-user rate limit: these clear within seconds (a triage pass just before can trip them).
      if (attempt === 0 && gmailRefusal(response.status, body) === "RATE_LIMIT") {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        continue;
      }
      throw new GmailMailboxError(response.status, gmailErrorMessage(response.status, body));
    }
  };
}

export function gmailHeader(headers: unknown, name: string): string {
  const found = Array.isArray(headers) ? headers.find((item: { name?: string }) => item?.name?.toLowerCase() === name) as { value?: string } | undefined : undefined;
  return found?.value ?? "";
}

export interface JobApplyLabelIds {
  ids: Record<JobApplyMailCategory, string>;
  /** Every label under "Job Applications/" (the legacy Other and any the operator made there too): exclusive on a thread. */
  all: string[];
  /** "Job Applications/Other" while it still exists (filed before 3/11). */
  legacyOther: string | null;
}

const JOB_LABEL_PREFIX = `${JOB_APPLY_MAIL_ROOT_LABEL}/`.toLowerCase();
/** The ids of every label named "Job Applications/…" among a mailbox's labels. */
export function jobLabelIdsOf(labels: ReadonlyArray<{ id?: string; name?: string }>): string[] {
  return labels.filter((label) => label.id && label.name?.toLowerCase().startsWith(JOB_LABEL_PREFIX)).map((label) => label.id!);
}

/**
 * A thread carries at most one Job Applications label (operator 3/11, Kraken: one rejection under both Other and Rejections): a change
 * that adds one takes every other one off in the same write. Job Copilot's filing and the Mail Copilot's label, move and modify both apply it.
 */
export function exclusiveJobLabels(change: { addLabelIds: string[]; removeLabelIds: string[] }, jobLabelIds: readonly string[]): { addLabelIds: string[]; removeLabelIds: string[] } {
  const keep = change.addLabelIds.filter((id) => jobLabelIds.includes(id)).at(-1);
  if (!keep) return change;
  return { addLabelIds: change.addLabelIds.filter((id) => !jobLabelIds.includes(id) || id === keep),
    removeLabelIds: [...new Set([...change.removeLabelIds, ...jobLabelIds])].filter((id) => id !== keep) };
}

/** Label ids of the Job Copilot labels, created on first use (parent first, so Gmail nests them). */
export async function ensureJobApplyLabels(input: { accessToken: string; fetchImpl?: typeof fetch }): Promise<JobApplyLabelIds> {
  const call = jobGmailCall(input.accessToken, input.fetchImpl);
  const listed = ((await call("/labels")).labels as Array<{ id?: string; name?: string }> | undefined ?? []).filter((label) => label.id && label.name);
  const existing = new Map(listed.map((label) => [label.name!.toLowerCase(), label.id!]));
  const ids = new Map<string, string>();
  for (const name of [JOB_APPLY_MAIL_ROOT_LABEL, ...Object.values(JOB_APPLY_MAIL_LABELS)]) {
    let id = existing.get(name.toLowerCase());
    if (!id) {
      const created = await call("/labels", { method: "POST", body: { name, labelListVisibility: "labelShow", messageListVisibility: "show" } });
      id = String(created.id ?? "");
      if (!id) throw new GmailMailboxError(502, `Gmail did not create the label ${name}.`);
      listed.push({ id, name });
    }
    ids.set(name, id);
  }
  return { ids: { CONFIRMATION: ids.get(JOB_APPLY_MAIL_LABELS.CONFIRMATION)!, REJECTION: ids.get(JOB_APPLY_MAIL_LABELS.REJECTION)!, ACTION_NEEDED: ids.get(JOB_APPLY_MAIL_LABELS.ACTION_NEEDED)! },
    all: jobLabelIdsOf(listed), legacyOther: existing.get(JOB_APPLY_MAIL_LEGACY_OTHER_LABEL.toLowerCase()) ?? null };
}

/**
 * Files whole threads under one Job Applications label (null takes every one off) and, with `archive`, out of the inbox: one
 * threads.modify each, every other Job Applications label off in the same write (`exclusiveJobLabels`). Never deletes.
 */
export async function fileGmailThreads(input: { accessToken: string; fetchImpl?: typeof fetch; threadIds: readonly string[]; labelId: string | null; archive: boolean; jobLabelIds: readonly string[] }): Promise<void> {
  const inbox = input.archive ? ["INBOX"] : [];
  const change = input.labelId ? exclusiveJobLabels({ addLabelIds: [input.labelId], removeLabelIds: inbox }, input.jobLabelIds) : { addLabelIds: [], removeLabelIds: [...inbox, ...input.jobLabelIds] };
  if (!change.addLabelIds.length && !change.removeLabelIds.length) return;
  const call = jobGmailCall(input.accessToken, input.fetchImpl);
  for (const threadId of new Set(input.threadIds)) {
    // No empty arrays: the body carries only what changes.
    await call(`/threads/${encodeURIComponent(threadId)}/modify`, { method: "POST", body: { ...(change.addLabelIds.length ? { addLabelIds: change.addLabelIds } : {}), ...(change.removeLabelIds.length ? { removeLabelIds: change.removeLabelIds } : {}) } });
  }
}

/** The thread of each message (the copilot names messages; labels go on threads). */
export async function gmailThreadIds(input: { accessToken: string; fetchImpl?: typeof fetch; messageIds: readonly string[] }): Promise<string[]> {
  const call = jobGmailCall(input.accessToken, input.fetchImpl);
  const threads: string[] = [];
  for (const id of input.messageIds) {
    const message = await call(`/messages/${encodeURIComponent(id)}?format=minimal`);
    threads.push(typeof message.threadId === "string" && message.threadId ? message.threadId : id);
  }
  return [...new Set(threads)];
}

/** Takes the given labels off messages; the inbox and every other label stay as they are. Never deletes. */
export async function unlabelGmailMessages(input: { accessToken: string; fetchImpl?: typeof fetch; messageIds: string[]; labelIds: string[]; retryDelayMs?: number }): Promise<void> {
  if (!input.messageIds.length || !input.labelIds.length) return;
  // No empty addLabelIds: the body carries only what changes.
  await jobGmailCall(input.accessToken, input.fetchImpl, input.retryDelayMs)("/messages/batchModify", { method: "POST",
    body: { ids: input.messageIds, removeLabelIds: input.labelIds } });
}

/** Inbox messages matching a Gmail search, newest first, with their labels (at most `max`). */
/** Messages matching the search (or any of several searches, each message once), with their metadata; at most `max`. */
export async function listGmailTriageMessages(input: { accessToken: string; fetchImpl?: typeof fetch; query: string | readonly string[]; max: number; labelId?: string }): Promise<GmailTriageMessage[]> {
  const call = jobGmailCall(input.accessToken, input.fetchImpl);
  const found = new Set<string>();
  // Every page of each search up to `max` (until 31/10 one page of 100: a search with more matches lost the rest).
  for (const query of typeof input.query === "string" ? [input.query] : input.query) {
    for (let pageToken: string | undefined; found.size < input.max; ) {
      const list = await call(`/messages?${new URLSearchParams({ q: query, maxResults: String(Math.min(500, input.max - found.size)), ...(input.labelId ? { labelIds: input.labelId } : {}), ...(pageToken ? { pageToken } : {}) })}`);
      for (const message of (list.messages as Array<{ id?: unknown }> | undefined) ?? []) if (typeof message.id === "string") found.add(message.id);
      pageToken = typeof list.nextPageToken === "string" ? list.nextPageToken : undefined;
      if (!pageToken) break;
    }
  }
  const ids = [...found].slice(0, input.max);
  const messages: GmailTriageMessage[] = [];
  for (const id of ids) {
    const message = await call(`/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=List-Unsubscribe`);
    const headers = (message.payload as { headers?: unknown } | undefined)?.headers;
    const received = Number(message.internalDate);
    messages.push({ messageId: id, threadId: typeof message.threadId === "string" && message.threadId ? message.threadId : id, from: gmailHeader(headers, "from"), subject: gmailHeader(headers, "subject"),
      snippet: typeof message.snippet === "string" ? message.snippet : "",
      receivedAt: Number.isFinite(received) && received > 0 ? new Date(received).toISOString() : null,
      labelIds: Array.isArray(message.labelIds) ? message.labelIds.filter((label): label is string => typeof label === "string") : [],
      listUnsubscribe: gmailHeader(headers, "list-unsubscribe") !== "" });
  }
  return messages;
}

/** The text of one message (plain part, or the HTML part as text), capped for classification. */
export async function gmailMessageText(input: { accessToken: string; fetchImpl?: typeof fetch; messageId: string; max: number }): Promise<string> {
  const message = await jobGmailCall(input.accessToken, input.fetchImpl)(`/messages/${encodeURIComponent(input.messageId)}?format=full`);
  return messageText(message.payload as Record<string, unknown> | undefined, input.max).text;
}
