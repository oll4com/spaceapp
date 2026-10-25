import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoomAgentEvent } from "@space/contracts";
import { useRoomAgentAttention, ROOM_AGENT_ATTENTION_VISIBLE_MS } from "../src/features/room-agent/use-room-agent-attention.js";
import { setRoomAgentDesktopNotifications } from "../src/features/room-agent/room-agent-notifications.js";
import { showDesktopNotification } from "../src/features/notifications/desktop-notifications.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

const event = (eventId: string): RoomAgentEvent => ({ eventId, roomId: "room:attention", paneId: "pane:bob-term", paneName: "Bob", kind: "WAITING",
  severity: "ATTENTION", title: "Bob is waiting: Permission prompt", detail: null, status: "ESCALATED", decision: "Needs you: only the operator may approve git push.",
  createdAt: "2026-10-13T05:00:00.000Z", updatedAt: "2026-10-13T05:00:00.000Z" });

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); window.localStorage.clear(); });

describe("Room Agent attention", () => {
  it("counts what waits across rooms and reports only events that are new after the first read", async () => {
    installSpaceRuntime(liveRuntime);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const replies = [
      { rooms: { "room:attention": 1 }, latest: [event("room_agent_event:old")] },
      { rooms: { "room:attention": 2, "room:other": 1 }, latest: [event("room_agent_event:new"), event("room_agent_event:old")] }
    ];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(replies.shift() ?? { rooms: {}, latest: [] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const onNew = vi.fn();
    const { result } = renderHook(() => useRoomAgentAttention(true, onNew));
    await waitFor(() => expect(result.current.total).toBe(1));
    expect(onNew).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(ROOM_AGENT_ATTENTION_VISIBLE_MS); });
    await waitFor(() => expect(result.current.total).toBe(3));
    expect(onNew).toHaveBeenCalledWith([expect.objectContaining({ eventId: "room_agent_event:new" })]);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain("/api/room-agent/pending");
  });

  it("shows desktop notifications only when turned on, allowed and Space is in the background (the switch every source shares)", async () => {
    const shown: Array<{ title: string; body?: string }> = [];
    class FakeNotification {
      static permission = "granted";
      static requestPermission = vi.fn(async () => "granted");
      onclick: (() => void) | null = null;
      constructor(title: string, options?: { body?: string }) { shown.push({ title, body: options?.body }); }
      close() {}
    }
    vi.stubGlobal("Notification", FakeNotification);
    const open = vi.fn();
    const show = () => showDesktopNotification({ title: "Room Agent: needs you", body: "Bob is waiting: Permission prompt", tag: "room_agent_event:a", onClick: open });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    expect(show()).toBe(false);
    expect(await setRoomAgentDesktopNotifications(true)).toBe(true);
    expect(show()).toBe(true);
    expect(shown[0]).toEqual({ title: "Room Agent: needs you", body: "Bob is waiting: Permission prompt" });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    expect(show()).toBe(false);
  });
});
