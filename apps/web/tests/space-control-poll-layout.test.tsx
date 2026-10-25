import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSpaceControlClient } from "../src/features/room-agent/space-control-client.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
import { liveRuntime } from "../src/live/live-runtime.js";

let frames: Map<number, FrameRequestCallback>;
let requests: Array<{ roomId: string; geometry: unknown }>;
beforeEach(() => {
  installSpaceRuntime(liveRuntime);
  vi.useFakeTimers();
  frames = new Map(); requests = [];
  let nextId = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => {
    frames.set(++nextId, callback); return nextId;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id); });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/auth/csrf") return new Response(JSON.stringify({ csrfToken: "fixture-csrf" }));
    if (path.endsWith("/client")) requests.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ commands: [], layout: null }));
  }));
});
afterEach(() => { cleanup(); document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function pane(roomId: string) {
  const element = document.body.appendChild(document.createElement("article"));
  element.dataset.spaceRoomId = roomId; element.dataset.spacePaneId = `pane:${roomId}`;
  const width = vi.fn(() => 640);
  Object.defineProperty(element, "offsetWidth", { get: width });
  element.getBoundingClientRect = vi.fn(() => ({ x: 10, y: 20, width: 640, height: 480 }) as DOMRect);
  return { element, width };
}
async function paint() {
  act(() => {
    const callbacks = [...frames.values()]; frames.clear();
    callbacks.forEach(callback => callback(16));
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}
it("collects current control geometry after paint without a layout read during the room commit", async () => {
  const p = pane("room:one");
  renderHook(() => useSpaceControlClient("room:one", true, async () => {}, () => {}));
  expect(p.width).not.toHaveBeenCalled();
  expect(requests).toEqual([]);
  await paint();
  expect(requests).toEqual([expect.objectContaining({ roomId: "room:one", geometry: [{ paneId: "pane:room:one", x: 10, y: 20, width: 640, height: 480 }] })]);
});
it("cancels obsolete room measurements before their frame runs", async () => {
  const old = pane("room:old"), current = pane("room:current");
  const hook = renderHook(({ roomId }) => useSpaceControlClient(roomId, true, async () => {}, () => {}), { initialProps: { roomId: "room:old" } });
  hook.rerender({ roomId: "room:current" });
  await paint();
  expect(old.width).not.toHaveBeenCalled();
  expect(current.width).toHaveBeenCalled();
  expect(requests.map(request => request.roomId)).toEqual(["room:current"]);
});
it("rechecks focus before collecting geometry after the scheduled frame", async () => {
  const p = pane("room:one");
  renderHook(() => useSpaceControlClient("room:one", true, async () => {}, () => {}));
  vi.mocked(document.hasFocus).mockReturnValue(false);
  await paint();
  expect(p.width).not.toHaveBeenCalled();
  expect(requests).toEqual([]);
});
