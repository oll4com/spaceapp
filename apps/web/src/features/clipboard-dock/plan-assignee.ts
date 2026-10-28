import { useEffect, useState } from "react";
import type { ClipboardItem } from "@space/contracts";
import { api } from "../../api.js";
import { loadBoundedRoomCatalog } from "../rooms-dock/room-catalog.js";

// Who took a plan and where it runs, shared by the Clipboard dock and a CLI pane's Open plans list.

/** "Andy · Room: SpaceApp": the agent (pane) that took the plan and the room it runs in. */
export function planAssignee(plan: ClipboardItem, currentPaneId: string | undefined, roomNames: Map<string, string>,
  openPanes: Map<string, string> | null = null): string | null {
  if (!plan.paneId) return null;
  // A plan keeps its pane's old name after the pane closes: once the open panes are read, name the pane as it is now or say it closed.
  const name = openPanes ? openPanes.get(plan.paneId) : plan.paneTitle;
  const agent = plan.paneId === currentPaneId ? "this pane" : openPanes && !name ? "a closed pane" : name || "another pane";
  const room = plan.roomId ? roomNames.get(plan.roomId) : undefined;
  return room ? `${agent} · Room: ${room}` : agent;
}

/** The plan is on an open pane: this one or one of `openPanes` (until those are read, any linked pane counts). */
export function planOnOpenPane(plan: ClipboardItem, currentPaneId: string | undefined, openPanes: Map<string, string> | null): boolean {
  return Boolean(plan.paneId) && (plan.paneId === currentPaneId || !openPanes || openPanes.has(plan.paneId!));
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

/** Open panes' names by id in the rooms of `roomNames`; null until read or when a read fails (plans show their stored pane name then). */
export function useOpenPaneNames(roomNames: Map<string, string>): Map<string, string> | null {
  const [openPanes, setOpenPanes] = useState<Map<string, string> | null>(null);
  useEffect(() => {
    if (!roomNames.size || typeof api?.panes !== "function") return;
    let cancelled = false;
    Promise.all([...roomNames.keys()].map((roomId) => api.panes(roomId))).then(
      (pages) => { if (!cancelled) setOpenPanes(new Map(pages.flatMap((page) => page.data.map((pane) => [pane.id, pane.paneName ?? pane.title] as const)))); },
      () => {}
    );
    return () => { cancelled = true; };
  }, [roomNames]);
  return openPanes;
}
