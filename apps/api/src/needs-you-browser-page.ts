import { needsYouBrowserPage, siteSigninDomain, type NeedsYouBrowserPage, type NotificationRaiseInput, type SpaceNotification } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import type { BrowserControlActivity } from "./browser-control-activity.js";
import { isBrowserPane } from "./pane-guards.js";

/**
 * Operator 2/11 13:15 BKK («το go to pane παει στο cli Και εκει δεν μπορώ να κανω τιποτα!! … πρεπει να με πηγαινει στο broswer στην σελιδα που
 * ειναι συμπληρωμενα τα παντα!!»; the Patreon card on Crypto/Max opened that CLI, the page was in Crypto/Cody's browser): a Nous hands card or an
 * agent's needs-you raised on a pane with no browser names the browser pane holding its page (`payload.browserPage`), which Go now and Go to pane
 * open at that tab. Order: the target's tab, then a tab at the target's address (origin and path), then one on the target's or a named site, then
 * the browser that CLI drives, then (with an address) the room's browser pane, which opens it in a new tab. Same room and that CLI's browser first.
 * Operator 3/11 19:25 BKK (a phone-only update card on Cleo/Iris opened Alex/Bob's Google Calendar): only an exact tab or address crosses rooms;
 * a guess (the same site, a site the card names) stays with that CLI's browser and its room's.
 */
export interface LiveBrowser { roomId: string; paneId: string; pages: readonly { pageId: string; url: string | null; isActive: boolean }[]; driverPaneId: string | null }
/** `url`: the page's address the card keeps (`payload.pageUrl`), so a tab id that is gone still finds the page; `ownBrowser`: the card's own
 *  pane is a browser (third choice, after the tab and the address anywhere); `heldPaneId`: the browser that held a tab now gone (its address opens there). */
export interface BrowserPageAsk { roomId: string; paneId: string; target?: string; text: string; url?: string; ownBrowser?: boolean; heldPaneId?: string }

// Words that make a card about a page: hands work (pane-notices' HANDS_WORK), a link, a handoff or a form.
const PAGE_WORK = /sign[- ]?in|log[- ]?in|captcha|password|passcode|2fa|\bmfa\b|\botp\b|verif|\bsms\b|handoff|billing|payout|payment|onboarding|install|https?:\/\/|\bpage\b|browser|\bform\b|σελίδ|φόρμ|πληρωμ/i;

const pathKey = (url: string | null) => {
  try { const parsed = new URL(url ?? ""); return parsed.protocol.startsWith("http") ? `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}` : null; } catch { return null; }
};
const siteOf = (url: string | null) => { try { return url && /^https?:/.test(url) ? siteSigninDomain(url) : null; } catch { return null; } };

export function pickBrowserPage(browsers: readonly LiveBrowser[], ask: BrowserPageAsk, roomBrowserPaneIds: readonly string[] = []): NeedsYouBrowserPage | null {
  const rank = (browser: LiveBrowser) => (browser.driverPaneId === ask.paneId ? 0 : 2) + (browser.roomId === ask.roomId ? 0 : 1);
  const ordered = [...browsers].sort((a, b) => rank(a) - rank(b));
  const at = (browser: LiveBrowser, pageId: string): NeedsYouBrowserPage => ({ roomId: browser.roomId, paneId: browser.paneId, target: `tab:${pageId}` });
  const near = ordered.filter((browser) => browser.driverPaneId === ask.paneId || browser.roomId === ask.roomId);
  const first = (matches: (url: string | null) => boolean, among = ordered) => {
    for (const browser of among) {
      const page = [...browser.pages].sort((a, b) => Number(b.isActive) - Number(a.isActive)).find((entry) => matches(entry.url));
      if (page) return at(browser, page.pageId);
    }
    return null;
  };
  // Operator 9/11 (nous_msg:2d012acb, Go now took them to unrelated windows): a page that opens in a new tab goes to a browser no other agent
  // drives now; another agent's browser (its tab taken from under it) only when the room has no other.
  const free = (ids: readonly (string | null | undefined)[]) => {
    const list = ids.filter((id): id is string => Boolean(id));
    return list.find((id) => !browsers.some((browser) => browser.paneId === id && browser.driverPaneId && browser.driverPaneId !== ask.paneId)) ?? list[0];
  };
  const target = ask.target ?? "";
  if (target.startsWith("tab:")) {
    const browser = ordered.find((entry) => entry.pages.some((page) => page.pageId === target.slice(4)));
    if (browser) return at(browser, target.slice(4));
    // Operator 9/11 13:31 BKK (nous_msg:2d012acb): a tab that is gone never falls to a pane picked by site name (Df/Jack's Google Cloud tab for a
    // fal.ai card); its address (kept, else the first in the card's text) is the tab at that address or opens in the card's room, else nothing.
    const address = ask.url ?? /https:\/\/[^\s"'<>()[\]]+/.exec(ask.text)?.[0]?.replace(/[.,;:!?…]+$/, "") ?? null;
    const key = pathKey(address);
    if (!key) return null;
    // The browser the asking CLI drives now before the one that held the tab, which another agent may drive by now (Df/Paul, Andy's NVIDIA work).
    const driven = ordered.find((browser) => browser.driverPaneId === ask.paneId)?.paneId;
    const room = free([...[driven, ask.heldPaneId, ask.paneId].filter((id) => id && roomBrowserPaneIds.includes(id)), ...roomBrowserPaneIds]);
    return first((page) => pathKey(page) === key) ?? (room ? { roomId: ask.roomId, paneId: room, target: `url:${address}` } : null);
  }
  const url = target.startsWith("url:") ? target.slice(4) : ask.url ?? null;
  const key = pathKey(url);
  const site = siteOf(url);
  const named = new Set(near.flatMap((browser) => browser.pages.map((page) => siteOf(page.url)).filter((entry): entry is string => Boolean(entry)))
    .filter((entry) => entry.split(".")[0]!.length >= 3 && new RegExp(`(?:^|[^\\p{L}\\p{N}])${entry.split(".")[0]!.replace(/[^a-z0-9-]/gi, "")}(?![\\p{L}\\p{N}])`, "iu").test(ask.text)));
  const found = (key ? first((page) => pathKey(page) === key) : null) ?? (site ? first((page) => siteOf(page) === site, near) : null)
    ?? (named.size ? first((page) => named.has(siteOf(page) ?? ""), near) : null);
  if (found) return found;
  if (ask.ownBrowser) return { roomId: ask.roomId, paneId: ask.paneId, ...(url ? { target: `url:${url}` } : target ? { target } : {}) };
  const driven = ordered.find((browser) => browser.driverPaneId === ask.paneId);
  if (driven && (url || target === "browser" || PAGE_WORK.test(ask.text))) {
    const active = driven.pages.find((page) => page.isActive) ?? driven.pages[0];
    return { roomId: driven.roomId, paneId: driven.paneId, ...(url ? { target: `url:${url}` } : active ? { target: `tab:${active.pageId}` } : {}) };
  }
  // No browser holds the page: the room's browser opens it (a new tab), never the CLI.
  const room = url ? free([...ordered.filter((browser) => browser.roomId === ask.roomId).map((browser) => browser.paneId), ...roomBrowserPaneIds]) : undefined;
  return room ? { roomId: ask.roomId, paneId: room, target: `url:${url}` } : null;
}

type PageDeps = { store: Pick<SpaceStore, "getPane" | "getRoom" | "listPanes" | "listActivePaneBrowserSessions">;
  agents?: Pick<BrowserControlActivity, "agentFor">; log?: (error: unknown) => void };

/** The owner's live browsers in every room, with their tabs. */
async function liveBrowsers(deps: PageDeps, owner: string): Promise<LiveBrowser[]> {
  const owners = new Map<string, Promise<string | null>>();
  const ownerOf = (roomId: string) => {
    if (!owners.has(roomId)) owners.set(roomId, Promise.resolve(deps.store.getRoom(roomId)).then((room) => room.ownerUserId ?? null).catch(() => null));
    return owners.get(roomId)!;
  };
  const browsers: LiveBrowser[] = [];
  for (const session of await deps.store.listActivePaneBrowserSessions()) {
    if (await ownerOf(session.roomId) !== owner) continue;
    browsers.push({ roomId: session.roomId, paneId: session.paneId, driverPaneId: deps.agents?.agentFor(session.paneId)?.paneId ?? null,
      pages: session.pages.map((page) => ({ pageId: page.pageId, url: page.url, isActive: page.isActive })) });
  }
  return browsers;
}
const roomBrowserIds = async (deps: PageDeps, roomId: string) =>
  (await deps.store.listPanes(roomId)).filter((entry) => !entry.isClosed && isBrowserPane(entry)).map((entry) => entry.id);
const cardText = (card: { title: string; body: string; payload?: Record<string, unknown> }) => {
  const ask = card.payload?.ask as { question?: unknown } | undefined;
  const items = Array.isArray(card.payload?.items) ? card.payload.items as Array<{ target?: unknown }> : [];
  return [card.title, card.body, typeof ask?.question === "string" ? ask.question : "",
    ...items.map((item) => typeof item?.target === "string" && item.target.startsWith("url:") ? item.target.slice(4) : "")].join("\n");
};
/** The address of the tab a target names, while some browser still holds it. */
const tabUrl = (browsers: readonly LiveBrowser[], target: string | undefined) => {
  const pageId = target?.startsWith("tab:") ? target.slice(4) : null;
  const url = pageId ? browsers.flatMap((browser) => browser.pages).find((page) => page.pageId === pageId)?.url : null;
  return url && pathKey(url) ? url : null;
};

/** The raise input with its pane's mode (needsYouHasPlace), the address of its tab (`payload.pageUrl`, so a tab id that is gone later still
 *  finds the page) and, on a pane with no browser, its browser page, for a Nous NEEDS_HANDS or an agent NEEDS_YOU card; unchanged otherwise. */
export function createNeedsYouBrowserPages(deps: PageDeps) {
  return async (input: NotificationRaiseInput): Promise<NotificationRaiseInput> => {
    if (!input.roomId || !input.paneId || !((input.source === "NOUS" && input.kind === "NEEDS_HANDS") || (input.source === "AGENT" && input.kind === "NEEDS_YOU"))) return input;
    try {
      const pane = await deps.store.getPane(input.paneId);
      const browsers = await liveBrowsers(deps, input.ownerUserId);
      const pageUrl = tabUrl(browsers, input.link?.target);
      const stamped = { ...input, payload: { ...input.payload, paneMode: pane.mode, ...(pageUrl ? { pageUrl } : {}) } };
      if (isBrowserPane(pane)) return stamped;
      const page = pickBrowserPage(browsers, { roomId: input.roomId, paneId: input.paneId, ...(input.link?.target ? { target: input.link.target } : {}),
        text: cardText(input) }, await roomBrowserIds(deps, input.roomId));
      return page ? { ...stamped, payload: { ...stamped.payload, browserPage: page } } : stamped;
    } catch (error) {
      deps.log?.(error);
      return input;
    }
  };
}

/** Where Go now lands, resolved at the click: `page` false for a card about no page (it goes to its own pane as before); `place` null for a page
 *  no browser holds and no address to open (the card says so, nothing moves). */
export interface NeedsYouPlace { page: boolean; place: NeedsYouBrowserPage | null; url: string | null }
export const isPageTarget = (target: string | undefined) => Boolean(target?.startsWith("tab:") || target?.startsWith("url:"));

/**
 * Operator 9/11 13:31 BKK («οταν παταω το go now … με πηγαινει σε ασχετα»; the fal.ai card on the CLI Df/Hugo named a tab no browser held, the page
 * was open in Df/Paul): the card's page is found again at each Go against the live browsers in every room: the browser holding its tab, then a tab
 * at its address, then its own pane when that is a browser, then its address opened in the browser the asking agent uses. The card is rebound
 * to what was found (`payload.browserPage`, and `payload.pageUrl` once a tab shows the address); the link keeps the asking pane.
 */
export function createNeedsYouPlaces(deps: PageDeps & { notifications: { addPayload(owner: string, id: string, payload: Record<string, unknown>): Promise<unknown> } }) {
  return async (card: SpaceNotification): Promise<NeedsYouPlace> => {
    const kept = needsYouBrowserPage(card);
    const linkTarget = card.link.target;
    if (!card.roomId || !card.paneId || !(isPageTarget(linkTarget) || kept)) return { page: false, place: null, url: null };
    // The card's own tab or address first; the browser page found on raise only when the card names neither.
    const target = isPageTarget(linkTarget) ? linkTarget : kept?.target ?? linkTarget;
    const browsers = await liveBrowsers(deps, card.ownerUserId);
    const stored = typeof card.payload.pageUrl === "string" && pathKey(card.payload.pageUrl) ? card.payload.pageUrl : null;
    const url = stored ?? (target?.startsWith("url:") ? target.slice(4) : null) ?? (kept?.target?.startsWith("url:") ? kept.target.slice(4) : null);
    const own = await Promise.resolve(deps.store.getPane(card.paneId)).catch(() => null);
    const place = pickBrowserPage(browsers, { roomId: card.roomId, paneId: card.paneId, ...(target ? { target } : {}), ...(url ? { url } : {}),
      ownBrowser: Boolean(own && !own.isClosed && isBrowserPane(own)), ...(kept ? { heldPaneId: kept.paneId } : {}), text: cardText(card) }, await roomBrowserIds(deps, card.roomId));
    const seen = tabUrl(browsers, place?.target);
    const learned = !stored && seen ? { pageUrl: seen } : {};
    if (place && (JSON.stringify(place) !== JSON.stringify(kept) || Object.keys(learned).length)) {
      await deps.notifications.addPayload(card.ownerUserId, card.id, { browserPage: place, ...learned }).catch((error: unknown) => deps.log?.(error));
    }
    return { page: true, place, url: url ?? seen };
  };
}
