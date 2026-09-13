import { Loader2, RectangleHorizontal } from "../ui-theme/app-icons.js";

/** Id of the minimized panes bar that this control shows and hides. */
export const MINIMIZED_PANE_BAR_ID = "minimized-pane-bar";
/** Id of the control itself, so other surfaces can hand keyboard focus to it. */
export const MINIMIZED_PANE_BAR_TOGGLE_ID = "minimized-pane-bar-toggle";
/** Rail id of the control, matching the other room toolbar / rail buttons. */
export const MINIMIZED_PANE_BAR_TOGGLE_RAIL_ID = "minimized-bar";

export type MinimizedPaneBarToggleProps = {
  /** Number of minimized panes the bar represents. */
  count: number;
  /** How many minimized panes have an active agent run. */
  runningCount: number;
  /** Whether the minimized panes bar is currently visible at the top of the board. */
  expanded: boolean;
  onToggle: () => void;
};

/**
 * Room toolbar control that shows and hides the minimized panes bar.
 *
 * The bar is parked by default, so this control is the only affordance that
 * brings it back. It sits with the other room toolbar buttons, and in the
 * floating rail while the toolbar is hidden, instead of overlapping the pane
 * board. Panes stay unmounted while minimized, so the control never attaches,
 * hydrates or replays a terminal; showing the bar just re-renders the same
 * restore buttons the bar always had.
 */
export function MinimizedPaneBarToggle({
  count,
  runningCount,
  expanded,
  onToggle
}: MinimizedPaneBarToggleProps) {
  const label = `${expanded ? "Hide" : "Show"} minimized panes bar (${count} minimized pane${count === 1 ? "" : "s"})`;

  return (
    <button
      type="button"
      id={MINIMIZED_PANE_BAR_TOGGLE_ID}
      className="room-toolbar-visibility-button minimized-pane-bar-toggle"
      data-rail-id={MINIMIZED_PANE_BAR_TOGGLE_RAIL_ID}
      aria-label={label}
      aria-controls={MINIMIZED_PANE_BAR_ID}
      aria-expanded={expanded}
      title={label}
      data-minimized-count={count}
      data-running-count={runningCount}
      onClick={onToggle}
    >
      <RectangleHorizontal aria-hidden="true" />
      <span className="minimized-pane-bar-toggle-count" aria-hidden="true">
        {count}
      </span>
      {runningCount > 0 ? (
        <Loader2 className="minimized-pane-bar-toggle-run" aria-hidden="true" />
      ) : null}
    </button>
  );
}
