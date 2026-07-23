export const BROWSER_PANE_ACTION_EVENT = "space:browser-pane-action";

export type BrowserPaneAction = "bookmarks" | "import" | "handoff";

export interface BrowserPaneActionDetail {
  paneId: string;
  action: BrowserPaneAction;
  roomId?: string;
}

const activeBrowserPaneTargets = new Map<string, number>();
const pendingBrowserPaneActions = new Map<string, BrowserPaneActionDetail[]>();

export function dispatchBrowserPaneActionEvent(detail: BrowserPaneActionDetail) {
  if ((activeBrowserPaneTargets.get(detail.paneId) ?? 0) === 0) {
    const queued = pendingBrowserPaneActions.get(detail.paneId) ?? [];
    queued.push(detail);
    pendingBrowserPaneActions.set(detail.paneId, queued);
    return;
  }
  window.dispatchEvent(new CustomEvent(BROWSER_PANE_ACTION_EVENT, { detail }));
}

export function registerBrowserPaneEventTarget(paneId: string): () => void {
  activeBrowserPaneTargets.set(paneId, (activeBrowserPaneTargets.get(paneId) ?? 0) + 1);
  const actions = pendingBrowserPaneActions.get(paneId) ?? [];
  pendingBrowserPaneActions.delete(paneId);
  for (const detail of actions) {
    window.dispatchEvent(new CustomEvent(BROWSER_PANE_ACTION_EVENT, { detail }));
  }

  return () => {
    const remainingTargets = (activeBrowserPaneTargets.get(paneId) ?? 1) - 1;
    if (remainingTargets > 0) activeBrowserPaneTargets.set(paneId, remainingTargets);
    else activeBrowserPaneTargets.delete(paneId);
  };
}

export function parseBrowserPaneActionDetail(detail: unknown): BrowserPaneActionDetail | null {
  if (typeof detail !== "object" || detail === null) return null;
  const maybeDetail = detail as { paneId?: unknown; action?: unknown; roomId?: unknown };
  if (
    typeof maybeDetail.paneId !== "string" ||
    (maybeDetail.action !== "bookmarks" && maybeDetail.action !== "import" && maybeDetail.action !== "handoff")
  ) return null;
  if (maybeDetail.roomId !== undefined && typeof maybeDetail.roomId !== "string") return null;
  return {
    paneId: maybeDetail.paneId,
    action: maybeDetail.action,
    ...(maybeDetail.roomId ? { roomId: maybeDetail.roomId } : {})
  };
}
