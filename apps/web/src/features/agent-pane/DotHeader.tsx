import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { dotPersonalities, type AgentPaneSession, type DotMood, type DotProfile } from "@space/contracts";
import { ChevronDown, MoreHorizontal, PanelRight, Phone, Settings, SquarePen } from "../ui-theme/app-icons.js";
import { DotAvatar, statusMood } from "./DotAvatar.js";

const artwork: Record<DotProfile["appearance"]["character"], string> = {
  astronaut: "orbit", star: "nova", robot: "byte", comet: "comet", moon: "luna", planet: "cosmo"
};
export function dotArtwork(dot: DotProfile): string { return `/dots/${artwork[dot.appearance.character]}.svg`; }
export function dotStatus(session: AgentPaneSession | null, unavailable = false, goalStatus?: string): string {
  if (unavailable || !session) return "Status unavailable";
  if (session.pendingRequest?.kind === "APPROVAL") return "Waiting for approval";
  if (["QUEUED", "RUNNING", "INTERRUPTING"].includes(session.runStatus)
    || session.latestRun?.status === "QUEUED" || session.latestRun?.status === "RUNNING") return "Working";
  if (session.goal?.status === "paused" || goalStatus === "PAUSED") return "Paused";
  // An active server Goal is working between its steps.
  if (goalStatus === "ACTIVE") return "Working";
  if (session.runtimeState === "UNAVAILABLE") return "Offline";
  if (session.runtimeState === "AVAILABLE" && session.binding.status === "READY" && !session.pendingRequest && session.goal?.status !== "active") return "Ready";
  return "Status unavailable";
}
// Visual tone only; the status text remains the accessible source of truth.
function statusTone(status: string): "ready" | "working" | "waiting" | "paused" | "offline" | "unknown" {
  return status === "Ready" ? "ready" : status === "Working" ? "working" : status === "Waiting for approval" ? "waiting"
    : status === "Paused" ? "paused" : status === "Offline" ? "offline" : "unknown";
}

export interface DotHeaderAction { label: string; onSelect: () => void; disabled?: boolean }

/** Closes a popup menu on outside pointer, Escape or Tab, and returns focus to its trigger. */
function usePopupMenu(triggerRef: RefObject<HTMLButtonElement | null>, menuRef: RefObject<HTMLDivElement | null>, focusSelector: string) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLButtonElement>(focusSelector)?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && (menuRef.current?.contains(event.target) || triggerRef.current?.contains(event.target))) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", dismissOutside);
    return () => document.removeEventListener("pointerdown", dismissOutside);
  }, [open]);
  function close() { setOpen(false); triggerRef.current?.focus(); }
  return { open, setOpen, close };
}

/**
 * The Dot pane header, like ChatGPT dot: new conversation on the left, the Dot (and its menu of
 * Dots) in the middle, more actions, call and the info card on the right. Settings live in SpaceApp.
 */
export function DotHeader({ dots, selected, status, mood, blocked, motionActive, onSelect, onManage, onNewConversation, newConversationDisabled,
  onCall, callDisabledReason, panelOpen, onTogglePanel, actions, unread = 0 }: {
  dots: DotProfile[]; selected: DotProfile | null; status: string; mood?: DotMood; blocked: boolean; motionActive: boolean;
  onSelect: (dot: DotProfile) => void; onManage: () => void;
  onNewConversation: () => void; newConversationDisabled: boolean;
  onCall: () => void; callDisabledReason: string | null;
  panelOpen: boolean; onTogglePanel: () => void;
  actions: DotHeaderAction[]; unread?: number;
}) {
  const [documentVisible, setDocumentVisible] = useState(() => document.visibilityState !== "hidden");
  const dotTrigger = useRef<HTMLButtonElement>(null);
  const dotMenu = useRef<HTMLDivElement>(null);
  const moreTrigger = useRef<HTMLButtonElement>(null);
  const moreMenu = useRef<HTMLDivElement>(null);
  const dotsPopup = usePopupMenu(dotTrigger, dotMenu, `[aria-checked="true"]`);
  const morePopup = usePopupMenu(moreTrigger, moreMenu, "button:not(:disabled)");
  useEffect(() => {
    const update = () => setDocumentVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  useEffect(() => {
    if (blocked) dotsPopup.setOpen(false);
  }, [blocked]);
  function navigate(event: KeyboardEvent, index: number, count: number, columns: number, popup: ReturnType<typeof usePopupMenu>, menu: RefObject<HTMLDivElement | null>) {
    const moves: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns };
    if (event.key === "Escape") { event.preventDefault(); popup.close(); return; }
    if (event.key === "Tab") { popup.close(); return; }
    const delta = moves[event.key];
    if (delta === undefined && !["Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? count - 1 : (index + (delta ?? 0) + count) % count;
    menu.current?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
  }
  const name = selected?.name ?? "Dots";
  return <header className="dots-header">
    <div className="dots-header-start">
      <button type="button" className="dots-icon-button" aria-label="New conversation" title="New conversation" disabled={newConversationDisabled}
        onClick={onNewConversation}><SquarePen aria-hidden="true" /></button>
    </div>
    <div className="dots-header-center">
      <button ref={dotTrigger} type="button" className="dots-identity" aria-label={`Choose Dot (${name})`} aria-haspopup="menu" aria-expanded={dotsPopup.open}
        title={blocked ? "Finish or stop the current action before switching Dots." : "Choose Dot"}
        disabled={blocked || dots.length !== 6} onClick={() => dotsPopup.setOpen((value) => !value)}>
        {selected ? <span className="dots-selected-mascot" data-motion-active={motionActive && documentVisible ? "true" : "false"}>
          <DotAvatar character={selected.appearance.character} mood={mood ?? statusMood(status)} size={32}
            motion={motionActive && documentVisible ? "on" : "off"} />
          {unread ? <span className="dots-unread" aria-hidden="true" /> : null}
        </span> : null}
        <span className="dots-identity-text"><strong>{name}</strong><span className="dots-status" data-status={statusTone(status)}>{status}</span></span>
        <ChevronDown aria-hidden="true" />
      </button>
      <span className="sr-only" role="status">{`${name}: ${status}${unread ? `, ${unread} unread` : ""}`}</span>
      {dotsPopup.open ? <div ref={dotMenu} className="dots-choice-menu" role="menu" aria-label="Dots">
        {dots.map((dot, i) => <button key={dot.dotId} type="button" role="menuitemradio" aria-checked={selected?.dotId === dot.dotId} aria-label={`Select ${dot.name}`}
          title={dotPersonalities[dot.appearance.character].archetype}
          onKeyDown={(event) => navigate(event, i, dots.length + 1, 3, dotsPopup, dotMenu)} onClick={() => { dotsPopup.close(); onSelect(dot); }}>
          <DotAvatar character={dot.appearance.character} size={36} motion="hover" /><span>{dot.name}</span>
        </button>)}
        <button type="button" role="menuitem" className="dots-choice-manage" onKeyDown={(event) => navigate(event, dots.length, dots.length + 1, 3, dotsPopup, dotMenu)}
          onClick={() => { dotsPopup.close(); onManage(); }}><Settings aria-hidden="true" /><span>Manage Dots in Settings</span></button>
      </div> : null}
    </div>
    <div className="dots-header-end">
      <button ref={moreTrigger} type="button" className="dots-icon-button" aria-label="More actions" title="More actions" aria-haspopup="menu"
        aria-expanded={morePopup.open} onClick={() => morePopup.setOpen((value) => !value)}><MoreHorizontal aria-hidden="true" /></button>
      {morePopup.open ? <div ref={moreMenu} className="dots-more-menu" role="menu" aria-label="More actions">
        {actions.map((action, i) => <button key={action.label} type="button" role="menuitem" disabled={action.disabled}
          onKeyDown={(event) => navigate(event, i, actions.length, 1, morePopup, moreMenu)}
          onClick={() => { morePopup.close(); action.onSelect(); }}>{action.label}</button>)}
      </div> : null}
      <button type="button" className="dots-icon-button" aria-label={`Call ${name}`} title={callDisabledReason ?? `Call ${name}`}
        disabled={Boolean(callDisabledReason)} onClick={onCall}><Phone aria-hidden="true" /></button>
      <button type="button" className="dots-icon-button" aria-label={`${name} details`} title={panelOpen ? "Hide details" : "Show details"}
        aria-pressed={panelOpen} onClick={onTogglePanel}><PanelRight aria-hidden="true" /></button>
    </div>
  </header>;
}
