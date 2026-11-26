import { needsYouBrowserPage, needsYouPlace, type BrowserPageSummary, type Pane, type SpaceNotification } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import { BROWSER_CONTROL_IDLE_RELEASE_MS, type BrowserControlActivity } from "./browser-control-activity.js";
import { safeBrowserObservationUrl } from "./browser-observation.js";
import type { NotificationService } from "./notifications/service.js";
import { allNotifications } from "./nous/pane-notices.js";

/** How often a pane browser is read while the operator acts in it (the address and title of its active tab, from the browser host). */
export const NEEDS_YOU_PAGE_WATCH_POLL_MS = 3_000;

type Page = { url: string | null; title: string | null };

/** A waiting card whose page is this pane browser: an agent's or Nous's needs-you card that names it, the browser's own handoff card, or a hands
 *  card raised on the browser itself (19/11 REVIEW, Braintrust LOGIN card 01fedf92 on Work/Bob: raise stamps no browserPage on a browser pane). */
export const boundToBrowser = (card: SpaceNotification, browserPaneId: string) => {
  const page = needsYouBrowserPage(card);
  if (page) return page.paneId === browserPaneId;
  return card.paneId === browserPaneId && (card.source === "BROWSER_HANDOFF" || needsYouPlace(card, "BROWSER") === "PANE");
};

/**
 * Operator 20/11 18:25 BKK (Braintrust 2FA): an agent raised a needs-you card and went idle; the operator typed the code in the page through
 * Live Teleport, the page moved on, and nothing woke the agent. Every operator input to a pane browser opens a watch on its active tab until
 * BROWSER_CONTROL_IDLE_RELEASE_MS after the last input (when his lease goes back to the agent); when the tab's address or title moves, every
 * waiting card bound to that browser goes to its CLI pane as a prompt and is marked answered in the page. Only the address (redacted) and
 * title are read, never what was typed. A CLI that is not at a free prompt is told at a later read.
 * shortcut: a step that changes neither address nor title (some single-page apps) is not seen; upgrade to a masked DOM digest if one is missed.
 */
export function createNeedsYouPageWatch(deps: {
  store: Pick<SpaceStore, "getPane" | "getRoom">;
  pages(pane: Pane): Promise<{ pages: BrowserPageSummary[] }>;
  notifications: Pick<NotificationService, "list" | "setStatus">;
  agents?: Pick<BrowserControlActivity, "agentFor">;
  tell(cliPaneId: string, text: string): Promise<void>;
  log(error: unknown, paneId: string): void;
  now?: () => number;
  pollMs?: number;
}) {
  const now = deps.now ?? Date.now;
  const watches = new Map<string, { input: number; before?: Page; told?: Set<string>; busy: boolean; timer?: ReturnType<typeof setInterval> }>();

  /** One read of the browser; true once the watch is over. */
  async function read(paneId: string, watch: { input: number; before?: Page; told?: Set<string> }): Promise<boolean> {
    if (now() - watch.input > BROWSER_CONTROL_IDLE_RELEASE_MS) return true;
    const pane = await deps.store.getPane(paneId);
    if (pane.isClosed) return true;
    const active = (await deps.pages(pane)).pages.find((page) => page.isActive);
    const page = { url: active?.url ?? null, title: active?.title ?? null };
    if (!watch.before) { watch.before = page; return false; }
    if (page.url === watch.before.url && page.title === watch.before.title) return false;
    const owner = (await deps.store.getRoom(pane.roomId)).ownerUserId;
    if (!owner) return true;
    const cards = (await allNotifications(deps.notifications.list, owner, { status: "NEEDS_YOU" })).filter((card) => boundToBrowser(card, paneId));
    const shown = `${safeBrowserObservationUrl(page.url) ?? "a page with no address"}${page.title ? ` ("${page.title}")` : ""}`;
    let left = 0;
    for (const card of cards) {
      const codePane = typeof card.payload?.codePane === "string" ? card.payload.codePane : null;
      const cliPaneId = (card.paneId && card.paneId !== paneId ? card.paneId : null) ?? codePane ?? deps.agents?.agentFor(paneId)?.paneId ?? null;
      try {
        // No agent to wake (a Nous card on a browser nobody drives): the card still closes, so Nous does not tell him again it waits (01fedf92).
        // A card whose prompt went out but whose ACK failed is not told again at the next read (DEV3D-064).
        if (cliPaneId && !watch.told?.has(card.id)) await deps.tell(cliPaneId, `The operator acted in ${pane.paneName ?? pane.title} for your card "${card.title}"; the page now shows ${shown}. `
          + "Read it and continue.");
        (watch.told ??= new Set()).add(card.id);
        await deps.notifications.setStatus(owner, card.id, "ACKED", { answer: { text: `Answered in the page: ${shown}`, at: new Date(now()).toISOString(), routed: "PAGE" } },
          "answered in the page");
      } catch (error) {
        left += 1;
        deps.log(error, paneId);
      }
    }
    return left === 0;
  }

  const stop = (paneId: string) => {
    clearInterval(watches.get(paneId)?.timer);
    watches.delete(paneId);
  };
  const tick = (paneId: string) => {
    const watch = watches.get(paneId);
    if (!watch || watch.busy) return;
    watch.busy = true;
    void read(paneId, watch).then((done) => { if (done) stop(paneId); }, (error: unknown) => { deps.log(error, paneId); })
      .finally(() => { watch.busy = false; });
  };

  return {
    /** Operator input to a pane browser (browserControlActivity.onUse). */
    use(paneId: string): void {
      const watch = watches.get(paneId);
      if (watch) { watch.input = now(); return; }
      const timer = setInterval(() => tick(paneId), deps.pollMs ?? NEEDS_YOU_PAGE_WATCH_POLL_MS);
      timer.unref?.();
      watches.set(paneId, { input: now(), busy: false, timer });
      // The page before this input, read at once.
      tick(paneId);
    },
    close(): void {
      for (const paneId of [...watches.keys()]) stop(paneId);
    }
  };
}
