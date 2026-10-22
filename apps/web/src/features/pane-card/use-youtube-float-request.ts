import { useEffect, useRef } from "react";
import type { Pane } from "@space/contracts";

/**
 * Floats a YouTube pane of the active room on request (the Nous dock's full-screen launcher, plan clipboard:wr9yNPJwkDrp;
 * operator-approved Warm change 2026-10-18). It calls the same toggle as the pane's own float button; a room without a
 * YouTube pane gets a new one that opens floating (operator request and approved Warm change 2026-10-18).
 */
export const OPEN_YOUTUBE_FLOAT_EVENT = "space:open-youtube-float";

export function useYouTubeFloatRequest({ panes, activeRoomId, floatingIds, toggle, open }: {
  panes: Pane[]; activeRoomId: string | null; floatingIds: ReadonlySet<string>; toggle(paneId: string): void; open(): void;
}): void {
  // Kept in a ref so the window listener registers once per mount, not again on every App render (Warm A/B 2026-10-18).
  const onRequest = useRef(() => {});
  onRequest.current = () => {
    const youTube = panes.filter((pane) => pane.roomId === activeRoomId && pane.mode === "YOUTUBE" && !pane.isClosed);
    const target = youTube.find((pane) => !floatingIds.has(pane.id));
    if (target) toggle(target.id);
    else if (youTube.length === 0) open();
  };
  useEffect(() => {
    const listener = () => onRequest.current();
    window.addEventListener(OPEN_YOUTUBE_FLOAT_EVENT, listener);
    return () => window.removeEventListener(OPEN_YOUTUBE_FLOAT_EVENT, listener);
  }, []);
}
