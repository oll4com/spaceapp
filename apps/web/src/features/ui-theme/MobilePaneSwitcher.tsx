import type { Pane } from "@space/contracts";
import { ChevronLeft, ChevronRight } from "./app-icons.js";

export function MobilePaneSwitcher({ panes, activePaneId, onSelect }: {
  panes: readonly Pane[];
  activePaneId: string | undefined;
  onSelect: (paneId: string) => void;
}) {
  if (panes.length < 2) return null;
  const index = Math.max(0, panes.findIndex(pane => pane.id === activePaneId));
  const active = panes[index]!;
  return <div className="mobile-pane-navigation" role="group" aria-label="Room panes">
    <button type="button" aria-label="Previous pane" onClick={() => onSelect(panes[(index + panes.length - 1) % panes.length]!.id)}>
      <ChevronLeft aria-hidden="true" />
    </button>
    <label>
      <span aria-hidden="true">{index + 1} / {panes.length}</span>
      <select aria-label="Choose pane" title={active.title} value={active.id} onChange={event => onSelect(event.target.value)}>
        {panes.map((pane, position) => <option key={pane.id} value={pane.id}>{position + 1}. {pane.title}</option>)}
      </select>
    </label>
    <button type="button" aria-label="Next pane" onClick={() => onSelect(panes[(index + 1) % panes.length]!.id)}>
      <ChevronRight aria-hidden="true" />
    </button>
  </div>;
}
