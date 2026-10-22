import { useEffect } from "react";
import type { Pane } from "@space/contracts";
import { api } from "../../api.js";
import { useStableCallback } from "../../render-performance.js";
import { SPACE_OPEN_PLAN_PANE_EVENT, type OpenPlanPaneDetail } from "../clipboard-dock/plan-assignee.js";

/**
 * Opens a pane by id the way an Agents Dashboard entry does (`openPane`: its room, then the pane with focus),
 * for Room Agent links and a plan's "Open pane". A pane outside the loaded ones is read from its room when the
 * room is known; a plan whose pane is gone says so.
 */
export function usePaneOpener(
  knownPanes: () => Pane[],
  openPane: (pane: Pane) => Promise<void>,
  onError: (message: string) => void
): (paneId: string, roomId?: string) => Promise<void> {
  const openById = useStableCallback(async (paneId: string, roomId?: string) => {
    try {
      const pane = knownPanes().find((candidate) => candidate.id === paneId)
        ?? (roomId ? (await api.panes(roomId)).data.find((candidate) => candidate.id === paneId) : undefined);
      if (pane) await openPane(pane);
      else if (roomId) onError("The pane that ran this plan is closed.");
    } catch {
      onError("The pane could not be opened.");
    }
  });

  useEffect(() => {
    const handleOpenPlanPane = (event: Event) => {
      const detail = (event as CustomEvent<OpenPlanPaneDetail>).detail;
      if (detail?.roomId && detail.paneId) void openById(detail.paneId, detail.roomId);
    };
    window.addEventListener(SPACE_OPEN_PLAN_PANE_EVENT, handleOpenPlanPane);
    return () => window.removeEventListener(SPACE_OPEN_PLAN_PANE_EVENT, handleOpenPlanPane);
  }, [openById]);

  return openById;
}
