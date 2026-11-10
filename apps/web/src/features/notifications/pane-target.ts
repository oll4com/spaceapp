import { dispatchBrowserPaneActionEvent } from "../browser-pane/events.js";

/**
 * Go to pane opens the item itself (operator 1/11 11:58 BKK «πρέπει πάντα να βλέπω ακριβώς την σελίδα ή το εμαιλ»): a notification click or
 * Go now sends its link's target ("thread:<account>:<id>", "url:https://…", "question:<id>", …) to the pane as `space:notification-open`.
 * A lazy pane mounts after that event, so a target no pane took is kept for it a short while and handed over when it subscribes; a page
 * target also goes to the pane's browser (its open tab, else a new tab).
 */
export const NOTIFICATION_OPEN_EVENT = "space:notification-open";
// Technical: a cold room loads, then its lazy pane's code; a target older than this is no longer the operator's click.
const PENDING_MS = 15_000;

type Handler = (target: string) => void;
const handlers = new Map<string, Set<Handler>>();
const pending = new Map<string, { target: string; at: number }>();
const shownPages = new Map<string, number>();

/** `pageUrl`: the card's page address, which a `tab:` whose tab is gone opens instead (operator 9/11 13:31 BKK). */
function deliver(paneId: string, target: string, pageUrl?: string) {
  const url = /^url:(https?:\/\/\S+)$/.exec(target)?.[1];
  const tab = /^tab:(\S+)$/.exec(target)?.[1];
  // Go now repeats its target until the pane's answer control is focused: one page opens once (no second new tab).
  const key = `${paneId} ${target}`;
  if ((url || tab) && (shownPages.get(key) ?? 0) < Date.now() - PENDING_MS) {
    shownPages.set(key, Date.now());
    dispatchBrowserPaneActionEvent({ paneId, action: "show_page", ...(url ? { url } : { pageId: tab!, ...(pageUrl ? { url: pageUrl } : {}) }) });
  }
  const listening = handlers.get(paneId);
  if (listening?.size) for (const handler of listening) handler(target);
  else pending.set(paneId, { target, at: Date.now() });
}

if (typeof window !== "undefined") {
  window.addEventListener(NOTIFICATION_OPEN_EVENT, (event) => {
    const detail = (event as CustomEvent<{ paneId?: unknown; target?: unknown; url?: unknown }>).detail;
    if (typeof detail?.paneId === "string" && typeof detail.target === "string" && detail.target) {
      deliver(detail.paneId, detail.target, typeof detail.url === "string" && /^https?:\/\//.test(detail.url) ? detail.url : undefined);
    }
  });
}

/** A pane's handler for the targets sent to it; a target sent before it mounted is handed over at once. Returns the unsubscribe. */
export function onPaneTarget(paneId: string, handler: Handler): () => void {
  const set = handlers.get(paneId) ?? new Set<Handler>();
  set.add(handler);
  handlers.set(paneId, set);
  const waiting = pending.get(paneId);
  pending.delete(paneId);
  if (waiting && Date.now() - waiting.at <= PENDING_MS) handler(waiting.target);
  return () => {
    set.delete(handler);
    if (!set.size) handlers.delete(paneId);
  };
}
