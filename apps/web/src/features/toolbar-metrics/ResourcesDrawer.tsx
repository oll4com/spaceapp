import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Activity, X } from "../ui-theme/app-icons.js";
import { dispatchRailMenuChange } from "../rail-popover.js";
import "./resources-drawer.css";

export function ResourcesDrawer({ children, onClose, triggerRef }: {
  children: ReactNode;
  onClose: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [positionStyle, setPositionStyle] = useState<{ top: number; right?: number }>({ top: 64 });
  useLayoutEffect(() => {
    const position = () => {
      const computedTop = Math.max(8, (triggerRef.current?.closest(".board-toolbar")?.getBoundingClientRect().bottom ?? 58) + 6);
      const rail = document.querySelector<HTMLElement>(".room-toolbar-floating-controls");
      if (rail && window.innerWidth >= 768) {
        const railRect = rail.getBoundingClientRect();
        if (railRect.width > 0 && railRect.left > 0) {
          const computedRight = Math.max(8, Math.round(window.innerWidth - railRect.left + 8));
          setPositionStyle({ top: computedTop, right: computedRight });
          dispatchRailMenuChange();
          return;
        }
      }
      setPositionStyle({ top: computedTop });
      dispatchRailMenuChange();
    };
    position();
    window.addEventListener("resize", position);
    return () => {
      window.removeEventListener("resize", position);
      dispatchRailMenuChange();
    };
  }, [triggerRef]);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    headingRef.current?.focus();
    return () => { triggerRef.current?.focus(); };
  }, [triggerRef]);
  const source = triggerRef.current?.closest<HTMLElement>("[data-shell-mode]");
  return createPortal(
    <aside className="resources-drawer" id="resources-drawer" aria-label="Resources"
      style={{ top: positionStyle.top, right: positionStyle.right !== undefined ? `${positionStyle.right}px` : undefined }}
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
