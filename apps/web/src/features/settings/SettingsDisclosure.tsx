import { createContext, useContext, useId, useState, type ReactNode } from "react";
import { ChevronRight, type LucideIcon } from "../ui-theme/app-icons.js";
import "./settings-disclosure.css";

const SectionsContext = createContext<{
  active: string | null;
  setActive: (id: string | null) => void;
} | null>(null);

export function SettingsSections({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<string | null>(null);
  return <SectionsContext.Provider value={{ active, setActive }}>{children}</SectionsContext.Provider>;
}

/** Mount on first use; retain drafts when another section opens. */
export function SettingsDisclosure({ title, description, scope, icon: Icon, children, hidden = false, initialOpen = false }: {
  hidden?: boolean;
  initialOpen?: boolean;
  title: string;
  description: string;
  scope: "This browser" | "Selected pane" | "Installation" | "New sessions";
  icon: LucideIcon;
  children: ReactNode;
}) {
  const id = useId();
  const sections = useContext(SectionsContext);
  const [localOpen, setLocalOpen] = useState(initialOpen);
  const [visited, setVisited] = useState(initialOpen);
  const open = sections ? (sections.active === id || (sections.active === null && initialOpen)) : localOpen;
  return (
    <section className="settings-disclosure" data-open={open} hidden={hidden}>
      <h3>
        <button type="button" aria-label={title} aria-describedby={`${id}-description`} aria-expanded={open} aria-controls={id} onClick={() => {
          setVisited(true);
          if (sections) sections.setActive(open ? null : id);
          else setLocalOpen(!open);
        }}>
          <Icon aria-hidden="true" />
          <span><strong>{title}</strong><small id={`${id}-description`}>{description}</small></span>
          <ChevronRight aria-hidden="true" />
        </button>
      </h3>
      <div id={id} hidden={!open} className="settings-disclosure-content">
        {visited ? <><p className="settings-scope">Applies to: {scope}</p>{children}</> : null}
      </div>
    </section>
  );
}
