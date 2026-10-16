import type { MutableRefObject } from "react";
import type { Pane, Turn } from "@space/contracts";
import type { PaneCompletionLifecycleState } from "../../pane-completion-lifecycle.js";
import { PaneModeIcon, displayPaneTitle } from "../pane-card/PaneCard.js";
import { Eye, Grid2X2, Loader2, Minus, Zap } from "../ui-theme/app-icons.js";
import { openManage } from "../server-actions/manage-navigation.js";
import { MINIMIZED_PANE_BAR_ID } from "./MinimizedPaneBarToggle.js";
import { MinimizedPaneChip, MinimizedPanePreviewCard } from "./MinimizedPanePreview.js";
import { formatPaneFullTitle, minimizedPaneSubtitle, paneModeLabel } from "./pane-mode-labels.js";
import type { MinimizedPaneBar as MinimizedPaneBarState } from "./useMinimizedPaneBar.js";

/** The expanded minimized-pane bar: one chip or preview card per pane, then the bar actions. */
export function MinimizedPaneBar({
  bar, visiblePaneCount, paneCompletionLifecycle, turns, restoreRefs, restorePane, minimizeAllPanes, restoreAllPanes, minimizeAllPending,
  restoreAllPending
}: {
  bar: MinimizedPaneBarState;
  visiblePaneCount: number;
  paneCompletionLifecycle: PaneCompletionLifecycleState;
  /** Turns of the active room; a minimized Chat pane shows its latest one. */
  turns: Turn[];
  /** Restore buttons by pane id, for focus after a minimize. */
  restoreRefs: MutableRefObject<Map<string, HTMLButtonElement>>;
  restorePane: (pane: Pane) => Promise<void>;
  minimizeAllPanes: () => Promise<void>;
  restoreAllPanes: () => Promise<void>;
  minimizeAllPending: boolean;
  restoreAllPending: boolean;
}) {
  const { minimizedPanes, cliUpdate, minimizedBarPreviewMode, toggleMinimizedBarPreviewMode } = bar;
  const cliUpdateTitle = !cliUpdate ? "" : !cliUpdate.finished
    ? `Updating ${cliUpdate.label}`
    : cliUpdate.error || cliUpdate.result?.overallStatus === "FAIL" ? "CLI update failed" : "CLI update finished";
  const minimizedPaneRestoreRefs = restoreRefs;
  return (
    <section
      className={`minimized-pane-bar${minimizedBarPreviewMode ? " is-preview-mode" : ""}`}
      id={MINIMIZED_PANE_BAR_ID}
      aria-label="Minimized panes"
    >
      <div className="minimized-pane-items">
        {visiblePaneCount === 0 ? (
          <span className="all-panes-minimized" role="status">All panes minimized</span>
        ) : null}
        {cliUpdate ? (
          <button
            type="button"
            className={`minimized-pane-chip${cliUpdate.finished ? "" : " is-running"}`}
            data-status={cliUpdate.finished ? "done" : "working"}
            aria-label={`Restore ${cliUpdateTitle}`}
            title={cliUpdateTitle}
            onClick={() => openManage("cli-update-all")}
          >
            <span className="minimized-pane-chip-icon" aria-hidden="true"><Zap /></span>
            <span className="minimized-pane-chip-label">{cliUpdateTitle}</span>
            {cliUpdate.finished ? null : <Loader2 className="minimized-pane-run-indicator" aria-hidden="true" />}
          </button>
        ) : null}
        {minimizedPanes.map((pane) => {
          const paneRunActive =
            paneCompletionLifecycle.panes[pane.id]?.activeRunKey != null;
          const fullTitle = formatPaneFullTitle(pane);
          const latestTurn = pane.mode === "CHAT" ? turns.find((t) => t.paneId === pane.id) ?? null : null;
          if (minimizedBarPreviewMode) {
            return (
              <MinimizedPanePreviewCard
                key={pane.id}
                pane={pane}
                icon={<PaneModeIcon pane={pane} />}
                title={displayPaneTitle(pane)}
                subtitle={minimizedPaneSubtitle(pane)}
                fullTitle={fullTitle}
                modeLabel={paneModeLabel(pane.mode)}
                isRunning={paneRunActive}
                latestTurn={latestTurn}
                onRestore={() => void restorePane(pane)}
              />
            );
          }
          return (
            <MinimizedPaneChip
              key={pane.id}
              pane={pane}
              icon={<PaneModeIcon pane={pane} />}
              title={displayPaneTitle(pane)}
              fullTitle={fullTitle}
              isRunning={paneRunActive}
              latestTurn={latestTurn}
              buttonRef={(element) => {
                if (element) minimizedPaneRestoreRefs.current.set(pane.id, element);
                else minimizedPaneRestoreRefs.current.delete(pane.id);
              }}
              onRestore={() => void restorePane(pane)}
            />
          );
        })}
      </div>
      <div className="minimized-pane-bar-actions">
        <button
          type="button"
          className={`minimized-preview-toggle${minimizedBarPreviewMode ? " is-active" : ""}`}
          aria-label={minimizedBarPreviewMode ? "Collapse pane preview" : "Expand pane preview"}
          title={minimizedBarPreviewMode ? "Collapse pane preview" : "Expand pane preview"}
          aria-pressed={minimizedBarPreviewMode}
          onClick={toggleMinimizedBarPreviewMode}
        >
          <Eye aria-hidden="true" />
        </button>
        <button
          type="button"
          className="minimize-all-panes"
          aria-label="Minimize all visible panes"
          title="Minimize all visible panes"
          disabled={minimizeAllPending || visiblePaneCount === 0}
          onClick={() => void minimizeAllPanes()}
        >
          <Minus aria-hidden="true" />
        </button>
        <button
          type="button"
          className="restore-all-panes"
          aria-label="Restore all minimized panes"
          title="Restore all minimized panes"
          aria-busy={restoreAllPending}
          disabled={restoreAllPending}
          onClick={() => void restoreAllPanes()}
        >
          <Grid2X2 aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
