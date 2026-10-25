import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Pane, Room } from "@space/contracts";
import { api } from "../../api.js";
import { isLiveHandoff } from "../copilot-kit/live-handoff.js";
import { ArrowLeft, Nous, X } from "../ui-theme/app-icons.js";
import type { SideSurface } from "../docks/dock-types.js";
import { announceNousFocusPhase, NOUS_FOCUS_EVENT, readNousFocusEnabled, type NousFocusDetail } from "./nous-focus-events.js";

export { forwardNousFocusEvents } from "./nous-focus-events.js";
import "./nous-focus.css";

/**
 * Nous brings the operator to a pane that needs them and back (plan clipboard:twwygEtD4uuX). Everything here goes through
 * the shell's own actions (room select as a click, maximize, restore, select pane, open dock): no room, warm or terminal code
 * changes. A banner offers Go now / Not now and goes by itself after 5 s unless the operator is typing, a dialog is open or
 * Live is on; Back (pill) restores the room, pane, maximized pane and dock, also by itself 2 s after the pane stops waiting.
 */
export const AUTO_GO_MS = 5_000;
export const AUTO_BACK_MS = 2_000;
export const WAIT_POLL_MS = 3_000;
const TYPING_MS = 2_000;
const LIVE_ON = new Set(["connecting", "active", "listening", "thinking", "speaking"]);
// Only these panes have a browser that can hand off to the operator; asking any other pane would only answer 404.
const HANDOFF_MODES = new Set<Pane["mode"]>(["BROWSER", "JOB_APPLY", "MARKETING_COPILOT", "FREELANCE_COPILOT"]);

export interface NousFocusShell {
  userId: string | null;
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
interface Visit { origin: Origin; roomId: string; paneId: string; maximizedByUs: boolean }

let lastKeyAt = 0;
if (typeof window !== "undefined") window.addEventListener("keydown", () => { lastKeyAt = Date.now(); }, true);

/** Why the banner must wait for a click instead of going by itself; null when the operator is free. */
export function nousFocusHold(): string | null {
  const active = document.activeElement as HTMLElement | null;
  if (Date.now() - lastKeyAt < TYPING_MS || (active && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)))) return "you are typing";
  if (document.querySelector("dialog[open], [role='dialog'][aria-modal='true'], [role='alertdialog']")) return "a dialog is open";
  if ([...document.querySelectorAll<HTMLElement>("[data-live-status]")].some((element) => LIVE_ON.has(element.dataset.liveStatus ?? ""))) return "Live is on";
  return null;
}

/** The pane's own "needs you" control first (a browser handoff's Take control), then its terminal input, then the pane. */
function focusPane(paneId: string): boolean {
  const pane = [...document.querySelectorAll<HTMLElement>("[data-space-pane-id]")].find((element) => element.dataset.spacePaneId === paneId);
  if (!pane) return false;
  const target = pane.querySelector<HTMLElement>(".jc-handoff-strip[data-state='requested'] button, textarea.xterm-helper-textarea") ?? pane;
  target.focus({ preventScroll: true });
  pane.scrollIntoView?.({ block: "nearest" });
  return true;
}

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

export function useNousFocus(shell: NousFocusShell): ReactNode {
  const latest = useRef(shell);
  latest.current = shell;
  const [request, setRequest] = useState<NousFocusDetail | null>(null);
  const [hold, setHold] = useState<string | null>(null);
  const [visit, setVisit] = useState<Visit | null>(null);
  const visitRef = useRef<Visit | null>(null);
  visitRef.current = visit;
  const moving = useRef(false);
  const paneOf = (id: string | null) => (id ? latest.current.panes.find((pane) => pane.id === id) ?? null : null);

  const go = useCallback(async (detail: NousFocusDetail) => {
    setRequest(null);
    const shell = latest.current;
    const origin: Origin = visitRef.current?.origin ?? {
      roomId: shell.selectedRoomId, paneId: shell.selectedPaneId,
      maximizedPaneId: shell.panes.find((pane) => pane.roomId === shell.selectedRoomId && pane.isMaximized && !pane.isClosed)?.id ?? null,
      surface: shell.sideSurfaces.activeSideSurface, surfaceOpen: shell.sideSurfaces.isSideSurfaceOpen
    };
    moving.current = true;
    try {
      announceNousFocusPhase("go");
      if (shell.selectedRoomId !== detail.roomId) await shell.selectRoom(detail.roomId);
      // A cold room loads its panes after it is shown.
      for (let tries = 0; tries < 50 && !paneOf(detail.paneId); tries += 1) await wait(100);
      let pane = paneOf(detail.paneId);
      if (!pane || pane.isClosed) return;
      if (pane.isMinimized) { await latest.current.restorePane(pane); pane = paneOf(detail.paneId) ?? pane; }
      const maximizedByUs = !pane.isMaximized;
      if (maximizedByUs) await latest.current.toggleMaximize(pane);
      latest.current.selectPane(detail.paneId);
      const same = visitRef.current?.paneId === detail.paneId;
      setVisit({ origin, roomId: detail.roomId, paneId: detail.paneId, maximizedByUs: maximizedByUs || Boolean(same && visitRef.current?.maximizedByUs) });
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

  // Requests: Nous's (this owner, a visible tab, the setting on) wait for the banner; "Take me there" goes at once.
  useEffect(() => {
    const onFocus = (event: Event) => {
      const detail = (event as CustomEvent<NousFocusDetail>).detail;
      if (!detail) return;
      if (detail.immediate) { void go(detail); return; }
      if (detail.ownerUserId !== latest.current.userId || document.visibilityState !== "visible" || !readNousFocusEnabled()) return;
      setRequest(detail);
    };
    window.addEventListener(NOUS_FOCUS_EVENT, onFocus);
    return () => window.removeEventListener(NOUS_FOCUS_EVENT, onFocus);
  }, [go]);

  // The banner goes by itself after 5 s while the operator is free; any hold keeps it until they click.
  useEffect(() => {
    if (!request) return;
    const deadline = Date.now() + AUTO_GO_MS;
    let held = false;
    let gone = false;
    const tick = () => {
      const reason = nousFocusHold();
      setHold(reason);
      held ||= reason !== null;
      if (!held && !gone && Date.now() >= deadline) { gone = true; void go(request); }
    };
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [request, go]);

  // The operator moving away themselves (another room, the pane no longer maximized) ends the visit without going back.
  const target = visit ? paneOf(visit.paneId) : null;
  useEffect(() => {
    if (!visit || moving.current) return;
    if (shell.selectedRoomId !== visit.roomId || !target || target.isClosed || (visit.maximizedByUs && !target.isMaximized)) setVisit(null);
  }, [visit, shell.selectedRoomId, target]);

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
  return (
    <>
      {request ? (
        <div className="nous-focus-banner" role="alert" aria-label="Nous needs you">
          <Nous aria-hidden="true" />
          <span className="nous-focus-text">Nous: {room(request.roomId)} · {requested ? requested.paneName ?? requested.title : "a pane"} needs you
            {hold ? <span className="nous-focus-hold"> · waiting: {hold}</span> : null}</span>
          <button type="button" className="nous-focus-go" onClick={() => void go(request)}>Go now</button>
          <button type="button" onClick={() => setRequest(null)}>Not now</button>
        </div>
      ) : null}
      {visit ? (
        <div className="nous-focus-back" role="status">
          <button type="button" className="nous-focus-go" onClick={() => void back()}><ArrowLeft aria-hidden="true" />Back to {room(visit.origin.roomId)}</button>
          <button type="button" aria-label="Stay here" title="Stay here" onClick={() => setVisit(null)}><X aria-hidden="true" /></button>
        </div>
      ) : null}
    </>
  );
}
