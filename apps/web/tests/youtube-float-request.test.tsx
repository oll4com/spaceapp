import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Pane } from "@space/contracts";
import { OPEN_YOUTUBE_FLOAT_EVENT, YOUTUBE_FLOAT_RESULT_EVENT, useYouTubeFloatRequest } from "../src/features/pane-card/use-youtube-float-request.js";

// The Nous dock's YouTube float request (plan clipboard:wr9yNPJwkDrp step 5, operator-approved Warm change 2026-10-18).
const pane = (id: string, roomId: string, mode: Pane["mode"], extra: Partial<Pane> = {}) => ({ id, roomId, mode, isClosed: false, ...extra }) as unknown as Pane;

function request(): boolean | undefined {
  let opened: boolean | undefined;
  const onResult = (event: Event) => { opened = (event as CustomEvent<{ opened: boolean }>).detail.opened; };
  window.addEventListener(YOUTUBE_FLOAT_RESULT_EVENT, onResult);
  window.dispatchEvent(new Event(OPEN_YOUTUBE_FLOAT_EVENT));
  window.removeEventListener(YOUTUBE_FLOAT_RESULT_EVENT, onResult);
  return opened;
}

describe("useYouTubeFloatRequest", () => {
  it("floats the active room's open YouTube pane with the pane's own toggle, and answers whether it did", () => {
    const toggle = vi.fn();
    const panes = [pane("pane:other001", "room:b", "YOUTUBE"), pane("pane:closed01", "room:a", "YOUTUBE", { isClosed: true }),
      pane("pane:cli00001", "room:a", "TERMINAL"), pane("pane:float001", "room:a", "YOUTUBE"), pane("pane:tube0001", "room:a", "YOUTUBE")];
    const { rerender, unmount } = renderHook((props: { floating: Set<string> }) =>
      useYouTubeFloatRequest({ panes, activeRoomId: "room:a", floatingIds: props.floating, toggle }), { initialProps: { floating: new Set(["pane:float001"]) } });
    expect(request()).toBe(true);
    expect(toggle).toHaveBeenCalledWith("pane:tube0001");
    rerender({ floating: new Set(["pane:float001", "pane:tube0001"]) });
    expect(request()).toBe(false);
    expect(toggle).toHaveBeenCalledTimes(1);
    unmount();
    expect(request()).toBeUndefined();
  });
});
