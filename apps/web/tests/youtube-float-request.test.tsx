import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Pane } from "@space/contracts";
import { OPEN_YOUTUBE_FLOAT_EVENT, useYouTubeFloatRequest } from "../src/features/pane-card/use-youtube-float-request.js";

// The Nous dock's YouTube float request (plan clipboard:wr9yNPJwkDrp step 5, operator-approved Warm change 2026-10-18).
const pane = (id: string, roomId: string, mode: Pane["mode"], extra: Partial<Pane> = {}) => ({ id, roomId, mode, isClosed: false, ...extra }) as unknown as Pane;
const request = () => window.dispatchEvent(new Event(OPEN_YOUTUBE_FLOAT_EVENT));

describe("useYouTubeFloatRequest", () => {
  it("registers the window listener once per mount, whatever the shell re-renders with", () => {
    const add = vi.spyOn(window, "addEventListener");
    const registrations = () => add.mock.calls.filter(([type]) => type === OPEN_YOUTUBE_FLOAT_EVENT).length;
    const panes = [pane("pane:tube0001", "room:a", "YOUTUBE")];
    const toggle = vi.fn();
    const { rerender, unmount } = renderHook((props: { open: () => void; panes: Pane[] }) =>
      useYouTubeFloatRequest({ panes: props.panes, activeRoomId: "room:a", floatingIds: new Set(), toggle, open: props.open }),
    { initialProps: { open: vi.fn(), panes } });
    const open = vi.fn();
    rerender({ open, panes });
    rerender({ open, panes: [] });
    expect(registrations()).toBe(1);
    // The handler reads the latest render: no YouTube pane now, so it opens one with the latest callback.
    request();
    expect(open).toHaveBeenCalledTimes(1);
    expect(toggle).not.toHaveBeenCalled();
    unmount();
    add.mockRestore();
  });

  it("floats the active room's open YouTube pane with the pane's own toggle, and opens a floating one when the room has none", () => {
    const toggle = vi.fn();
    const open = vi.fn();
    const panes = [pane("pane:other001", "room:b", "YOUTUBE"), pane("pane:closed01", "room:a", "YOUTUBE", { isClosed: true }),
      pane("pane:cli00001", "room:a", "TERMINAL"), pane("pane:float001", "room:a", "YOUTUBE"), pane("pane:tube0001", "room:a", "YOUTUBE")];
    const { rerender, unmount } = renderHook((props: { panes: Pane[]; floating: Set<string> }) =>
      useYouTubeFloatRequest({ panes: props.panes, activeRoomId: "room:a", floatingIds: props.floating, toggle, open }),
    { initialProps: { panes, floating: new Set(["pane:float001"]) } });
    request();
    expect(toggle).toHaveBeenCalledWith("pane:tube0001");
    // Every YouTube pane already floats: nothing to do.
    rerender({ panes, floating: new Set(["pane:float001", "pane:tube0001"]) });
    request();
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    // No open YouTube pane in the room (closed ones and other rooms' do not count): open one.
    rerender({ panes: panes.filter((entry) => !["pane:float001", "pane:tube0001"].includes(entry.id)), floating: new Set() });
    request();
    expect(open).toHaveBeenCalledTimes(1);
    expect(toggle).toHaveBeenCalledTimes(1);
    unmount();
    request();
    expect(open).toHaveBeenCalledTimes(1);
  });
});
