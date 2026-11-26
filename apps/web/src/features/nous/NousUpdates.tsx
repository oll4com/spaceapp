import { useEffect, useRef } from "react";
import { consumeUpdatesView, NOUS_DONE_OPEN_EVENT } from "./nous-done-events.js";

/**
 * Opens Nous › Inbox when a toast or pop-up asks for the updates view (R73). The update cards themselves are Inbox Threads
 * (`apps/api/src/inbox/service.ts`: an UPDATE event carries the body, full report and links).
 */
export function useUpdatesView(onOpen: () => void): void {
  const callback = useRef(onOpen);
  callback.current = onOpen;
  useEffect(() => {
    const open = () => { if (consumeUpdatesView()) callback.current(); };
    window.addEventListener(NOUS_DONE_OPEN_EVENT, open);
    open();
    return () => window.removeEventListener(NOUS_DONE_OPEN_EVENT, open);
  }, []);
}
