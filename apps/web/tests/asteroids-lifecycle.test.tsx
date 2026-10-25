import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SpaceappAsteroids from "../src/features/asteroids/SpaceappAsteroids.js";
import { ArcadeAudio } from "../src/features/asteroids/audio.js";

vi.mock("../src/features/asteroids/audio.js", () => ({ ArcadeAudio: vi.fn(class { enable = vi.fn(async () => true); pause = vi.fn(); tick = vi.fn(); cue = vi.fn(); dispose = vi.fn(); }) }));
vi.mock("../src/features/asteroids/render.js", () => ({ createRenderer: () => ({ resize: vi.fn(), draw: vi.fn(), setPalette: vi.fn() }) }));
let frames: Map<number, FrameRequestCallback>, nextFrame: number;
const disconnect = vi.fn();
beforeEach(() => {
  frames = new Map(); nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { frames.set(++nextFrame, cb); return nextFrame; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect = disconnect; });
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  localStorage.clear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe("arcade resource lifecycle", () => {
  it("schedules nothing on the title screen, stops on pause/blur, disposes on close", async () => {
    const { unmount } = render(<SpaceappAsteroids onClose={vi.fn()} />);
    expect(frames.size).toBe(0);
    const demo = screen.getByRole("figure");
    expect(demo.getAttribute("data-active")).toBe("true");
    fireEvent(window, new Event("blur"));
    expect(demo.getAttribute("data-active")).toBe("false");
    fireEvent(window, new Event("focus"));
    expect(demo.getAttribute("data-active")).toBe("true");
    const audio = vi.mocked(ArcadeAudio).mock.results[0]!.value;
    expect(audio.enable).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Launch mission")); expect(frames.size).toBe(1);
    expect(screen.queryByRole("figure")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("fly forward");
    fireEvent.click(screen.getByLabelText("Pause game")); expect(frames.size).toBe(0);
    fireEvent.click(screen.getByText("Resume mission")); expect(frames.size).toBe(1);
    await act(async () => { fireEvent.click(screen.getByLabelText("Turn music on")); });
    expect(audio.enable).toHaveBeenCalled();
    fireEvent(window, new Event("blur")); expect(frames.size).toBe(0); expect(screen.getByText("Your mission is paused.")).toBeTruthy();
    unmount(); expect(frames.size).toBe(0); expect(audio.dispose).toHaveBeenCalledOnce(); expect(disconnect).toHaveBeenCalledOnce();
  });
  it("keeps keyboard controls scoped and closes with Escape", () => {
    const close = vi.fn(); render(<SpaceappAsteroids onClose={close} />);
    const game = screen.getByLabelText("Spaceapp Asteroids game");
    fireEvent.click(screen.getByText("Launch mission"));
    const event = new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true, cancelable: true });
    act(() => game.dispatchEvent(event)); expect(event.defaultPrevented).toBe(true);
    fireEvent.keyDown(game, { key: "Escape" }); expect(close).toHaveBeenCalledOnce();
  });
});
