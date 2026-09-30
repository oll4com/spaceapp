import { createPortal } from "react-dom";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Search, X, Wrench, Link as LinkIcon, ServerCog, Users, type LucideIcon } from "../ui-theme/app-icons.js";
import { SERVER_ACTIONS_MENU_ID } from "../toolbar-menu-ids.js";
import "./manage.css";
export { SERVER_ACTIONS_MENU_ID } from "../toolbar-menu-ids.js";
export interface ServerActionCommand {
  id: string; label: string; description: string; icon: LucideIcon; onSelect: () => void;
  disabled?: boolean; title?: string; categoryHeader?: string;
}
const groups = [
  { id: "maintenance", label: "Maintenance", detail: "Check, update and clean up", icon: Wrench },
  { id: "connections", label: "Connections", detail: "Tools, accounts and providers", icon: LinkIcon },
  { id: "services", label: "Services", detail: "Services and runtime controls", icon: ServerCog },
  { id: "administration", label: "Administration", detail: "Users, permissions and releases", icon: Users }
] as const;
export function managementGroup(id: string) {
  if (["setup-connections", "codex-lb-speed-control"].includes(id)) return "connections";
  if (["restart-server", "restart-all-cli-runtimes", "system-services"].includes(id)) return "services";
  if (["user-management", "publish-space-release"].includes(id)) return "administration";
  return "maintenance";
}
export function ServerActionsMenu({ actions, onClose, triggerRef, renderAction, initialAction, suspended = false }: {
  actions: ServerActionCommand[]; mobile: boolean; onClose: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
  renderAction?: (id: string, back: () => void) => ReactNode;
  initialAction?: string | null;
  suspended?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<string | null>(initialAction ? managementGroup(initialAction) : null);
  const [selected, setSelected] = useState<string | null>(initialAction ?? null);
  const previousInitialAction = useRef(initialAction);
  useEffect(() => {
    if (previousInitialAction.current === initialAction) return;
    previousInitialAction.current = initialAction;
    setSelected(initialAction ?? null);
    setGroup(initialAction ? managementGroup(initialAction) : null);
  }, [initialAction]);
  const childBusy = () => Boolean(ref.current?.querySelector('[aria-busy="true"]'));
  const close = () => { if (!childBusy()) onClose(); };
  const back = () => { if (!childBusy()) { setSelected(null); setQuery(""); } };
  const content = selected ? renderAction?.(selected, back) : null;
  const source = triggerRef.current?.closest<HTMLElement>("[data-shell-mode]") ?? document.querySelector<HTMLElement>(".space-shell");
  useEffect(() => {
    (ref.current?.querySelector<HTMLInputElement>("input") ?? ref.current?.querySelector<HTMLButtonElement>("button"))?.focus();
    const trigger = triggerRef.current;
    return () => trigger?.focus();
  }, [triggerRef]);
  const filtered = actions.filter(a => a.id !== "system-analytics" && (query
    ? `${a.label} ${a.description} ${a.categoryHeader ?? ""}`.toLowerCase().includes(query.toLowerCase())
    : managementGroup(a.id) === group));
  function activate(action: ServerActionCommand) {
    if (action.disabled) return;
    if (renderAction?.(action.id, back)) setSelected(action.id);
    else { action.onSelect(); }
  }
  return createPortal(<div className="manage-backdrop" style={suspended ? { display: "none" } : undefined} onPointerDown={e => { if (e.target === e.currentTarget) close(); }}>
    <section ref={ref} id={SERVER_ACTIONS_MENU_ID} className="manage-workspace" role="dialog" aria-modal="true" aria-label="Manage"
      data-ui-theme={source?.dataset.uiTheme} data-color-mode={source?.dataset.colorMode} data-room-theme={source?.dataset.roomTheme}
      onKeyDown={e => {
        if (e.key === "Escape") { e.stopPropagation(); if (e.defaultPrevented || childBusy()) return; if (selected) back(); else if (group) setGroup(null); else close(); }
        if (e.key === "Tab") {
          const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href],summary,[tabindex="0"]') ?? []).filter(el => el.getClientRects().length);
          const first = items[0], last = items.at(-1);
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
          if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        }
      }}>
      <header className="manage-header"><div><h2>Manage</h2><p>Tools, services & maintenance</p></div><button type="button" aria-label="Close Manage" onClick={close}><X /></button></header>
      <div className="manage-body">
        {selected && content ? <><button type="button" className="manage-back" onClick={back}>← Back</button>{content}</> : <>
          <label className="manage-search"><Search aria-hidden="true" /><input aria-label="Find an action" placeholder="Find an action…" value={query} onChange={e => setQuery(e.target.value)} /></label>
          {!group && !query ? <div className="manage-groups">{groups.map(g => <button type="button" key={g.id} aria-label={g.label} onClick={() => setGroup(g.id)}><g.icon aria-hidden="true" /><span><strong>{g.label}</strong><small>{g.detail}</small></span></button>)}</div> : <>
            <button type="button" className="manage-back" onClick={() => { setGroup(null); setQuery(""); }}>← All sections</button>
            <div className="manage-actions">{filtered.map(a => <button type="button" key={a.id} aria-label={a.label} disabled={a.disabled} title={a.title} onClick={() => activate(a)}><a.icon aria-hidden="true" /><span><strong>{a.label}</strong><small>{a.description}</small></span></button>)}{!filtered.length && <p>No matching actions.</p>}</div>
          </>}
        </>}
      </div>
    </section>
  </div>, document.body);
}
