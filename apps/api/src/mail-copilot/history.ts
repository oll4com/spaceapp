import type { MailOperatorAction } from "@space/contracts";

// Gmail history (users.history.list) as operator actions: what happened to each conversation in Gmail web, on the
// phone or in any other client since the last sync, net per thread, classified the way the pane's own actions are.

interface GmailHistoryMessage { id?: string; threadId?: string; labelIds?: string[] }
/** One history record, the parts Mail Copilot reads. */
export interface GmailHistoryEntry {
  id?: string | number;
  messagesAdded?: Array<{ message?: GmailHistoryMessage }>;
  messagesDeleted?: Array<{ message?: GmailHistoryMessage }>;
  labelsAdded?: Array<{ message?: GmailHistoryMessage; labelIds?: string[] }>;
  labelsRemoved?: Array<{ message?: GmailHistoryMessage; labelIds?: string[] }>;
}

export interface ThreadChange {
  threadId: string;
  messageIds: string[];
  /** Labels added and removed over the records, net: added then removed again cancels out (an undo). */
  added: string[];
  removed: string[];
  /** A message of the thread was deleted for good (emptied from Trash, or deleted outright). */
  deleted: boolean;
  /** Messages the account sent in the thread (not drafts). */
  sent: string[];
}

const USER_LABEL = /^Label_\d+$/;

export function netThreadChanges(entries: readonly GmailHistoryEntry[]): ThreadChange[] {
  const threads = new Map<string, { messageIds: Set<string>; added: Set<string>; removed: Set<string>; deleted: boolean; sent: string[] }>();
  const thread = (message: GmailHistoryMessage | undefined) => {
    if (!message?.id || !message.threadId) return null;
    let entry = threads.get(message.threadId);
    if (!entry) threads.set(message.threadId, entry = { messageIds: new Set(), added: new Set(), removed: new Set(), deleted: false, sent: [] });
    entry.messageIds.add(message.id);
    return entry;
  };
  for (const entry of entries) {
    for (const { message } of entry.messagesAdded ?? []) {
      const labels = message?.labelIds ?? [];
      if (labels.includes("SENT") && !labels.includes("DRAFT")) thread(message)?.sent.push(message!.id!);
    }
    for (const { message, labelIds } of entry.labelsAdded ?? []) {
      const change = thread(message);
      for (const label of change ? labelIds ?? [] : []) if (!change!.removed.delete(label)) change!.added.add(label);
    }
    for (const { message, labelIds } of entry.labelsRemoved ?? []) {
      const change = thread(message);
      for (const label of change ? labelIds ?? [] : []) if (!change!.added.delete(label)) change!.removed.add(label);
    }
    for (const { message } of entry.messagesDeleted ?? []) {
      // Gmail replaces a draft's message on every edit; a deleted draft is no deleted mail.
      if (message?.labelIds?.includes("DRAFT")) continue;
      const change = thread(message);
      if (change) change.deleted = true;
    }
  }
  return [...threads].map(([threadId, change]) => ({ threadId, messageIds: [...change.messageIds], added: [...change.added], removed: [...change.removed], deleted: change.deleted, sent: change.sent }));
}

/**
 * The operator actions behind one thread's net change. Read marks, importance and categories are Gmail's own
 * bookkeeping (opening a message, automatic sorting) and say nothing. A change that adds one of `ignoredLabels`
 * (Job Copilot's filing labels) is Space's own work. A sent message reads as REPLY here; the caller tells a
 * forward or a new message apart from the thread.
 */
export function classifyThreadChange(change: ThreadChange, ignoredLabels: ReadonlySet<string> = new Set()): Array<{ action: MailOperatorAction; labelIds: string[] }> {
  if (change.deleted) return [{ action: "DELETE", labelIds: [] }];
  const added = new Set(change.added);
  const removed = new Set(change.removed);
  if ([...added].some((label) => ignoredLabels.has(label))) return [];
  const userAdded = [...added].filter((label) => USER_LABEL.test(label));
  const userRemoved = [...removed].filter((label) => USER_LABEL.test(label));
  const actions: Array<{ action: MailOperatorAction; labelIds: string[] }> = [];
  if (added.has("TRASH")) actions.push({ action: "TRASH", labelIds: [] });
  else if (removed.has("TRASH")) actions.push({ action: "UNTRASH", labelIds: [] });
  if (added.has("SPAM")) actions.push({ action: "SPAM", labelIds: [] });
  else if (removed.has("SPAM")) actions.push({ action: "NOT_SPAM", labelIds: [] });
  const leftInbox = removed.has("INBOX") && !added.has("TRASH") && !added.has("SPAM");
  if (leftInbox) actions.push(userAdded.length ? { action: "MOVE", labelIds: userAdded } : { action: "ARCHIVE", labelIds: [] });
  else if (added.has("INBOX") && !removed.has("TRASH") && !removed.has("SPAM")) actions.push({ action: "UNARCHIVE", labelIds: [] });
  if (!leftInbox && userAdded.length) actions.push({ action: "LABEL", labelIds: userAdded });
  if (userRemoved.length) actions.push({ action: "UNLABEL", labelIds: userRemoved });
  if (added.has("STARRED")) actions.push({ action: "STAR", labelIds: [] });
  else if (removed.has("STARRED")) actions.push({ action: "UNSTAR", labelIds: [] });
  if (change.sent.length) actions.push({ action: "REPLY", labelIds: [] });
  return actions;
}
