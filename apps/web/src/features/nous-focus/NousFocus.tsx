import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { NEEDS_YOU_CHECKED_HEADER, NEEDS_YOU_GO_NOW, heldForNous, needsYou, needsYouAsk, needsYouBrowserPage, needsYouHasPlace, needsYouTranslation,
  type NotificationAnswerInput, type Pane, type Room, type SpaceNotification, type UiLanguage } from "@space/contracts";
import { api } from "../../api.js";
import { browserPaneControlHeld, dispatchBrowserPaneActionEvent } from "../browser-pane/events.js";
import { ackNotification, goToNeedsYouPane, markNotificationRead, peekNotificationStore, refreshNotifications, subscribeNotificationStore, useNotificationStore } from "../notifications/notification-store.js";
import { NOTIFICATION_OPEN_EVENT } from "../notifications/pane-target.js";
import { useAgentLanguage, useUiLanguage, uiServerText, uiText } from "../ui-language/ui-language.js";
import { ArrowLeft, Check, ChevronDown, X } from "../ui-theme/app-icons.js";
import { dropNeedsYouPeek, pushNeedsYouPeek } from "../needs-you/needs-you-view.js";
import { NeedsYouFiles } from "../needs-you/NeedsYouFiles.js";
import type { SideSurface } from "../docks/dock-types.js";
import { useCoreApiOutage } from "../../core-api-availability.js";
import { getCoreApiOutage } from "../../core-api-state.js";
import { announceNousFocusPhase, NOUS_FOCUS_CHECK_EVENT, NOUS_FOCUS_EVENT, readNousFocusEnabled, requestNousFocus, type NousFocusDetail } from "./nous-focus-events.js";

export { forwardNousPaneBoardEvents, nousFocusHold } from "./nous-focus-events.js";
import "./nous-focus.css";

/**
 * Needs you (operator request 2026-10-24; plan clipboard:twwygEtD4uuX before it): a notification on a pane whose kind needs the operator
 * there brings them to it and back. Everything here goes through the shell's own actions (room select as a click, maximize, restore,
 * select pane, open dock): no room, warm or terminal code changes. Operator 3/11 19:25 and 19:30 BKK («δεν πρεπει να γινεται focus και
 * αλλαγη οθονης στο χειριστη χωρις εγω να το εχω επιλεξει να παω», plan clipboard:ytwWl09xNH0Z): nothing moves his screen without his click.
 * A new card only shows in the small window (NeedsYouPeek, which waits while he types); only his click on a pane card's Go (immediate)
 * goes; the visit never comes back by itself (Back and Stay are his). Go maximizes the pane and focuses what needs them (a browser handoff is
 * taken); leaving a pane whose browser the operator holds gives it back.
 * A request no screen showed (a hidden tab, no stream, the app not open yet; stable 2026-10-24) is never lost: the record stays OPEN, and the
 * tab shows the newest open one in the window when it becomes visible, when its stream (re)connects and after its first load, once per record.
 */
// Only these panes have a browser that can hand off to the operator; asking any other pane would only answer 404.
const HANDOFF_MODES = new Set<Pane["mode"]>(["BROWSER", "YOUTUBE", "JOB_APPLY", "MARKETING_COPILOT", "FREELANCE_COPILOT"]);

export interface NousFocusShell {
  /** False before sign-in: the hook runs in App on the login screen too, which reads no settings. */
  signedIn?: boolean;
  rooms: Room[];
  panes: Pane[];
  selectedRoomId: string | null;
  selectedPaneId: string | null;
  selectRoom(roomId: string): Promise<void>;
  selectPane(paneId: string | null): void;
  toggleMaximize(pane: Pane): Promise<void>;
  restorePane(pane: Pane): Promise<void>;
  sideSurfaces: { activeSideSurface: SideSurface; isSideSurfaceOpen: boolean; openSideSurface(surface: SideSurface): void };
}

interface Origin { roomId: string | null; paneId: string | null; maximizedPaneId: string | null; surface: SideSurface; surfaceOpen: boolean; notificationId: string | null }
interface Visit { origin: Origin; roomId: string; paneId: string; maximizedByUs: boolean; notificationId: string | null; terminal: boolean; record: SpaceNotification | null }

/** Whether Go has somewhere to take him: a request he made himself always has. */
const placeOf = (detail: NousFocusDetail, mode?: string | null) => !detail.notification || needsYouHasPlace(detail.notification, mode);

/** The pane's own "needs you" control first (a browser handoff's Take control is pressed for the operator), then its terminal input, then the pane. */
function focusPane(paneId: string, handoff: boolean, needsAnswer: boolean, targetId?: string): boolean {
  const pane = [...document.querySelectorAll<HTMLElement>("[data-space-pane-id]")].find((element) => element.dataset.spacePaneId === paneId);
  if (!pane) return false;
  const visible = (element: HTMLElement) => !element.closest('[hidden], [aria-hidden="true"]')
    && (typeof element.checkVisibility !== "function" || element.checkVisibility({ visibilityProperty: true }));
  if (!visible(pane)) return false;
  const pending = [...pane.querySelectorAll<HTMLElement>("[data-copilot-pending-id]")].find((item) => item.dataset.copilotPendingId === targetId) ?? pane;
  const answer = [...pending.querySelectorAll<HTMLElement>(".jc-pending input:not(:disabled), .jc-pending textarea:not(:disabled)")].find(visible)
    ?? [...pending.querySelectorAll<HTMLElement>(".jc-pending button:not(:disabled)")].find(visible);
  if (needsAnswer && !answer) return false;
  const target = (handoff ? pane.querySelector<HTMLElement>(".browser-control-toggle") : null) ?? answer ?? [...pane.querySelectorAll<HTMLElement>("textarea.xterm-helper-textarea")].find(visible) ?? pane;
  if (target === pane) pane.tabIndex = -1;
  target.focus({ preventScroll: true });
  target.scrollIntoView?.({ block: "nearest" });
  return true;
}

/** Leaving a pane whose browser the operator holds gives it back to the agent (operator decision 2026-10-24). */
function releaseBrowser(paneId: string): void {
  if (browserPaneControlHeld(paneId)) dispatchBrowserPaneActionEvent({ paneId, action: "release" });
}

/** A card a CLI pane raised about a page goes to the browser pane holding that page (`payload.browserPage`), never the CLI. */
function atBrowserPage(detail: NousFocusDetail | null | undefined): NousFocusDetail | null {
  const page = detail?.notification ? needsYouBrowserPage(detail.notification) : null;
  return detail && page ? { ...detail, roomId: page.roomId, paneId: page.paneId } : detail ?? null;
}

export const PAGE_GONE = "This page is no longer open. Ask the agent to open it again.";
const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

/** Go now lands on the spot (operator 3/11 12:40 BKK): once the tab shows, what waits for the operator there (a reCAPTCHA, a code, an
 * empty required field, Submit) is scrolled into view; a page still loading is tried once more. */
export const REVEAL_TRIES_MS = [800, 3_000];
async function revealNeed(paneId: string, target: string, live: () => boolean): Promise<void> {
  const tab = /^tab:(\S+)$/.exec(target)?.[1];
  const url = /^url:(\S+)$/.exec(target)?.[1];
  if (!tab && !url) return;
  for (const delay of REVEAL_TRIES_MS) {
    await wait(delay);
    if (!live()) return;
    const pageId = tab ?? await api.browserPages(paneId).then((list) => list.pages.find((page) => page.url === url)?.pageId ?? list.activePageId).catch(() => null);
    if (pageId && (await api.revealBrowserNeed(paneId, pageId).catch(() => null))?.revealed) return;
  }
}
const settled = (status: string | undefined) => status === "RESOLVED" || status === "ACKED";
/** An open needs-you record this screen can show now: not held for the operator's morning. */
const openNeedsYou = (item: SpaceNotification) => item.status === "OPEN" && needsYou(item) && !heldForNous(item)
  && !(typeof item.payload?.heldUntil === "string" && Date.parse(item.payload.heldUntil) > Date.now());

export function useNousFocus(shell: NousFocusShell): ReactNode {
  const language = useUiLanguage(shell.signedIn ?? true);
  // The banner's labels are the interface language; the card's own words the agents' (operator 2/11 09:51 BKK).
  const agents = useAgentLanguage(shell.signedIn ?? true);
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const stored = useNotificationStore().items;
  const latest = useRef(shell);
  latest.current = shell;
  const [visit, setVisit] = useState<Visit | null>(null);
  const visitRef = useRef<Visit | null>(null);
  visitRef.current = visit;
  const [moving, setMoving] = useState(false);
  const navigating = useRef(false);
  const focusRun = useRef(0);
  const [error, setError] = useState<string | null>(null);
  /** A Go that a Space restart stopped: it runs again once Space answers (nous_msg:1be51d08). */
  const [retry, setRetry] = useState<NousFocusDetail | null>(null);
  const outage = useCoreApiOutage();
  useEffect(() => () => { ++focusRun.current; }, []);
  /** Records this screen already offered or went to: a missed request is offered once. */
  const shown = useRef(new Set<string>());
  const paneOf = (id: string | null) => (id ? latest.current.panes.find((pane) => pane.id === id) ?? null : null);

  const go = useCallback(async (asked: NousFocusDetail) => {
    if (navigating.current) return;
    navigating.current = true;
    const run = ++focusRun.current;
    setError(null);
    setRetry(null);
    // Operator 9/11 13:31 BKK («με πηγαινει σε ασχετα»): a card about a page goes where the server finds that page now (the card is rebound to
    // it); a page no browser holds, with no address to open, moves nothing.
    const found = asked.notification ? await api.needsYouPlace(asked.notification.id).catch(() => null) : null;
    if (found?.page && !found.place) { navigating.current = false; setError(PAGE_GONE); return; }
    const detail = found?.place && asked.notification ? { ...asked, roomId: found.place.roomId, paneId: found.place.paneId,
      notification: { ...asked.notification, payload: { ...asked.notification.payload, browserPage: found.place } } } : asked;
    // Going there is seeing it: an open record would be offered again on every other tab and after each reload (only OPEN: the read
    // route would turn a resolved record back into READ).
    const record = detail.notification;
    const shell = latest.current;
    const origin: Origin = visitRef.current?.origin ?? {
      roomId: shell.selectedRoomId, paneId: shell.selectedPaneId,
      maximizedPaneId: shell.panes.find((pane) => pane.roomId === shell.selectedRoomId && pane.isMaximized && !pane.isClosed)?.id ?? null,
      surface: shell.sideSurfaces.activeSideSurface, surfaceOpen: shell.sideSurfaces.isSideSurfaceOpen, notificationId: record?.id ?? null
    };
    setMoving(true);
    // Save and hide the dock before selectRoom can close/unmount a compact drawer. Same-room visits need this too.
    announceNousFocusPhase("go");
    try {
      if (shell.selectedRoomId !== detail.roomId) await shell.selectRoom(detail.roomId);
      // A cold room loads its panes after it is shown.
      for (let tries = 0; tries < 50 && !paneOf(detail.paneId); tries += 1) await wait(100);
      let pane = paneOf(detail.paneId);
      if (!pane || pane.isClosed) throw new Error("This pane is no longer available. Open Needs you to check the request.");
      if (pane.isMinimized) { await latest.current.restorePane(pane); pane = paneOf(detail.paneId) ?? pane; }
      const maximizedByUs = !pane.isMaximized;
      if (maximizedByUs) await latest.current.toggleMaximize(pane);
      latest.current.selectPane(detail.paneId);
      // A copilot rail opens the question or review the notification points at (the same convention as a notification click).
      // A copilot's own handoff card (Job Copilot HANDOFF_REQUESTED) takes the browser too.
      // Operator 2/11 13:15 BKK: a card a CLI raised about a page opens the browser pane holding it, at its tab (atBrowserPage below).
      const page = record ? needsYouBrowserPage(record) : null;
      const atPage = page?.paneId === detail.paneId;
      const handoff = !record || atPage || record.source === "BROWSER_HANDOFF" || record.kind === "HANDOFF_REQUESTED";
      const target = (atPage ? page.target : null) ?? record?.link.target ?? (record?.source === "BROWSER_HANDOFF" ? "browser" : record ? "activity" : null);
      const same = visitRef.current?.paneId === detail.paneId;
      const nextVisit = { origin, roomId: detail.roomId, paneId: detail.paneId, maximizedByUs: maximizedByUs || Boolean(same && visitRef.current?.maximizedByUs),
        notificationId: record?.id ?? null, terminal: (pane.mode ?? "TERMINAL") === "TERMINAL", record: record ?? null };
      visitRef.current = nextVisit;
      setVisit(nextVisit);
      const current = record ? peekNotificationStore().items.find((item) => item.id === record.id) ?? record : null;
      if (record) dropNeedsYouPeek(record.id);
      // R27-2: going to a card that offers "Go now" is that answer, scored once (the server keeps the record READ for the visit).
      if (current && (current.status === "OPEN" || current.status === "READ") && needsYouAsk(current).options?.includes(NEEDS_YOU_GO_NOW)
        && (current.payload.answer as { text?: unknown } | undefined)?.text !== NEEDS_YOU_GO_NOW) {
        void api.answerNotification(current.id, { option: NEEDS_YOU_GO_NOW }).catch(() => current.status === "OPEN" ? markNotificationRead(current.id) : undefined);
      } else if (current?.status === "OPEN") void markNotificationRead(current.id);
      // Every browser handoff uses the pane action; no focus path depends on a copilot strip being mounted.
      if (handoff && HANDOFF_MODES.has(pane.mode) && await api.browserHandoff(detail.paneId).then((result) => result.handoff?.status === "REQUESTED").catch(() => false)) {
        dispatchBrowserPaneActionEvent({ paneId: detail.paneId, action: "handoff", roomId: detail.roomId });
      }
      // The pane mounts or grows a moment later; focus it without holding the visit back.
      void (async () => {
        // Cold pane listeners and the selected rail tab must mount before focusing their answer control.
        for (let tries = 0; tries < 100 && focusRun.current === run; tries += 1) {
          const mounted = [...document.querySelectorAll<HTMLElement>("[data-space-pane-id]")].some((element) => element.dataset.spacePaneId === detail.paneId);
          if (mounted) {
            if (target) window.dispatchEvent(new CustomEvent(NOTIFICATION_OPEN_EVENT, { detail: { paneId: detail.paneId, target, ...(found?.url ? { url: found.url } : {}) } }));
            await wait(50);
            if (focusRun.current === run && focusPane(detail.paneId, handoff, record?.kind === "QUESTION", record?.link.target)) break;
          } else await wait(50);
        }
        if (target && HANDOFF_MODES.has(pane.mode)) await revealNeed(detail.paneId, target, () => focusRun.current === run);
      })();
    } catch (failure) {
      // Operator nous_msg:4031716d (9/11): a failed Go never takes him back (he was typing there 5 s later); Back to Nous is his click.
      if (latest.current.selectedRoomId === detail.roomId) {
        const stayed: Visit = { origin, roomId: detail.roomId, paneId: detail.paneId, maximizedByUs: false, notificationId: record?.id ?? null, terminal: false, record: record ?? null };
        visitRef.current = stayed;
        setVisit(stayed);
      } else if (!visitRef.current) announceNousFocusPhase("back");
      // While Space restarts the room's panes do not load: that pane is not gone, so say so and go again when Space answers.
      const restarting = getCoreApiOutage() !== null;
      if (restarting) setRetry(detail);
      setError(restarting ? "SpaceApp is updating… reconnecting" : failure instanceof Error ? failure.message : "The pane could not be opened. Please try again.");
    } finally {
      navigating.current = false;
      // Let the shell's own state settle before watching for the operator moving away.
      window.setTimeout(() => setMoving(false), 300);
    }
  }, []);

  useEffect(() => {
    if (outage || !retry) return;
    setRetry(null);
    void go(retry);
  }, [outage, retry, go]);

  const back = useCallback(async () => {
    if (navigating.current) return;
    const current = visitRef.current;
    if (!current) return;
    navigating.current = true;
    const returnRun = ++focusRun.current;
    visitRef.current = null;
    setVisit(null);
    setMoving(true);
    try {
      releaseBrowser(current.paneId);
      const target = paneOf(current.paneId);
      if (current.maximizedByUs && target?.isMaximized) await latest.current.toggleMaximize(target);
      const { origin } = current;
      if (origin.roomId && latest.current.selectedRoomId !== origin.roomId) await latest.current.selectRoom(origin.roomId);
      const earlier = paneOf(origin.maximizedPaneId);
      if (earlier && !earlier.isMaximized) await latest.current.toggleMaximize(earlier);
      latest.current.selectPane(origin.paneId);
      if (origin.surfaceOpen) latest.current.sideSurfaces.openSideSurface(origin.surface);
      announceNousFocusPhase("back");
      // The preserved Needs you view is back. Return keyboard focus and scroll to the card that started the visit.
      void (async () => {
        for (let tries = 0; tries < 20 && !visitRef.current && focusRun.current === returnRun; tries += 1) {
          const card = [...document.querySelectorAll<HTMLElement>("[data-notification-id]")].find((element) => element.dataset.notificationId === origin.notificationId);
          if (card && (typeof card.checkVisibility !== "function" || card.checkVisibility({ visibilityProperty: true }))) {
            card.scrollIntoView?.({ block: "nearest" });
            const control = card.querySelector<HTMLElement>("button, input");
            control?.focus({ preventScroll: true });
            if (control && document.activeElement === control) break;
          }
          await wait(50);
        }
      })();
    } catch (failure) {
      setVisit(current);
      setError(failure instanceof Error ? failure.message : "Could not return. Please try Back again.");
    } finally {
      navigating.current = false;
      window.setTimeout(() => setMoving(false), 300);
    }
  }, []);

  // Requests: his click (immediate) goes at once; a delivered needs-you (this owner's, a visible tab; delivery checked the device setting) only
  // shows in the small window, never moving anything.
  useEffect(() => {
    const onFocus = (event: Event) => {
      const detail = atBrowserPage((event as CustomEvent<NousFocusDetail>).detail);
      if (!detail) return;
      if (detail.notification) shown.current.add(detail.notification.id);
      const place = placeOf(detail, paneOf(detail.paneId)?.mode);
      if (detail.immediate && place) { void go(detail); return; }
      if (!detail.notification || document.visibilityState !== "visible") return;
      const shell = latest.current;
      const current = visitRef.current;
      if (place) {
        // A visit there shows the newest request on its bar; the window still asks unless he is looking at the pane with nothing over it
        // (6/11: Kate's PayPal code came during the visit Leo's sign-in left on that browser, the Nous dock open, and nothing asked him).
        if (current?.paneId === detail.paneId) setVisit({ ...current, notificationId: detail.notification.id, record: detail.notification });
        if (shell.selectedRoomId === detail.roomId && shell.selectedPaneId === detail.paneId && !shell.sideSurfaces.isSideSurfaceOpen && !paneOf(detail.paneId)?.isMinimized) return;
      }
      pushNeedsYouPeek(detail.notification);
    };
    window.addEventListener(NOUS_FOCUS_EVENT, onFocus);
    return () => window.removeEventListener(NOUS_FOCUS_EVENT, onFocus);
  }, [go]);

  // The Nous app's Go now on a browser card opens Space with ?needsYou=<id> (operator nous_msg:4b36b80e): his tap there is the click that goes.
  const signedIn = shell.signedIn ?? true;
  const hasRooms = shell.rooms.length > 0;
  useEffect(() => {
    if (!signedIn || !hasRooms) return;
    const url = new URL(window.location.href);
    const id = url.searchParams.get("needsYou");
    if (!id) return;
    url.searchParams.delete("needsYou");
    window.history.replaceState(window.history.state, "", url);
    void api.notification(id).then(({ notification }) => goToNeedsYouPane(notification)).catch(() => undefined);
  }, [signedIn, hasRooms]);

  // A request this tab did not show (hidden, no stream, not open yet) is offered from the records: the newest open one, once each.
  useEffect(() => {
    const offerPending = () => {
      if (document.visibilityState !== "visible" || !readNousFocusEnabled()) return;
      const store = peekNotificationStore();
      if (!store.loaded) return;
      const missed = store.items.filter((item) => openNeedsYou(item) && !shown.current.has(item.id) && item.roomId && item.paneId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (missed) requestNousFocus({ roomId: missed.roomId!, paneId: missed.paneId!, immediate: false, notification: missed });
    };
    const check = () => { if (document.visibilityState === "visible") void refreshNotifications().then(offerPending); };
    let offeredOnLoad = false;
    const onStore = () => { if (!offeredOnLoad && peekNotificationStore().loaded) { offeredOnLoad = true; offerPending(); } };
    document.addEventListener("visibilitychange", check);
    window.addEventListener(NOUS_FOCUS_CHECK_EVENT, check);
    const unsubscribe = subscribeNotificationStore(onStore);
    onStore();
    return () => { document.removeEventListener("visibilitychange", check); window.removeEventListener(NOUS_FOCUS_CHECK_EVENT, check); unsubscribe(); };
  }, []);

  // The operator moving away themselves (another room, the pane no longer maximized) ends the visit without going back. A closed pane keeps
  // the bar ("The pane closed", Back): nothing moves his screen without his click.
  const target = visit ? paneOf(visit.paneId) : null;
  const paneClosed = !target || target.isClosed;
  useEffect(() => {
    if (!visit || moving) return;
    if (shell.selectedRoomId !== visit.roomId || (!paneClosed && visit.maximizedByUs && !target!.isMaximized)) {
      ++focusRun.current; releaseBrowser(visit.paneId); setVisit(null); announceNousFocusPhase("stay");
    }
  }, [visit, shell.selectedRoomId, target, paneClosed, moving]);

  // His Enter inside the terminal pane answers the card there: it is acknowledged (he goes back with Back).
  useEffect(() => {
    if (!visit?.notificationId || !visit.terminal) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      const pane = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-space-pane-id]") : null;
      if (pane?.dataset.spacePaneId === visit.paneId) void ackNotification(visit.notificationId!);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [visit]);

  const room = (id: string | null) => latest.current.rooms.find((entry) => entry.id === id)?.name ?? t("the room");
  return (
    <>
      {error ? <div className="nous-focus-banner" role="alert"><span className="nous-focus-text">{t(error)}</span><button type="button" onClick={() => { setError(null); setRetry(null); }}>{t("Dismiss")}</button></div> : null}
      {visit ? (
        <FocusBar key={visit.notificationId ?? "here"} language={language} agents={agents} closed={paneClosed}
          record={visit.notificationId ? stored.find((item) => item.id === visit.notificationId) ?? visit.record : null}
          backLabel={t("Back to {where}", { where: visit.origin.surfaceOpen && visit.origin.surface === "nous" ? "Nous" : room(visit.origin.roomId) })}
          onBack={() => void back()} onStay={() => { ++focusRun.current; setVisit(null); announceNousFocusPhase("stay"); }} />
      ) : null}
    </>
  );
}

const STEP_LINE = /^\s*(?:•\s*)?(?:(?:Step|Βήμα)\s+)?\d+\s*[.):]\s/i;
const STEPS_SHOWN = 3;

/**
 * "Back to Nous" with the card that brought the operator here, closed: Back, its title on one line, ⌄ for its question and answers, × to stay
 * (design §3.4). When the card is answered or resolved the bar says Done; when the pane closes, that it closed. Back is always his click.
 */
function FocusBar({ record, closed, language, agents, backLabel, onBack, onStay }: {
  record: SpaceNotification | null; closed: boolean; language: UiLanguage; agents: UiLanguage; backLabel: string; onBack(): void; onStay(): void;
}) {
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [open, setOpen] = useState(false);
  const translated = record ? needsYouTranslation(record, agents) : null;
  // Going there was the card's "Go now" answer (R27-2); any other answer, or the record settling, is the card done.
  const answer = (record?.payload.answer as { text?: unknown } | undefined)?.text;
  const done = Boolean(record && (settled(record.status) || (answer !== undefined && answer !== NEEDS_YOU_GO_NOW)));
  const card = record && !done && !closed;
  return (
    // data-nous-focus: the proofs press Back, Stay, the card and Details by role, in any language and whatever joins the row.
    <div className={`nous-focus-back${record ? " has-reason" : ""}${done || closed ? " is-done" : ""}`} role="status">
      <div className="nous-focus-row">
        <button type="button" className={done || closed ? "nous-focus-go" : undefined} data-nous-focus="back" onClick={onBack}><ArrowLeft aria-hidden="true" /><span>{backLabel}</span></button>
        {closed ? <span className="nous-focus-title">{t("The pane closed")}</span>
          : done ? <span className="nous-focus-title nous-focus-done"><Check aria-hidden="true" />{t("Done")}</span>
          : record ? <span className="nous-focus-title" data-sensitive-masked="manual">{translated?.title ?? record.title}</span> : null}
        {card ? <button type="button" className="nous-focus-details" data-nous-focus="card" aria-expanded={open} aria-label={t(open ? "Less" : "Details")} title={t(open ? "Less" : "Details")}
          onClick={() => setOpen(!open)}><ChevronDown aria-hidden="true" /></button> : null}
        <button type="button" data-nous-focus="stay" aria-label={t("Stay here")} title={t("Stay here")} onClick={onStay}><X aria-hidden="true" /></button>
      </div>
      {card && open ? <CardAsk record={record} language={language} agents={agents} /> : null}
    </div>
  );
}

/**
 * A needs-you card at a glance (operator 3/11 19:25 BKK «οι περισοτερες πληροφορίες πρεπει να ανοιγουν οταν εγω το επιλεξω αλλιως πρεπει να ειναι
 * ενα μικρο παραθυρο»): its question and answers, sent the way the Needs you card sends them; its text, steps (3, then the rest) and what was
 * checked open on Details. Only shown on a visit, where going there was its Go now.
 */
function CardAsk({ record, language, agents }: { record: SpaceNotification; language: UiLanguage; agents: UiLanguage }) {
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [open, setOpen] = useState(false);
  const [allSteps, setAllSteps] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const translated = needsYouTranslation(record, agents);
  const ask = needsYouAsk(record);
  const own = record.body.lastIndexOf(NEEDS_YOU_CHECKED_HEADER);
  const body = uiServerText(agents, (translated?.body ?? (own < 0 ? record.body : record.body.slice(0, own))).trim());
  let step = 0;
  const lines = body.split("\n").map((line) => ({ line, step: STEP_LINE.test(line) ? ++step : 0 }));
  const shownSteps = allSteps ? step : STEPS_SHOWN;
  const question = translated?.question ?? ask.question ?? "";
  // Going there was the "Go now"; the card's other answers stay.
  const answers: Array<{ key: string; label: string; input: NotificationAnswerInput; primary: boolean }> = (ask.options ?? [])
    .map((option, index) => ({ key: option, label: translated?.options[index] || uiText(agents, option), input: { option }, primary: option === ask.recommended }))
    .filter(({ key }) => key !== NEEDS_YOU_GO_NOW);
  const answer = async (input: NotificationAnswerInput) => {
    setBusy(true);
    setError(null);
    try {
      setSent((await api.answerNotification(record.id, input)).display);
      await refreshNotifications();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const details = Boolean(body) && body !== question;
  return (
    <div className="nous-focus-card">
      {question ? <p className="nous-focus-question" data-sensitive-masked="manual">{question}</p> : null}
      <NeedsYouFiles item={record} />
      {sent ? <p role="status" data-sensitive-masked="manual">{sent}</p> : (
        <div className="nous-focus-answers">
          {answers.map(({ key, label, input, primary }) => (
            <button key={key} type="button" className={primary ? "nous-focus-go" : undefined} disabled={busy} onClick={() => void answer(input)} data-sensitive-masked="manual">{label}</button>
          ))}
          {details ? (
            <button type="button" className="nous-focus-details" data-nous-focus="details" aria-expanded={open} onClick={() => setOpen(!open)}>
              <span>{t("Details")}</span><ChevronDown aria-hidden="true" />
            </button>
          ) : null}
        </div>
      )}
      {open ? (
        <div className="nous-focus-reason" aria-label={t("Details")}>
          <p data-sensitive-masked="manual">{lines.filter((entry) => entry.step <= shownSteps).map((entry) => entry.line).join("\n")}</p>
          {step > STEPS_SHOWN ? <button type="button" className="nous-focus-more" onClick={() => setAllSteps(!allSteps)}>{allSteps ? t("Fewer steps") : t("{count} more steps", { count: step - STEPS_SHOWN })}</button> : null}
        </div>
      ) : null}
      {error ? <p role="alert" data-sensitive-masked="manual">{error}</p> : null}
    </div>
  );
}
