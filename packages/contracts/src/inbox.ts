import { z } from "zod";
import type { NousRequestStatus } from "./nous.js";

/**
 * «Εισερχόμενα» v2 (spec v2 §2-§4, plan clipboard:aE7U1J_gU9OV, operator approval 15/11 20:39 BKK): one Thread per request, plan or item, built
 * from append-only events that point at their source record (`ref`). The sources stay the ones that execute; a Thread keeps the one state.
 */
export type InboxWaitingFor = "OPERATOR" | "NOUS" | "AGENT" | "NOBODY";
export type InboxPriority = "URGENT" | "ATTENTION" | "INFO";
export type InboxOrigin = "OPERATOR" | "NOUS" | "AGENT" | "COPILOT" | "SYSTEM";
export const INBOX_EVENT_TYPES = ["REQUEST", "ASK", "ANSWER", "PROGRESS", "REPORT", "UPDATE", "ALERT", "NOTE", "CLOSED", "REOPENED"] as const;
export type InboxEventType = typeof INBOX_EVENT_TYPES[number];

/** Plan clipboard:JD8EbQgQdRls (operator 24/11): the Inbox's four tabs over the same Threads; a Thread's tab is `inboxTabOf`. */
export const INBOX_NEWS = ["REPORT", "UPDATE", "PROGRESS", "ALERT"] as const;
export type InboxNews = typeof INBOX_NEWS[number];
export type InboxTab = "NEEDS" | "DONE" | "UPDATES" | "REQUESTS";

/**
 * Operator 27/11 (plan clipboard:va__qa_eBMYr §3; an agent's sign-in card offered "Go now" for 69 minutes after its browser handoff ran out): what a
 * hands ask's place looks like at this read, from what Space already holds (the pane, the live browsers, the handoff, the pane's reports). Never stored.
 */
export type InboxAskLiveState = "READY" | "EXPIRED" | "PAGE_GONE" | "PANE_CLOSED" | "MOVED_ON";
export interface InboxAskLive {
  state: InboxAskLiveState;
  /** One plain English line; MOVED_ON: the agent's own later report. A client says the state in its own language. */
  line: string;
  /** When it became so, where Space knows (the handoff ran out, the agent reported). */
  at?: string;
  /** READY under a browser handoff: when that runs out. */
  until?: string;
}

export interface InboxAsk {
  /** As written; whether it is still open is derived (`inboxThreadState`): no later ANSWER or CLOSED for its ref. */
  open: boolean;
  /** false: held for Nous (heldForNous, an allowance, a card whose pane is closed); it neither counts nor pushes. */
  forOperator: boolean;
  kind: "APPROVAL" | "QUESTION" | "HANDS" | "OFF_SPACE";
  options: string[];
  recommended?: string;
  action?: string;
  always?: { key: string; label: string };
  files?: string[];
  checked?: string;
  goToPane?: { roomId: string; paneId: string; target?: string };
  category?: "RELEASE" | "DESTRUCTIVE" | "EXTERNAL" | "DIRECTION";
  /** An open hands ask of the operator's, on the Threads read only. */
  live?: InboxAskLive;
}

export interface InboxThreadRefs {
  requestId?: string; planId?: string; roomId?: string; paneId?: string; ticketIds?: string[]; requestStatus?: NousRequestStatus;
  /** A done request: where its work is live (the Done card's Stable / Dev / No code). */
  where?: "stable" | "dev" | "no code";
}

export interface InboxThread {
  id: string;
  ownerUserId: string;
  /** Grouping key (§2.2), unique per owner: plan:<planId>, dedupe:<dedupeKey>, else the first record's own id (nous_msg:, nous_decision:, notification:). */
  key: string;
  title: string;
  origin: InboxOrigin;
  originLabel: string;
  waitingFor: InboxWaitingFor;
  unseen: boolean;
  closedAt: string | null;
  closedBy: "OPERATOR" | "SOURCE" | null;
  priority: InboxPriority;
  now: string;
  progress: number | null;
  refs: InboxThreadRefs;
  createdAt: string;
  lastEventAt: string;
}

export interface InboxEvent {
  id: string;
  threadId: string;
  at: string;
  type: InboxEventType;
  actor: string;
  title: string;
  body: string;
  priority: InboxPriority;
  /** The source record: notification:<id> | nous_decision:<id> | nous_msg:<id>. None on a thread-level CLOSED or REOPENED. */
  ref?: string;
  ask?: InboxAsk;
}

export interface InboxThreadState {
  waitingFor: InboxWaitingFor;
  unseen: boolean;
  closedAt: string | null;
  closedBy: "OPERATOR" | "SOURCE" | null;
  priority: InboxPriority;
  now: string;
  /** Every ask still open, oldest first: a Thread's card shows each of them (§2.2 safety rule). */
  openAsks: InboxEvent[];
  /** An operator's request on it is still open (not done, not answered). */
  openRequest: boolean;
  /** What its unseen news is, the kind that decides its tab first (a Done report, then an update, a progress line, an alert). */
  news: InboxNews | null;
}

// An internal id (nous_msg:…, mktmem:…, artifact:…, "FACT <id>"): a Thread's line never shows one; its timeline (Details) keeps them.
const INTERNAL_ID = /(?<![\w./-])(?:[a-z][a-z_]{1,20}:[A-Za-z0-9][\w-]{5,}(?:\/[\w-]+)*|FACT\s+[\w-]{8,})/;
const INTERNAL_IDS = new RegExp(INTERNAL_ID.source, "g");
/**
 * Operator 16/11 12:05 BKK («τι ειναι ολα αυτα τα κατεβατα need you???», plan clipboard:LkwKdOOh2mXK step 1): a card's line is one plain line,
 * its first, without internal ids or the brackets holding them, cut at a word; the whole text stays in the Thread's timeline.
 */
export function inboxPlainLine(text: string, max = 160): string {
  const first = (text.split("\n").map((line) => line.trim()).find(Boolean) ?? "").replace(/^[•*-]\s+/, "");
  const line = first.replace(/\s*\([^()]*\)/g, (group) => INTERNAL_ID.test(group) ? "" : group).replace(INTERNAL_IDS, "")
    .replace(/\s+([.,;:])/g, "$1").replace(/\s{2,}/g, " ").trim();
  if (line.length <= max) return line;
  const space = line.lastIndexOf(" ", max);
  return `${line.slice(0, space > max * 0.6 ? space : max).trimEnd()}…`;
}

const RANK: Record<InboxPriority, number> = { INFO: 0, ATTENTION: 1, URGENT: 2 };
/** The operator's Not relevant close: it closes a Thread even over an open request, which his Done never does (operator 16/11 12:41). */
export const INBOX_NOT_RELEVANT = "Not relevant";
const OPENS = new Set<InboxEventType>(["REQUEST", "ASK", "REPORT", "UPDATE", "ALERT"]);
const SEEN = new Set<InboxEventType>(["REPORT", "UPDATE", "ALERT"]);

/**
 * The one state (§3) from a Thread's events in the order they were recorded (insertion order, not `at`: a late sync may carry an earlier
 * source time). A ref's ANSWER or CLOSED settles every earlier opener of that ref; a ref-less CLOSED is the operator closing the Thread,
 * which an open ask for the operator always overrides, and an open request too unless he closed it as Not relevant.
 */
export function inboxThreadState(events: readonly InboxEvent[], threadTitle?: string): InboxThreadState {
  const settled = new Map<string, number>();
  let threadClosed = -1;
  let lastOpening = -1;
  events.forEach((event, index) => {
    if (event.type === "ANSWER" || event.type === "CLOSED") {
      if (event.ref) settled.set(event.ref, index);
      else if (event.type === "CLOSED") threadClosed = index;
    }
    if (OPENS.has(event.type)) lastOpening = index;
  });
  const latest = new Map<string, number>();
  events.forEach((event, index) => { if (event.ref && (event.type === "ASK" || event.type === "REQUEST")) latest.set(`${event.type}|${event.ref}`, index); });
  const live = (event: InboxEvent, index: number) => !event.ref || (settled.get(event.ref) ?? -1) < index;
  const openAsks = events.filter((event, index) => event.type === "ASK" && event.ref && latest.get(`ASK|${event.ref}`) === index && live(event, index));
  const openRequest = events.some((event, index) => event.type === "REQUEST" && event.ref && latest.get(`REQUEST|${event.ref}`) === index && live(event, index));
  // A progress line is news only while its request is open: a finished request is not kept open by the steps that led to it.
  const unseenItems = events.filter((event, index) => (SEEN.has(event.type) || (event.type === "PROGRESS" && openRequest)) && live(event, index) && threadClosed < index);
  const forOperator = openAsks.filter((event) => event.ask?.forOperator);
  const waitingFor: InboxWaitingFor = forOperator.length ? "OPERATOR" : openAsks.length || openRequest ? "NOUS" : "NOBODY";
  const unseen = unseenItems.length > 0;
  const last = events.at(-1);
  let closedAt: string | null = null;
  let closedBy: InboxThreadState["closedBy"] = null;
  const operatorClosed = threadClosed > lastOpening && (!openRequest || events[threadClosed]!.title === INBOX_NOT_RELEVANT);
  if (waitingFor !== "OPERATOR" && operatorClosed) [closedAt, closedBy] = [events[threadClosed]!.at, "OPERATOR"];
  else if (waitingFor === "NOBODY" && !unseen && last) [closedAt, closedBy] = [events.reduce((max, event) => event.at > max ? event.at : max, last.at), "SOURCE"];
  const priority = [...openAsks, ...unseenItems].reduce<InboxPriority>((top, event) => RANK[event.priority] > RANK[top] ? event.priority : top, "INFO");
  // A request in progress says where its work stands (its last progress line), seen or not.
  const pick = forOperator.at(-1) ?? unseenItems.at(-1) ?? openAsks.at(-1) ?? (openRequest ? events.findLast((event) => event.type === "PROGRESS") : undefined) ?? last;
  // A record whose title is the Thread's own (a one-record Thread) says what is new in its body, so a card never shows the title twice.
  const now = inboxPlainLine(!pick ? "" : pick.title !== threadTitle ? pick.title : pick.body.split("\n").map((line) => line.trim()).find((line) => line && line !== threadTitle) ?? "");
  const news = INBOX_NEWS.find((type) => unseenItems.some((event) => event.type === type)) ?? null;
  return { waitingFor, unseen, closedAt, closedBy, priority, now, openAsks, openRequest, news };
}

type InboxBadgeThread = Pick<InboxThread, "closedAt" | "waitingFor" | "unseen" | "priority"> & { openRequest?: boolean; news?: InboxNews | null; refs?: InboxThreadRefs };
/**
 * Plan clipboard:JD8EbQgQdRls §3: an open request with a plan (an "important" one) whose news is an update or a progress line. It shows under
 * Updates too and counts once, however many steps were reported; an alert on a request still does not count.
 */
export const inboxRequestNews = (thread: InboxBadgeThread) =>
  !thread.closedAt && Boolean(thread.openRequest && thread.refs?.planId) && (thread.news === "UPDATE" || thread.news === "PROGRESS");
/** Whether a Thread counts in the badge (§4; INFO never counts, E2); other news on an open request sits under Requests and does not (plan LkwKdOOh2mXK step 10). */
export const inboxThreadCounts = (thread: InboxBadgeThread) =>
  !thread.closedAt && (thread.waitingFor === "OPERATOR" || (thread.unseen && !thread.openRequest && thread.priority !== "INFO") || inboxRequestNews(thread));
/** An open Thread's one tab: what waits on the operator, a Done report to see, other news, else the work in progress (what Nous holds included). */
export const inboxTabOf = (thread: InboxBadgeThread): InboxTab =>
  thread.waitingFor === "OPERATOR" ? "NEEDS" : thread.unseen && !thread.openRequest ? (thread.news === "REPORT" ? "DONE" : "UPDATES") : "REQUESTS";

/** The one badge every client shows, counted by the server: attention when at least one Thread waits on the operator. */
export function inboxBadge(threads: ReadonlyArray<InboxBadgeThread>): { badge: number; attention: boolean } {
  return { badge: threads.filter(inboxThreadCounts).length, attention: threads.some((thread) => !thread.closedAt && thread.waitingFor === "OPERATOR") };
}

/** GET /api/inbox (§10): what waits, read whole, then a page of closed Threads; `q` searches every Thread's words (closed ones inside `since`). */
export const inboxQuerySchema = z.object({
  /** The last page's `cursor` (closed Threads only). */
  cursor: z.string().min(1).max(300).optional(),
  // Technical: one page of closed Threads per request; the next comes with the cursor.
  limit: z.coerce.number().int().min(1).max(200).default(50),
  q: z.string().max(200).optional(),
  /** The History period's floor (HISTORY_FLOORS): closed Threads only; an open Thread shows whatever its age. */
  since: z.string().datetime({ offset: true }).optional(),
  /** UPDATES: the closed page holds only the Threads with an update of Nous's (the Updates tab's read ones, newest first). */
  tab: z.enum(["UPDATES"]).optional()
}).strict();
export type InboxQuery = z.infer<typeof inboxQuerySchema>;

export const INBOX_VERBS = ["APPROVE", "DECLINE", "ANSWER", "DONE", "DISMISS"] as const;
export type InboxVerb = typeof INBOX_VERBS[number];
/** POST /api/inbox/threads/:id/act: an answer goes to one open ask (`askId`, its ref); DONE and DISMISS act on the Thread. */
export const inboxActInputSchema = z.object({
  verb: z.enum(INBOX_VERBS),
  askId: z.string().min(1).max(200).optional(),
  option: z.string().trim().min(1).max(500).optional(),
  text: z.string().trim().min(1).max(2_000).optional(),
  always: z.boolean().optional()
}).strict().refine((input) => !["APPROVE", "DECLINE", "ANSWER"].includes(input.verb) || Boolean(input.askId), { message: "An answer names its ask.", path: ["askId"] })
  .refine((input) => input.verb !== "ANSWER" || Boolean(input.option || input.text), { message: "An answer needs an option or text.", path: ["text"] });
export type InboxActInput = z.infer<typeof inboxActInputSchema>;
// Technical: the ids a select-all sends at once (the list's own page size).
export const inboxDoneAllInputSchema = z.object({ ids: z.array(z.string().min(1).max(200)).min(1).max(500) }).strict();

/** `held`: it waits only on Nous or an agent (asks held for Nous, no open request of the operator's): never an operator card or count. */
/** `openRequest`: an operator's request on it is still open; it shows under In progress, news or not, and leaves only when the work is done. */
/** `tab`: an open Thread's tab, counted by the server; `requestNews`: a request under Requests that shows under Updates too until its news is seen. */
/** `report`: an unseen Done report's text (the summary, then its "Checked: …" line). */
export type InboxThreadView = InboxThread & { openAsks: InboxEvent[]; held?: boolean; openRequest?: boolean; tab?: InboxTab; news?: InboxNews; requestNews?: boolean; report?: string };
export interface InboxBadge { badge: number; attention: boolean }
export interface InboxPage extends InboxBadge {
  /** Waiting on the operator (URGENT first, then the oldest ask), unseen, working, then the closed page (newest first). */
  threads: InboxThreadView[];
  cursor: string | null;
  /** `working` counts the operator's own work in progress; `held` what Nous or an agent decides (shown folded, never in the header). */
  /** `tabs`: the four tabs' counters; needs + done + updates is the badge (an INFO Thread shows in its tab and is not counted). */
  summary: { operator: number; unseen: number; working: number; held?: number; tabs?: Record<"needs" | "done" | "updates" | "requests", number> };
}
export interface InboxActResult extends InboxBadge { thread: InboxThreadView | null; display: string | null }
