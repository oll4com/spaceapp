import { useEffect, useState } from "react";
import type { ClipboardItem } from "@space/contracts";
import { api } from "../../api.js";
import { loadBoundedRoomCatalog } from "../rooms-dock/room-catalog.js";

// Who took a plan and where it runs, shared by the Clipboard dock and a CLI pane's Open plans list.

/** "Andy · Room: SpaceApp": the agent (pane) that took the plan and the room it runs in. */
export function planAssignee(plan: ClipboardItem, currentPaneId: string | undefined, roomNames: Map<string, string>): string | null {
  if (!plan.paneId) return null;
  const agent = plan.paneId === currentPaneId ? "this pane" : plan.paneTitle || "another pane";
  const room = plan.roomId ? roomNames.get(plan.roomId) : undefined;
  return room ? `${agent} · Room: ${room}` : agent;
}

/** Asks the workspace to open the room a plan runs in and focus its pane; App listens. */
export const SPACE_OPEN_PLAN_PANE_EVENT = "space:plan-pane:open";

export interface OpenPlanPaneDetail {
  roomId: string;
  paneId: string;
}

export function canOpenPlanPane(plan: ClipboardItem): boolean {
  return Boolean(plan.roomId && plan.paneId);
}

export function openPlanPane(plan: ClipboardItem): void {
  if (!plan.roomId || !plan.paneId) return;
  const detail: OpenPlanPaneDetail = { roomId: plan.roomId, paneId: plan.paneId };
  window.dispatchEvent(new CustomEvent<OpenPlanPaneDetail>(SPACE_OPEN_PLAN_PANE_EVENT, { detail }));
}

/** Room names by id, read each time `enabled` turns on; empty until then or when the read fails. */
export function useRoomNames(enabled: boolean): Map<string, string> {
  const [roomNames, setRoomNames] = useState<Map<string, string>>(() => new Map());
  useEffect(() => {
    if (!enabled || typeof api?.rooms !== "function") return;
    let cancelled = false;
    loadBoundedRoomCatalog().then(
      (rooms) => { if (!cancelled) setRoomNames(new Map(rooms.map((room) => [room.id, room.name]))); },
      () => {}
    );
    return () => { cancelled = true; };
  }, [enabled]);
  return roomNames;
}
