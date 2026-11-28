import { inboxPlainLine, needsYou, needsYouBrowserPage, needsYouPlace, type BrowserHandoffRequest, type InboxAskLive, type SpaceNotification } from "@space/contracts";
import type { PaneReport } from "@space/db";
import type { NeedsYouPlace } from "../needs-you-browser-page.js";

/**
 * Operator 27/11 (plan clipboard:va__qa_eBMYr §3): Jack's NBG sign-in card offered "Go now" from 10:39 to 12:18 ICT while its browser handoff had
 * run out at 11:09. What an open hands card's place looks like now, from what Space already holds; no model call, nothing stored.
 */
export interface AskLiveFacts {
  paneOpen: boolean;
  /** A card about a page: whether a browser holds it or its address can be opened again; null for a card about no page. */
  pageOpen: boolean | null;
  /** The newest browser handoff on the card's page that had not run out when the card asked. */
  handoff: Pick<BrowserHandoffRequest, "status" | "expiresAt" | "expiredAt"> | null;
  /** The asking pane's newest report, when its agent worked on after asking. */
  report: Pick<PaneReport, "at" | "summary"> | null;
}

export function askLive(facts: AskLiveFacts, now = Date.now()): InboxAskLive {
  if (!facts.paneOpen) return { state: "PANE_CLOSED", line: "The pane was closed." };
  if (facts.report) return { state: "MOVED_ON", line: inboxPlainLine(facts.report.summary), at: facts.report.at };
  if (facts.pageOpen === false) return { state: "PAGE_GONE", line: "The page is no longer open." };
  const handoff = facts.handoff;
  const held = handoff?.status === "REQUESTED" || handoff?.status === "ACCEPTED";
  if (handoff && held && Date.parse(handoff.expiresAt) > now) return { state: "READY", line: "The page is open and waits for you.", until: handoff.expiresAt };
  // A completed or cancelled handoff did not run out: the card says only what its page and pane say.
  if (handoff && (held || handoff.status === "EXPIRED")) return { state: "EXPIRED", line: "The handoff ran out.", at: handoff.expiredAt ?? handoff.expiresAt };
  return { state: "READY", line: facts.pageOpen ? "The page is open and waits for you." : "The pane is open and waits for you." };
}

// The agent worked on or finished; a wait, a heartbeat or a turn's end says nothing about the card.
const WORKED = new Set<PaneReport["status"]>(["STARTED", "PROGRESS", "DONE", "FAILED"]);
const askedAt = (card: SpaceNotification) => typeof card.payload.alertAt === "string" ? card.payload.alertAt : card.createdAt;

export interface AskLiveDeps {
  notifications: { get(owner: string, id: string): Promise<SpaceNotification | null> };
  paneOpen(paneId: string): Promise<boolean>;
  /** needs-you-browser-page.ts `createNeedsYouPlaceReads`: the card's page against the live browsers, read only. */
  places(owner: string): (card: SpaceNotification) => Promise<NeedsYouPlace>;
  /** A room's browser handoffs, newest first. */
  handoffs(roomId: string): Promise<BrowserHandoffRequest[]>;
  /** The newest report of each of the owner's panes. */
  reports(owner: string): Promise<PaneReport[]>;
  now?: () => number;
}

/** The live state of each open hands card among `refs` (notification ids); a card that is not one, or whose facts cannot be read, gets none. */
export function createAskLive(deps: AskLiveDeps) {
  return async (owner: string, refs: readonly string[]): Promise<Map<string, InboxAskLive>> => {
    const live = new Map<string, InboxAskLive>();
    if (!refs.length) return live;
    const place = deps.places(owner);
    const rooms = new Map<string, Promise<BrowserHandoffRequest[]>>();
    const handoffs = (roomId: string) => rooms.get(roomId) ?? (rooms.set(roomId, deps.handoffs(roomId)), rooms.get(roomId)!);
    let reports: Promise<PaneReport[]> | undefined;
    await Promise.all(refs.map(async (ref) => {
      try {
        const card = await deps.notifications.get(owner, ref);
        if (!card || !needsYou(card) || needsYouPlace(card) !== "PANE") return;
        if (!card.paneId || !card.roomId) {
          // A closed pane's carried card (17/11) is still the operator's; a plan's card never had a pane.
          if (card.dedupeKey?.startsWith("nous:closed-pane:")) live.set(ref, askLive({ paneOpen: false, pageOpen: null, handoff: null, report: null }));
          return;
        }
        const asked = Date.parse(askedAt(card));
        const [paneOpen, found, latest] = await Promise.all([deps.paneOpen(card.paneId), place(card), (reports ??= deps.reports(owner))]);
        const page = found.place ?? needsYouBrowserPage(card) ?? { roomId: card.roomId, paneId: card.paneId };
        const handoff = (await handoffs(page.roomId)).find((entry) => entry.paneId === page.paneId && Date.parse(entry.expiresAt) > asked) ?? null;
        // nous_msg:832a500e: a card about one plan never follows the pane's later report about another plan.
        const plan = typeof card.payload.planId === "string" ? card.payload.planId : null;
        const report = latest.find((entry) => entry.paneId === card.paneId && Date.parse(entry.at) > asked && WORKED.has(entry.status) && !(plan && entry.planId && entry.planId !== plan)) ?? null;
        live.set(ref, askLive({ paneOpen, pageOpen: found.page ? Boolean(found.place) : null, handoff, report }, deps.now?.()));
      } catch { /* no status line: the card shows as it did before */ }
    }));
    return live;
  };
}
