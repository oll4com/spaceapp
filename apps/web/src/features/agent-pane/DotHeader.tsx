import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { type AgentPaneSession, type DotMood, type DotProfile } from "@space/contracts";
import { MoreHorizontal, SquarePen } from "../ui-theme/app-icons.js";
import { DotAvatar, statusMood } from "./DotAvatar.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";

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
  }, [open, menuRef, focusSelector]);
  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && (menuRef.current?.contains(event.target) || triggerRef.current?.contains(event.target))) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", dismissOutside);
    return () => document.removeEventListener("pointerdown", dismissOutside);
  }, [open, menuRef, triggerRef]);
  function close() { setOpen(false); triggerRef.current?.focus(); }
  return { open, setOpen, close };
}

/**
 * The Chat pane header, kept minimal: new conversation on the left, the assistant in the middle,
 * more actions on the right (no call button, operator 23/11). Settings live in SpaceApp.
 */
export function DotHeader({ selected, status, mood, motionActive, onNewConversation, newConversationDisabled,
  actions, unread = 0 }: {
  selected: DotProfile | null; status: string; mood?: DotMood; motionActive: boolean;
  onNewConversation: () => void; newConversationDisabled: boolean;
  actions: DotHeaderAction[]; unread?: number;
}) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [documentVisible, setDocumentVisible] = useState(() => document.visibilityState !== "hidden");
  const moreTrigger = useRef<HTMLButtonElement>(null);
  const moreMenu = useRef<HTMLDivElement>(null);
  const morePopup = usePopupMenu(moreTrigger, moreMenu, "button:not(:disabled)");
  useEffect(() => {
    const update = () => setDocumentVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
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
      <button type="button" className="dots-icon-button" aria-label={t("New conversation")} title={t("New conversation")} disabled={newConversationDisabled}
        onClick={onNewConversation}><SquarePen aria-hidden="true" /></button>
    </div>
    <div className="dots-header-center">
      <div className="dots-identity">
        {selected ? <span className="dots-selected-mascot" data-motion-active={motionActive && documentVisible ? "true" : "false"}>
          <DotAvatar character={selected.appearance.character} mood={mood ?? statusMood(status)} size={32}
            motion={motionActive && documentVisible ? "on" : "off"} />
          {unread ? <span className="dots-unread" aria-hidden="true" /> : null}
        </span> : null}
        <span className="dots-identity-text"><strong>{name}</strong><span className="dots-status" data-status={statusTone(status)}>{t(status)}</span></span>
      </div>
      <span className="sr-only" role="status">{unread ? t("{name}: {status}, {count} unread", { name, status: t(status), count: unread }) : t("{name}: {status}", { name, status: t(status) })}</span>
    </div>
    <div className="dots-header-end">
      <button ref={moreTrigger} type="button" className="dots-icon-button" aria-label={t("More actions")} title={t("More actions")} aria-haspopup="menu"
        aria-expanded={morePopup.open} onClick={() => morePopup.setOpen((value) => !value)}><MoreHorizontal aria-hidden="true" /></button>
      {morePopup.open ? <div ref={moreMenu} className="dots-more-menu" role="menu" aria-label={t("More actions")}>
        {actions.map((action, i) => <button key={action.label} type="button" role="menuitem" disabled={action.disabled}
          onKeyDown={(event) => navigate(event, i, actions.length, 1, morePopup, moreMenu)}
          onClick={() => { morePopup.close(); action.onSelect(); }}>{t(action.label)}</button>)}
      </div> : null}
    </div>
  </header>;
}
