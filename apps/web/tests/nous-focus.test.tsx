import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pane, Room, SpaceNotification } from "@space/contracts";
import type { SideSurface } from "../src/features/docks/dock-types.js";
import { BROWSER_PANE_ACTION_EVENT, publishBrowserPaneControl, registerBrowserPaneEventTarget, type BrowserPaneActionDetail } from "../src/features/browser-pane/events.js";
import { AUTO_BACK_MS, AUTO_GO_FREE_MS, AUTO_GO_MS, useNousFocus, WAIT_POLL_MS } from "../src/features/nous-focus/NousFocus.js";
import { forwardNousPaneBoardEvents, NOUS_FOCUS_PHASE_EVENT, NOUS_PANE_BOARD_EVENT, requestNousFocus, writeNousFocusEnabled } from "../src/features/nous-focus/nous-focus-events.js";
import { deliverNotifications } from "../src/features/notifications/notification-delivery.js";
import { peekNotificationStore, refreshNotifications, resetNotificationStore } from "../src/features/notifications/notification-store.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

vi.mock("../src/features/desktop-widgets/audio-chime.js", () => ({ playChime: vi.fn() }));

// Needs you (operator request 2026-10-24): a notification on a pane whose kind needs the operator brings them there and back.
const rooms = [{ id: "room:home000001", name: "Home" }, { id: "room:work000001", name: "Work" }] as Room[];
const pane = (id: string, roomId: string, paneName: string, patch: Partial<Pane> = {}) =>
  ({ id, roomId, paneName, title: paneName, isMaximized: false, isMinimized: false, isClosed: false, ...patch }) as Pane;
const HOME_MAX = "pane:homemax0001";
const EMMA = "pane:emma0000001";
const at = "2026-10-24T08:00:00.000Z";
const needsYou = (id: string, patch: Partial<SpaceNotification> = {}): SpaceNotification => ({
  id: `notification:${id}`, ownerUserId: "user:operator", roomId: "room:work000001", paneId: EMMA, source: "AGENT", kind: "NEEDS_YOU", severity: "ATTENTION",
  title: "Emma needs you", body: "Pick the colour", link: { roomId: "room:work000001", paneId: EMMA }, dedupeKey: `agent:needs-you:${EMMA}`, status: "OPEN", payload: {},
  createdAt: at, updatedAt: at, readAt: null, ackedAt: null, resolvedAt: null, ...patch
});

const calls: string[] = [];
let activity: Record<string, string> = {};
let handoffStatus: string | null = null;
let emmaMode: Pane["mode"] = "TERMINAL";
let strip = false;
let records: SpaceNotification[] = [];
let visibility = "visible";

function Harness() {
  const [selectedRoomId, setRoom] = useState<string | null>("room:home000001");
  const [selectedPaneId, setPane] = useState<string | null>(HOME_MAX);
  const [panes, setPanes] = useState<Pane[]>([pane(HOME_MAX, "room:home000001", "Andy", { isMaximized: true }), pane(EMMA, "room:work000001", "Emma", { mode: emmaMode })]);
  const [dock, setDock] = useState<{ surface: SideSurface; open: boolean }>({ surface: "nous", open: true });
  const element = useNousFocus({
    rooms, panes, selectedRoomId, selectedPaneId,
    selectRoom: async (roomId) => { calls.push(`room ${roomId}`); setRoom(roomId); setDock((current) => ({ ...current, open: false })); },
    selectPane: (id) => { calls.push(`select ${id}`); setPane(id); },
    // As the shell's toggleMaximize: one maximized pane on screen.
    toggleMaximize: async (target) => {
      calls.push(`${target.isMaximized ? "unmax" : "max"} ${target.id}`);
      setPanes((current) => current.map((item) => item.id === target.id ? { ...item, isMaximized: !target.isMaximized } : !target.isMaximized ? { ...item, isMaximized: false } : item));
    },
    restorePane: async (target) => { calls.push(`restore ${target.id}`); },
    sideSurfaces: { activeSideSurface: dock.surface, isSideSurfaceOpen: dock.open, openSideSurface: (surface) => { calls.push(`dock ${surface}`); setDock({ surface, open: true }); } }
  });
  return <>{element}
    <button type="button" onClick={() => setRoom("room:home000001")}>Switch myself</button>
    <input aria-label="Draft" />
    <section data-space-pane-id={EMMA}>
      {emmaMode === "TERMINAL" ? <textarea className="xterm-helper-textarea" aria-label="Emma terminal" /> : null}
      {strip ? <div className="jc-handoff-strip" data-state="requested"><button type="button" onClick={() => calls.push("take control")}>Take control</button></div> : null}
    </section>
    <input aria-label="Elsewhere" />
  </>;
}

const deliver = (record: SpaceNotification) => act(async () => { records = [record]; deliverNotifications([record], null); });
const takeMeThere = () => act(async () => requestNousFocus({ roomId: "room:work000001", paneId: EMMA, immediate: true }));
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const fetched = (suffix: string) => vi.mocked(fetch).mock.calls.some(([url]) => decodeURIComponent(String(url)).includes(suffix));
const actions: BrowserPaneActionDetail[] = [];
const onAction = (event: Event) => actions.push((event as CustomEvent<BrowserPaneActionDetail>).detail);

beforeEach(() => {
  installSpaceRuntime(liveRuntime);
  vi.useFakeTimers();
  calls.length = 0;
  actions.length = 0;
  activity = {};
  handoffStatus = null;
  emmaMode = "TERMINAL";
  strip = false;
  records = [];
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
    if (url.includes("/notifications/pending")) return Response.json({ total: records.length, bySource: {}, byRoom: {}, byPane: {}, latest: records.filter((item) => item.status === "OPEN") });
    const settled = /\/notifications\/(notification:[^/]+)\/(ack|read)$/.exec(url);
    if (settled) {
      records = records.map((item) => item.id === settled[1] ? { ...item, status: settled[2] === "ack" ? "ACKED" : "READ" } : item);
      return Response.json({ notification: records.find((item) => item.id === settled[1]) ?? null });
    }
    if (url.includes("/notifications")) return Response.json({ notifications: records });
    return Response.json({});
  }));
});
afterEach(() => {
  window.removeEventListener(BROWSER_PANE_ACTION_EVENT, onAction); publishBrowserPaneControl(EMMA, false); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  (document.activeElement as HTMLElement | null)?.blur?.(); delete (document as { visibilityState?: string }).visibilityState;
});

describe("Needs you brings the operator to a pane", () => {
  it("shows a delivered needs-you as the banner (source and title, no toast), goes by itself after 5 s and comes back, restoring the room, the maximized pane and the dock", async () => {
    const phases: string[] = [];
    window.addEventListener(NOUS_FOCUS_PHASE_EVENT, (event) => phases.push((event as CustomEvent<string>).detail));
    render(<Harness />);
    await deliver(needsYou("n1"));
    expect(screen.getByRole("alert", { name: "Needs you" }).textContent).toContain("Agent: Emma needs you");
    expect(peekNotificationStore().toasts).toEqual([]);
    await advance(AUTO_GO_MS - 300);
    expect(calls).toEqual([]);
    await advance(600);
    expect(calls).toEqual(["room room:work000001", `max ${EMMA}`, `select ${EMMA}`]);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText("Emma terminal"));
    calls.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "Back to Home" }));
    await advance(0);
    expect(calls).toEqual([`unmax ${EMMA}`, "room room:home000001", `max ${HOME_MAX}`, `select ${HOME_MAX}`, "dock nous"]);
    expect(phases).toEqual(["go", "back"]);
    expect(screen.queryByRole("button", { name: "Back to Home" })).toBeNull();
  });

  it("waits while the operator types and goes 2 s after they stop; Not now marks the record read", async () => {
    render(<Harness />);
    screen.getByLabelText("Draft").focus();
    await deliver(needsYou("n1"));
    await advance(AUTO_GO_MS * 2);
    expect(calls).toEqual([]);
    expect(screen.getByRole("alert").textContent).toContain("waiting: you are typing");
    screen.getByLabelText("Draft").blur();
    await advance(AUTO_GO_FREE_MS - 500);
    expect(calls).toEqual([]);
    await advance(1_000);
    expect(calls[0]).toBe("room room:work000001");
    calls.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "Back to Home" }));
    await advance(0);
    await deliver(needsYou("n2"));
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("alert")).toBeNull();
    await advance(0);
    expect(fetched("/notifications/notification:n2/read")).toBe(true);
  });

  it("keeps the toast when this device turned the setting off, shows no banner for the pane already on screen, and Take me there goes at once", async () => {
    render(<Harness />);
    writeNousFocusEnabled(false);
    await deliver(needsYou("n1"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(peekNotificationStore().toasts.map((toast) => toast.id)).toEqual(["notification:n1"]);
    writeNousFocusEnabled(true);
    await takeMeThere();
    await advance(0);
    expect(calls).toEqual(["room room:work000001", `max ${EMMA}`, `select ${EMMA}`]);
    // Already there: no banner; the visit follows the newest request instead.
    await deliver(needsYou("n2"));
    expect(screen.queryByRole("alert")).toBeNull();
    records = [needsYou("n2", { status: "RESOLVED" })];
    await act(() => refreshNotifications());
    await advance(AUTO_BACK_MS);
    expect(calls).toContain("room room:home000001");
  });

  it("returns 2 s after the record is resolved (answered elsewhere, or by the pane moving on)", async () => {
    render(<Harness />);
    await deliver(needsYou("n1"));
    fireEvent.click(screen.getByRole("button", { name: "Go now" }));
    await advance(0);
    calls.length = 0;
    records = [needsYou("n1", { status: "RESOLVED" })];
    await act(() => refreshNotifications());
    await advance(AUTO_BACK_MS - 500);
    expect(calls).toEqual([]);
    await advance(600);
    expect(calls[0]).toBe(`unmax ${EMMA}`);
    expect(calls).toContain("room room:home000001");
  });

  it("acknowledges the record on the operator's Enter inside the terminal pane and returns; Enter elsewhere changes nothing", async () => {
    render(<Harness />);
    await deliver(needsYou("n1"));
    fireEvent.click(screen.getByRole("button", { name: "Go now" }));
    await advance(0);
    calls.length = 0;
    fireEvent.keyDown(screen.getByLabelText("Elsewhere"), { key: "Enter" });
    await advance(AUTO_BACK_MS);
    expect(fetched("/notifications/notification:n1/ack")).toBe(false);
    expect(calls).toEqual([]);
    fireEvent.keyDown(screen.getByLabelText("Emma terminal"), { key: "Enter" });
    await advance(0);
    expect(fetched("/notifications/notification:n1/ack")).toBe(true);
    await advance(AUTO_BACK_MS + 100);
    expect(calls).toContain("room room:home000001");
  });

  it("takes a requested handoff on arrival (the copilot's Take control; a Browser pane's action) and gives the browser back on Back", async () => {
    emmaMode = "FREELANCE_COPILOT";
    strip = true;
    handoffStatus = "REQUESTED";
    render(<Harness />);
    await deliver(needsYou("h1", { source: "BROWSER_HANDOFF", kind: "BROWSER_HANDOFF_REQUESTED", title: "Upwork: tick the box", dedupeKey: `browser-handoff:${EMMA}` }));
    expect(screen.getByRole("alert").textContent).toContain("Browser: Upwork: tick the box");
    fireEvent.click(screen.getByRole("button", { name: "Go now" }));
    await advance(100);
    expect(calls).toContain("take control");
    publishBrowserPaneControl(EMMA, true);
    const unregister = registerBrowserPaneEventTarget(EMMA);
    fireEvent.click(screen.getByRole("button", { name: "Back to Home" }));
    await advance(0);
    expect(actions).toEqual([{ paneId: EMMA, action: "release" }]);
    unregister();
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

  it("returns 2 s after a waiting CLI prompt is answered", async () => {
    render(<Harness />);
    activity = { [EMMA]: "waiting" };
    await takeMeThere();
    await advance(WAIT_POLL_MS);
    activity = { [EMMA]: "working" };
    calls.length = 0;
    await advance(WAIT_POLL_MS);
    expect(calls).toEqual([]);
    await advance(AUTO_BACK_MS);
    expect(calls[0]).toBe(`unmax ${EMMA}`);
    expect(calls).toContain("room room:home000001");
    // A terminal pane has no browser: its handoff is never asked for (no 404 every poll).
    expect(fetched("/browser/handoff")).toBe(false);
  });

  it("counts a browser handoff as needing the operator and returns when it completes", async () => {
    emmaMode = "FREELANCE_COPILOT";
    render(<Harness />);
    handoffStatus = "REQUESTED";
    await takeMeThere();
    await advance(WAIT_POLL_MS * 2);
    handoffStatus = "ACCEPTED";
    calls.length = 0;
    await advance(WAIT_POLL_MS * 2);
    expect(calls).toEqual([]);
    handoffStatus = "COMPLETED";
    await advance(WAIT_POLL_MS + AUTO_BACK_MS);
    expect(calls).toContain("room room:home000001");
  });

  it("drops the way back when the operator moves away themselves, giving a held browser back", async () => {
    render(<Harness />);
    await takeMeThere();
    await advance(400);
    expect(screen.getByRole("button", { name: "Back to Home" })).toBeTruthy();
    publishBrowserPaneControl(EMMA, true);
    const unregister = registerBrowserPaneEventTarget(EMMA);
    fireEvent.click(screen.getByRole("button", { name: "Switch myself" }));
    await advance(0);
    expect(screen.queryByRole("button", { name: "Back to Home" })).toBeNull();
    expect(actions).toEqual([{ paneId: EMMA, action: "release" }]);
    unregister();
  });

  // Stable 2026-10-24: the operator saw no banner; a request the tab could not show was lost for good. The record is the copy now.
  it("offers a request the hidden tab missed once it is visible again (no toast meanwhile), never twice, and one missed while the stream was down", async () => {
    render(<Harness />);
    visibility = "hidden";
    await deliver(needsYou("m1"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(peekNotificationStore().toasts).toEqual([]);
    visibility = "visible";
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await advance(0);
    expect(screen.getByRole("alert", { name: "Needs you" }).textContent).toContain("Agent: Emma needs you");
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await advance(0);
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await advance(0);
    expect(screen.queryByRole("alert")).toBeNull();
    records = [needsYou("m2")];
    const listeners = new Map<string, EventListener>();
    const stop = forwardNousPaneBoardEvents({ addEventListener: (type: string, listener: EventListener) => listeners.set(type, listener), removeEventListener: (type: string) => listeners.delete(type) } as unknown as EventSource);
    await act(async () => { listeners.get("replay-complete")!(new Event("replay-complete")); });
    await advance(0);
    expect(screen.getByRole("alert").textContent).toContain("Agent: Emma needs you");
    stop();
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
