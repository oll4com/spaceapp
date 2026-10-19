import { useEffect } from "react";
import type { Pane } from "@space/contracts";

/**
 * Floats an open YouTube pane of the active room on request (the Nous dock's full-screen launcher, plan clipboard:wr9yNPJwkDrp;
 * operator-approved Warm change 2026-10-18). It calls the same toggle as the pane's own float button and never opens a pane.
 */
export const OPEN_YOUTUBE_FLOAT_EVENT = "space:open-youtube-float";
export const YOUTUBE_FLOAT_RESULT_EVENT = "space:youtube-float-result";

export function useYouTubeFloatRequest({ panes, activeRoomId, floatingIds, toggle }: {
  panes: Pane[]; activeRoomId: string | null; floatingIds: ReadonlySet<string>; toggle(paneId: string): void;
}): void {
  useEffect(() => {
    const onRequest = () => {
      const target = panes.find((pane) => pane.roomId === activeRoomId && pane.mode === "YOUTUBE" && !pane.isClosed && !floatingIds.has(pane.id));
      if (target) toggle(target.id);
      window.dispatchEvent(new CustomEvent(YOUTUBE_FLOAT_RESULT_EVENT, { detail: { opened: Boolean(target) } }));
    };
    window.addEventListener(OPEN_YOUTUBE_FLOAT_EVENT, onRequest);
    return () => window.removeEventListener(OPEN_YOUTUBE_FLOAT_EVENT, onRequest);
  }, [panes, activeRoomId, floatingIds, toggle]);
}
