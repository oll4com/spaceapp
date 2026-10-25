import { SpaceNotFoundError, type SpaceStore } from "@space/runtime";
import type { BrowserSessionManager } from "./browser-sessions.js";

// Coordinate tab operations at the API boundary so preserved Browser Hosts
// receive the same lifecycle semantics as the in-process runtime.
export function withBrowserPageLifecycle<T extends BrowserSessionManager>(manager: T, store: Pick<SpaceStore, "getLatestPaneBrowserSession" | "updatePaneBrowserSession">): T {
  if (!manager.listPages || !manager.createPage || !manager.activatePage || !manager.closePage) return manager;
  const start = manager.startOrRestore.bind(manager);
  const list = manager.listPages.bind(manager);
  const create = manager.createPage.bind(manager);
  const activate = manager.activatePage.bind(manager);
  const close = manager.closePage.bind(manager);
  const emptyPages = async (paneId: string) => {
    const prior = await store.getLatestPaneBrowserSession(paneId);
    return prior?.status === "CLOSED" && !prior.isActive
      ? { sessionId: prior.sessionId, activePageId: null, pages: [] }
      : null;
  };
  const queues = new Map<string, Promise<unknown>>();

  function ordered<R>(paneId: string, operation: () => Promise<R>): Promise<R> {
    const next = (queues.get(paneId) ?? Promise.resolve()).catch(() => undefined).then(operation);
    queues.set(paneId, next);
    const cleanup = () => { if (queues.get(paneId) === next) queues.delete(paneId); };
    void next.then(cleanup, cleanup);
    return next;
  }

  return {
    ...manager,
    startOrRestore: (input, context) => ordered(input.pane.id, async () => {
      const prior = await store.getLatestPaneBrowserSession(input.pane.id);
      const response = await start(input, context);
      if (input.targetUrl !== "about:blank" || prior?.sessionId === response.session.sessionId) return response;
      // Preserved hosts launch Chrome with a blank startup page and attach a
      // second blank target. An explicit new-tab start must expose one tab.
      // Existing sessions and their intentional background tabs are untouched.
      let current = await list(input.pane);
      for (const page of current.pages.filter(page => page.pageId !== current.activePageId && page.url === "about:blank" && !page.openerPageId)) {
        current = await close(input.pane, page.pageId, input.traceId, context);
      }
      return { ...response, session: { ...response.session, pages: current.pages, activePageId: current.activePageId } };
    }),
    listPages: (pane) => ordered(pane.id, async () => (await emptyPages(pane.id)) ?? list(pane)),
    createPage: (pane, url, selected, traceId, context) => ordered(pane.id, () => create(pane, url, selected, traceId, context)),
    activatePage: (pane, pageId, traceId, context) => ordered(pane.id, () => activate(pane, pageId, traceId, context)),
    closePage: (pane, pageId, traceId, context) => ordered(pane.id, async () => {
      const current = (await emptyPages(pane.id)) ?? await list(pane);
      // A repeated close or a stale tab from before a Chrome restore is done.
      // Never substitute another page for an ID that has already disappeared.
      if (!current.pages.some((page) => page.pageId === pageId)) return current;
      try {
        if (current.pages.length === 1) {
          // Closing the final tab releases this pane's Chrome runtime. Its
          // persistent account profile survives; no hidden replacement target
          // consumes frames or reappears when the user reloads Space.
          await manager.stopPane(pane.id, traceId, context);
          await store.updatePaneBrowserSession(current.sessionId, {
            pages: [], activePageId: null, targetUrl: "about:blank", currentUrl: null,
            title: null, restoreScrollX: null, restoreScrollY: null, restoreVideoPaused: null
          });
          return { sessionId: current.sessionId, activePageId: null, pages: [] };
        } else if (current.activePageId === pageId) {
          const index = current.pages.findIndex((page) => page.pageId === pageId);
          const replacement = current.pages[index + 1] ?? current.pages[index - 1]!;
          // Switch the CDP/input/stream attachment before destroying its page.
          await activate(pane, replacement.pageId, traceId, context);
        }
        return await close(pane, pageId, traceId, context);
      } catch (error) {
        if (!(error instanceof SpaceNotFoundError)) throw error;
        const refreshed = await list(pane);
        if (refreshed.pages.some((page) => page.pageId === pageId)) throw error;
        return refreshed;
      }
    })
  };
}
