export const BROWSER_PANE_ACTION_EVENT = "space:browser-pane-action";

export type BrowserPaneAction = "bookmarks" | "import" | "handoff" | "release" | "reload" | "account" | "restart" | "tabs";

export interface BrowserPaneActionDetail {
  paneId: string;
  action: BrowserPaneAction;
  roomId?: string;
  /** "account": the Google account profile to open (Job Copilot Setup chooses it outside the toolbar). */
  profileId?: string;
  /** "account": open Google sign-in for that account. */
  signIn?: boolean;
}

/** A Marketing Copilot bookmark was saved outside the Bookmarks tab (a browser tab's context menu). */
export const MARKETING_BOOKMARKS_CHANGED_EVENT = "space:marketing-bookmarks-changed";

/** A pane browser switched Google accounts (toolbar menu or Setup); the detail names the pane. */
export const BROWSER_PANE_ACCOUNT_SELECTED_EVENT = "space:browser-pane-account-selected";

/** The operator took or gave back a pane browser's control lease; the detail is { paneId, held }. */
export const BROWSER_PANE_CONTROL_EVENT = "space:browser-pane-control";
/** An operator who pressed nothing for this long gives the browser back (operator decision 2026-10-24: 60 s, was 2 minutes), so an
 * ended handoff cannot lock the agent out. Same value as the API's BROWSER_CONTROL_IDLE_RELEASE_MS. */
export const BROWSER_CONTROL_IDLE_RELEASE_MS = 60_000;

const heldBrowserControl = new Set<string>();

export function publishBrowserPaneControl(paneId: string, held: boolean) {
  if (held === heldBrowserControl.has(paneId)) return;
  if (held) heldBrowserControl.add(paneId);
  else heldBrowserControl.delete(paneId);
  window.dispatchEvent(new CustomEvent(BROWSER_PANE_CONTROL_EVENT, { detail: { paneId, held } }));
}

/** Whether the operator currently holds this pane browser (for panes that mount after the browser published it). */
export function browserPaneControlHeld(paneId: string): boolean {
  return heldBrowserControl.has(paneId);
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
  const maybeDetail = detail as { paneId?: unknown; action?: unknown; roomId?: unknown; profileId?: unknown; signIn?: unknown };
  if (
    typeof maybeDetail.paneId !== "string" ||
    (maybeDetail.action !== "bookmarks" && maybeDetail.action !== "import" && maybeDetail.action !== "handoff" && maybeDetail.action !== "release" && maybeDetail.action !== "reload"
      && maybeDetail.action !== "account" && maybeDetail.action !== "restart" && maybeDetail.action !== "tabs")
  ) return null;
  if (maybeDetail.roomId !== undefined && typeof maybeDetail.roomId !== "string") return null;
  if (maybeDetail.action === "account" && typeof maybeDetail.profileId !== "string") return null;
  return {
    paneId: maybeDetail.paneId,
    action: maybeDetail.action,
    ...(maybeDetail.roomId ? { roomId: maybeDetail.roomId } : {}),
    ...(maybeDetail.action === "account" ? { profileId: maybeDetail.profileId as string, signIn: maybeDetail.signIn === true } : {})
  };
}
