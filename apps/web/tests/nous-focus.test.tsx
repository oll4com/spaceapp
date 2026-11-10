import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { needsYouCardTexts, needsYouPlace, type Pane, type Room, type SpaceNotification } from "@space/contracts";
import type { SideSurface } from "../src/features/docks/dock-types.js";
import { BROWSER_PANE_ACTION_EVENT, publishBrowserPaneControl, registerBrowserPaneEventTarget, type BrowserPaneActionDetail } from "../src/features/browser-pane/events.js";
import { REVEAL_TRIES_MS, useNousFocus } from "../src/features/nous-focus/NousFocus.js";
import { NotificationToastHost } from "../src/features/notifications/NotificationToastHost.js";
import { dropNeedsYouPeek } from "../src/features/needs-you/needs-you-view.js";
import { PEEK_MS, PEEK_SENT_MS } from "../src/features/needs-you/NeedsYouPeek.js";
import { forwardNousPaneBoardEvents, NOUS_FOCUS_PHASE_EVENT, NOUS_PANE_BOARD_EVENT, requestNousFocus, writeNousFocusEnabled } from "../src/features/nous-focus/nous-focus-events.js";
import { deliverNotifications } from "../src/features/notifications/notification-delivery.js";
import { peekNotificationStore, refreshNotifications, resetNotificationStore } from "../src/features/notifications/notification-store.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
import { announceAgentLanguage, announceUiLanguage } from "../src/features/ui-language/ui-language.js";
import { reportCoreApiFailure, reportCoreApiSuccess, resetCoreApiAvailability } from "../src/core-api-state.js";

vi.mock("../src/features/desktop-widgets/audio-chime.js", () => ({ playChime: vi.fn() }));

// Needs you (operator request 2026-10-24): a notification on a pane whose kind needs the operator brings them there and back, only on their click
// (plan clipboard:ytwWl09xNH0Z: a new card shows in the small window, NeedsYouPeek, and nothing moves by itself).
const rooms = [{ id: "room:home000001", name: "Home" }, { id: "room:work000001", name: "Work" }] as Room[];
const pane = (id: string, roomId: string, paneName: string, patch: Partial<Pane> = {}) =>
  ({ id, roomId, paneName, title: paneName, isMaximized: false, isMinimized: false, isClosed: false, ...patch }) as Pane;
const HOME_MAX = "pane:homemax0001";
const EMMA = "pane:emma0000001";
const CODY = "pane:cody0000001";
const at = "2026-10-24T08:00:00.000Z";
const needsYou = (id: string, patch: Partial<SpaceNotification> = {}): SpaceNotification => ({
  id: `notification:${id}`, ownerUserId: "user:operator", roomId: "room:work000001", paneId: EMMA, source: "AGENT", kind: "NEEDS_YOU", severity: "ATTENTION",
  title: "Emma needs you", body: "Pick the colour", link: { roomId: "room:work000001", paneId: EMMA }, dedupeKey: `agent:needs-you:${EMMA}`, status: "OPEN", payload: {},
  createdAt: at, updatedAt: at, readAt: null, ackedAt: null, resolvedAt: null, ...patch
});

/** A card with somewhere to go in Space (its target): a bare agent card on a CLI pane has none (operator 3/11 19:25 BKK). */
const there = (id: string, patch: Partial<SpaceNotification> = {}) => needsYou(id, { link: { roomId: "room:work000001", paneId: EMMA, target: "activity" }, ...patch });
// The window waits while he types and the last key is module state: each test's clock starts an hour after the last one's.
let clockHours = 0;

const calls: string[] = [];
let place: unknown = {};
let activity: Record<string, string> = {};
let handoffStatus: string | null = null;
let emmaMode: Pane["mode"] = "TERMINAL";
let emmaClosed = false;
/** false: the room's panes have not loaded (Space restarting). */
let emmaLoaded = true;
let records: SpaceNotification[] = [];
let visibility = "visible";

function Harness() {
  const [selectedRoomId, setRoom] = useState<string | null>("room:home000001");
  const [selectedPaneId, setPane] = useState<string | null>(HOME_MAX);
  const [panes, setPanes] = useState<Pane[]>([pane(HOME_MAX, "room:home000001", "Andy", { isMaximized: true }), pane(EMMA, "room:work000001", "Emma", { mode: emmaMode, isClosed: emmaClosed }),
    pane(CODY, "room:work000001", "Cody", { mode: "BROWSER" })]);
  const [dock, setDock] = useState<{ surface: SideSurface; open: boolean }>({ surface: "nous", open: true });
  const element = useNousFocus({
    rooms, panes: emmaLoaded ? panes : panes.filter((item) => item.id !== EMMA), selectedRoomId, selectedPaneId,
    selectRoom: async (roomId) => { calls.push(`room ${roomId}`); setRoom(roomId); },
    selectPane: (id) => { calls.push(`select ${id}`); setPane(id); },
    // As the shell's toggleMaximize: one maximized pane on screen.
    toggleMaximize: async (target) => {
      calls.push(`${target.isMaximized ? "unmax" : "max"} ${target.id}`);
      setPanes((current) => current.map((item) => item.id === target.id ? { ...item, isMaximized: !target.isMaximized } : !target.isMaximized ? { ...item, isMaximized: false } : item));
    },
    restorePane: async (target) => { calls.push(`restore ${target.id}`); },
    sideSurfaces: { activeSideSurface: dock.surface, isSideSurfaceOpen: dock.open, openSideSurface: (surface) => { calls.push(`dock ${surface}`); setDock({ surface, open: true }); } }
  });
  return <>{element}<NotificationToastHost />
    <button type="button" onClick={() => setRoom("room:home000001")}>Switch myself</button>
    <button type="button" onClick={() => setDock((current) => ({ ...current, open: false }))}>Close dock</button>
    <input aria-label="Draft" />
    <section data-space-pane-id={EMMA}>
      {emmaMode === "TERMINAL" ? <textarea className="xterm-helper-textarea" aria-label="Emma terminal" /> : null}
    </section>
    <section data-space-pane-id={CODY} />
    <input aria-label="Elsewhere" />
  </>;
}

const deliver = (record: SpaceNotification) => act(async () => { records = [record]; deliverNotifications([record], null); });
/** The small window a new card arrives in (null when none shows). */
const peek = () => screen.queryByRole("status", { name: "Needs you" });
const takeMeThere = () => act(async () => requestNousFocus({ roomId: "room:work000001", paneId: EMMA, immediate: true }));
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const fetched = (suffix: string) => vi.mocked(fetch).mock.calls.some(([url]) => decodeURIComponent(String(url)).includes(suffix));
const actions: BrowserPaneActionDetail[] = [];
const onAction = (event: Event) => actions.push((event as CustomEvent<BrowserPaneActionDetail>).detail);

beforeEach(() => {
  // Browser action queues outlive a component mount; these fixtures reuse a pane id, so drain the previous fixture first.
  registerBrowserPaneEventTarget(EMMA)();
  installSpaceRuntime(liveRuntime);
  vi.useFakeTimers({ now: Date.now() + ++clockHours * 3_600_000 });
  calls.length = 0;
  actions.length = 0;
  dropNeedsYouPeek();
  activity = {};
  handoffStatus = null;
  emmaMode = "TERMINAL";
  emmaClosed = false;
  emmaLoaded = true;
  records = [];
  place = {};
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  writeNousFocusEnabled(true);
  resetNotificationStore("user:operator");
  window.addEventListener(BROWSER_PANE_ACTION_EVENT, onAction);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = decodeURIComponent(String(input));
    if (url.endsWith("/dashboard-agents")) return Response.json({ data: [], activity });
    if (url.endsWith("/browser/handoff")) {
      return handoffStatus ? Response.json({ handoff: { status: handoffStatus, expiresAt: "2099-01-01T00:00:00.000Z" } }) : Response.json({ error: "none" }, { status: 404 });
    }
    if (url.endsWith("/reveal")) return Response.json({ revealed: "recaptcha" });
    if (url.endsWith("/place")) return Response.json(place);
    if (/\/notifications\/notification:[^/]+\/answer$/.test(url)) return Response.json({ routed: "NOUS", display: "Going to Emma.", notification: null });
    if (url.includes("/notifications/pending")) return Response.json({ total: records.length, bySource: {}, byRoom: {}, byPane: {}, latest: records.filter((item) => item.status === "OPEN") });
    const settled = /\/notifications\/(notification:[^/]+)\/(ack|read)$/.exec(url);
    if (settled) {
      records = records.map((item) => item.id === settled[1] ? { ...item, status: settled[2] === "ack" ? "ACKED" : "READ" } : item);
      return Response.json({ notification: records.find((item) => item.id === settled[1]) ?? null });
    }
    const one = /\/notifications\/(notification:[^/?]+)$/.exec(decodeURIComponent(url));
    if (one) return Response.json({ notification: records.find((item) => item.id === one[1]) ?? null });
    if (url.includes("/notifications")) return Response.json({ notifications: records });
    return Response.json({});
  }));
});
afterEach(() => {
  window.removeEventListener(BROWSER_PANE_ACTION_EVENT, onAction); publishBrowserPaneControl(EMMA, false); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  (document.activeElement as HTMLElement | null)?.blur?.(); delete (document as { visibilityState?: string }).visibilityState;
});

describe("Needs you brings the operator to a pane", () => {
  it("R27-2: going to a Nous card that offers Go now is that answer (scored by the server), not a bare read", async () => {
    // Mercor card 11:52 (1/11) went unscored; the operator answered «open the page and go to the point» 2/2.
    render(<Harness />);
    await deliver(there("g1", { source: "NOUS", kind: "NEEDS_HANDS", dedupeKey: `nous:pane:${EMMA}`,
      payload: { ask: { question: "Sign in to Mercor", options: ["Go now", "Failed", "Need links/steps"], recommended: "Go now", answer: { kind: "NOUS" } } } }));
    fireEvent.click(within(peek()!).getByRole("button", { name: "Go to pane" }));
    await advance(300);
    expect(calls).toEqual(["room room:work000001", `max ${EMMA}`, `select ${EMMA}`]);
    const answered = vi.mocked(fetch).mock.calls.find(([url]) => decodeURIComponent(String(url)).includes("/notifications/notification:g1/answer"));
    expect(JSON.parse(String(answered?.[1]?.body))).toEqual({ option: "Go now" });
    expect(fetched("/notifications/notification:g1/read")).toBe(false);
  });

  it("operator 3/11 19:25 and 19:30 BKK: a delivered needs-you only shows the small window; 60 s later nothing moved and his focus is where it was", async () => {
    render(<Harness />);
    const own = screen.getByRole("button", { name: "Switch myself" });
    own.focus();
    await deliver(there("n0"));
    const window = peek()!;
    expect(within(window).getByRole("article", { name: "Emma needs you" })).toBeTruthy();
    // One answer and Details; the rest waits behind Details.
    expect(within(window).getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent)).toEqual(["Later", "Go to pane", "Details"]);
    expect(peekNotificationStore().toasts).toEqual([]);
    await advance(60_000);
    expect(calls).toEqual([]);
    expect(document.activeElement).toBe(own);
    // It folded into the counter after PEEK_MS: the card waits in Needs you, unread.
    expect(peek()).toBeNull();
    expect(fetched("/notifications/notification:n0/read")).toBe(false);
  });

  it("operator 3/11 19:25 and 19:30 BKK: his Go to pane goes; when the card resolves the bar says Done and nothing comes back by itself", async () => {
    const phases: string[] = [];
    window.addEventListener(NOUS_FOCUS_PHASE_EVENT, (event) => phases.push((event as CustomEvent<string>).detail));
    render(<Harness />);
    await deliver(there("n1"));
    await advance(PEEK_MS - 1_000);
    expect(calls).toEqual([]);
    fireEvent.click(within(peek()!).getByRole("button", { name: "Go to pane" }));
    await advance(100);
    expect(calls).toEqual(["room room:work000001", `max ${EMMA}`, `select ${EMMA}`]);
    expect(peek()).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText("Emma terminal"));
    // Visited is seen: no other tab or reload offers it again.
    expect(fetched("/notifications/notification:n1/read")).toBe(true);
    const bar = screen.getByRole("status");
    expect(bar.textContent).toContain("Emma needs you");
    // Resolved elsewhere: the bar says Done, the way back stays his, nothing moves.
    calls.length = 0;
    records = [there("n1", { status: "RESOLVED" })];
    await act(() => refreshNotifications());
    await advance(60_000);
    expect(calls).toEqual([]);
    expect(bar.textContent).toContain("Done");
    fireEvent.click(screen.getByRole("button", { name: "Back to Nous" }));
    await advance(0);
    expect(calls).toEqual([`unmax ${EMMA}`, "room room:home000001", `max ${HOME_MAX}`, `select ${HOME_MAX}`, "dock nous"]);
    expect(phases).toEqual(["go", "back"]);
    expect(screen.queryByRole("button", { name: "Back to Nous" })).toBeNull();
  });

  it("operator 3/11 19:30 BKK: no window pops while he types (a draft, the terminal); it shows once he stops; Later marks the record read", async () => {
    render(<Harness />);
    screen.getByLabelText("Draft").focus();
    await deliver(there("typed1"));
    await advance(5_000);
    expect(peek()).toBeNull();
    screen.getByLabelText("Draft").blur();
    await advance(300);
    expect(peek()).toBeTruthy();
    fireEvent.click(within(peek()!).getByRole("button", { name: "Later" }));
    expect(peek()).toBeNull();
    await advance(0);
    expect(fetched("/notifications/notification:typed1/read")).toBe(true);
    // Keys in a terminal are typing too (its hidden input is always focused, so only its recent keys count).
    fireEvent.keyDown(screen.getByLabelText("Emma terminal"), { key: "a" });
    await deliver(there("typed2"));
    expect(peek()).toBeNull();
    await advance(2_300);
    expect(peek()).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it("design §3.1: one window for many, the newest first; the pointer on it keeps it past PEEK_MS and a newer card never replaces the one under it", async () => {
    render(<Harness />);
    await deliver(there("a1", { title: "First card" }));
    await act(async () => { records = [there("a2", { title: "Second card", createdAt: "2026-10-24T08:01:00.000Z" }), ...records]; deliverNotifications([records[0]!], null); });
    expect(within(peek()!).getByRole("article").getAttribute("aria-label")).toBe("Second card");
    expect(peek()!.textContent).toContain("1 more wait for you");
    fireEvent.pointerEnter(peek()!);
    await act(async () => { records = [there("a3", { title: "Third card", paneId: CODY, link: { roomId: "room:work000001", paneId: CODY, target: "activity" } }), ...records]; deliverNotifications([records[0]!], null); });
    expect(within(peek()!).getByRole("article").getAttribute("aria-label")).toBe("Second card");
    await advance(PEEK_MS * 2);
    expect(peek()).toBeTruthy();
    fireEvent.pointerLeave(peek()!);
    await advance(PEEK_MS);
    expect(peek()).toBeNull();
    expect(calls).toEqual([]);
  });

  it("operator 3/11 19:30 BKK: the window lets a card go the moment it is resolved or answered elsewhere", async () => {
    render(<Harness />);
    await deliver(there("r1"));
    expect(peek()).toBeTruthy();
    records = [there("r1", { status: "RESOLVED" })];
    await act(() => refreshNotifications());
    await advance(0);
    expect(peek()).toBeNull();
    await deliver(there("r2"));
    records = [there("r2", { status: "READ", payload: { answer: { text: "Failed", at, routed: "NOUS" } } })];
    await act(() => refreshNotifications());
    await advance(0);
    expect(peek()).toBeNull();
    expect(calls).toEqual([]);
  });

  it("operator 3/11 19:25 and 19:30 BKK: a card with nothing to do in Space (a phone's steps) offers no Go, even from a click; «Το έκανα, όλα καλά» goes as his words and closes it; its steps wait behind Details", async () => {
    announceAgentLanguage("el");
    try {
      render(<Harness />);
      const card = needsYou("phone", { source: "NOUS", kind: "NEEDS_HANDS", title: "SpaceApp 0.2.13: update on the phone", body: "Update SpaceApp on the phone\n1. Open the Play Store.\n2. Update SpaceApp.",
        payload: { paneMode: "APP_STUDIO", ask: { question: "Is SpaceApp 0.2.13 on the phone?", options: ["Go now", "Failed", "Need links/steps"], recommended: "Go now", answer: { kind: "NOUS" } } } });
      records = [card];
      // A click that asks to go there shows the card instead: it has nowhere to go.
      await act(async () => requestNousFocus({ roomId: "room:work000001", paneId: EMMA, immediate: true, notification: card }));
      await advance(1_000);
      expect(calls).toEqual([]);
      const window = peek()!;
      expect(window.querySelector("[data-needs-you-place]")?.getAttribute("data-needs-you-place")).toBe("OFF_SPACE");
      expect(within(window).queryByRole("button", { name: /Go to pane|Go now/ })).toBeNull();
      expect(within(window).queryByRole("button", { name: "Χρειάζομαι οδηγίες" })).toBeNull();
      expect(window.textContent).toContain("Is SpaceApp 0.2.13 on the phone?");
      expect(window.textContent).not.toContain("Open the Play Store");
      fireEvent.click(within(window).getByRole("button", { name: "Details" }));
      expect(window.textContent).toContain("Open the Play Store.");
      expect(within(window).getByRole("button", { name: "Υπάρχει πρόβλημα" })).toBeTruthy();
      fireEvent.click(within(window).getByRole("button", { name: "Το έκανα, όλα καλά" }));
      await advance(0);
      const sent = vi.mocked(fetch).mock.calls.find(([url]) => decodeURIComponent(String(url)).endsWith("notification:phone/answer"));
      expect(JSON.parse(String(sent?.[1]?.body))).toEqual({ text: "Done, all good" });
      expect(window.textContent).toContain("Going to Emma.");
      await advance(PEEK_SENT_MS);
      expect(peek()).toBeNull();
      expect(calls).toEqual([]);
    } finally {
      announceAgentLanguage("en");
    }
  });
  it("keeps the toast when this device turned the setting off, shows no banner for the pane already on screen, and Take me there goes at once", async () => {
    render(<Harness />);
    writeNousFocusEnabled(false);
    await deliver(needsYou("n1"));
    expect(peek()).toBeNull();
    expect(peekNotificationStore().toasts.map((toast) => toast.id)).toEqual(["notification:n1"]);
    writeNousFocusEnabled(true);
    await takeMeThere();
    await advance(0);
    expect(calls).toEqual(["room room:work000001", `max ${EMMA}`, `select ${EMMA}`]);
    // Already there with nothing over the pane: no window; the bar shows the newest request instead, and stays after it resolves.
    fireEvent.click(screen.getByRole("button", { name: "Close dock" }));
    await deliver(there("n2"));
    expect(peek()).toBeNull();
    records = [there("n2", { status: "RESOLVED" })];
    await act(() => refreshNotifications());
    await advance(5_000);
    expect(calls).not.toContain("room room:home000001");
  });

  it("acknowledges the record on the operator's Enter inside the terminal pane and stays there; Enter elsewhere changes nothing", async () => {
    render(<Harness />);
    await deliver(there("n1"));
    fireEvent.click(within(peek()!).getByRole("button", { name: "Go to pane" }));
    await advance(0);
    calls.length = 0;
    fireEvent.keyDown(screen.getByLabelText("Elsewhere"), { key: "Enter" });
    await advance(2_000);
    expect(fetched("/notifications/notification:n1/ack")).toBe(false);
    fireEvent.keyDown(screen.getByLabelText("Emma terminal"), { key: "Enter" });
    await advance(0);
    expect(fetched("/notifications/notification:n1/ack")).toBe(true);
    await advance(5_000);
    expect(calls).toEqual([]);
    expect(screen.getByRole("button", { name: "Back to Nous" })).toBeTruthy();
  });
  it("takes a requested copilot handoff through the browser action and releases it on Back", async () => {
    emmaMode = "FREELANCE_COPILOT";
    handoffStatus = "REQUESTED";
    render(<Harness />);
    const unregister = registerBrowserPaneEventTarget(EMMA);
    await deliver(needsYou("h1", { source: "BROWSER_HANDOFF", kind: "BROWSER_HANDOFF_REQUESTED", title: "Upwork: tick the box", dedupeKey: `browser-handoff:${EMMA}` }));
    expect(within(peek()!).getByRole("article", { name: "Upwork: tick the box" })).toBeTruthy();
    fireEvent.click(within(peek()!).getByRole("button", { name: "Go to pane" }));
    await advance(100);
    expect(actions).toEqual([{ paneId: EMMA, action: "handoff", roomId: "room:work000001" }]);
    actions.length = 0;
    publishBrowserPaneControl(EMMA, true);
    fireEvent.click(screen.getByRole("button", { name: "Back to Nous" }));
    await advance(0);
    expect(actions).toEqual([{ paneId: EMMA, action: "release" }]);
    unregister();
  });

  it("operator nous_msg:4b36b80e: the Nous app's Go now opens Space with ?needsYou=<id>, which goes to the handoff's own tab once", async () => {
    emmaMode = "JOB_APPLY";
    handoffStatus = "REQUESTED";
    const unregister = registerBrowserPaneEventTarget(EMMA);
    records = [needsYou("h2", { source: "BROWSER_HANDOFF", kind: "BROWSER_HANDOFF_REQUESTED", title: "Finn: sign in to google.com", dedupeKey: `browser-handoff:${EMMA}`,
      link: { roomId: "room:work000001", paneId: EMMA, target: "tab:page-google" } })];
    window.history.replaceState(null, "", "/?needsYou=notification%3Ah2&keep=1");
    render(<Harness />);
    await advance(300);
    expect(window.location.search).toBe("?keep=1");
    expect(calls.slice(0, 3)).toEqual(["room room:work000001", `max ${EMMA}`, `select ${EMMA}`]);
    expect(actions).toContainEqual({ paneId: EMMA, action: "show_page", pageId: "page-google" });
    expect(actions).toContainEqual({ paneId: EMMA, action: "handoff", roomId: "room:work000001" });
    window.history.replaceState(null, "", "/");
    unregister();
  });

  it("operator 2/11 13:15 BKK: Go to pane on a card a CLI raised about a page opens the browser pane holding it, at its tab, never the CLI", async () => {
    // The Patreon card on Crypto/Max opened that CLI; the filled-in payouts page was in Crypto/Cody's browser.
    render(<Harness />);
    const unregister = registerBrowserPaneEventTarget(CODY);
    const record = needsYou("p1", { source: "NOUS", kind: "NEEDS_HANDS", dedupeKey: `nous:pane:${EMMA}`, link: { roomId: "room:work000001", paneId: EMMA, target: "url:https://www.patreon.com/payouts" },
      payload: { browserPage: { roomId: "room:work000001", paneId: CODY, target: "tab:page-payouts" } } });
    records = [record];
    await act(async () => requestNousFocus({ roomId: "room:work000001", paneId: EMMA, immediate: true, notification: record }));
    await advance(200);
    expect(calls).toEqual(["room room:work000001", `max ${CODY}`, `select ${CODY}`]);
    expect(actions).toContainEqual({ paneId: CODY, action: "show_page", pageId: "page-payouts" });
    expect(actions.some((action) => action.paneId === EMMA)).toBe(false);
    unregister();
  });

  it("operator 9/11 13:31 BKK: Go now asks the server where the card's page is now and lands on that browser and tab, never the CLI or a stale browser page", async () => {
    // The Iris card on the CLI Df/Iris: its tab was held by Df/Zoe; the browser page kept on raise was stale.
    render(<Harness />);
    const unregister = registerBrowserPaneEventTarget(CODY);
    const record = needsYou("iris", { link: { roomId: "room:work000001", paneId: EMMA, target: "tab:B6DF" },
      payload: { browserPage: { roomId: "room:work000001", paneId: EMMA, target: "tab:gone" } } });
    records = [record];
    place = { page: true, place: { roomId: "room:work000001", paneId: CODY, target: "tab:B6DF" }, url: "https://iris.example/verify" };
    await act(async () => requestNousFocus({ roomId: "room:work000001", paneId: EMMA, immediate: true, notification: record }));
    await advance(200);
    expect(fetched("/notifications/notification:iris/place")).toBe(true);
    expect(calls).toEqual(["room room:work000001", `max ${CODY}`, `select ${CODY}`]);
    expect(actions).toContainEqual({ paneId: CODY, action: "show_page", pageId: "B6DF", url: "https://iris.example/verify" });
    expect(actions.some((action) => action.paneId === EMMA)).toBe(false);
    unregister();
  });

  it("operator 9/11 13:31 BKK: no browser holds the card's page and it has no address: nothing moves and the card says the page is no longer open", async () => {
    render(<Harness />);
    const record = needsYou("fal", { source: "NOUS", kind: "NEEDS_HANDS", dedupeKey: `nous:pane:${EMMA}`, link: { roomId: "room:work000001", paneId: EMMA, target: "tab:82CA" } });
    records = [record];
    place = { page: true, place: null, url: null };
    await act(async () => requestNousFocus({ roomId: "room:work000001", paneId: EMMA, immediate: true, notification: record }));
    await advance(200);
    expect(calls).toEqual([]);
    expect(actions).toEqual([]);
    expect(screen.getByRole("alert").textContent).toContain("This page is no longer open");
  });

  it("operator 3/11 12:40 and 19:25 BKK: the way back names the card in his language, its question and answers at hand, the rest (3 steps, then more) on Details; the page lands on its reCAPTCHA", async () => {
    // Emergent Ventures (notification:df8dbfac3e6340b18992c6c1): Go now opened the long filled form at its top; reCAPTCHA and Submit waited at the bottom.
    announceUiLanguage("el"); announceAgentLanguage("el");
    try {
      render(<Harness />);
      const unregister = registerBrowserPaneEventTarget(CODY);
      const card = needsYou("ev1", { source: "NOUS", kind: "NEEDS_HANDS", paneId: CODY, dedupeKey: `nous:pane:${CODY}`, title: "Emergent Ventures: reCAPTCHA and Submit",
        body: "• Tick the reCAPTCHA and press Submit\n  1. one\n  2. two\n  3. three\n  4. four\n  5. five\n\nChecked first:\n- the form is filled",
        link: { roomId: "room:work000001", paneId: CODY, target: "tab:page-form" },
        payload: { ask: { question: "Tick the reCAPTCHA and press Submit", options: ["Go now", "Failed", "Need links/steps"], recommended: "Go now", answer: { kind: "NOUS" } } } });
      const record = { ...card, payload: { ...card.payload, translated: { language: "el", from: needsYouCardTexts(card).from, title: "Emergent Ventures: reCAPTCHA και Υποβολή",
        body: "• Τσέκαρε το reCAPTCHA και πάτα Υποβολή\n  1. ένα\n  2. δύο\n  3. τρία\n  4. τέσσερα\n  5. πέντε", question: "Τσέκαρε το reCAPTCHA και πάτα Υποβολή",
        options: ["Πήγαινε τώρα", "Απέτυχε", "Χρειάζομαι οδηγίες"] } } } as SpaceNotification;
      records = [record];
      await act(async () => requestNousFocus({ roomId: "room:work000001", paneId: CODY, immediate: true, notification: record }));
      await advance(200);
      const bar = screen.getByRole("status");
      expect(screen.getByRole("button", { name: "Πίσω στο Nous" })).toBeTruthy();
      // The proofs press Back, the card, Stay and Details by role in any language (stable 3/11: a class-and-order selector hit the title).
      const roles = () => [...bar.querySelectorAll<HTMLElement>("[data-nous-focus]")].map((button) => [button.dataset.nousFocus, button.getAttribute("aria-expanded")]);
      // Closed (design §3.4): Back, the title on one line, the card's toggle and Stay.
      expect(roles()).toEqual([["back", null], ["card", "false"], ["stay", null]]);
      expect(bar.textContent).toContain("Emergent Ventures: reCAPTCHA και Υποβολή");
      expect(bar.textContent).not.toContain("Τσέκαρε το reCAPTCHA και πάτα Υποβολή");
      fireEvent.click(screen.getByRole("button", { name: "Λεπτομέρειες" }));
      expect(roles()).toEqual([["back", null], ["card", "true"], ["stay", null], ["details", "false"]]);
      expect(bar.textContent).toContain("Τσέκαρε το reCAPTCHA και πάτα Υποβολή");
      expect(bar.textContent).not.toContain("1. ένα");
      expect(bar.textContent).not.toContain("Πήγαινε τώρα");
      fireEvent.click(bar.querySelector<HTMLElement>('[data-nous-focus="details"]')!);
      expect(bar.textContent).toContain("3. τρία");
      expect(bar.textContent).not.toContain("4. τέσσερα");
      expect(bar.textContent).not.toContain("Checked first");
      fireEvent.click(screen.getByRole("button", { name: "2 ακόμη βήματα" }));
      expect(bar.textContent).toContain("5. πέντε");
      // The tab named by the card is shown, then its reCAPTCHA scrolled into view, once.
      expect(actions).toContainEqual({ paneId: CODY, action: "show_page", pageId: "page-form" });
      await advance(REVEAL_TRIES_MS[0]!);
      expect(vi.mocked(fetch).mock.calls.filter(([url]) => decodeURIComponent(String(url)).endsWith(`/panes/${CODY}/browser/pages/page-form/reveal`))).toHaveLength(1);
      await advance(REVEAL_TRIES_MS[1]!);
      expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/reveal"))).toHaveLength(1);
      // He answers from the bar the way the Needs you card does.
      fireEvent.click(screen.getByRole("button", { name: "Απέτυχε" }));
      await advance(0);
      expect(vi.mocked(fetch).mock.calls.some(([url, init]) => decodeURIComponent(String(url)).endsWith(`${record.id}/answer`) && JSON.parse(String(init?.body ?? "{}")).option === "Failed")).toBe(true);
      unregister();
    } finally {
      announceUiLanguage("en"); announceAgentLanguage("en");
    }
  });

  it("takes a plain Browser pane's requested handoff through the pane action", async () => {
    emmaMode = "BROWSER";
    handoffStatus = "REQUESTED";
    render(<Harness />);
    const unregister = registerBrowserPaneEventTarget(EMMA);
    await takeMeThere();
    await advance(0);
    expect(actions).toEqual([{ paneId: EMMA, action: "handoff", roomId: "room:work000001" }]);
    unregister();
  });

  it("operator nous_msg:42ec5f5c: a handoff another CLI raises on the browser a visit is on still offers Go now, and only his click takes the pane and tab", async () => {
    // 6/11: Leo (Claude) left a visit on the PayPal browser; Kate (Gemini CLI) then asked for the code through the same handoff route, the Nous dock open.
    emmaMode = "BROWSER";
    handoffStatus = "REQUESTED";
    render(<Harness />);
    const unregister = registerBrowserPaneEventTarget(EMMA);
    await takeMeThere();
    await advance(0);
    calls.length = 0;
    actions.length = 0;
    const handoff = needsYou("h2", { source: "BROWSER_HANDOFF", kind: "BROWSER_HANDOFF_REQUESTED", title: "Enter the PayPal code", dedupeKey: `browser-handoff:${EMMA}`,
      link: { roomId: "room:work000001", paneId: EMMA, target: "tab:page-paypal" }, payload: { site: "paypal.com" } });
    expect(needsYouPlace(handoff, "BROWSER")).toBe("PANE");
    await deliver(handoff);
    expect(within(peek()!).getByRole("button", { name: "Go now" })).toBeTruthy();
    await advance(PEEK_MS - 1_000);
    expect(calls).toEqual([]);
    expect(actions).toEqual([]);
    fireEvent.click(within(peek()!).getByRole("button", { name: "Go now" }));
    await advance(200);
    expect(actions).toContainEqual({ paneId: EMMA, action: "handoff", roomId: "room:work000001" });
    unregister();
  });

  it("focuses the copilot answer instead of its terminal or an unrelated browser handoff", async () => {
    emmaMode = "JOB_APPLY";
    render(<Harness />);
    const answer = document.createElement("input");
    answer.setAttribute("aria-label", "Copilot answer");
    const pending = document.createElement("section");
    pending.className = "jc-pending";
    pending.append(answer);
    document.querySelector(`[data-space-pane-id="${EMMA}"]`)!.append(pending);
    await act(async () => requestNousFocus({ roomId: "room:work000001", paneId: EMMA, immediate: true,
      notification: needsYou("question", { source: "JOB_COPILOT", kind: "QUESTION", link: { roomId: "room:work000001", paneId: EMMA, target: "question:one" } }) }));
    await advance(200);
    expect(document.activeElement).toBe(answer);
    expect(calls).not.toContain("take control");
  });

  it("reports an unavailable pane without marking its request seen", async () => {
    emmaClosed = true;
    render(<Harness />);
    await deliver(there("closed"));
    fireEvent.click(within(peek()!).getByRole("button", { name: "Go to pane" }));
    await advance(0);
    expect(screen.getByRole("alert").textContent).toContain("no longer available");
    expect(fetched("/notifications/notification:closed/read")).toBe(false);
  });

  // Operator nous_msg:4031716d (9/11 13:29 BKK, video: Go now to a pane that was gone, 5 s later his 2FA typing in that room was cut by a jump back).
  it("a Go whose pane never comes keeps him where he is: the alert and Back to Nous, which only his click takes", async () => {
    emmaLoaded = false;
    render(<Harness />);
    await takeMeThere();
    await advance(5_100);
    expect(screen.getByRole("alert").textContent).toContain("no longer available");
    expect(calls).toEqual(["room room:work000001"]);
    await advance(60_000);
    expect(calls).toEqual(["room room:work000001"]);
    fireEvent.click(screen.getByRole("button", { name: "Back to Nous" }));
    await advance(0);
    expect(calls).toEqual(["room room:work000001", "room room:home000001", `select ${HOME_MAX}`, "dock nous"]);
  });

  it("nous_msg:1be51d08: a Go that a Space restart stopped says it is reconnecting, not gone, and goes once Space answers", async () => {
    const answer = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input).endsWith("/readyz") ? new Response(null, { status: 503 }) : answer(input, init));
    emmaLoaded = false;
    render(<Harness />);
    act(() => reportCoreApiFailure());
    await takeMeThere();
    await advance(5_100);
    expect(screen.getByRole("alert").textContent).toContain("SpaceApp is updating… reconnecting");
    expect(calls).not.toContain(`max ${EMMA}`);

    emmaLoaded = true;
    await act(async () => reportCoreApiSuccess());
    await advance(0);
    expect(screen.queryByText(/reconnecting/)).toBeNull();
    expect(calls).toContain(`max ${EMMA}`);
    act(() => resetCoreApiAvailability());
  });

  it("cancels delayed pane focus when the operator chooses Stay", async () => {
    render(<Harness />);
    await takeMeThere();
    fireEvent.click(screen.getByRole("button", { name: "Stay here" }));
    screen.getByLabelText("Elsewhere").focus();
    await advance(200);
    expect(document.activeElement).toBe(screen.getByLabelText("Elsewhere"));
  });

  it("drops the way back when the operator moves away themselves, giving a held browser back", async () => {
    render(<Harness />);
    await takeMeThere();
    await advance(400);
    expect(screen.getByRole("button", { name: "Back to Nous" })).toBeTruthy();
    publishBrowserPaneControl(EMMA, true);
    const unregister = registerBrowserPaneEventTarget(EMMA);
    fireEvent.click(screen.getByRole("button", { name: "Switch myself" }));
    await advance(0);
    expect(screen.queryByRole("button", { name: "Back to Nous" })).toBeNull();
    expect(actions).toEqual([{ paneId: EMMA, action: "release" }]);
    unregister();
  });

  // Stable 2026-10-24: the operator saw no banner; a request the tab could not show was lost for good. The record is the copy now.
  it("shows a request the hidden tab missed in the window once it is visible again (no toast meanwhile), never twice, and one missed while the stream was down", async () => {
    render(<Harness />);
    visibility = "hidden";
    await deliver(needsYou("m1"));
    expect(peek()).toBeNull();
    expect(peekNotificationStore().toasts).toEqual([]);
    visibility = "visible";
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await advance(300);
    expect(within(peek()!).getByRole("article", { name: "Emma needs you" })).toBeTruthy();
    fireEvent.click(within(peek()!).getByRole("button", { name: "Later" }));
    await advance(0);
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await advance(300);
    expect(peek()).toBeNull();
    expect(calls).toEqual([]);
    records = [needsYou("m2", { source: "MAIL_COPILOT", kind: "QUESTION", title: "Mail Copilot needs you (Mail 5)" })];
    const listeners = new Map<string, EventListener>();
    const stop = forwardNousPaneBoardEvents({ addEventListener: (type: string, listener: EventListener) => listeners.set(type, listener), removeEventListener: (type: string) => listeners.delete(type) } as unknown as EventSource);
    await act(async () => { listeners.get("replay-complete")!(new Event("replay-complete")); });
    await advance(300);
    expect(within(peek()!).getByRole("article", { name: "Mail Copilot needs you (Mail 5)" })).toBeTruthy();
    stop();
  });

  it("a card put off with Later stays out of the window when delivery's copy of the same alert lands late; it alerting again shows it", async () => {
    // Stable 3/11 (PROVE_NOUS_FOCUS): the refresh hands a card to delivery behind a settings read, NousFocus offers it at once; Later fell between.
    render(<Harness />);
    const card = needsYou("late1");
    await deliver(card);
    await advance(300);
    fireEvent.click(within(peek()!).getByRole("button", { name: "Later" }));
    await advance(0);
    expect(peek()).toBeNull();
    await act(async () => { deliverNotifications([card], null); });
    await advance(300);
    expect(peek()).toBeNull();
    await act(async () => { deliverNotifications([{ ...card, payload: { alertAt: "2026-10-24T09:00:00.000Z" } }], null); });
    await advance(300);
    expect(within(peek()!).getByRole("article", { name: "Emma needs you" })).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it("forwards the pane board's updates from the server stream", () => {
    const listeners = new Map<string, EventListener>();
    const source = { addEventListener: (type: string, listener: EventListener) => listeners.set(type, listener), removeEventListener: (type: string) => listeners.delete(type) };
    const seen: unknown[] = [];
    const onBoard = (event: Event) => seen.push((event as CustomEvent).detail);
    window.addEventListener(NOUS_PANE_BOARD_EVENT, onBoard);
    const stop = forwardNousPaneBoardEvents(source as unknown as EventSource);
    expect([...listeners.keys()].sort()).toEqual(["NOUS_PANE_BOARD_UPDATED", "replay-complete"]);
    listeners.get("NOUS_PANE_BOARD_UPDATED")!(new MessageEvent("NOUS_PANE_BOARD_UPDATED", { data: JSON.stringify({ type: "NOUS_PANE_BOARD_UPDATED", paneId: EMMA }) }));
    stop();
    window.removeEventListener(NOUS_PANE_BOARD_EVENT, onBoard);
    expect(seen).toEqual([{ paneId: EMMA }]);
    expect(listeners.size).toBe(0);
  });
});
