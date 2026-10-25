import { useEffect, useRef } from "react";
import type { Pane } from "@space/contracts";
import { modeIcons } from "../pane-card/pane-mode-icons.js";
import { displayPaneTitle } from "../pane-card/PaneCard.js";

/** Phone bottom bar: one chip per room pane; a tap shows that pane (the title swipe does the same). */
export function MobilePaneSwitcher({ panes, activePaneId, onSelect }: {
  panes: readonly Pane[];
  activePaneId: string | undefined;
  onSelect: (paneId: string) => void;
}) {
  const activeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activePaneId]);
  if (panes.length < 2) return null;
  return <nav className="mobile-pane-bar" aria-label="Room panes">
    {panes.map((pane) => {
      const Icon = modeIcons[pane.mode];
      const title = displayPaneTitle(pane);
      const active = pane.id === activePaneId;
      return <button key={pane.id} ref={active ? activeRef : undefined} type="button" aria-current={active ? "true" : undefined} title={title} onClick={() => onSelect(pane.id)}>
        <Icon aria-hidden="true" />
        <span>{title}</span>
      </button>;
    })}
  </nav>;
}
