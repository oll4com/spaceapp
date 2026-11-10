import { describe, expect, it } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import type { NotificationRaiseInput, SpaceNotification } from "@space/contracts";
import { createNeedsYouBrowserPages, createNeedsYouPlaces, pickBrowserPage, type LiveBrowser } from "../src/needs-you-browser-page.js";

// Operator 2/11 13:15 BKK: Go to pane on the Patreon card opened the CLI Crypto/Max; the filled-in page was in Crypto/Cody's browser.
const CRYPTO = "room:Rlpskijugcs0";
const ALEX = "room:alex00000001";
const MAX = "pane:tuXdHjurOR4u";
const DF = "room:eaI4Xd-OAMdc";
const HUGO = "pane:MLpZ-_XlDqmV";
const tab = (pageId: string, url: string | null, isActive = false) => ({ pageId, url, isActive });

describe("a needs-you card raised on a CLI opens the browser holding its page", () => {
  const cody: LiveBrowser = { roomId: CRYPTO, paneId: "pane:cody", driverPaneId: MAX,
    pages: [tab("p-home", "https://www.patreon.com/home"), tab("p-payouts", "https://www.patreon.com/payouts?step=2", true)] };

  it("the Patreon card: url:https://www.patreon.com/payouts on Crypto/Max goes to Cody's payouts tab (origin and path, query aside)", () => {
    const other: LiveBrowser = { roomId: ALEX, paneId: "pane:jack", driverPaneId: "pane:kate", pages: [tab("j1", "https://www.patreon.com/payouts", true)] };
    expect(pickBrowserPage([other, cody], { roomId: CRYPTO, paneId: MAX, target: "url:https://www.patreon.com/payouts", text: "Set up Patreon payouts" }))
      .toEqual({ roomId: CRYPTO, paneId: "pane:cody", target: "tab:p-payouts" });
  });

  it("the Stripe card: Alex/Max with target activity goes to the browser holding the Stripe Connect page", () => {
    const finn: LiveBrowser = { roomId: ALEX, paneId: "pane:finn", driverPaneId: "pane:dana", pages: [tab("f1", "https://mail.google.com/mail/u/0/", true)] };
    const leo: LiveBrowser = { roomId: ALEX, paneId: "pane:leo", driverPaneId: "pane:emma", pages: [tab("l1", "https://dashboard.stripe.com/b/acct_1/connect/onboarding", true)] };
    expect(pickBrowserPage([finn, leo], { roomId: ALEX, paneId: "pane:alexmax", target: "activity", text: "Finish the Stripe Connect onboarding (bank and ID)" }))
      .toEqual({ roomId: ALEX, paneId: "pane:leo", target: "tab:l1" });
  });

  it("a fenced page or no address: the browser this CLI drives, at its active tab; a tab id is that tab", () => {
    const fenced: LiveBrowser = { ...cody, pages: [tab("p-fenced", null, true)] };
    expect(pickBrowserPage([fenced], { roomId: CRYPTO, paneId: MAX, text: "Sign in to Patreon: the password is filled in, press Log in" }))
      .toEqual({ roomId: CRYPTO, paneId: "pane:cody", target: "tab:p-fenced" });
    expect(pickBrowserPage([cody], { roomId: CRYPTO, paneId: MAX, target: "tab:p-home", text: "x" })).toEqual({ roomId: CRYPTO, paneId: "pane:cody", target: "tab:p-home" });
  });

  it("no browser holds the address: the room's browser opens it; a CLI question with no page stays on the CLI", () => {
    expect(pickBrowserPage([], { roomId: CRYPTO, paneId: MAX, target: "url:https://example.org/form", text: "Fill the form" }, ["pane:web"]))
      .toEqual({ roomId: CRYPTO, paneId: "pane:web", target: "url:https://example.org/form" });
    expect(pickBrowserPage([cody], { roomId: CRYPTO, paneId: MAX, text: "Which release option do you want, A or B?" })).toBeNull();
    expect(pickBrowserPage([], { roomId: CRYPTO, paneId: MAX, target: "url:https://example.org/form", text: "x" })).toBeNull();
  });

  it("operator 3/11 19:25 BKK: a phone update card that names Google never lands on Google Calendar open in another room; in its own room the guess stays", () => {
    const bob: LiveBrowser = { roomId: ALEX, paneId: "pane:bob", driverPaneId: "pane:jack", pages: [tab("b1", "https://calendar.google.com/calendar/u/0/r", true)] };
    const text = "SpaceApp 0.2.13: update on the phone\n1. Open Google Play on the phone.\n2. Install the update.";
    expect(pickBrowserPage([bob], { roomId: CRYPTO, paneId: MAX, text })).toBeNull();
    expect(pickBrowserPage([bob], { roomId: CRYPTO, paneId: MAX, target: "url:https://play.google.com/store/apps/details?id=space", text })).toBeNull();
    expect(pickBrowserPage([{ ...bob, roomId: CRYPTO }], { roomId: CRYPTO, paneId: MAX, text })).toEqual({ roomId: CRYPTO, paneId: "pane:bob", target: "tab:b1" });
  });

  it("stores the page on Nous's NEEDS_HANDS and an agent's NEEDS_YOU, only for the owner's browsers, never on a browser pane's card", async () => {
    const store = new InMemorySpaceStore();
    const room = await store.createRoom({ name: "Crypto", initialPaneCount: 0 }, "trace:t", "user:operator");
    const elsewhere = await store.createRoom({ name: "Theirs", initialPaneCount: 0 }, "trace:t", "user:other");
    const max = await store.createPane({ roomId: room.id, title: "Max", paneName: "Max", mode: "TERMINAL", terminalRuntimeId: "cli:claude" } as never);
    const browser = await store.createPane({ roomId: room.id, title: "Cody", paneName: "Cody", mode: "BROWSER" } as never);
    const theirs = await store.createPane({ roomId: elsewhere.id, title: "Web", paneName: "Web", mode: "BROWSER" } as never);
    const session = (sessionId: string, paneId: string, roomId: string, pageId: string) => {
      store.createPaneBrowserSession({ sessionId, paneId, roomId, ownerAgentId: "agent:1", agentNumber: 1, profileId: "profile:x", profilePath: `/tmp/${sessionId}`,
        viewport: "desktop", targetUrl: null, currentUrl: null, title: null, status: "READY", isActive: true } as never);
      store.updatePaneBrowserSession(sessionId, { pages: [{ pageId, kind: "PAGE", url: "https://www.patreon.com/payouts", title: "Payouts", isActive: true,
        openerPageId: null, canGoBack: false, canGoForward: false }] } as never);
    };
    session("browser_session:theirs", theirs.id, elsewhere.id, "t1");
    session("browser_session:cody", browser.id, room.id, "c1");
    const withPage = createNeedsYouBrowserPages({ store, agents: { agentFor: (id) => id === browser.id ? { paneId: max.id, at: 0, active: true } : null } });
    const card = (patch: Partial<NotificationRaiseInput>): NotificationRaiseInput => ({ ownerUserId: "user:operator", roomId: room.id, paneId: max.id, source: "NOUS",
      kind: "NEEDS_HANDS", severity: "ATTENTION", title: "Patreon payouts", body: "Set up payouts", link: { roomId: room.id, paneId: max.id, target: "url:https://www.patreon.com/payouts" },
      dedupeKey: `nous:pane:${max.id}`, payload: { items: [] }, telegram: null, ...patch });
    const page = { roomId: room.id, paneId: browser.id, target: "tab:c1" };
    expect((await withPage(card({}))).payload).toEqual({ items: [], paneMode: "TERMINAL", browserPage: page });
    expect((await withPage(card({ source: "AGENT", kind: "NEEDS_YOU", link: { roomId: room.id, paneId: max.id }, body: "Patreon asks for the bank code" }))).payload.browserPage).toEqual(page);
    // The link keeps the asking pane: answers, dedupe and Needs you stay on it.
    expect((await withPage(card({}))).link.paneId).toBe(max.id);
    expect((await withPage(card({ paneId: browser.id, link: { roomId: room.id, paneId: browser.id } }))).payload).toEqual({ items: [], paneMode: "BROWSER" });
    expect((await withPage(card({ source: "MAIL_COPILOT", kind: "NEEDS_USER" }))).payload.browserPage).toBeUndefined();
  });
});

// Operator 9/11 13:31 BKK («οταν παταω το go now … με πηγαινει σε ασχετα»): the fal.ai card on the CLI Df/Hugo named tab 82CA… no browser held; the page was
// in Df/Paul. Go now finds the page again at the click, on the server, and the card is rebound to it.
describe("Go now finds the card's page again at the click", () => {
  const card = (patch: Partial<SpaceNotification>): SpaceNotification => ({ id: "notification:f0", ownerUserId: "user:operator", roomId: DF, paneId: HUGO,
    source: "NOUS", kind: "NEEDS_HANDS", severity: "ATTENTION", title: "fal.ai Startup Program ($1,000 free credits)", body: "Only the 'I'm not a robot' box is left.",
    link: { roomId: DF, paneId: HUGO, target: "tab:82CA" }, dedupeKey: `nous:pane:${HUGO}`, status: "OPEN", payload: {},
    createdAt: "2026-11-09T00:17:18.846Z", updatedAt: "2026-11-09T01:38:04.649Z", readAt: null, ackedAt: null, resolvedAt: null, ...patch });
  async function setup(sessions: Array<{ paneId: "paul" | "zoe"; pages: Array<{ pageId: string; url: string | null; isActive: boolean }> }>, hugoMode = "TERMINAL") {
    const store = new InMemorySpaceStore();
    const df = await store.createRoom({ name: "Df", initialPaneCount: 0 }, "trace:t", "user:operator");
    const other = await store.createRoom({ name: "Iris", initialPaneCount: 0 }, "trace:t", "user:operator");
    const hugo = await store.createPane({ roomId: df.id, title: "Hugo", paneName: "Hugo", mode: hugoMode, terminalRuntimeId: "cli:gemini" } as never);
    const panes = { paul: await store.createPane({ roomId: df.id, title: "Paul", paneName: "Paul", mode: "BROWSER" } as never),
      zoe: await store.createPane({ roomId: other.id, title: "Zoe", paneName: "Zoe", mode: "BROWSER" } as never) };
    for (const [index, entry] of sessions.entries()) {
      const pane = panes[entry.paneId];
      const sessionId = `browser_session:s${index}`;
      store.createPaneBrowserSession({ sessionId, paneId: pane.id, roomId: pane.roomId, ownerAgentId: "agent:1", agentNumber: 1, profileId: "profile:x",
        profilePath: `/tmp/${sessionId}`, viewport: "desktop", targetUrl: null, currentUrl: null, title: null, status: "READY", isActive: true } as never);
      store.updatePaneBrowserSession(sessionId, { pages: entry.pages.map((page) => ({ ...page, kind: "PAGE", title: null, openerPageId: null, canGoBack: false, canGoForward: false })) } as never);
    }
    const added: Array<Record<string, unknown>> = [];
    const place = createNeedsYouPlaces({ store, agents: { agentFor: (id) => id === panes.paul.id ? { paneId: hugo.id, at: 0, active: true } : null },
      notifications: { addPayload: async (_owner, _id, payload) => { added.push(payload); return null; } } });
    const at = (patch: Partial<SpaceNotification> = {}) => card({ roomId: df.id, paneId: hugo.id, link: { roomId: df.id, paneId: hugo.id, target: "tab:82CA" }, ...patch });
    return { place, added, at, df, other, hugo, paul: panes.paul, zoe: panes.zoe };
  }

  it("a CLI-bound card whose tab is in another room's browser pane lands on that pane and tab, and the card is rebound to it", async () => {
    const { place, added, at, other, zoe } = await setup([{ paneId: "zoe", pages: [tab("B6DF", "https://iris.example/verify", false), tab("z1", "https://mail.google.com/", true)] }]);
    const found = await place(at({ link: { roomId: DF, paneId: HUGO, target: "tab:B6DF" } }));
    expect(found).toEqual({ page: true, place: { roomId: other.id, paneId: zoe.id, target: "tab:B6DF" }, url: "https://iris.example/verify" });
    expect(added).toEqual([{ browserPage: found.place, pageUrl: "https://iris.example/verify" }]);
  });

  it("a stale tab id with the card's address lands on the tab at that address, wherever it is", async () => {
    const { place, at, zoe, other } = await setup([{ paneId: "zoe", pages: [tab("119A", "https://fal.ai/startup-program?ref=x", false), tab("z1", "https://mail.google.com/", true)] }]);
    expect((await place(at({ payload: { pageUrl: "https://fal.ai/startup-program" } }))).place).toEqual({ roomId: other.id, paneId: zoe.id, target: "tab:119A" });
  });

  it("nous_msg:2d012acb: a gone tab whose address is only in the card's text opens that address in the card's room, in the browser that held it", async () => {
    const { place, added, at, df, paul } = await setup([{ paneId: "paul", pages: [tab("p1", "https://paypalaihackathon.devpost.com/", true)] }]);
    const card = at({ body: "• fal.ai Startup Program: only the reCAPTCHA is left.\n  1. Open https://fal.ai/startup-program#apply through Go to pane (tab 82CA4310…).",
      payload: { browserPage: { roomId: df.id, paneId: paul.id, target: "tab:82CA" } } });
    const found = await place(card);
    expect(found.place).toEqual({ roomId: df.id, paneId: paul.id, target: "url:https://fal.ai/startup-program#apply" });
    expect(added).toEqual([{ browserPage: found.place }]);
  });

  it("nous_msg:2d012acb: a gone tab opens its address in the browser the asking CLI drives now, not the one that held it and another agent drives", () => {
    const paul: LiveBrowser = { roomId: DF, paneId: "pane:paul", driverPaneId: "pane:andy", pages: [tab("p1", "https://www.nvidia.com/", true)] };
    const max: LiveBrowser = { roomId: DF, paneId: "pane:max", driverPaneId: HUGO, pages: [tab("m1", "https://github.com/", true)] };
    const ask = { roomId: DF, paneId: HUGO, target: "tab:82CA", heldPaneId: "pane:paul", text: "Open https://fal.ai/startup-program#apply" };
    expect(pickBrowserPage([paul, max], ask, ["pane:paul", "pane:max"])).toEqual({ roomId: DF, paneId: "pane:max", target: "url:https://fal.ai/startup-program#apply" });
    // Max runs no browser yet: the address waits in its bar rather than taking Andy's tab; when every room browser is another agent's, the held one.
    expect(pickBrowserPage([paul], ask, ["pane:paul", "pane:max"])).toEqual({ roomId: DF, paneId: "pane:max", target: "url:https://fal.ai/startup-program#apply" });
    expect(pickBrowserPage([paul], ask, ["pane:paul"])).toEqual({ roomId: DF, paneId: "pane:paul", target: "url:https://fal.ai/startup-program#apply" });
  });

  it("nous_msg:2d012acb: a page no browser holds opens in a room browser no other agent drives, never a busy one when a free one exists", () => {
    const paul: LiveBrowser = { roomId: DF, paneId: "pane:paul", driverPaneId: "pane:andy", pages: [tab("p1", "https://www.nvidia.com/", true)] };
    const kim: LiveBrowser = { roomId: DF, paneId: "pane:kim", driverPaneId: null, pages: [tab("k1", "https://example.org/", true)] };
    const ask = { roomId: DF, paneId: HUGO, target: "url:https://fal.ai/startup-program#apply", text: "Open the fal.ai form" };
    expect(pickBrowserPage([paul, kim], ask, ["pane:paul", "pane:kim"])).toEqual({ roomId: DF, paneId: "pane:kim", target: "url:https://fal.ai/startup-program#apply" });
    expect(pickBrowserPage([paul], ask, ["pane:paul"])).toEqual({ roomId: DF, paneId: "pane:paul", target: "url:https://fal.ai/startup-program#apply" });
  });

  it("nous_msg:2d012acb: a gone tab with no address never lands on a tab picked by site name (Df/Jack's Google Cloud tab for a reCAPTCHA card)", async () => {
    const { place, at } = await setup([{ paneId: "paul", pages: [tab("j1", "https://console.cloud.google.com/auth/branding", true), tab("119A", "https://fal.ai/", false)] }]);
    expect(await place(at({ body: "Tick the Google reCAPTCHA on fal.ai's form and press Submit." }))).toEqual({ page: true, place: null, url: null });
  });

  it("nous_msg:2d012acb: a tab some browser still holds wins over any address the card keeps or names", async () => {
    const { place, at, other, zoe } = await setup([{ paneId: "zoe", pages: [tab("B6DF", "https://iris.example/verify", false)] },
      { paneId: "paul", pages: [tab("p1", "https://fal.ai/startup-program", true)] }]);
    expect((await place(at({ link: { roomId: DF, paneId: HUGO, target: "tab:B6DF" }, body: "Open https://fal.ai/startup-program", payload: { pageUrl: "https://fal.ai/startup-program" } }))).place)
      .toEqual({ roomId: other.id, paneId: zoe.id, target: "tab:B6DF" });
  });

  it("nothing holds the page: never the active tab of the browser that CLI drives; with an address that browser opens it", async () => {
    const { place, added, at, df, paul } = await setup([{ paneId: "paul", pages: [tab("p1", "https://github.com/", true)] }]);
    expect(await place(at({ title: "A form", body: "Only the robot box is left." }))).toEqual({ page: true, place: null, url: null });
    expect(added).toEqual([]);
    expect((await place(at({ title: "A form", body: "x", payload: { pageUrl: "https://example.org/apply" } }))).place)
      .toEqual({ roomId: df.id, paneId: paul.id, target: "url:https://example.org/apply" });
  });

  it("the card's own pane third, only when it is a browser; a card about no page goes as before", async () => {
    const { place, at, df, hugo } = await setup([], "BROWSER");
    expect((await place(at({ payload: { pageUrl: "https://fal.ai/startup-program" } }))).place).toEqual({ roomId: df.id, paneId: hugo.id, target: "url:https://fal.ai/startup-program" });
    expect(await place(at({ link: { roomId: df.id, paneId: hugo.id, target: "question:q1" } }))).toEqual({ page: false, place: null, url: null });
  });

  it("a card keeps its tab's address when it is raised", async () => {
    const store = new InMemorySpaceStore();
    const room = await store.createRoom({ name: "Df", initialPaneCount: 0 }, "trace:t", "user:operator");
    const cli = await store.createPane({ roomId: room.id, title: "Hugo", paneName: "Hugo", mode: "TERMINAL", terminalRuntimeId: "cli:gemini" } as never);
    const web = await store.createPane({ roomId: room.id, title: "Paul", paneName: "Paul", mode: "BROWSER" } as never);
    store.createPaneBrowserSession({ sessionId: "browser_session:p", paneId: web.id, roomId: room.id, ownerAgentId: "agent:1", agentNumber: 1, profileId: "profile:x",
      profilePath: "/tmp/p", viewport: "desktop", targetUrl: null, currentUrl: null, title: null, status: "READY", isActive: true } as never);
    store.updatePaneBrowserSession("browser_session:p", { pages: [{ pageId: "119A", kind: "PAGE", url: "https://fal.ai/startup-program", title: null, isActive: true,
      openerPageId: null, canGoBack: false, canGoForward: false }] } as never);
    const raised = await createNeedsYouBrowserPages({ store })({ ownerUserId: "user:operator", roomId: room.id, paneId: cli.id, source: "NOUS", kind: "NEEDS_HANDS",
      severity: "ATTENTION", title: "fal.ai", body: "robot box", link: { roomId: room.id, paneId: cli.id, target: "tab:119A" }, dedupeKey: null, payload: {}, telegram: null });
    expect(raised.payload).toMatchObject({ pageUrl: "https://fal.ai/startup-program", browserPage: { roomId: room.id, paneId: web.id, target: "tab:119A" } });
  });
});
