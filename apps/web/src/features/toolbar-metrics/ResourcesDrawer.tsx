import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Activity, X } from "../ui-theme/app-icons.js";
import "./resources-drawer.css";

export function ResourcesDrawer({ children, onClose, triggerRef }: {
  children: ReactNode;
  onClose: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [top, setTop] = useState(64);
  useLayoutEffect(() => {
    const position = () => setTop(Math.max(8, (triggerRef.current?.closest(".board-toolbar")?.getBoundingClientRect().bottom ?? 58) + 6));
    position();
    window.addEventListener("resize", position);
    return () => window.removeEventListener("resize", position);
  }, [triggerRef]);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    headingRef.current?.focus();
    return () => { triggerRef.current?.focus(); };
  }, [triggerRef]);
  const source = triggerRef.current?.closest<HTMLElement>("[data-shell-mode]");
  return createPortal(
    <aside className="resources-drawer" id="resources-drawer" aria-label="Resources" style={{ top }}
      data-ui-theme={source?.dataset.uiTheme} data-color-mode={source?.dataset.colorMode}
      data-room-theme={source?.dataset.roomTheme}
      onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); closeRef.current(); } }}>
      <header className="resources-drawer-header">
        <Activity aria-hidden="true" /><div><h2 ref={headingRef} tabIndex={-1}>Resources</h2>
        <p>Select a metric to see details.</p></div>
        <button type="button" aria-label="Close Resources" onClick={onClose}><X aria-hidden="true" /></button>
      </header>
      <div className="resources-drawer-body">{children}</div>
    </aside>, document.body
  );
}
