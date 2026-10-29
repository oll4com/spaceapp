import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { NOTIFICATION_SOURCE_LABELS, heldForNous, needsYou, type Pane, type Room, type SpaceNotification } from "@space/contracts";
import { api } from "../../api.js";
import { browserPaneControlHeld, dispatchBrowserPaneActionEvent } from "../browser-pane/events.js";
import { isLiveHandoff } from "../copilot-kit/live-handoff.js";
import { ackNotification, markNotificationRead, peekNotificationStore, refreshNotifications, subscribeNotificationStore } from "../notifications/notification-store.js";
import { ArrowLeft, Nous, X } from "../ui-theme/app-icons.js";
import type { SideSurface } from "../docks/dock-types.js";
import { announceNousFocusPhase, NOUS_FOCUS_CHECK_EVENT, NOUS_FOCUS_EVENT, readNousFocusEnabled, requestNousFocus, type NousFocusDetail } from "./nous-focus-events.js";

export { forwardNousPaneBoardEvents } from "./nous-focus-events.js";
import "./nous-focus.css";

/**
 * Needs you (operator request 2026-10-24; plan clipboard:twwygEtD4uuX before it): a notification on a pane whose kind needs the operator
 * there brings them to it and back. Everything here goes through the shell's own actions (room select as a click, maximize, restore,
 * select pane, open dock): no room, warm or terminal code changes. A banner names the request (source and title) and offers Go now /
 * Not now; it goes by itself 5 s later once the operator has been free for 2 s (not typing, no dialog, Live off). Go maximizes the pane,
 * focuses what needs them (a browser handoff is taken), and the visit ends by itself 2 s after the request resolves (answered, the
 * handoff over, the pane moved on, the operator's Enter in a terminal pane); leaving a pane whose browser the operator holds gives it back.
 * A request no screen showed (a hidden tab, no stream, the app not open yet; stable 2026-10-24) is never lost: the record stays OPEN, and the
 * tab offers the newest open one when it becomes visible, when its stream (re)connects and after its first load, once per record.
 */
export const AUTO_GO_MS = 5_000;
/** After the deadline the operator must have been free this long before the banner goes by itself (no latch: a hold only delays it). */
export const AUTO_GO_FREE_MS = 2_000;
export const AUTO_BACK_MS = 2_000;
export const WAIT_POLL_MS = 3_000;
const TYPING_MS = 2_000;
const LIVE_ON = new Set(["connecting", "active", "listening", "thinking", "speaking"]);
// Only these panes have a browser that can hand off to the operator; asking any other pane would only answer 404.
const HANDOFF_MODES = new Set<Pane["mode"]>(["BROWSER", "YOUTUBE", "JOB_APPLY", "MARKETING_COPILOT", "FREELANCE_COPILOT"]);
// A plain browser pane has no handoff strip: the handoff is taken through the pane's own action.
const BROWSER_ACTION_MODES = new Set<Pane["mode"]>(["BROWSER", "YOUTUBE"]);

export interface NousFocusShell {
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

interface Origin { roomId: string | null; paneId: string | null; maximizedPaneId: string | null; surface: SideSurface; surfaceOpen: boolean }
// ask: what the request needs, shown on the Back pill while the operator is there (stable 2026-10-25: a visit showed nothing of it).
interface Visit { origin: Origin; roomId: string; paneId: string; maximizedByUs: boolean; notificationId: string | null; terminal: boolean; ask: string | null }

let lastKeyAt = 0;
if (typeof window !== "undefined") window.addEventListener("keydown", () => { lastKeyAt = Date.now(); }, true);

/** Why the banner must wait instead of going by itself; null when the operator is free. */
export function nousFocusHold(): string | null {
  const active = document.activeElement as HTMLElement | null;
  // A terminal keeps its hidden input focused all the time: only its recent keys count as typing (2026-10-26: the banner never went).
  const field = active && !active.classList.contains("xterm-helper-textarea") && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName));
  if (Date.now() - lastKeyAt < TYPING_MS || field) return "you are typing";
  if (document.querySelector("dialog[open], [role='dialog'][aria-modal='true'], [role='alertdialog']")) return "a dialog is open";
  if ([...document.querySelectorAll<HTMLElement>("[data-live-status]")].some((element) => LIVE_ON.has(element.dataset.liveStatus ?? ""))) return "Live is on";
  return null;
}

/** The pane's own "needs you" control first (a browser handoff's Take control is pressed for the operator), then its terminal input, then the pane. */
function focusPane(paneId: string): boolean {
  const pane = [...document.querySelectorAll<HTMLElement>("[data-space-pane-id]")].find((element) => element.dataset.spacePaneId === paneId);
  if (!pane) return false;
  const takeControl = pane.querySelector<HTMLElement>(".jc-handoff-strip[data-state='requested'] button");
  if (takeControl) takeControl.click();
  const target = takeControl ?? pane.querySelector<HTMLElement>("textarea.xterm-helper-textarea") ?? pane;
  target.focus({ preventScroll: true });
  pane.scrollIntoView?.({ block: "nearest" });
  return true;
}

/** Leaving a pane whose browser the operator holds gives it back to the agent (operator decision 2026-10-24). */
function releaseBrowser(paneId: string): void {
  if (browserPaneControlHeld(paneId)) dispatchBrowserPaneActionEvent({ paneId, action: "release" });
}

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
const settled = (status: string | undefined) => status === "RESOLVED" || status === "ACKED";
/** An open needs-you record this screen can show now: not held for the operator's morning. */
const openNeedsYou = (item: SpaceNotification) => item.status === "OPEN" && needsYou(item) && !heldForNous(item)
  && !(typeof item.payload?.heldUntil === "string" && Date.parse(item.payload.heldUntil) > Date.now());

export function useNousFocus(shell: NousFocusShell): ReactNode {
  const latest = useRef(shell);
  latest.current = shell;
  const [request, setRequest] = useState<NousFocusDetail | null>(null);
  const [hold, setHold] = useState<string | null>(null);
  const [visit, setVisit] = useState<Visit | null>(null);
  const visitRef = useRef<Visit | null>(null);
  visitRef.current = visit;
  const moving = useRef(false);
  /** Records this screen already offered or went to: a missed request is offered once. */
  const shown = useRef(new Set<string>());
  const paneOf = (id: string | null) => (id ? latest.current.panes.find((pane) => pane.id === id) ?? null : null);

  const go = useCallback(async (detail: NousFocusDetail) => {
    setRequest(null);
    // Going there is seeing it: an open record would be offered again on every other tab and after each reload (only OPEN: the read
    // route would turn a resolved record back into READ).
    const record = detail.notification;
    if (record && (peekNotificationStore().items.find((item) => item.id === record.id) ?? record).status === "OPEN") void markNotificationRead(record.id);
    const shell = latest.current;
    const origin: Origin = visitRef.current?.origin ?? {
      roomId: shell.selectedRoomId, paneId: shell.selectedPaneId,
      maximizedPaneId: shell.panes.find((pane) => pane.roomId === shell.selectedRoomId && pane.isMaximized && !pane.isClosed)?.id ?? null,
      surface: shell.sideSurfaces.activeSideSurface, surfaceOpen: shell.sideSurfaces.isSideSurfaceOpen
    };
    moving.current = true;
    try {
      if (shell.selectedRoomId !== detail.roomId) await shell.selectRoom(detail.roomId);
      // A cold room loads its panes after it is shown.
      for (let tries = 0; tries < 50 && !paneOf(detail.paneId); tries += 1) await wait(100);
      let pane = paneOf(detail.paneId);
      if (!pane || pane.isClosed) return;
      announceNousFocusPhase("go");
      if (pane.isMinimized) { await latest.current.restorePane(pane); pane = paneOf(detail.paneId) ?? pane; }
      const maximizedByUs = !pane.isMaximized;
      if (maximizedByUs) await latest.current.toggleMaximize(pane);
      latest.current.selectPane(detail.paneId);
      // A copilot rail opens the question or review the notification points at (the same convention as a notification click).
      const target = detail.notification?.link.target;
      if (target) window.dispatchEvent(new CustomEvent("space:notification-open", { detail: { paneId: detail.paneId, target } }));
      const same = visitRef.current?.paneId === detail.paneId;
      setVisit({ origin, roomId: detail.roomId, paneId: detail.paneId, maximizedByUs: maximizedByUs || Boolean(same && visitRef.current?.maximizedByUs),
        notificationId: detail.notification?.id ?? null, terminal: (pane.mode ?? "TERMINAL") === "TERMINAL", ask: detail.notification?.body.trim() || null });
      // A plain browser pane's requested handoff is taken for the operator (the pane action queues until the pane mounts).
      if (BROWSER_ACTION_MODES.has(pane.mode) && await api.browserHandoff(detail.paneId).then((result) => result.handoff?.status === "REQUESTED").catch(() => false)) {
        dispatchBrowserPaneActionEvent({ paneId: detail.paneId, action: "handoff", roomId: detail.roomId });
      }
      // The pane mounts or grows a moment later; focus it without holding the visit back.
      void (async () => { for (let tries = 0; tries < 20 && !focusPane(detail.paneId); tries += 1) await wait(50); })();
    } finally {
      // Let the shell's own state settle before watching for the operator moving away.
      window.setTimeout(() => { moving.current = false; }, 300);
    }
  }, []);

  const back = useCallback(async () => {
    const current = visitRef.current;
    if (!current) return;
    setVisit(null);
    moving.current = true;
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
    } finally {
      window.setTimeout(() => { moving.current = false; }, 300);
    }
  }, []);

  // Requests: a delivered needs-you (this owner's, a visible tab; delivery checked the device setting) waits for the banner; a click goes at once.
  useEffect(() => {
    const onFocus = (event: Event) => {
      const detail = (event as CustomEvent<NousFocusDetail>).detail;
      if (!detail) return;
      if (detail.notification) shown.current.add(detail.notification.id);
      if (detail.immediate) { void go(detail); return; }
      if (document.visibilityState !== "visible") return;
      const shell = latest.current;
      const current = visitRef.current;
      // Already there: no banner; the visit follows the newest request so it ends when that one resolves.
      if (current?.paneId === detail.paneId) { setVisit({ ...current, notificationId: detail.notification?.id ?? current.notificationId, ask: detail.notification?.body.trim() || current.ask }); return; }
      if (shell.selectedRoomId === detail.roomId && shell.selectedPaneId === detail.paneId) return;
      setRequest(detail);
    };
    window.addEventListener(NOUS_FOCUS_EVENT, onFocus);
    return () => window.removeEventListener(NOUS_FOCUS_EVENT, onFocus);
  }, [go]);

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

  // The banner goes by itself 5 s later, once the operator has been free for 2 s; a hold only delays it (no latch).
  useEffect(() => {
    if (!request) return;
    const deadline = Date.now() + AUTO_GO_MS;
    let freeSince: number | null = null;
    let gone = false;
    const tick = () => {
      const reason = nousFocusHold();
      setHold(reason);
      const at = Date.now();
      if (reason) freeSince = null;
      else freeSince ??= at;
      if (!gone && at >= deadline && freeSince !== null && at - freeSince >= AUTO_GO_FREE_MS) { gone = true; void go(request); }
    };
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [request, go]);

  // The operator moving away themselves (another room, the pane no longer maximized) ends the visit without going back; a closed pane goes back.
  const target = visit ? paneOf(visit.paneId) : null;
  useEffect(() => {
    if (!visit || moving.current) return;
    if (!target || target.isClosed) { void back(); return; }
    if (shell.selectedRoomId !== visit.roomId || (visit.maximizedByUs && !target.isMaximized)) { releaseBrowser(visit.paneId); setVisit(null); }
  }, [visit, shell.selectedRoomId, target, back]);

  // Back by itself 2 s after the request resolves: answered or handled (the record), or the operator's Enter in the terminal pane (acknowledged here).
  useEffect(() => {
    if (!visit?.notificationId) return;
    const id = visit.notificationId;
    let timer: number | null = null;
    const check = () => {
      if (timer === null && settled(peekNotificationStore().items.find((item) => item.id === id)?.status)) {
        timer = window.setTimeout(() => { if (visitRef.current === visit) void back(); }, AUTO_BACK_MS);
      }
    };
    check();
    const unsubscribe = subscribeNotificationStore(check);
    return () => { unsubscribe(); if (timer !== null) window.clearTimeout(timer); };
  }, [visit, back]);
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

  // Back by itself 2 s after the pane stops waiting (a CLI prompt, a browser handoff); only once it was seen waiting.
  useEffect(() => {
    if (!visit) return;
    let cancelled = false;
    let sawWaiting = false;
    let timer: number | null = null;
    const hasBrowser = HANDOFF_MODES.has(paneOf(visit.paneId)?.mode ?? "TERMINAL");
    const check = async () => {
      if (document.visibilityState === "visible") {
        const [activity, handoff] = await Promise.all([
          api.dashboardAgents(visit.roomId).then((snapshot) => snapshot.activity[visit.paneId] ?? null).catch(() => null),
          hasBrowser ? api.browserHandoff(visit.paneId).then((result) => result.handoff).catch(() => null) : null
        ]);
        if (cancelled) return;
        const waiting = activity === "waiting" || isLiveHandoff(handoff, Date.now());
        if (waiting) sawWaiting = true;
        else if (sawWaiting) {
          timer = window.setTimeout(() => { if (!cancelled && visitRef.current === visit) void back(); }, AUTO_BACK_MS);
          return;
        }
      }
      if (!cancelled) timer = window.setTimeout(() => void check(), WAIT_POLL_MS);
    };
    void check();
    return () => { cancelled = true; if (timer !== null) window.clearTimeout(timer); };
  }, [visit, back]);

  const room = (id: string | null) => latest.current.rooms.find((entry) => entry.id === id)?.name ?? "the room";
  const requested = request ? paneOf(request.paneId) : null;
  const source = request?.notification ? NOTIFICATION_SOURCE_LABELS[request.notification.source] : "";
  // A title that already names its source ("Mail Copilot needs you (…)") is not prefixed again.
  const text = request?.notification ? (request.notification.title.startsWith(source) ? request.notification.title : `${source}: ${request.notification.title}`)
    : request ? `Nous: ${room(request.roomId)} · ${requested ? requested.paneName ?? requested.title : "a pane"} needs you` : "";
  const ask = request?.notification?.body.trim() || null;
  const notNow = () => {
    if (request?.notification) void markNotificationRead(request.notification.id);
    setRequest(null);
  };
  return (
    <>
      {request ? (
        <div className="nous-focus-banner" role="alert" aria-label="Needs you">
          <Nous aria-hidden="true" />
          <span className="nous-focus-text">{text}
            {hold ? <span className="nous-focus-hold"> · waiting: {hold}</span> : null}
            {ask ? <span className="nous-focus-ask" data-sensitive-masked="manual" title={ask}>{ask}</span> : null}</span>
          <button type="button" className="nous-focus-go" onClick={() => void go(request)}>Go now</button>
          <button type="button" onClick={notNow}>Not now</button>
        </div>
      ) : null}
      {visit ? (
        <div className={visit.ask ? "nous-focus-back has-ask" : "nous-focus-back"} role="status">
          {visit.ask ? <p className="nous-focus-ask" data-sensitive-masked="manual">{visit.ask}</p> : null}
          <button type="button" className="nous-focus-go" onClick={() => void back()}><ArrowLeft aria-hidden="true" />Back to {room(visit.origin.roomId)}</button>
          <button type="button" aria-label="Stay here" title="Stay here" onClick={() => setVisit(null)}><X aria-hidden="true" /></button>
        </div>
      ) : null}
    </>
  );
}
