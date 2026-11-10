import { JOB_APPLY_MAIL_LEGACY_OTHER_LABEL, JOB_APPLY_MAIL_ROOT_LABEL, type JobApplyMailCategory } from "@space/contracts";
import { fileGmailThreads, gmailHeader, gmailMessageText, jobGmailCall, type JobApplyLabelIds } from "./gmail-organize.js";
import { classifyApplicationMail } from "./mail-triage.js";

export interface JobMailLabelCleanup {
  account: string;
  /** Threads that were under Job Applications/Other. */
  other: number;
  /** Threads under two or more Job Applications labels besides Other. */
  multiLabel: number;
  rejections: number;
  confirmations: number;
  actionNeeded: number;
  /** Nothing placed them and only Other was on: the label came off, the inbox state stayed. */
  unlabelled: number;
  /** Nothing placed them: the label of their newest labelled message stayed, the others came off. */
  kept: number;
  /** In the trash or spam: only Other came off. */
  trashOrSpam: number;
  otherDeleted: boolean;
}

const COUNTED: Record<JobApplyMailCategory, "rejections" | "confirmations" | "actionNeeded"> = { REJECTION: "rejections", CONFIRMATION: "confirmations", ACTION_NEEDED: "actionNeeded" };
type GmailMessage = { id?: string; labelIds?: string[]; internalDate?: string; snippet?: string; payload?: { headers?: unknown } };

/**
 * One-off repair of the mail filed before 3/11 (operator 3/11 «γιατί υπάρχει το label Other???», Kraken under Other and Rejections):
 * every thread under the legacy "Job Applications/Other" or under two or more Job Applications labels is read again (its newest mail
 * not sent from the account) and filed as the rules say now, under one label: a rejection or a receipt archived as the triage does, a
 * test or interview under Action needed. Anything the rules do not place keeps the label of its newest labelled message, or with only
 * Other just loses it, its inbox state unchanged. Once Other holds nothing the label goes (labels only: no mail is deleted). Null when
 * the mailbox has no Other label: the triage calls it every pass, so a failed run continues on the next one.
 */
export async function cleanupJobMailLabels(input: { accessToken: string; fetchImpl?: typeof fetch; account: string; labels: JobApplyLabelIds; nowMs: number }): Promise<JobMailLabelCleanup | null> {
  const legacy = input.labels.legacyOther;
  if (!legacy) return null;
  const call = jobGmailCall(input.accessToken, input.fetchImpl);
  const threadsUnder = async (labelId: string): Promise<Set<string>> => {
    const ids = new Set<string>();
    for (let pageToken: string | undefined; ;) {
      const page = await call(`/threads?${new URLSearchParams({ labelIds: labelId, includeSpamTrash: "true", maxResults: "500", ...(pageToken ? { pageToken } : {}) })}`);
      for (const thread of (page.threads as Array<{ id?: unknown }> | undefined) ?? []) if (typeof thread.id === "string") ids.add(thread.id);
      pageToken = typeof page.nextPageToken === "string" ? page.nextPageToken : undefined;
      if (!pageToken) break;
    }
    return ids;
  };
  const under = new Map<string, Set<string>>();
  for (const labelId of input.labels.all) under.set(labelId, await threadsUnder(labelId));
  const others = under.get(legacy) ?? new Set<string>();
  const labelCount = (threadId: string) => [...under].filter(([labelId, threads]) => labelId !== legacy && threads.has(threadId)).length;
  const current = new Set(Object.values(input.labels.ids));
  const result: JobMailLabelCleanup = { account: input.account, other: 0, multiLabel: 0, rejections: 0, confirmations: 0, actionNeeded: 0, unlabelled: 0, kept: 0, trashOrSpam: 0, otherDeleted: false };
  const file = (threadId: string, labelId: string | null, archive: boolean, jobLabelIds = input.labels.all) =>
    fileGmailThreads({ accessToken: input.accessToken, fetchImpl: input.fetchImpl, threadIds: [threadId], labelId, archive, jobLabelIds });
  const candidates = new Set([...others, ...[...under.values()].flatMap((threads) => [...threads]).filter((threadId) => labelCount(threadId) >= 2)]);
  for (const threadId of candidates) {
    if (others.has(threadId)) result.other += 1;
    if (labelCount(threadId) >= 2) result.multiLabel += 1;
    const thread = await call(`/threads/${encodeURIComponent(threadId)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=List-Unsubscribe`);
    const messages = ((thread.messages as GmailMessage[] | undefined) ?? []).sort((left, right) => Number(right.internalDate ?? 0) - Number(left.internalDate ?? 0));
    const labelsOf = (message: GmailMessage) => message.labelIds ?? [];
    if (messages.some((message) => labelsOf(message).includes("TRASH") || labelsOf(message).includes("SPAM"))) {
      await file(threadId, null, false, [legacy]);
      result.trashOrSpam += 1;
      continue;
    }
    const newest = messages.find((message) => !labelsOf(message).includes("SENT") && !labelsOf(message).includes("DRAFT"));
    let category: JobApplyMailCategory | "NONE" | null = "NONE";
    if (newest?.id) {
      const headers = newest.payload?.headers;
      const received = Number(newest.internalDate);
      const text = await gmailMessageText({ accessToken: input.accessToken, fetchImpl: input.fetchImpl, messageId: newest.id, max: 6000 }).catch(() => newest.snippet ?? "");
      category = classifyApplicationMail({ from: gmailHeader(headers, "from"), subject: gmailHeader(headers, "subject"), text,
        receivedAt: Number.isFinite(received) && received > 0 ? new Date(received).toISOString() : null, listUnsubscribe: gmailHeader(headers, "list-unsubscribe") !== "" }, input.nowMs);
    }
    if (category && category !== "NONE") {
      await file(threadId, input.labels.ids[category], category === "CONFIRMATION" || category === "REJECTION");
      result[COUNTED[category]] += 1;
      continue;
    }
    const keep = messages.flatMap(labelsOf).find((labelId) => current.has(labelId));
    if (keep) {
      await file(threadId, keep, false);
      result.kept += 1;
    } else {
      await file(threadId, null, false, [legacy]);
      result.unlabelled += 1;
    }
  }
  if (!(await threadsUnder(legacy)).size) {
    await call(`/labels/${encodeURIComponent(legacy)}`, { method: "DELETE" });
    result.otherDeleted = true;
  }
  return result;
}

/** The cleanup's line in the Job Copilot's activity. */
export function cleanupNote(cleanup: JobMailLabelCleanup): string {
  const placed = [[cleanup.rejections, "Rejections"], [cleanup.confirmations, "Confirmations"], [cleanup.actionNeeded, "Action needed"]]
    .filter(([count]) => count).map(([count, label]) => `${count} → ${label}`);
  return [`Cleaned the ${JOB_APPLY_MAIL_ROOT_LABEL} labels of ${cleanup.account}: ${cleanup.other} thread${cleanup.other === 1 ? "" : "s"} under Other, ${cleanup.multiLabel} under two or more labels`,
    placed.length ? `; filed ${placed.join(", ")}` : "",
    cleanup.unlabelled ? `; ${cleanup.unlabelled} left where they were without a label` : "",
    cleanup.kept ? `; ${cleanup.kept} kept their newest label` : "",
    cleanup.trashOrSpam ? `; ${cleanup.trashOrSpam} in the trash or spam lost Other` : "",
    cleanup.otherDeleted ? `. Deleted the empty label ${JOB_APPLY_MAIL_LEGACY_OTHER_LABEL} (no mail deleted).` : `. ${JOB_APPLY_MAIL_LEGACY_OTHER_LABEL} still holds mail; the next pass continues.`].join("");
}
