import { afterEach, describe, expect, it, vi } from "vitest";
import { frameLoop } from "../src/window-idle.js";

describe("frameLoop", () => {
  afterEach(() => { document.documentElement.removeAttribute("data-window-idle"); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("sleeps between ticks, stops while the window is idle and starts again when it comes back", async () => {
    vi.useFakeTimers();
    const queued: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => queued.push(callback));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const tick = vi.fn();
    const stop = frameLoop(tick);
    queued.shift()!(16);
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(32);
    expect(queued).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(queued).toHaveLength(1);
    document.documentElement.setAttribute("data-window-idle", "");
    queued.shift()!(50);
    expect(tick).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(100);
    expect(queued).toHaveLength(0);
    document.documentElement.removeAttribute("data-window-idle");
    await vi.waitFor(() => expect(queued).toHaveLength(1));
    stop();
  });
});
