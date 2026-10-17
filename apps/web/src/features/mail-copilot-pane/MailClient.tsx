import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { MAIL_SYSTEM_LABELS, mailCopilotConsentUrl, type MailAccountSummary, type MailComposeInput, type MailMessage, type MailThreadAction, type MailThreadSummary } from "@space/contracts";
import { api } from "../../api.js";
// The icon pack has no reply/forward glyphs: Undo2 reads as reply, ChevronRight as forward, Mail as the inbox.
import { Archive, ArrowLeft, Bot, Check, ChevronDown, ChevronRight, ChevronUp, Folder, Mail, Paperclip, Pencil, RefreshCw, Search, Send, Star, Trash2, Undo2, X } from "../ui-theme/app-icons.js";
import type { MailboxState } from "./useMailbox.js";

const SYSTEM_LABEL_ICONS: Partial<Record<string, typeof Mail>> = { INBOX: Mail, STARRED: Star, SENT: Send, DRAFT: Pencil, TRASH: Trash2, ALL: Archive };
const ACCOUNT_COLORS = ["#6db7aa", "#8fb8f0", "#f0c36b", "#d49cf0", "#f08a8a", "#9adf9a"];

export function accountColor(email: string, accounts: ReadonlyArray<Pick<MailAccountSummary, "email">>): string {
  const index = accounts.findIndex((account) => account.email === email);
  return ACCOUNT_COLORS[(index < 0 ? 0 : index) % ACCOUNT_COLORS.length]!;
}

export function mailTime(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const at = new Date(iso);
  const sameDay = at.toDateString() === new Date(now).toDateString();
  if (sameDay) return at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const days = (now - at.getTime()) / 86_400_000;
  if (days < 7) return at.toLocaleDateString([], { weekday: "short" });
  return at.toLocaleDateString([], { month: "short", day: "numeric", ...(at.getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" } : {}) });
}

export function participantLabel(participant: { name: string; address: string }): string {
  return participant.name || participant.address || "Unknown sender";
}

// Hues that stay clear on the dark surfaces (no olive or brown yellows), as in the Google account menu.
const AVATAR_HUES = [205, 225, 255, 280, 310, 335, 165, 185, 145, 10, 25, 350];
/** A stable hue per sender, so the same person keeps the same avatar color everywhere. */
export function senderHue(participant: { name: string; address: string }): number {
  let hash = 0;
  for (const char of (participant.address || participant.name).toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AVATAR_HUES[hash % AVATAR_HUES.length]!;
}

/** First letter of the sender's name (or address), for the avatar. */
export function senderInitial(participant: { name: string; address: string }): string {
  return (participant.name || participant.address).replace(/^["'\s]+/, "").charAt(0).toUpperCase() || "?";
}

function SenderAvatar({ participant, account, accountTone, size = "md", checked = false }: { participant: { name: string; address: string }; account?: string; accountTone?: string; size?: "md" | "sm"; checked?: boolean }) {
  return (
    <span className={`mc-avatar${size === "sm" ? " sm" : ""}${checked ? " checked" : ""}`} style={{ "--avatar-hue": senderHue(participant) } as CSSProperties} aria-hidden="true">
      {checked ? <Check /> : senderInitial(participant)}
      {accountTone ? <span className="mc-avatar-account" style={{ background: accountTone }} title={account} /> : null}
    </span>
  );
}

/** The reply addresses of a message: Reply-To or From; reply-all adds the other recipients except our account. */
export function replyRecipients(message: MailMessage, all: boolean): { to: string[]; cc: string[] } {
  const to = (message.replyTo.length ? message.replyTo : [message.from]).map((entry) => entry.address).filter(Boolean);
  if (!all) return { to, cc: [] };
  const mine = message.account.toLowerCase();
  const others = [...message.to, ...message.cc].map((entry) => entry.address).filter((address) => address && address.toLowerCase() !== mine && !to.includes(address));
  return { to, cc: [...new Set(others)] };
}

function quoted(message: MailMessage): string {
  const when = message.receivedAt ? new Date(message.receivedAt).toLocaleString() : "";
  return `\n\nOn ${when}, ${participantLabel(message.from)} wrote:\n${message.text.split("\n").map((line) => `> ${line}`).join("\n")}`;
}

export type ComposeMode = { kind: "new" } | { kind: "reply" | "replyAll" | "forward"; message: MailMessage };

export function composeDraft(mode: ComposeMode, account: string, signature: string | null): Omit<MailComposeInput, "account"> & { account: string } {
  const sign = signature ? `\n\n${signature}` : "";
  if (mode.kind === "new") return { account, to: [], cc: [], bcc: [], subject: "", text: sign.trimStart() ? sign : "" };
  const { message } = mode;
  const subject = message.subject.replace(/^(\s*(re|fwd?)\s*:\s*)+/i, "");
  if (mode.kind === "forward") {
    return { account: message.account, to: [], cc: [], bcc: [], subject: `Fwd: ${subject}`, text: `${sign}\n\n---------- Forwarded message ----------\nFrom: ${participantLabel(message.from)} <${message.from.address}>\nSubject: ${message.subject}\n\n${message.text}` };
  }
  const recipients = replyRecipients(message, mode.kind === "replyAll");
  return { account: message.account, to: recipients.to, cc: recipients.cc, bcc: [], subject: `Re: ${subject}`, text: `${sign}${quoted(message)}`,
    threadId: message.threadId, inReplyToMessageId: message.messageId };
}

function parseAddresses(text: string): string[] {
  return text.split(/[,;\s]+/).map((value) => value.trim()).filter((value) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)).slice(0, 50);
}

export function Composer({ mode, accounts, defaultAccount, signature, paneId, onClose, onSent }: {
  mode: ComposeMode;
  accounts: MailAccountSummary[];
  defaultAccount: string;
  signature: string | null;
  paneId: string;
  onClose(): void;
  onSent(result: { messageId: string; threadId: string }): void;
}) {
  const fieldId = useId();
  const [draft, setDraft] = useState(() => composeDraft(mode, defaultAccount, signature));
  const [to, setTo] = useState(draft.to.join(", "));
  const [cc, setCc] = useState(draft.cc.join(", "));
  const [bcc, setBcc] = useState(draft.bcc.join(", "));
  const [showCc, setShowCc] = useState(draft.cc.length > 0);
  const [busy, setBusy] = useState<"send" | "draft" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const senders = accounts.filter((account) => account.access === "full" && account.inPane);
  const title = mode.kind === "new" ? "New message" : mode.kind === "forward" ? "Forward" : mode.kind === "replyAll" ? "Reply all" : "Reply";

  const input = (): MailComposeInput | null => {
    const recipients = parseAddresses(to);
    if (!recipients.length) { setError("Add at least one recipient."); return null; }
    return { account: draft.account, to: recipients, cc: parseAddresses(cc), bcc: parseAddresses(bcc), subject: draft.subject, text: draft.text,
      ...(draft.threadId ? { threadId: draft.threadId } : {}), ...(draft.inReplyToMessageId ? { inReplyToMessageId: draft.inReplyToMessageId } : {}) };
  };
  async function submit(event: FormEvent) {
    event.preventDefault();
    const message = input();
    if (!message || busy) return;
    setBusy("send");
    setError(null);
    try {
      onSent(await api.sendMail(paneId, message));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The message could not be sent.");
      setBusy(null);
    }
  }
  async function saveDraft() {
    const message = input();
    if (!message || busy) return;
    setBusy("draft");
    setError(null);
    try {
      await api.saveMailDraft(paneId, message);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The draft could not be saved.");
      setBusy(null);
    }
  }

  return (
    <form className="mc-composer" aria-label={title} onSubmit={(event) => void submit(event)}>
      <header className="mc-composer-head">
        <button type="button" className="jc-icon-button" aria-label="Close composer" title="Close" onClick={onClose}><X aria-hidden="true" /></button>
        <strong>{title}</strong>
        <button type="button" className="jc-button ghost" disabled={busy !== null || !senders.length} onClick={() => void saveDraft()}>{busy === "draft" ? "Saving…" : "Save draft"}</button>
        <button type="submit" className="jc-button primary mc-send" disabled={busy !== null || !senders.length}><Send aria-hidden="true" /> {busy === "send" ? "Sending…" : "Send"}</button>
      </header>
      {!senders.length ? <p className="jc-muted mc-composer-hint">Sending needs full Gmail access on an account.</p> : null}
      {error ? <p className="jc-message" role="alert">{error}</p> : null}
      {/* Rows are divs: the shell styles every input inside a <label> as a boxed field. */}
      <div className="mc-composer-fields">
        <div className="mc-composer-row"><label htmlFor={`${fieldId}-from`}>From</label>
          <select id={`${fieldId}-from`} value={draft.account} aria-label="From account" disabled={mode.kind !== "new" || busy !== null} onChange={(event) => setDraft({ ...draft, account: event.target.value })}>
            {senders.map((account) => <option key={account.email} value={account.email}>{account.email}</option>)}
            {!senders.some((account) => account.email === draft.account) ? <option value={draft.account}>{draft.account}</option> : null}
          </select>
        </div>
        <div className="mc-composer-row"><label htmlFor={`${fieldId}-to`}>To</label>
          <input id={`${fieldId}-to`} value={to} aria-label="To" placeholder="name@example.com, other@example.com" disabled={busy !== null} onChange={(event) => setTo(event.target.value)} />
          {!showCc ? <button type="button" className="mc-cc-toggle" onClick={() => setShowCc(true)}>Cc / Bcc</button> : null}
        </div>
        {showCc ? (
          <>
            <div className="mc-composer-row"><label htmlFor={`${fieldId}-cc`}>Cc</label><input id={`${fieldId}-cc`} value={cc} aria-label="Cc" disabled={busy !== null} onChange={(event) => setCc(event.target.value)} /></div>
            <div className="mc-composer-row"><label htmlFor={`${fieldId}-bcc`}>Bcc</label><input id={`${fieldId}-bcc`} value={bcc} aria-label="Bcc" disabled={busy !== null} onChange={(event) => setBcc(event.target.value)} /></div>
          </>
        ) : null}
        <div className="mc-composer-row">
          <input value={draft.subject} aria-label="Subject" placeholder="Subject" disabled={busy !== null} onChange={(event) => setDraft({ ...draft, subject: event.target.value })} />
        </div>
      </div>
      <textarea className="mc-composer-body" value={draft.text} aria-label="Message" placeholder="Write your message" rows={12} disabled={busy !== null} onChange={(event) => setDraft({ ...draft, text: event.target.value })} />
    </form>
  );
}

function MessageCard({ message, expanded, onToggle, onReply, onForward, paneId, onLoadImages }: {
  message: MailMessage; expanded: boolean; onToggle(): void; onReply(all: boolean): void; onForward(): void; paneId: string; onLoadImages(): void;
}) {
  return (
    <article className={`mc-message${expanded ? " expanded" : ""}${message.unread ? " unread" : ""}`} aria-label={`Message from ${participantLabel(message.from)}`}>
      <header className="mc-message-head" onClick={onToggle}>
        <SenderAvatar participant={message.from} size="sm" />
        <div className="mc-message-from">
          <strong>{participantLabel(message.from)}</strong>
          <small className="jc-muted">{message.from.address}{message.to.length ? ` · to ${message.to.map(participantLabel).join(", ")}` : ""}</small>
        </div>
        <time className="jc-muted" dateTime={message.receivedAt ?? undefined} title={message.receivedAt ?? undefined}>{mailTime(message.receivedAt)}</time>
        {expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
      </header>
      {expanded ? (
        <>
          {message.html ? (
            <iframe className="mc-message-html" title={`Message from ${participantLabel(message.from)}`} sandbox="" referrerPolicy="no-referrer"
              srcDoc={`<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>body{margin:12px;font:14px/1.5 system-ui,sans-serif;color:#1c1c1c;background:#fff;word-break:break-word}img{max-width:100%;height:auto}img[data-blocked-src]{display:none}blockquote{border-left:3px solid #ccc;margin:8px 0;padding-left:10px;color:#555}pre{white-space:pre-wrap}</style></head><body>${message.html}</body></html>`} />
          ) : <pre className="mc-message-text">{message.text}</pre>}
          {message.blockedImages ? <p className="mc-message-note jc-muted">Remote images are not loaded. <button type="button" className="jc-button ghost" onClick={onLoadImages}>Load images</button></p> : null}
          {message.attachments.filter((attachment) => !attachment.contentId || attachment.filename).length ? (
            <ul className="mc-attachments" aria-label="Attachments">
              {message.attachments.map((attachment) => (
                <li key={attachment.attachmentId}>
                  <a className="jc-button" href={api.mailAttachmentUrl(paneId, message.account, message.messageId, attachment.attachmentId)} download={attachment.filename}>
                    <Paperclip aria-hidden="true" /> {attachment.filename} <small className="jc-muted">{attachment.size ? `${Math.max(1, Math.round(attachment.size / 1024))} KB` : ""}</small>
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="mc-message-actions">
            <button type="button" className="jc-button" onClick={() => onReply(false)}><Undo2 aria-hidden="true" /> Reply</button>
            {message.to.length + message.cc.length > 1 ? <button type="button" className="jc-button" onClick={() => onReply(true)}><Undo2 aria-hidden="true" /> Reply all</button> : null}
            <button type="button" className="jc-button" onClick={onForward}><ChevronRight aria-hidden="true" /> Forward</button>
          </div>
        </>
      ) : <p className="mc-message-snippet jc-muted">{message.text.replace(/\s+/g, " ").slice(0, 160)}</p>}
    </article>
  );
}

const LIST_MIN = 260;
const THREAD_MIN = 320;
const listWidthKey = (paneId: string) => `space:mail-copilot:list-width:${paneId}`;
function readListWidth(paneId: string): number | null {
  try {
    const value = Number(window.localStorage.getItem(listWidthKey(paneId)));
    return Number.isFinite(value) && value >= LIST_MIN ? value : null;
  } catch {
    return null;
  }
}
/** The list width a pane keeps, kept inside the room the client has (the conversation keeps at least THREAD_MIN). */
export function clampListWidth(width: number, clientWidth: number): number {
  return Math.round(Math.max(LIST_MIN, Math.min(width, Math.max(LIST_MIN, clientWidth - THREAD_MIN))));
}

/** How far a row must travel (share of its width) before letting go archives or trashes it. */
const SWIPE_COMMIT = 0.32;
const UNDO_MS = 6_000;
type RowAction = "archive" | "trash";
interface Undo { rows: MailThreadSummary[]; action: RowAction; at: number }
const rowKey = (row: Pick<MailThreadSummary, "account" | "threadId">) => `${row.account}:${row.threadId}`;

/**
 * The mailbox: one header row (search, refresh, account), label chips, the thread list with a floating Compose
 * button, and the open conversation. Narrow panes show one column at a time like the Gmail phone app; there a row
 * swipes sideways to archive it (or move it to trash outside the inbox), and every removal can be undone. Tapping a
 * sender avatar selects its conversation; the selection bar then acts on all of them at once.
 */
export function MailClient({ paneId, mailbox, signature, stacked }: { paneId: string; mailbox: MailboxState; signature: string | null; stacked: boolean }) {
  const { accounts, labels, threads, thread, selection, selectedThreadId } = mailbox;
  const [compose, setCompose] = useState<ComposeMode | null>(null);
  // Which messages are open; a conversation starts with only its newest message expanded.
  const [expandedState, setExpandedState] = useState<{ threadId: string; ids: Set<string> } | null>(null);
  const newestId = thread?.messages[thread.messages.length - 1]?.messageId ?? null;
  const expanded = expandedState && expandedState.threadId === thread?.threadId ? expandedState.ids : new Set(newestId ? [newestId] : []);
  const toggleExpanded = (messageId: string) => setExpandedState(() => {
    const next = new Set(expanded);
    if (next.has(messageId)) next.delete(messageId); else next.add(messageId);
    return { threadId: thread?.threadId ?? "", ids: next };
  });
  const [search, setSearch] = useState(selection.query);
  const [busyThread, setBusyThread] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [swipe, setSwipe] = useState<{ threadId: string; dx: number } | null>(null);
  const gesture = useRef<{ threadId: string; x: number; y: number; width: number; horizontal: boolean | null; pointerId: number } | null>(null);
  const swipedRef = useRef(false);
  const usable = useMemo(() => accounts.filter((account) => account.inPane && account.access !== "none"), [accounts]);
  const defaultAccount = selection.account !== "all" ? selection.account : usable.find((account) => account.access === "full")?.email ?? usable[0]?.email ?? "";
  const listRef = useRef<HTMLDivElement | null>(null);
  const clientRef = useRef<HTMLDivElement | null>(null);
  // Wide panes: the list/conversation split is dragged (or moved with the arrow keys) and remembered per pane.
  const [listWidth, setListWidth] = useState<number | null>(() => readListWidth(paneId));
  const [resizing, setResizing] = useState(false);
  const resizeStart = useRef<{ x: number; width: number } | null>(null);
  const saveListWidth = useCallback((width: number | null) => {
    try {
      if (width === null) window.localStorage.removeItem(listWidthKey(paneId)); else window.localStorage.setItem(listWidthKey(paneId), String(width));
    } catch {
      // Preference storage is optional.
    }
  }, [paneId]);
  const clientWidth = () => clientRef.current?.getBoundingClientRect().width || window.innerWidth;
  const currentListWidth = () => listWidth ?? (listRef.current?.parentElement?.getBoundingClientRect().width || clampListWidth(clientWidth() * 0.4, clientWidth()));
  const onSplitterDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    resizeStart.current = { x: event.clientX, width: currentListWidth() };
    setResizing(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onSplitterMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = resizeStart.current;
    if (!start) return;
    setListWidth(clampListWidth(start.width + event.clientX - start.x, clientWidth()));
  };
  const onSplitterEnd = () => {
    if (!resizeStart.current) return;
    resizeStart.current = null;
    setResizing(false);
    setListWidth((width) => { saveListWidth(width); return width; });
  };
  const onSplitterKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 16;
    const delta = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const next = clampListWidth(event.key === "Home" ? LIST_MIN : Number.MAX_SAFE_INTEGER, clientWidth());
      setListWidth(next);
      saveListWidth(next);
      return;
    }
    if (!delta) return;
    event.preventDefault();
    const next = clampListWidth(currentListWidth() + delta, clientWidth());
    setListWidth(next);
    saveListWidth(next);
  };
  // Outside the inbox a row is removed by moving it to trash; Trash itself restores instead.
  const removeAction: RowAction = selection.labelId === "INBOX" ? "archive" : "trash";
  const canRemove = selection.labelId !== "TRASH";

  useEffect(() => {
    if (!undo) return;
    const timer = window.setTimeout(() => setUndo((current) => current === undo ? null : current), UNDO_MS);
    return () => window.clearTimeout(timer);
  }, [undo]);

  // Conversations picked with their avatar; the search bar turns into their action bar.
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  const checkedRows = threads.filter((row) => checked.has(rowKey(row)));
  const toggleChecked = (row: MailThreadSummary) => setChecked((current) => {
    const next = new Set(current);
    if (!next.delete(rowKey(row))) next.add(rowKey(row));
    return next;
  });
  useEffect(() => setChecked(new Set()), [selection.account, selection.labelId, selection.query]);
  // The query also changes from outside (Show this mail, Open conversation): the box shows what filters the list.
  useEffect(() => setSearch(selection.query), [selection.query]);

  const act = useCallback(async (target: MailThreadSummary | MailThreadSummary[], action: MailThreadAction["action"], labelIds?: string[]) => {
    const rows = Array.isArray(target) ? target : [target];
    if (busyThread || !rows.length) return;
    setNotice(null);
    // A move leaves the inbox; in any other label the conversation stays where it is.
    const leaves = action === "archive" || action === "trash" || action === "untrash" || action === "unarchive" || (action === "move" && selection.labelId === "INBOX");
    const done: MailThreadSummary[] = [];
    let failure: string | null = null;
    // shortcut: one request per conversation in turn (keeps under Gmail's per-user rate limit); add a batch route if selections grow past a page.
    for (const row of rows) {
      setBusyThread(row.threadId);
      try {
        await api.modifyMailThread(paneId, row.threadId, { account: row.account, action, ...(labelIds ? { labelIds } : {}) });
        done.push(row);
        if (leaves) mailbox.removeThread(row.threadId);
        else if (action === "star" || action === "unstar") mailbox.patchThread(row.threadId, { starred: action === "star" });
        else if (action === "read" || action === "unread") mailbox.patchThread(row.threadId, { unread: action === "unread" });
      } catch (caught) {
        failure = caught instanceof Error ? caught.message : "The action failed.";
      }
    }
    setBusyThread(null);
    if (failure) setNotice(rows.length > 1 ? `${rows.length - done.length} of ${rows.length} conversations failed: ${failure}` : failure);
    if (!done.length) return;
    if (leaves) setChecked((current) => new Set([...current].filter((key) => !done.some((row) => rowKey(row) === key))));
    if (action === "archive" || action === "trash") setUndo({ rows: done, action, at: Date.now() });
    if (leaves && action !== "untrash" && action !== "unarchive" && done.some((row) => row.threadId === selectedThreadId)) void mailbox.openThread(null);
  }, [busyThread, mailbox, paneId, selectedThreadId, selection.labelId]);

  // "Send to AI": the copilot checks and fixes what a mail needs; an optional note says what to look at.
  const [fixFor, setFixFor] = useState<MailThreadSummary | null>(null);
  const [fixNote, setFixNote] = useState("");
  const [fixBusy, setFixBusy] = useState(false);
  const sendToAi = async () => {
    if (!fixFor || fixBusy) return;
    setFixBusy(true);
    try {
      const result = await api.requestMailFix(paneId, { account: fixFor.account, threadId: fixFor.threadId, ...(fixNote.trim() ? { note: fixNote.trim() } : {}) });
      setNotice(result.runStarted ? "Sent to the copilot: it checks and fixes what this mail needs." : "Sent to the copilot. Press Start (with its terminal open) so it can work on it.");
      setFixFor(null);
      setFixNote("");
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "The mail could not be sent to the copilot.");
    } finally {
      setFixBusy(false);
    }
  };

  const undoLast = useCallback(async () => {
    const last = undo;
    if (!last) return;
    setUndo(null);
    try {
      for (const row of last.rows) await api.modifyMailThread(paneId, row.threadId, { account: row.account, action: last.action === "archive" ? "unarchive" : "untrash" });
      await mailbox.refresh();
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "The action could not be undone.");
    }
  }, [mailbox, paneId, undo]);

  const open = useCallback(async (row: MailThreadSummary) => {
    // A swipe ends with a click on the row; it must not open the conversation.
    if (swipedRef.current) { swipedRef.current = false; return; }
    await mailbox.openThread(row);
    // Opening marks the thread read, like any mail client; the account needs full access for that.
    if (row.unread && accounts.find((account) => account.email === row.account)?.access === "full") {
      mailbox.patchThread(row.threadId, { unread: false });
      void api.modifyMailThread(paneId, row.threadId, { account: row.account, action: "read" }).catch(() => undefined);
    }
  }, [accounts, mailbox, paneId]);

  // Sideways swipes on phones; vertical movement stays a scroll (rows use touch-action: pan-y).
  const onRowPointerDown = (row: MailThreadSummary, event: ReactPointerEvent<HTMLDivElement>) => {
    if (!stacked || !canRemove || event.pointerType === "mouse" || busyThread) return;
    gesture.current = { threadId: row.threadId, x: event.clientX, y: event.clientY, width: event.currentTarget.getBoundingClientRect().width || 320, horizontal: null, pointerId: event.pointerId };
  };
  const onRowPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (current.horizontal === null && Math.hypot(dx, dy) > 8) {
      current.horizontal = Math.abs(dx) > Math.abs(dy) * 1.2;
      if (current.horizontal) event.currentTarget.setPointerCapture?.(event.pointerId);
      else gesture.current = null;
    }
    if (current.horizontal) setSwipe({ threadId: current.threadId, dx });
  };
  const onRowPointerEnd = (row: MailThreadSummary, event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    gesture.current = null;
    if (!current || !current.horizontal) { setSwipe(null); return; }
    swipedRef.current = true;
    window.setTimeout(() => { swipedRef.current = false; }, 400);
    const dx = event.clientX - current.x;
    setSwipe(null);
    if (event.type === "pointerup" && Math.abs(dx) >= current.width * SWIPE_COMMIT) void act(row, removeAction);
  };

  const selectedRow = threads.find((row) => row.threadId === selectedThreadId) ?? null;
  const showList = !stacked || (!thread && !compose && !mailbox.loadingThread);
  const showThread = !stacked || (Boolean(thread) || mailbox.loadingThread) && !compose;
  const labelName = labels.find((label) => label.id === selection.labelId)?.name ?? MAIL_SYSTEM_LABELS.find((label) => label.id === selection.labelId)?.name ?? selection.labelId;
  const accountLabel = selection.account === "all" ? "All inboxes" : selection.account;
  const userLabels = labels.filter((label) => label.type === "user");
  const activeUserLabel = userLabels.find((label) => label.id === selection.labelId);
  const RemoveIcon = removeAction === "archive" ? Archive : Trash2;

  // The open conversation's bar and the selection bar share these; read and star follow Gmail (any unread marks read).
  const threadActions = (rows: MailThreadSummary[], scope: "conversation" | "selected") => {
    const unread = rows.some((row) => row.unread);
    const starred = rows.every((row) => row.starred);
    return (
      <span className="mc-thread-bar-actions">
        {selection.labelId === "INBOX" ? <button type="button" className="jc-icon-button" aria-label={`Archive ${scope}`} title="Archive" onClick={() => void act(rows, "archive")}><Archive aria-hidden="true" /></button> : null}
        {selection.labelId === "TRASH"
          ? <button type="button" className="jc-icon-button" aria-label={`Restore ${scope}`} title="Restore" onClick={() => void act(rows, "untrash")}><Undo2 aria-hidden="true" /></button>
          : <button type="button" className="jc-icon-button" aria-label={`Trash ${scope}`} title="Move to trash" onClick={() => void act(rows, "trash")}><Trash2 aria-hidden="true" /></button>}
        {rows.length === 1 ? <button type="button" className="jc-icon-button" aria-label={`Send ${scope} to AI`} title="Send to AI: the copilot checks and fixes what this mail needs" onClick={() => { setFixFor(rows[0]!); setFixNote(""); }}><Bot aria-hidden="true" /></button> : null}
        {selection.labelId !== "TRASH" && labels.some((label) => label.type === "user") ? (
          <label className="jc-icon-button mc-move" title="Move to a label">
            <Folder aria-hidden="true" />
            <select aria-label={scope === "selected" ? "Move selected to" : "Move to"} value="" onChange={(event) => { if (event.target.value) void act(rows, "move", [event.target.value]); }}>
              <option value="" disabled>Move to…</option>
              {labels.filter((label) => label.type === "user" && label.id !== selection.labelId).map((label) => <option key={label.id} value={label.id}>{label.name}</option>)}
            </select>
          </label>
        ) : null}
        <button type="button" className="jc-icon-button" aria-label={unread ? "Mark as read" : "Mark as unread"} title={unread ? "Mark as read" : "Mark as unread"}
          onClick={() => void act(rows, unread ? "read" : "unread")}><Mail aria-hidden="true" /></button>
        <button type="button" className={`jc-icon-button mc-star-button${starred ? " on" : ""}`} aria-label={`${starred ? "Unstar" : "Star"} ${scope}`} aria-pressed={starred}
          onClick={() => void act(rows, starred ? "unstar" : "star")}><Star aria-hidden="true" /></button>
      </span>
    );
  };

  return (
    <div ref={clientRef} className="mc-client" data-stacked={stacked ? "true" : "false"} data-view={compose ? "compose" : thread || mailbox.loadingThread ? "thread" : "list"}
      data-resizing={resizing ? "true" : undefined} style={!stacked && listWidth ? { "--mc-list-width": `max(${LIST_MIN}px, min(${listWidth}px, calc(100% - ${THREAD_MIN}px)))` } as CSSProperties : undefined}>
      {showList ? (
        <div className="mc-list-column">
          <div className="mc-topbar">
            {checkedRows.length ? (
              <div className="mc-bulkbar" role="toolbar" aria-label="Selected conversations">
                <button type="button" className="jc-icon-button" aria-label="Clear selection" title="Clear selection" onClick={() => setChecked(new Set())}><X aria-hidden="true" /></button>
                <strong>{checkedRows.length} selected</strong>
                {checkedRows.length < threads.length ? <button type="button" className="jc-button ghost" onClick={() => setChecked(new Set(threads.map(rowKey)))}>Select all</button> : null}
                <span className="mc-thread-bar-spacer" />
                {threadActions(checkedRows, "selected")}
              </div>
            ) : <form className="mc-search" role="search" onSubmit={(event) => { event.preventDefault(); mailbox.setSelection({ query: search.trim() }); }}>
              <Search aria-hidden="true" />
              <input type="search" value={search} placeholder={selection.account === "all" ? "Search all inboxes" : `Search ${selection.account}`} aria-label="Search mail"
                onChange={(event) => setSearch(event.target.value)}
                onBlur={() => { if (!search.trim() && selection.query) mailbox.setSelection({ query: "" }); }} />
              <button type="button" className="mc-search-button" aria-label="Refresh" title="Refresh" disabled={mailbox.loading} onClick={() => void mailbox.refresh()}>
                <RefreshCw aria-hidden="true" className={mailbox.loading ? "mc-spin" : undefined} />
              </button>
              <label className="mc-account-switch" title={accountLabel}>
                {selection.account === "all"
                  ? <span className="mc-avatar sm mc-avatar-all" aria-hidden="true"><Mail /></span>
                  : <span className="mc-avatar sm" style={{ "--avatar-hue": senderHue({ name: "", address: selection.account }) } as CSSProperties} aria-hidden="true">{senderInitial({ name: "", address: selection.account })}</span>}
                <select aria-label="Account" value={selection.account} onChange={(event) => mailbox.setSelection({ account: event.target.value })}>
                  <option value="all">All inboxes</option>
                  {usable.map((account) => <option key={account.email} value={account.email}>{account.email}{account.unread ? ` (${account.unread})` : ""}</option>)}
                </select>
              </label>
            </form>}
          </div>
          <div className="mc-label-bar">
            <div className="mc-labels" role="tablist" aria-label="Labels">
              {labels.filter((label) => label.type === "system").map((label) => {
                const Icon = SYSTEM_LABEL_ICONS[label.id] ?? Mail;
                const active = label.id === selection.labelId;
                return (
                  <button key={label.id} type="button" role="tab" aria-selected={active} className={`mc-label${active ? " selected" : ""}`} onClick={() => mailbox.setSelection({ labelId: label.id })}>
                    <Icon aria-hidden="true" /> {label.name}{label.unread ? <span className="mc-label-count">{label.unread}</span> : null}
                  </button>
                );
              })}
            </div>
            {/* The account's own labels: a picker that stays visible, since the chip row scrolls without a scrollbar. */}
            {userLabels.length ? (
              <label className={`mc-label mc-label-picker${activeUserLabel ? " selected" : ""}`} title="Show a label">
                <Folder aria-hidden="true" /> {activeUserLabel?.name ?? "Labels"}<ChevronDown aria-hidden="true" />
                <select aria-label="Show label" value={activeUserLabel?.id ?? ""} onChange={(event) => { if (event.target.value) mailbox.setSelection({ labelId: event.target.value }); }}>
                  <option value="" disabled>Labels…</option>
                  {userLabels.map((label) => <option key={label.id} value={label.id}>{label.name}{label.unread ? ` (${label.unread})` : ""}</option>)}
                </select>
              </label>
            ) : null}
          </div>
          {notice || mailbox.error ? <p className="jc-message mc-banner" role="status">{notice ?? mailbox.error}</p> : null}
          {mailbox.errors.map((entry) => <p key={entry.account} className="jc-message mc-banner" role="status">{entry.account}: {entry.message}</p>)}
          <div className="mc-threads" ref={listRef} role="list" aria-label={`${labelName} conversations`} aria-busy={mailbox.loading}>
            {mailbox.loading && threads.length === 0 ? (
              <div className="mc-skeleton" role="status" aria-label="Loading mail…">
                {Array.from({ length: 6 }, (_, index) => <span key={index} className="mc-skeleton-row"><span /><span /></span>)}
              </div>
            ) : null}
            {!mailbox.loading && threads.length === 0 ? (
              <div className="jc-empty mc-empty"><Mail aria-hidden="true" /><strong>Nothing here</strong><span>{selection.query ? "No conversation matches the search." : `${labelName} is empty.`}</span></div>
            ) : null}
            {threads.map((row) => {
              const dx = swipe?.threadId === row.threadId ? swipe.dx : 0;
              const armed = Math.abs(dx) >= 96;
              const isChecked = checked.has(rowKey(row));
              return (
                <div key={rowKey(row)} role="listitem" className={`mc-thread${row.unread ? " unread" : ""}${row.threadId === selectedThreadId ? " selected" : ""}${isChecked ? " checked" : ""}${dx ? " swiping" : ""}`}
                  data-account={row.account} aria-busy={busyThread === row.threadId}
                  onPointerDown={(event) => onRowPointerDown(row, event)} onPointerMove={onRowPointerMove}
                  onPointerUp={(event) => onRowPointerEnd(row, event)} onPointerCancel={(event) => onRowPointerEnd(row, event)}>
                  {dx ? (
                    <span className={`mc-swipe-reveal ${removeAction}${armed ? " armed" : ""}`} data-side={dx > 0 ? "start" : "end"} aria-hidden="true">
                      <RemoveIcon /> {removeAction === "archive" ? "Archive" : "Trash"}
                    </span>
                  ) : null}
                  <div className="mc-thread-body" style={dx ? { transform: `translateX(${dx}px)` } : undefined}>
                    <button type="button" className="mc-thread-main" onClick={() => void open(row)} aria-label={`${row.unread ? "Unread: " : ""}${participantLabel(row.from)}: ${row.subject || "(no subject)"}`}>
                      <SenderAvatar participant={row.from} account={row.account} accountTone={usable.length > 1 ? accountColor(row.account, usable) : undefined} checked={isChecked} />
                      <span className="mc-thread-copy">
                        <span className="mc-thread-line">
                          <strong className="mc-thread-from">{participantLabel(row.from)}{row.messageCount > 1 ? <small> {row.messageCount}</small> : null}</strong>
                          <time dateTime={row.receivedAt ?? undefined}>{mailTime(row.receivedAt)}</time>
                        </span>
                        <span className="mc-thread-subject">{row.subject || "(no subject)"}{row.hasAttachment ? <Paperclip className="mc-thread-clip" aria-label="Has attachment" /> : null}</span>
                        <span className="mc-thread-snippet">{row.snippet}</span>
                      </span>
                    </button>
                    {/* Sits over the avatar: tapping it picks the conversation instead of opening it, like Gmail. */}
                    <button type="button" className="mc-select" aria-pressed={isChecked} aria-label={`Select ${participantLabel(row.from)}: ${row.subject || "(no subject)"}`}
                      title={isChecked ? "Deselect" : "Select"} onClick={() => toggleChecked(row)} />
                    <button type="button" className={`mc-star${row.starred ? " on" : ""}`} aria-label={row.starred ? "Unstar" : "Star"} aria-pressed={row.starred} disabled={busyThread === row.threadId}
                      onClick={() => void act(row, row.starred ? "unstar" : "star")}><Star aria-hidden="true" /></button>
                    <span className="mc-thread-actions">
                      {selection.labelId === "TRASH" ? (
                        <button type="button" className="jc-icon-button" aria-label="Restore" title="Restore" disabled={busyThread === row.threadId} onClick={() => void act(row, "untrash")}><Undo2 aria-hidden="true" /></button>
                      ) : (
                        <>
                          {selection.labelId === "INBOX" ? <button type="button" className="jc-icon-button" aria-label="Archive" title="Archive" disabled={busyThread === row.threadId} onClick={() => void act(row, "archive")}><Archive aria-hidden="true" /></button> : null}
                          <button type="button" className="jc-icon-button" aria-label="Trash" title="Move to trash" disabled={busyThread === row.threadId} onClick={() => void act(row, "trash")}><Trash2 aria-hidden="true" /></button>
                          <button type="button" className="jc-icon-button" aria-label="Send to AI" title="Send to AI: the copilot checks and fixes what this mail needs" onClick={() => { setFixFor(row); setFixNote(""); }}><Bot aria-hidden="true" /></button>
                          <button type="button" className="jc-icon-button" aria-label={row.unread ? "Mark as read" : "Mark as unread"} title={row.unread ? "Mark as read" : "Mark as unread"} disabled={busyThread === row.threadId}
                            onClick={() => void act(row, row.unread ? "read" : "unread")}><Mail aria-hidden="true" /></button>
                        </>
                      )}
                    </span>
                  </div>
                </div>
              );
            })}
            {mailbox.nextPageToken ? (
              <button type="button" className="jc-button mc-load-more" disabled={mailbox.loadingMore} onClick={() => void mailbox.loadMore()}>{mailbox.loadingMore ? "Loading…" : "Load more"}</button>
            ) : null}
          </div>
          <button type="button" className="mc-fab" disabled={!usable.some((account) => account.access === "full")} onClick={() => setCompose({ kind: "new" })}
            title={usable.some((account) => account.access === "full") ? "New message" : "Sending needs full Gmail access on an account"}>
            <Pencil aria-hidden="true" /> <span>Compose</span>
          </button>
        </div>
      ) : null}

      {!stacked ? (
        <div className="mc-splitter" role="separator" aria-orientation="vertical" aria-label="Resize the conversation list" tabIndex={0}
          aria-valuemin={LIST_MIN} aria-valuenow={Math.round(listWidth ?? 0) || undefined} data-dragging={resizing ? "true" : undefined}
          title="Drag to resize · double-click to reset"
          onPointerDown={onSplitterDown} onPointerMove={onSplitterMove} onPointerUp={onSplitterEnd} onPointerCancel={onSplitterEnd} onKeyDown={onSplitterKey}
          onDoubleClick={() => { setListWidth(null); saveListWidth(null); }} />
      ) : null}
      {compose ? (
        <div className="mc-thread-column">
          <Composer mode={compose} accounts={accounts} defaultAccount={defaultAccount} signature={signature} paneId={paneId} onClose={() => setCompose(null)}
            onSent={() => { setCompose(null); setNotice("Sent."); void mailbox.refresh(); }} />
        </div>
      ) : showThread ? (
        <div className="mc-thread-column" aria-label="Conversation">
          {thread || stacked ? (
            <div className="mc-thread-bar">
              {stacked ? <button type="button" className="jc-icon-button mc-back" aria-label="Back" title="Back to the list" onClick={() => void mailbox.openThread(null)}><ArrowLeft aria-hidden="true" /></button> : null}
              <span className="mc-thread-bar-spacer" />
              {selectedRow && thread ? threadActions([selectedRow], "conversation") : null}
            </div>
          ) : null}
          {mailbox.loadingThread && !thread ? <div className="mc-skeleton" role="status" aria-label="Loading conversation…"><span className="mc-skeleton-row"><span /><span /></span><span className="mc-skeleton-row"><span /><span /></span></div> : null}
          {!thread && !mailbox.loadingThread ? <div className="jc-empty mc-empty"><Mail aria-hidden="true" /><strong>Pick a conversation</strong><span>Its messages open here.</span></div> : null}
          {thread ? (
            <>
              <header className="mc-thread-head">
                <h2>{thread.subject || "(no subject)"}</h2>
                <span className="mc-thread-meta">
                  {usable.length > 1 ? <span className="mc-account-tag"><span style={{ background: accountColor(thread.account, usable) }} aria-hidden="true" />{thread.account}</span> : null}
                  <span>{thread.messages.length} message{thread.messages.length === 1 ? "" : "s"}</span>
                </span>
              </header>
              <div className="mc-messages">
                {thread.messages.map((message) => (
                  <MessageCard key={message.messageId} message={message} paneId={paneId} expanded={expanded.has(message.messageId)}
                    onToggle={() => toggleExpanded(message.messageId)}
                    onReply={(all) => setCompose({ kind: all ? "replyAll" : "reply", message })} onForward={() => setCompose({ kind: "forward", message })}
                    onLoadImages={() => void mailbox.openThread({ account: thread.account, threadId: thread.threadId }, true)} />
                ))}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
      {fixFor ? (
        <form className="mc-fix-sheet" aria-label="Send to AI" onSubmit={(event) => { event.preventDefault(); void sendToAi(); }}
          onKeyDown={(event) => { if (event.key === "Escape") setFixFor(null); }}>
          <strong><Bot aria-hidden="true" /> Send to AI</strong>
          <span className="jc-muted">{fixFor.subject || "(no subject)"} · {fixFor.account}</span>
          <textarea rows={2} value={fixNote} autoFocus disabled={fixBusy} placeholder="What should the copilot check or fix? (optional)" aria-label="What should the copilot check or fix?"
            onChange={(event) => setFixNote(event.target.value)} />
          <div className="jc-actions">
            <button type="submit" className="jc-button primary" disabled={fixBusy}>{fixBusy ? "Sending…" : "Send"}</button>
            <button type="button" className="jc-button ghost" disabled={fixBusy} onClick={() => setFixFor(null)}>Cancel</button>
          </div>
        </form>
      ) : null}
      {undo ? (
        <div className="mc-snackbar" role="status">
          <span>{undo.action === "archive" ? "Archived" : "Moved to trash"}{undo.rows.length > 1 ? ` · ${undo.rows.length} conversations` : ""}</span>
          <button type="button" onClick={() => void undoLast()}>Undo</button>
        </div>
      ) : null}
      {!usable.length ? (
        <div className="jc-empty mc-no-accounts"><strong>No Gmail account yet</strong><span>Allow a Google account in Setup → Accounts.</span>
          <a className="jc-button primary" href={mailCopilotConsentUrl()}>Allow a Google account</a></div>
      ) : null}
    </div>
  );
}
