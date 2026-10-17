import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryGraph3D } from "../src/features/memory-workspace/MemoryGraph3D.js";

const rendererCalls = vi.hoisted(() => ({ construct: vi.fn(), dispose: vi.fn(), setGraph: vi.fn() }));
vi.mock("../src/features/memory-workspace/memory-webgl-renderer.js", () => ({
  MemoryWebGLRenderer: class {
    width = 1; height = 1; dpr = 1;
    constructor() { rendererCalls.construct(); }
    resize(width: number, height: number, dpr: number) { this.width = width; this.height = height; this.dpr = dpr; }
    setGraph() { rendererCalls.setGraph(); } setPositions() {} setPicking() {} setFocus() {} render() {} labels() {}
    dispose() { rendererCalls.dispose(); }
    pick() { return null; }
  }
}));

let visibility: DocumentVisibilityState;
let callbacks: Map<number, FrameRequestCallback>;
let nextFrame: number;
let resizeCallback: ResizeObserverCallback;
let width: number;
const result = () => screen.getByTestId("memory-benchmark-result").textContent!;
const setVisibility = (value: DocumentVisibilityState) => act(() => { visibility = value; document.dispatchEvent(new Event("visibilitychange")); });
const tick = (now: number) => act(() => {
  const pending = [...callbacks.values()]; callbacks.clear();
  for (const callback of pending) callback(now);
});
const mount = (finishSetup = true) => {
  const view = render(<MemoryGraph3D nodes={[]} edges={[]} positions={new Map()} coordinates={new Map()} showTitles selectedNodeId={null} onSelectNode={() => {}} loading={false} resetToken={0} />);
  if (finishSetup) act(() => vi.runAllTimers());
  return view;
};

beforeEach(() => {
  vi.useFakeTimers();
  Object.values(rendererCalls).forEach(call => call.mockClear());
  history.replaceState(null, "", "/demo-workspace?memoryBenchmark=1");
  visibility = "visible"; callbacks = new Map(); nextFrame = 1; width = 900;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ x: 0, y: 0, top: 0, left: 0, right: width, bottom: 600, width, height: 600, toJSON() {} }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((kind: string) => kind === "2d" ? { setTransform() {} } : { getExtension: () => null, getParameter: () => "test renderer" }) as HTMLCanvasElement["getContext"]);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { const id = nextFrame++; callbacks.set(id, callback); return id; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
  vi.stubGlobal("ResizeObserver", class { constructor(callback: ResizeObserverCallback) { resizeCallback = callback; } observe() {} disconnect() {} });
  vi.stubGlobal("PerformanceObserver", class {
    static supportedEntryTypes = ["mark", "measure"];
    observe() { throw new Error("Unsupported observer must not be started"); }
    disconnect() {}
  });
});

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); history.replaceState(null, "", "/"); });

describe("memory WebGL startup", () => {
  it("yields between context creation, program setup and graph upload, keeping measurement disabled until ready", () => {
    mount(false);
    const button = screen.getByRole("button", { name: "Measure 600 frames" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(HTMLCanvasElement.prototype.getContext).not.toHaveBeenCalled();
    act(() => vi.advanceTimersToNextTimer());
    expect(HTMLCanvasElement.prototype.getContext).toHaveBeenCalledWith("webgl2", expect.any(Object));
    expect(rendererCalls.construct).not.toHaveBeenCalled();
    act(() => vi.advanceTimersToNextTimer());
    expect(rendererCalls.construct).toHaveBeenCalledTimes(1);
    expect(rendererCalls.setGraph).not.toHaveBeenCalled();
    expect(button.disabled).toBe(true);
    act(() => vi.advanceTimersToNextTimer());
    expect(rendererCalls.setGraph).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(false);
    expect(screen.getByRole("application").getAttribute("aria-busy")).toBe("false");
  });

  it("cancels pending startup and disposes created resources on unmount", () => {
    const first = mount(false);
    first.unmount();
    act(() => vi.runAllTimers());
    expect(rendererCalls.construct).not.toHaveBeenCalled();
    const second = mount(false);
    act(() => { vi.advanceTimersToNextTimer(); vi.advanceTimersToNextTimer(); });
    second.unmount();
    act(() => vi.runAllTimers());
    expect(rendererCalls.construct).toHaveBeenCalledTimes(1);
    expect(rendererCalls.dispose).toHaveBeenCalledTimes(1);
    expect(rendererCalls.setGraph).not.toHaveBeenCalled();
  });

  it("cancels a lost context's pending setup and initializes again after restoration", () => {
    mount(false);
    act(() => vi.advanceTimersToNextTimer());
    const canvas = screen.getByRole("application");
    fireEvent(canvas, new Event("webglcontextlost", { cancelable: true }));
    act(() => vi.runAllTimers());
    expect(rendererCalls.construct).not.toHaveBeenCalled();
    fireEvent(canvas, new Event("webglcontextrestored"));
    act(() => vi.runAllTimers());
    expect(rendererCalls.construct).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Measure 600 frames" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("stops later setup stages and uses the fallback when program creation fails", () => {
    rendererCalls.construct.mockImplementationOnce(() => { throw new Error("shader failed"); });
    mount();
    expect(rendererCalls.setGraph).not.toHaveBeenCalled();
    expect(screen.getByText("Canvas view · showing up to 2,000 nodes")).not.toBeNull();
    expect((screen.getByRole("button", { name: "Measure 600 frames" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("memory frame benchmark validity", () => {
  it("waits for a hidden tab, then measures all 600 intervals without filtering slow frames", () => {
    visibility = "hidden";
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Measure 600 frames" }));
    expect(result()).toContain("Waiting for this tab to become visible");
    tick(10);
    expect(result()).toContain("Waiting for this tab to become visible");
    setVisibility("visible");
    let now = 100;
    for (let i = 0; i <= 600; i++) { tick(now); now += i < 540 ? 17 : 100; }
    expect(JSON.parse(result())).toMatchObject({ status: "complete", valid: true, frames: 600, visibility: "visible", frameP50Ms: 17, frameP95Ms: 100, observerSupport: { longTasks: false, longAnimationFrames: false }, maxLoadOrLayoutTaskMs: null, maxPageTaskMs: null, longFrames: null });
  });

  it("invalidates a run hidden midway and requires an explicit fresh start", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Measure 600 frames" }));
    tick(100); tick(117);
    setVisibility("hidden");
    expect(JSON.parse(result())).toMatchObject({ status: "invalid", valid: false, frames: 1 });
    setVisibility("visible"); tick(20000);
    expect(JSON.parse(result()).status).toBe("invalid");
    fireEvent.click(screen.getByRole("button", { name: "Measure scheduling baseline" }));
    for (let i = 0; i <= 600; i++) tick(21000 + i * 17);
    expect(JSON.parse(result())).toMatchObject({ status: "complete", valid: true, mode: "scheduler", frames: 600, frameP95Ms: 17 });
  });

  it("retains a task failure and its timing while separating earlier page startup", () => {
    let observeTasks: PerformanceObserverCallback | undefined;
    vi.spyOn(performance, "now").mockReturnValue(100);
    vi.stubGlobal("PerformanceObserver", class {
      static supportedEntryTypes = ["longtask"];
      constructor(callback: PerformanceObserverCallback) { observeTasks = callback; }
      observe() {} disconnect() {}
    });
    mount();
    act(() => observeTasks?.({ getEntries: () => [
      { startTime: 1, duration: 180 },
      { startTime: 110, duration: 150 },
      { startTime: 300, duration: 60 }
    ] } as PerformanceObserverEntryList, {} as PerformanceObserver));
    fireEvent.click(screen.getByRole("button", { name: "Measure 600 frames" }));
    for (let i = 0; i <= 600; i++) tick(1000 + i * 17);
    expect(JSON.parse(result())).toMatchObject({ maxLoadOrLayoutTaskMs: 150, maxPageTaskMs: 180,
      longestMemoryTask: { startTime: 110, duration: 150 }, loadStartedAt: 100, benchmarkStartedAt: 100,
      observerSupport: { longTasks: true, longAnimationFrames: false }, longFrames: null });
  });

  it("rejects resized or context-lost runs instead of reporting mixed conditions", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Measure 600 frames" }));
    tick(100); tick(117);
    act(() => { width = 1200; resizeCallback([], {} as ResizeObserver); });
    expect(JSON.parse(result())).toMatchObject({ status: "invalid", valid: false, frames: 1 });
    expect(JSON.parse(result()).reason).toContain("size or pixel density changed");
    fireEvent.click(screen.getByRole("button", { name: "Measure 600 frames" }));
    fireEvent(screen.getByRole("application"), new Event("webglcontextlost", { cancelable: true }));
    expect(JSON.parse(result())).toMatchObject({ status: "invalid", valid: false, frames: 0 });
    expect(JSON.parse(result()).reason).toContain("WebGL context was lost");
  });
});
