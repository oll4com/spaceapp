import { afterEach, describe, expect, it, vi } from "vitest";
import { toggleBrowserFullscreen } from "../src/features/desktop-titlebar/fullscreen.js";

afterEach(() => { delete (window as any).spaceDesktop; vi.restoreAllMocks(); });
describe("desktop fullscreen routing", () => {
  it("uses the native bridge and leaves Chromium fullscreen inactive", async () => {
    const toggleFullscreen = vi.fn().mockResolvedValue(true);
    const requestFullscreen = vi.fn();
    (window as any).spaceDesktop = { toggleFullscreen };
    document.documentElement.requestFullscreen = requestFullscreen;
    await toggleBrowserFullscreen();
    expect(toggleFullscreen).toHaveBeenCalledOnce();
    expect(requestFullscreen).not.toHaveBeenCalled();
  });
  it("retains browser fullscreen for web clients and older bridges", async () => {
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    document.documentElement.requestFullscreen = requestFullscreen;
    (window as any).spaceDesktop = { isDesktop: true };
    await toggleBrowserFullscreen();
    expect(requestFullscreen).toHaveBeenCalledOnce();
  });
});
