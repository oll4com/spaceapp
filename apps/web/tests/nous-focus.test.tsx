import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pane, Room } from "@space/contracts";
import type { SideSurface } from "../src/features/docks/dock-types.js";
import { AUTO_BACK_MS, AUTO_GO_MS, useNousFocus, WAIT_POLL_MS } from "../src/features/nous-focus/NousFocus.js";
import { forwardNousFocusEvents, NOUS_FOCUS_PHASE_EVENT, requestNousFocus, writeNousFocusEnabled } from "../src/features/nous-focus/nous-focus-events.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

const rooms = [{ id: "room:home000001", name: "Home" }, { id: "room:work000001", name: "Work" }] as Room[];
const pane = (id: string, roomId: string, paneName: string, patch: Partial<Pane> = {}) =>
  ({ id, roomId, paneName, title: paneName, isMaximized: false, isMinimized: false, isClosed: false, ...patch }) as Pane;
const HOME_MAX = "pane:homemax0001";
const EMMA = "pane:emma0000001";

const calls: string[] = [];
let activity: Record<string, string> = {};
let handoffStatus: string | null = null;
let emmaMode: Pane["mode"] = "TERMINAL";

function Harness() {
  const [selectedRoomId, setRoom] = useState<string | null>("room:home000001");
  const [selectedPaneId, setPane] = useState<string | null>(HOME_MAX);
  const [panes, setPanes] = useState<Pane[]>([pane(HOME_MAX, "room:home000001", "Andy", { isMaximized: true }), pane(EMMA, "room:work000001", "Emma", { mode: emmaMode })]);
  const [dock, setDock] = useState<{ surface: SideSurface; open: boolean }>({ surface: "nous", open: true });
  const element = useNousFocus({
    userId: "user:operator", rooms, panes, selectedRoomId, selectedPaneId,
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
  return <>{element}<button type="button" onClick={() => setRoom("room:home000001")}>Switch myself</button><input aria-label="Draft" /></>;
}

const nous = (owner = "user:operator") => act(() => requestNousFocus({ roomId: "room:work000001", paneId: EMMA, ownerUserId: owner, immediate: false }));
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  installSpaceRuntime(liveRuntime);
  vi.useFakeTimers();
  calls.length = 0;
  activity = {};
  handoffStatus = null;
  emmaMode = "TERMINAL";
  writeNousFocusEnabled(true);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/dashboard-agents")) return Response.json({ data: [], activity });
    if (url.endsWith("/browser/handoff")) {
      return handoffStatus ? Response.json({ handoff: { status: handoffStatus, expiresAt: "2099-01-01T00:00:00.000Z" } }) : Response.json({ error: "none" }, { status: 404 });
    }
    return Response.json({});
  }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); (document.activeElement as HTMLElement | null)?.blur?.(); });

describe("Nous brings the operator to a pane", () => {
  it("offers the pane, goes by itself after 5 s and comes back, restoring the room, the maximized pane and the dock", async () => {
    const phases: string[] = [];
    window.addEventListener(NOUS_FOCUS_PHASE_EVENT, (event) => phases.push((event as CustomEvent<string>).detail));
    render(<Harness />);
    await nous();
    expect(screen.getByRole("alert", { name: "Nous needs you" }).textContent).toContain("Nous: Work · Emma needs you");
    await advance(AUTO_GO_MS - 300);
    expect(calls).toEqual([]);
    await advance(600);
    expect(calls).toEqual(["room room:work000001", `max ${EMMA}`, `select ${EMMA}`]);
    expect(screen.queryByRole("alert")).toBeNull();
    calls.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "Back to Home" }));
    await advance(0);
    expect(calls).toEqual([`unmax ${EMMA}`, "room room:home000001", `max ${HOME_MAX}`, `select ${HOME_MAX}`, "dock nous"]);
    expect(phases).toEqual(["go", "back"]);
    expect(screen.queryByRole("button", { name: "Back to Home" })).toBeNull();
  });

  it("waits for a click while the operator types, and Not now drops it", async () => {
    render(<Harness />);
    screen.getByLabelText("Draft").focus();
    await nous();
    await advance(AUTO_GO_MS * 2);
    expect(calls).toEqual([]);
    expect(screen.getByRole("alert").textContent).toContain("waiting: you are typing");
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("ignores another user's request and a device that turned it off; Take me there goes at once", async () => {
    render(<Harness />);
    await nous("user:someone-else");
    expect(screen.queryByRole("alert")).toBeNull();
    writeNousFocusEnabled(false);
    await nous();
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => requestNousFocus({ roomId: "room:work000001", paneId: EMMA, ownerUserId: null, immediate: true }));
    await advance(0);
    expect(calls).toEqual(["room room:work000001", `max ${EMMA}`, `select ${EMMA}`]);
  });

  it("returns 2 s after a waiting CLI prompt is answered", async () => {
    render(<Harness />);
    activity = { [EMMA]: "waiting" };
    await act(async () => requestNousFocus({ roomId: "room:work000001", paneId: EMMA, ownerUserId: null, immediate: true }));
    await advance(WAIT_POLL_MS);
    activity = { [EMMA]: "working" };
    calls.length = 0;
    await advance(WAIT_POLL_MS);
    expect(calls).toEqual([]);
    await advance(AUTO_BACK_MS);
    expect(calls[0]).toBe(`unmax ${EMMA}`);
    expect(calls).toContain("room room:home000001");
    // A terminal pane has no browser: its handoff is never asked for (no 404 every poll).
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/browser/handoff"))).toBe(false);
  });

  it("counts a browser handoff as needing the operator and returns when it completes", async () => {
    emmaMode = "FREELANCE_COPILOT";
    render(<Harness />);
    handoffStatus = "REQUESTED";
    await act(async () => requestNousFocus({ roomId: "room:work000001", paneId: EMMA, ownerUserId: null, immediate: true }));
    await advance(WAIT_POLL_MS * 2);
    handoffStatus = "ACCEPTED";
    calls.length = 0;
    await advance(WAIT_POLL_MS * 2);
    expect(calls).toEqual([]);
    handoffStatus = "COMPLETED";
    await advance(WAIT_POLL_MS + AUTO_BACK_MS);
    expect(calls).toContain("room room:home000001");
  });

  it("drops the way back when the operator moves away themselves", async () => {
    render(<Harness />);
    await act(async () => requestNousFocus({ roomId: "room:work000001", paneId: EMMA, ownerUserId: null, immediate: true }));
    await advance(400);
    expect(screen.getByRole("button", { name: "Back to Home" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Switch myself" }));
    await advance(0);
    expect(screen.queryByRole("button", { name: "Back to Home" })).toBeNull();
  });

  it("takes NOUS_FOCUS_REQUESTED from the server stream", () => {
    const listeners = new Map<string, EventListener>();
    const source = { addEventListener: (type: string, listener: EventListener) => listeners.set(type, listener), removeEventListener: (type: string) => listeners.delete(type) };
    const seen: unknown[] = [];
    const onFocus = (event: Event) => seen.push((event as CustomEvent).detail);
    window.addEventListener("space:nous-focus", onFocus);
    const stop = forwardNousFocusEvents(source as unknown as EventSource);
    listeners.get("NOUS_FOCUS_REQUESTED")!(new MessageEvent("NOUS_FOCUS_REQUESTED", { data: JSON.stringify({ type: "NOUS_FOCUS_REQUESTED",
      payload: { requestId: "nous_focus:abc", ownerUserId: "user:operator", roomId: "room:work000001", paneId: EMMA } }) }));
    listeners.get("NOUS_FOCUS_REQUESTED")!(new MessageEvent("NOUS_FOCUS_REQUESTED", { data: JSON.stringify({ type: "NOUS_FOCUS_REQUESTED", payload: { roomId: "x" } }) }));
    stop();
    window.removeEventListener("space:nous-focus", onFocus);
    expect(seen).toEqual([{ roomId: "room:work000001", paneId: EMMA, ownerUserId: "user:operator", immediate: false }]);
    expect(listeners.size).toBe(0);
  });
});
