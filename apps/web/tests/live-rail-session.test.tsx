// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveRailSession } from "../src/features/live-pane/LiveRailSession.js";
import { loadLiveConversationSession } from "../src/features/live-pane/live-session-loader.js";
import { LiveSessionProvider } from "../src/features/live-pane/LiveSessionProvider.js";
import { openLiveConversationSession, type LiveSessionCallbacks, type LiveSessionHandle } from "../src/features/live-pane/live-session.js";
vi.mock("../src/api.js", () => ({ api: {
  getLiveHistory: vi.fn(async () => ({ items: [], epochs: {} })), saveLiveHistory: vi.fn(async () => ({ receipts: [] })),
  getLivePersonalMemory: vi.fn(async () => ({ items: [] })), clearVoiceRealtimeLogs: vi.fn(async () => ({ ok: true })),
  getLiveRoomContext: vi.fn(async (roomId: string) => ({ roomId, name: roomId, description: null, objective: null, panes: [], revision: roomId, checkedAt: "" }))
} }));
vi.mock("../src/features/live-pane/live-session.js", () => ({ openLiveConversationSession: vi.fn() }));
vi.mock("../src/features/live-pane/live-session-loader.js", () => ({ loadLiveConversationSession: vi.fn() }));
const surface = (roomId = "room:a", ownerId = "owner:a") => <StrictMode><LiveSessionProvider ownerId={ownerId} roomId={roomId}><LiveRailSession /></LiveSessionProvider></StrictMode>;
const dispatch = (name = "space-live-rail-toggle") => window.dispatchEvent(new CustomEvent(name));
let callbacks: LiveSessionCallbacks, handle: LiveSessionHandle;
beforeEach(() => {
  localStorage.clear();
  vi.mocked(loadLiveConversationSession).mockImplementation(async () => openLiveConversationSession);
  handle = { close: vi.fn(), setMuted: vi.fn(), isMuted: () => false, sendTextMessage: vi.fn(), updateContext: vi.fn() };
  vi.mocked(openLiveConversationSession).mockImplementation(async (_options, cb = {}) => { callbacks = cb; cb.onStatusChange?.("active"); return handle; });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });
describe("persistent rail Live ownership", () => {
  it("preserves the same audio handle across room navigation", async () => {
    const view = render(surface()); await act(async () => { dispatch(); });
    await act(async () => { view.rerender(surface("room:b")); });
    expect(openLiveConversationSession).toHaveBeenCalledTimes(1);
    expect(handle.close).not.toHaveBeenCalled();
    expect(handle.updateContext).toHaveBeenCalledWith(expect.objectContaining({ roomId: "room:b" }));
    view.unmount(); expect(handle.close).toHaveBeenCalledTimes(1);
  });
  it("closes a microphone grant arriving after disconnect", async () => {
    let resolve!: (h: LiveSessionHandle) => void;
    vi.mocked(openLiveConversationSession).mockImplementation(() => new Promise(r => { resolve = r; }));
    render(surface()); await act(async () => { dispatch(); });
    act(() => { dispatch("space-live-session-stop"); }); await act(async () => { resolve(handle); });
    expect(handle.close).toHaveBeenCalledTimes(1);
  });
  it("ignores duplicate starts while connecting and keeps the session when the room changes", async () => {
    let resolve!: (h: LiveSessionHandle) => void;
    vi.mocked(openLiveConversationSession).mockImplementation(() => new Promise(r => { resolve = r; }));
    const view = render(surface()); await act(async () => { dispatch(); dispatch(); });
    await act(async () => { view.rerender(surface("room:b")); });
    await act(async () => { resolve(handle); });
    expect(openLiveConversationSession).toHaveBeenCalledTimes(1); expect(handle.close).not.toHaveBeenCalled();
  });
  it.each(["stop", "unmount", "owner change"])("does not open audio after %s while its module is loading", async action => {
    let resolve!: (open: typeof openLiveConversationSession) => void;
    vi.mocked(loadLiveConversationSession).mockImplementation(() => new Promise(r => { resolve = r; }));
    const view = render(surface());
    await act(async () => { dispatch(); });
    expect(loadLiveConversationSession).toHaveBeenCalledTimes(1);
    if (action === "unmount") view.unmount();
    else if (action === "owner change") await act(async () => { view.rerender(surface("room:b", "owner:b")); });
    else act(() => { dispatch("space-live-session-stop"); });
    await act(async () => { resolve(openLiveConversationSession); });
    expect(openLiveConversationSession).not.toHaveBeenCalled();
  });
  it("keeps legitimate repeated phrases and exposes shared mute/disconnect controls", async () => {
    render(surface()); await act(async () => { dispatch(); });
    act(() => {
      callbacks.onInputStart?.();
      for (const id of ["one", "two"]) callbacks.onTranscriptUpdate?.({ id, role: "user", text: "ναι", timestamp: "" });
      dispatch("space-live-rail-conversation-toggle");
    });
    expect(screen.getAllByText("ναι")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: /^Mute$/ })); expect(handle.setMuted).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" })); expect(handle.close).toHaveBeenCalledTimes(1);
  });
  it("captions the phrase being spoken, fades it after a pause and can be turned off", async () => {
    const view = render(surface()); await act(async () => { dispatch(); });
    vi.useFakeTimers();
    act(() => { callbacks.onTranscriptUpdate?.({ id: "a1", role: "assistant", text: "Κατάλαβα", timestamp: "" }); });
    const caption = view.container.querySelector(".live-rail-caption");
    expect(caption?.textContent).toBe("Κατάλαβα");
    expect(caption?.classList.contains("is-visible")).toBe(true);
    act(() => { vi.advanceTimersByTime(6000); });
    expect(caption?.classList.contains("is-visible")).toBe(false);
    act(() => { dispatch("space-live-rail-captions-toggle"); });
    expect(view.container.querySelector(".live-rail-caption")).toBeNull();
    expect(localStorage.getItem("space.liveRail.captionsDisabled.v1")).toBe("true");
  });
  it("does not reconnect Live left on by itself inside the phone app (Android bridge), but one tap does", async () => {
    localStorage.setItem("space.live.coordinator.v2:owner:a", JSON.stringify({ enabled: true, muted: true }));
    Object.defineProperty(window, "SpaceNative", { value: {}, configurable: true });
    try {
      render(surface()); await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
      expect(openLiveConversationSession).not.toHaveBeenCalled();
      await act(async () => { dispatch(); });
      expect(openLiveConversationSession).toHaveBeenCalledTimes(1); expect(handle.setMuted).toHaveBeenCalledWith(true);
    } finally { delete (window as { SpaceNative?: unknown }).SpaceNative; }
  });
  it("disconnects and clears visible private history on an owner change", async () => {
    const view = render(surface()); await act(async () => { dispatch(); });
    act(() => { callbacks.onTranscriptUpdate?.({ id: "private", role: "user", text: "owner one", timestamp: "" }); dispatch("space-live-rail-conversation-toggle"); });
    await act(async () => { view.rerender(surface("room:b", "owner:b")); });
    expect(handle.close).toHaveBeenCalledTimes(1); expect(screen.queryByText("owner one")).toBeNull();
  });
});
