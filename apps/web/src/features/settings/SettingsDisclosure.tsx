import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronRight, CircleHelp, type LucideIcon } from "../ui-theme/app-icons.js";
import "./settings-disclosure.css";

/** Opens the section with this key; a new nonce opens it again (for example from a Dot pane). */
export interface SettingsSectionRequest { key: string; nonce: number }
// Each request opens its section once: Settings remounts every time it opens, and an old request must not replay.
const handledRequests = new Map<string, number>();
/** True the first time this request is seen for `key`. */
export function claimSettingsRequest(key: string, nonce: number): boolean {
  if (handledRequests.get(key) === nonce) return false;
  handledRequests.set(key, nonce);
  return true;
}
const SectionsContext = createContext<{
  active: string | null | undefined;
  setActive: (id: string | null) => void;
  request: SettingsSectionRequest | null;
  query: string;
  revealOnOpen: boolean;
} | null>(null);

export function SettingsSections({ children, request = null, query = "", revealOnOpen = false }: {
  children: ReactNode;
  request?: SettingsSectionRequest | null;
  /** Search text: sections whose title, description, help and keywords miss a word are hidden. */
  query?: string;
  /** Keep a section's header in view when the user opens it (closing the one above shifts the list). */
  revealOnOpen?: boolean;
}) {
  // `undefined` means no section has been interacted with yet; `null` means
  // the user explicitly closed the initially open section.
  const [active, setActive] = useState<string | null | undefined>(undefined);
  return <SectionsContext.Provider value={{ active, setActive, request, query, revealOnOpen }}>{children}</SectionsContext.Provider>;
}

export type SettingsScope = "Your account" | "This browser" | "Selected pane" | "Installation" | "New sessions";

/** Who a change reaches, in plain words. */
export const settingsScopeText: Record<SettingsScope, string> = {
  "Your account": "Only you",
  "This browser": "Only this browser",
  "Selected pane": "The selected pane",
  "Installation": "Everyone on this Space",
  "New sessions": "New sessions only"
};

/** True when every word of the search text appears in one of the texts. */
export function settingsSearchMatches(query: string, texts: Array<string | undefined>): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = texts.filter(Boolean).join(" ").toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** Settings content outside a section (for example a featured card) that search can hide. */
export function SettingsSearchable({ keywords, children }: { keywords: string; children: ReactNode }) {
  const query = useContext(SectionsContext)?.query ?? "";
  return <div className="settings-searchable" hidden={!settingsSearchMatches(query, [keywords])}>{children}</div>;
}

/** A titled group of sections; the stylesheet hides it while search leaves none of them. */
export function SettingsGroup({ groupKey, title, description, children }: {
  /** Lets the fullscreen group list scroll to this group. */
  groupKey?: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className="settings-group" data-settings-group={groupKey} aria-labelledby={`${id}-title`}>
      <header className="settings-group-header">
        <h3 id={`${id}-title`}>{title}</h3>
        <small>{description}</small>
      </header>
      {children}
    </section>
  );
}

/** Mount on first use; retain drafts when another section opens. */
export function SettingsDisclosure({ title, description, help, keywords, scope, icon: Icon, children, hidden = false, initialOpen = false, sectionKey }: {
  /** Lets a request (SettingsSections `request`) open this section. */
  sectionKey?: string;
  hidden?: boolean;
  initialOpen?: boolean;
  title: string;
  description: string;
  /** Plain-language help shown first when the section is open: what it does and when to change it. */
  help?: string;
  /** Extra words that find this section in search. */
  keywords?: string;
  scope: SettingsScope;
  icon: LucideIcon;
  children: ReactNode;
}) {
  const id = useId();
  const sections = useContext(SectionsContext);
  const [localOpen, setLocalOpen] = useState(initialOpen);
  const [visited, setVisited] = useState(initialOpen);
  const open = sections ? (sections.active === undefined ? initialOpen : sections.active === id) : localOpen;
  const sectionRef = useRef<HTMLElement>(null);
  const headerRef = useRef<HTMLHeadingElement>(null);
  const openedByUser = useRef(false);
  const requestNonce = sections?.request?.key === sectionKey ? sections?.request?.nonce : undefined;
  const matches = settingsSearchMatches(sections?.query ?? "", [title, description, help, keywords]);
  useEffect(() => {
    if (!sectionKey || requestNonce === undefined || !claimSettingsRequest(`section:${sectionKey}`, requestNonce)) return;
    setVisited(true);
    if (sections) sections.setActive(id); else setLocalOpen(true);
    sectionRef.current?.scrollIntoView?.({ block: "start" });
  }, [requestNonce]);
  useEffect(() => {
    if (!open || !openedByUser.current) return;
    openedByUser.current = false;
    if (sections?.revealOnOpen) headerRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [open]);
  return (
    <section ref={sectionRef} className="settings-disclosure" data-open={open} data-section={sectionKey} hidden={hidden || !matches}>
      <h3 ref={headerRef}>
        <button type="button" aria-label={title} aria-describedby={`${id}-description`} aria-expanded={open} aria-controls={id} onClick={() => {
          setVisited(true);
          openedByUser.current = !open;
          if (sections) sections.setActive(open ? null : id);
          else setLocalOpen(!open);
        }}>
          <Icon aria-hidden="true" />
          <span><strong>{title}</strong><small id={`${id}-description`}>{description}</small></span>
          <ChevronRight aria-hidden="true" />
        </button>
      </h3>
      <div id={id} hidden={!open} className="settings-disclosure-content">
        {visited ? <>
          {/* Divs, not paragraphs: the Modern theme makes dock paragraphs inherit their colour. */}
          {help ? <div className="settings-help"><CircleHelp aria-hidden="true" /><div>{help}</div></div> : null}
          <div className="settings-scope">Affects: <strong>{settingsScopeText[scope]}</strong></div>
          {children}
        </> : null}
      </div>
    </section>
  );
}
