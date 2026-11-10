import { useEffect, useRef, useState } from "react";
import { needsYou, type SpaceNotification } from "@space/contracts";
import { markNotificationRead, openNeedsYouCard, useNotificationStore } from "../notifications/notification-store.js";
import { nousFocusHold } from "../nous-focus/nous-focus-events.js";
import { dropNeedsYouPeek, putOffNeedsYouPeek, useNeedsYouPeekQueue } from "./needs-you-view.js";
import { NeedsYouCard } from "./NeedsYouCard.js";
import { uiText, useUiLanguage } from "../ui-language/ui-language.js";
import { AgentFileMentions } from "../terminal-pane/AgentFileLinks.js";

/**
 * The small window a new Needs you card arrives in (plan clipboard:ytwWl09xNH0Z, design §3.1, approved 3/11 ~19:53 BKK): bottom right where the
 * toasts are, one window for many (the newest, then "N more wait for you"), never focused by itself and never moving anything. It waits while
 * the operator types (operator 3/11 19:30 BKK), then stays PEEK_MS and folds into the counter (§8.2); not while the pointer or focus is on it
 * or its Details are open. The cards stay in Needs you.
 */
export const PEEK_MS = 20_000;
/** How long an answered card stays in the window with its "Sent" line. */
export const PEEK_SENT_MS = 3_000;
const HOLD_CHECK_MS = 250;

// Answered or resolved elsewhere (another tab, the list, the pane), it leaves the window.
const waiting = (item: SpaceNotification) => (item.status === "OPEN" || item.status === "READ") && !item.payload?.answer;

export function NeedsYouPeek() {
  const queued = useNeedsYouPeekQueue();
  const { items } = useNotificationStore();
  const language = useUiLanguage();
  const [open, setOpen] = useState(false);
  const [held, setHeld] = useState(false);
  const [answeredId, setAnsweredId] = useState<string | null>(null);
  // False until the window may show: it appears only once he is free, then stays until it empties.
  const [shown, setShown] = useState(false);
  const box = useRef<HTMLElement>(null);
  const showing = useRef<string | null>(null);
  // The record as it is now (translation, status); one settled leaves the queue for good, even once the store's page no longer holds it.
  const current = queued.map((item) => items.find((entry) => entry.id === item.id) ?? item);
  const settledIds = current.filter((item) => item.id !== answeredId && !waiting(item)).map((item) => item.id).join(" ");
  useEffect(() => { for (const id of settledIds.split(" ").filter(Boolean)) dropNeedsYouPeek(id); }, [settledIds]);
  const cards = current.filter((item) => item.id === answeredId || waiting(item));
  const pinned = open || held || answeredId !== null;
  // A newer card never replaces the one under his pointer, focus or answer.
  const first = (pinned ? cards.find((item) => item.id === showing.current) : null) ?? cards[0] ?? null;
  const firstId = first?.id ?? null;
  showing.current = firstId;
  const empty = !first;
  useEffect(() => {
    if (empty) { setShown(false); return; }
    if (shown) return;
    const check = () => { if (!nousFocusHold()) setShown(true); };
    check();
    const timer = window.setInterval(check, HOLD_CHECK_MS);
    return () => window.clearInterval(timer);
  }, [empty, shown]);
  // A new card in the window starts closed and unheld: a window gone under his pointer (Go, resolved elsewhere) gets no pointer-leave.
  useEffect(() => { setOpen(false); setHeld(false); }, [firstId]);
  useEffect(() => {
    if (!shown || !firstId || pinned) return;
    const timer = window.setTimeout(() => dropNeedsYouPeek(), PEEK_MS);
    return () => window.clearTimeout(timer);
  }, [shown, firstId, pinned]);
  useEffect(() => {
    if (!answeredId) return;
    const timer = window.setTimeout(() => { setAnsweredId(null); setHeld(false); dropNeedsYouPeek(answeredId); }, PEEK_SENT_MS);
    return () => window.clearTimeout(timer);
  }, [answeredId]);
  if (!first || !shown) return null;
  const later = () => {
    if (first.status === "OPEN" && needsYou(first)) { void markNotificationRead(first.id); putOffNeedsYouPeek(first); } else dropNeedsYouPeek(first.id);
    setHeld(false);
  };
  const more = cards.length - 1;
  return (
    // role=status: announced politely, never focused; Escape works only once his own focus is inside it.
    <aside ref={box} className="ny-peek dock-kit-scope" role="status" aria-live="polite" aria-label={uiText(language, "Needs you")}
      onPointerEnter={() => setHeld(true)} onPointerLeave={() => setHeld(false)} onFocus={() => setHeld(true)}
      onBlur={(event) => { if (!box.current?.contains(event.relatedTarget as Node | null)) setHeld(false); }}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); later(); } }}>
      {/* nous_msg:8e7e6c25: the files the card names open their Agent Files preview here too. */}
      <AgentFileMentions><NeedsYouCard key={first.id} variant="peek" item={first} open={open} onOpenChange={setOpen} onLater={later} onAnswered={() => setAnsweredId(first.id)} /></AgentFileMentions>
      {more > 0 ? (
        <div className="ny-peek-more">
          <span>{uiText(language, "{count} more wait for you", { count: more })}</span>
          <button type="button" className="ny-link" onClick={() => { dropNeedsYouPeek(); openNeedsYouCard(first); }}>{uiText(language, "Open Needs you")}</button>
        </div>
      ) : null}
    </aside>
  );
}
