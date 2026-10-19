import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import type { MemoryAtlasPosition } from "../src/features/memory-workspace/memory-atlas.js";
import type { MemoryPoint3D } from "../src/features/memory-workspace/memory-3d.js";
import type { MemoryGpuScene } from "../src/features/memory-workspace/memory-gpu-scene.js";

// These tests exercise the React/browser boundary. GPU drawing and shader correctness
// deliberately remain outside this renderer double's claims.
const doubles = vi.hoisted(() => {
  class Renderer {
    constructor() { renderers.push(this); }
    gl = { getExtension: vi.fn(() => null), getParameter: vi.fn(() => "Mock GPU; not hardware evidence"), getContextAttributes: vi.fn(() => ({ alpha: true, antialias: true })), RENDERER: 0x1f01 };
    setScene = vi.fn<(scene: MemoryGpuScene) => void>();
    updateCoordinates = vi.fn();
    resize = vi.fn();
    draw = vi.fn();
    pick = vi.fn(() => -1);
    dispose = vi.fn();
    finish = vi.fn();
  }
  const renderers: Renderer[] = [];
  return { Renderer, renderers };
});
vi.mock("../src/features/memory-workspace/memory-webgl-renderer.js", () => ({ MemoryWebGLRenderer: doubles.Renderer }));
vi.mock("../src/features/memory-workspace/memory-gpu-scene.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/features/memory-workspace/memory-gpu-scene.js")>();
  return { ...actual, buildMemoryGpuScene: vi.fn(actual.buildMemoryGpuScene), prepareMemoryCoordinates: vi.fn(actual.prepareMemoryCoordinates) };
});
vi.mock("../src/features/memory-workspace/MemoryGraphCanvasFallback.js", () => ({
  MemoryGraphCanvasFallback: ({ nodes, edges }: { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] }) =>
    <div data-testid="canvas-fallback" data-node-count={nodes.length} data-edge-count={edges.length} />
}));

import { MemoryGraph3D } from "../src/features/memory-workspace/MemoryGraph3D.js";
import { buildMemoryGpuScene, prepareMemoryCoordinates } from "../src/features/memory-workspace/memory-gpu-scene.js";

const realScene = await vi.importActual<typeof import("../src/features/memory-workspace/memory-gpu-scene.js")>(
  "../src/features/memory-workspace/memory-gpu-scene.js"
);
let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
let previousUrl = "";
let performanceEntriesDescriptor: PropertyDescriptor | undefined;
let visibilityDescriptor: PropertyDescriptor | undefined;
const captureNames = ["setPointerCapture", "hasPointerCapture", "releasePointerCapture"] as const;
let captureDescriptors: Array<PropertyDescriptor | undefined> = [];

function graph(count = 2, edgeCount = 1) {
  const nodes: MemoryGraphNode[] = Array.from({ length: count }, (_, index) => ({
    id: `n-${index}`, type: index === 0 ? "SOURCE" : "MEMORY", label: index === 0 ? "space.md" : `Memory ${index}`,
    sourcePath: "/demo/space_memory_2026-10.md", recordId: index === 0 ? null : `n-${index}`
  }));
  const visible = Math.min(count, 2000);
  const edges: MemoryGraphEdge[] = Array.from({ length: edgeCount }, (_, index) => ({
    id: `e-${index}`, type: "CONTAINS", source: nodes[index % visible]!.id,
    target: nodes[(index + 1 + Math.floor(index / visible)) % visible]!.id
  }));
  const positions = new Map<string, MemoryAtlasPosition>(nodes.map((node, index) => [node.id,
    { x: index, y: 0, color: "#7395ad", hub: index === 0, groupId: "demo" }]));
  const coordinates = new Map<string, MemoryPoint3D>(nodes.map((node, index) => [node.id, { x: index, y: 0, z: index }]));
  return { nodes, edges, positions, coordinates, showTitles: true, selectedNodeId: null,
    onSelectNode: vi.fn(), loading: false, resetToken: 0, layoutComplete: true };
}

async function settle() { await act(async () => { await Promise.resolve(); }); }
async function frame() {
  const pending = [...frames.values()];
  frames.clear();
  await act(async () => { for (const callback of pending) callback(16 * nextFrame); });
}
function pointer(canvas: HTMLCanvasElement, type: string, id: number, x = 100, y = 100) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
  Object.defineProperty(event, "pointerId", { value: id });
  fireEvent(canvas, event);
}

beforeEach(() => {
  doubles.renderers.length = 0;
  vi.mocked(buildMemoryGpuScene).mockReset().mockImplementation(realScene.buildMemoryGpuScene);
  vi.mocked(prepareMemoryCoordinates).mockReset().mockImplementation(async (scene, points, cancelled) => {
    if (cancelled?.()) return null;
    const prepared = { ...scene, coordinates: scene.coordinates.slice() };
    realScene.updateMemoryCoordinates(prepared, points);
    return { coordinates: prepared.coordinates, extent: prepared.extent };
  });
  frames = new Map(); nextFrame = 0;
  visibilityDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  vi.stubGlobal("PerformanceObserver", undefined);
  previousUrl = window.location.href;
  window.history.replaceState({}, "", "/");
  // jsdom may omit performance entries. Preserve its real clock and restore this method after each case.
  performanceEntriesDescriptor = Object.getOwnPropertyDescriptor(performance, "getEntriesByName");
  Object.defineProperty(performance, "getEntriesByName", { configurable: true, value: () => [] });
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    const id = ++nextFrame; frames.set(id, callback); return id;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => { frames.delete(id); }));
  vi.stubGlobal("ResizeObserver", class {
    observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn();
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, width: 800, height: 600, top: 0, left: 0, bottom: 600, right: 800, toJSON: () => ({})
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    clearRect: vi.fn(), setTransform: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(),
    measureText: vi.fn(() => ({ width: 50 })), font: "", fillStyle: ""
  } as unknown as CanvasRenderingContext2D);
  const captures = new WeakMap<HTMLCanvasElement, Set<number>>();
  captureDescriptors = captureNames.map((name) => Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, name));
  Object.defineProperties(HTMLCanvasElement.prototype, {
    setPointerCapture: { configurable: true, value(this: HTMLCanvasElement, id: number) {
      if (!captures.has(this)) captures.set(this, new Set()); captures.get(this)!.add(id);
    } },
    hasPointerCapture: { configurable: true, value(this: HTMLCanvasElement, id: number) { return captures.get(this)?.has(id) ?? false; } },
    releasePointerCapture: { configurable: true, value(this: HTMLCanvasElement, id: number) { captures.get(this)?.delete(id); } }
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  captureNames.forEach((name, index) => {
    const descriptor = captureDescriptors[index];
    if (descriptor) Object.defineProperty(HTMLCanvasElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLCanvasElement.prototype, name);
  });
  if (performanceEntriesDescriptor) Object.defineProperty(performance, "getEntriesByName", performanceEntriesDescriptor);
  else Reflect.deleteProperty(performance, "getEntriesByName");
  if (visibilityDescriptor) Object.defineProperty(document, "visibilityState", visibilityDescriptor);
  else Reflect.deleteProperty(document, "visibilityState");
  window.history.replaceState({}, "", previousUrl);
});

describe("memory graph renderer integration (mock GPU)", () => {
  it("prevents default context loss and switches to a bounded, explicit canvas fallback", async () => {
    render(<MemoryGraph3D {...graph(2001, 7000)} />);
    await settle();
    const canvas = screen.getByRole("application") as HTMLCanvasElement;
    const lost = new Event("webglcontextlost", { cancelable: true });
    fireEvent(canvas, lost);
    expect(lost.defaultPrevented).toBe(true);
    expect(canvas.hidden).toBe(true);
    expect(screen.getByTestId("canvas-fallback").getAttribute("data-node-count")).toBe("2000");
    expect(screen.getByTestId("canvas-fallback").getAttribute("data-edge-count")).toBe("6000");
    expect(screen.getByRole("status").textContent).toContain("showing up to 2,000 nodes");
    expect(doubles.renderers[0]!.dispose).toHaveBeenCalledOnce();
  });

  it("recreates the GPU renderer with the latest graph on restoration and removes listeners on unmount", async () => {
    const original = graph();
    const view = render(<MemoryGraph3D {...original} />);
    await settle();
    const canvas = screen.getByRole("application") as HTMLCanvasElement;
    fireEvent(canvas, new Event("webglcontextlost", { cancelable: true }));
    const latest = graph(3, 2);
    latest.coordinates.set("n-2", { x: 25, y: 50, z: 75 });
    view.rerender(<MemoryGraph3D {...latest} />);
    fireEvent(canvas, new Event("webglcontextrestored"));
    await settle(); await frame();
    expect(doubles.renderers).toHaveLength(2);
    const restored = doubles.renderers[1]!;
    const scene = restored.setScene.mock.calls.at(-1)![0];
    expect(scene.nodes.map((node) => node.id)).toEqual(latest.nodes.map((node) => node.id));
    expect([...scene.coordinates.subarray(8, 11)]).toEqual([25, 50, 75]);
    expect(canvas.hidden).toBe(false);
    expect(screen.queryByTestId("canvas-fallback")).toBeNull();
    expect(canvas.dataset.nodeCount).toBe("3");
    view.unmount();
    expect(restored.dispose).toHaveBeenCalledOnce();
    fireEvent(canvas, new Event("webglcontextrestored"));
    pointer(canvas, "pointermove", 1);
    await frame();
    expect(doubles.renderers).toHaveLength(2);
    expect(restored.pick).not.toHaveBeenCalled();
  });

  it("installs the latest coordinate snapshot when asynchronous scene construction finishes", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(buildMemoryGpuScene).mockImplementationOnce(async (...args) => {
      await held;
      return realScene.buildMemoryGpuScene(...args);
    });
    const initial = graph();
    const view = render(<MemoryGraph3D {...initial} />);
    const coordinates = new Map(initial.coordinates);
    coordinates.set("n-1", { x: 9, y: 18, z: 27 });
    view.rerender(<MemoryGraph3D {...initial} coordinates={coordinates} />);
    expect(doubles.renderers[0]!.setScene).not.toHaveBeenCalled();
    await act(async () => { release(); await held; });
    await settle(); await frame();
    const installed = doubles.renderers[0]!.setScene.mock.calls.at(-1)![0];
    expect([...installed.coordinates.subarray(4, 7)]).toEqual([9, 18, 27]);
    expect(screen.getByRole("application").getAttribute("aria-busy")).toBe("false");
  });

  it("finishes an active coordinate snapshot then publishes the newest queued Map before enabling benchmarks", async () => {
    window.history.replaceState({}, "", "/demo-workspace?memoryGraphBenchmark=1");
    const initial = graph(2049, 1);
    const installed = (await realScene.buildMemoryGpuScene(initial.nodes, initial.edges, initial.positions, initial.coordinates))!;
    vi.mocked(buildMemoryGpuScene).mockResolvedValueOnce(installed);
    const view = render(<MemoryGraph3D {...initial} />);
    await settle(); await frame();
    const renderer = doubles.renderers[0]!;
    const original = installed.coordinates;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(prepareMemoryCoordinates).mockImplementationOnce(async (scene, points, cancelled) => {
      await held;
      if (cancelled?.()) return null;
      const next = { ...scene, coordinates: scene.coordinates.slice() };
      realScene.updateMemoryCoordinates(next, points);
      return { coordinates: next.coordinates, extent: next.extent };
    });
    const a = new Map(initial.coordinates), skipped = new Map(initial.coordinates), final = new Map(initial.coordinates);
    a.set("n-1", { x: 10, y: 20, z: 30 }); skipped.set("n-1", { x: 40, y: 50, z: 60 }); final.set("n-1", { x: 70, y: 80, z: 90 });
    view.rerender(<MemoryGraph3D {...initial} coordinates={a} />);
    view.rerender(<MemoryGraph3D {...initial} coordinates={skipped} />);
    view.rerender(<MemoryGraph3D {...initial} coordinates={final} />);
    expect(installed.coordinates).toBe(original);
    expect(renderer.updateCoordinates).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Run graph benchmark" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { release(); await held; });
    await settle();
    expect(renderer.updateCoordinates).toHaveBeenCalledTimes(2); // A finishes; only the newest queued snapshot follows.
    expect(vi.mocked(prepareMemoryCoordinates).mock.calls.map(call => call[1])).toEqual([initial.coordinates, a, final]);
    expect([...installed.coordinates.subarray(4, 7)]).toEqual([70, 80, 90]);
    expect((screen.getByRole("button", { name: "Run graph benchmark" }) as HTMLButtonElement).disabled).toBe(true);
    await frame();
    expect((screen.getByRole("button", { name: "Run graph benchmark" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("application").getAttribute("aria-busy")).toBe("false");
  });

  it.each(["graph replacement", "context restoration", "unmount"] as const)("cancels pending coordinate publication after %s", async cause => {
    const initial = graph(2049, 1);
    const installed = (await realScene.buildMemoryGpuScene(initial.nodes, initial.edges, initial.positions, initial.coordinates))!;
    vi.mocked(buildMemoryGpuScene).mockResolvedValueOnce(installed);
    const view = render(<MemoryGraph3D {...initial} />);
    await settle(); await frame();
    const renderer = doubles.renderers[0]!, before = installed.coordinates;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let cancelledAfterRelease = false;
    vi.mocked(prepareMemoryCoordinates).mockImplementationOnce(async (_scene, _points, cancelled) => {
      await held; cancelledAfterRelease = cancelled!();
      // Even a late completion must not publish into a replacement renderer/scene.
      return { coordinates: new Float32Array(before.length).fill(999), extent: 999 };
    });
    view.rerender(<MemoryGraph3D {...initial} coordinates={new Map(initial.coordinates)} />);
    const canvas = screen.getByRole("application");
    if (cause === "graph replacement") view.rerender(<MemoryGraph3D {...graph(3, 2)} />);
    else if (cause === "context restoration") {
      fireEvent(canvas, new Event("webglcontextlost", { cancelable: true }));
      view.rerender(<MemoryGraph3D {...graph(3, 2)} />);
      fireEvent(canvas, new Event("webglcontextrestored"));
    } else view.unmount();
    await settle();
    await act(async () => { release(); await held; });
    await settle(); await frame();
    expect(cancelledAfterRelease).toBe(true);
    expect(installed.coordinates).toBe(before);
    expect(renderer.updateCoordinates).not.toHaveBeenCalled();
    if (cause !== "unmount") {
      const active = doubles.renderers.at(-1)!;
      expect(active.setScene.mock.calls.at(-1)![0].nodes).toHaveLength(3);
      expect(screen.getByRole("application").getAttribute("aria-busy")).toBe("false");
    }
  });

  it("coalesces high-rate hover into one pick per animation frame using the latest pointer", async () => {
    render(<MemoryGraph3D {...graph()} />);
    await settle(); await frame();
    const canvas = screen.getByRole("application") as HTMLCanvasElement;
    const renderer = doubles.renderers[0]!;
    renderer.pick.mockReturnValue(1);
    for (let index = 0; index < 50; index++) pointer(canvas, "pointermove", 1, 100 + index, 150);
    expect(renderer.pick).not.toHaveBeenCalled();
    await frame();
    expect(renderer.pick).toHaveBeenCalledOnce();
    expect(renderer.pick.mock.calls[0]?.slice(0, 2)).toEqual([149, 150]);
    expect(renderer.draw.mock.calls.at(-1)?.[1]).toBe(1);
    pointer(canvas, "pointermove", 1, 200, 250);
    await frame();
    expect(renderer.pick).toHaveBeenCalledTimes(2);
    pointer(canvas, "pointermove", 1, 300, 350);
    fireEvent.pointerLeave(canvas);
    await frame();
    expect(renderer.pick).toHaveBeenCalledTimes(2);
    expect(renderer.draw.mock.calls.at(-1)?.[1]).toBe(-1);
  });

  it("never treats the final release of a multi-pointer gesture as a node click", async () => {
    const props = graph();
    render(<MemoryGraph3D {...props} />);
    await settle(); await frame();
    const canvas = screen.getByRole("application") as HTMLCanvasElement;
    const renderer = doubles.renderers[0]!;
    renderer.pick.mockReturnValue(1);
    pointer(canvas, "pointerdown", 1, 100, 100);
    pointer(canvas, "pointerdown", 2, 200, 100);
    pointer(canvas, "pointermove", 2, 202, 100); // Tiny pinch: less than the single-pointer drag threshold.
    pointer(canvas, "pointerup", 1, 100, 100);
    pointer(canvas, "pointerup", 2, 202, 100);
    expect(props.onSelectNode).not.toHaveBeenCalled();
    expect(renderer.pick).not.toHaveBeenCalled();
    pointer(canvas, "pointerdown", 3, 150, 150);
    pointer(canvas, "pointerup", 3, 150, 150);
    expect(props.onSelectNode).toHaveBeenCalledOnce();
    expect(props.onSelectNode).toHaveBeenCalledWith("n-1");
  });

  it("cancels measurement when the graph changes and reports only a fresh graph run", async () => {
    window.history.replaceState({}, "", "/demo-workspace?memoryGraphBenchmark=1");
    const view = render(<MemoryGraph3D {...graph()} />);
    await settle(); await frame();
    const button = screen.getByRole("button", { name: "Run graph benchmark" }) as HTMLButtonElement;
    fireEvent.click(button);
    for (let index = 0; index < 35; index++) await frame(); // Include samples beyond warm-up.
    expect(screen.getByRole("status").textContent).toContain("Measuring");

    view.rerender(<MemoryGraph3D {...graph(3, 2)} />);
    await settle(); await frame();
    expect(button.disabled).toBe(false);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByLabelText("Graph benchmark results")).toBeNull();

    fireEvent.click(button);
    for (let index = 0; index < 211; index++) await frame();
    const report = JSON.parse(screen.getByLabelText("Graph benchmark results").textContent!);
    expect(report).toMatchObject({ nodes: 3, edges: 2, samples: 180, gpu: "Mock GPU; not hardware evidence" });
    expect(report.rafIntervalsMs).toHaveLength(180);
    expect(report.cpuWorkAndSubmissionMs).toHaveLength(180);
    expect(report).not.toHaveProperty("webglCompletedDrawMs");
    expect(report.pickingMs).toHaveLength(180);
    expect(button.disabled).toBe(false);

    view.rerender(<MemoryGraph3D {...graph(4, 3)} />);
    await settle(); await frame();
    expect(screen.queryByLabelText("Graph benchmark results")).toBeNull();
  });

  it("uses the same controlled trajectory in both modes, restores interaction state, and fences only the diagnostic", async () => {
    window.history.replaceState({}, "", "/demo-workspace?memoryGraphBenchmark=1");
    render(<MemoryGraph3D {...graph()} />);
    await settle(); await frame();
    const canvas = screen.getByRole("application") as HTMLCanvasElement;
    const renderer = doubles.renderers[0]!;
    renderer.pick.mockReturnValue(1);
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    fireEvent.wheel(canvas, { deltaY: -100 });
    pointer(canvas, "pointermove", 1);
    await frame();
    const saved = { ...renderer.draw.mock.calls.at(-1)![0] };
    expect(renderer.draw.mock.calls.at(-1)![1]).toBe(1);
    renderer.draw.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Run graph benchmark" }));
    for (let index = 0; index < 210; index++) await frame();
    // A result cannot omit the interval following the last measured draw.
    expect(screen.queryByLabelText("Graph benchmark results")).toBeNull();
    await frame();
    const normalReport = screen.getByLabelText("Graph benchmark results").textContent!;
    const normal = JSON.parse(normalReport);
    const trace = renderer.draw.mock.calls.map(([camera, focus]) => [{ ...camera }, focus]);
    expect(trace).toHaveLength(210);
    expect(trace[0]![1]).toBe(-1); // Saved user hover does not change the controlled initial focus.
    expect(normal).toMatchObject({ mode: "NORMAL_INTERACTION", samples: 180, initialFocus: -1,
      contextAttributes: { antialias: true }, longTaskApiSupported: false, initialLoad: null });
    expect(normal.rafIntervalsMs).toHaveLength(180);
    expect(normal.cpuWorkAndSubmissionMs).toHaveLength(180);
    expect(normal).not.toHaveProperty("webglCompletedDrawMs");
    expect(normal.maxInteractionLongTaskMs).toBeNull();
    expect(renderer.finish).not.toHaveBeenCalled();
    await frame();
    expect(renderer.draw.mock.calls.at(-1)).toEqual([saved, 1]);

    renderer.draw.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Measure WebGL completion" }));
    expect(screen.queryByLabelText("Graph benchmark results")).toBeNull();
    for (let index = 0; index < 211; index++) await frame();
    const fenced = JSON.parse(screen.getByLabelText("WebGL completion diagnostic results").textContent!);
    expect(renderer.draw.mock.calls.map(([camera, focus]) => [{ ...camera }, focus])).toEqual(trace);
    expect(renderer.finish).toHaveBeenCalledTimes(210);
    expect(fenced).toMatchObject({ mode: "WEBGL_COMPLETION_DIAGNOSTIC", samples: 180 });
    expect(fenced.webglCompletedDrawMs).toHaveLength(180);
    expect(fenced.webglFenceWaitMs).toHaveLength(180);
    expect(fenced.rafIntervalsMs).toHaveLength(180);
    expect(screen.getByLabelText("Graph benchmark results").textContent).toBe(normalReport);
    await frame();
    expect(renderer.draw.mock.calls.at(-1)).toEqual([saved, 1]);
  });

  it.each(["coordinates", "hidden", "reset"] as const)("cancels a partial run on %s without publishing its samples", async (change) => {
    window.history.replaceState({}, "", "/demo-workspace?memoryGraphBenchmark=1");
    const props = graph();
    const view = render(<MemoryGraph3D {...props} />);
    await settle(); await frame();
    const canvas = screen.getByRole("application") as HTMLCanvasElement;
    const renderer = doubles.renderers[0]!;
    fireEvent.keyDown(canvas, { key: "ArrowRight" }); await frame();
    const saved = { ...renderer.draw.mock.calls.at(-1)![0] };
    const button = screen.getByRole("button", { name: "Run graph benchmark" }) as HTMLButtonElement;
    fireEvent.click(button);
    for (let index = 0; index < 40; index++) await frame();
    if (change === "coordinates") view.rerender(<MemoryGraph3D {...props} coordinates={new Map(props.coordinates)} />);
    if (change === "reset") view.rerender(<MemoryGraph3D {...props} resetToken={1} />);
    if (change === "hidden") {
      const descriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
      try {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        fireEvent(document, new Event("visibilitychange"));
      } finally {
        if (descriptor) Object.defineProperty(document, "visibilityState", descriptor);
        else Reflect.deleteProperty(document, "visibilityState");
      }
    }
    await settle(); await frame();
    expect(button.disabled).toBe(false);
    expect(screen.queryByLabelText("Graph benchmark results")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    if (change !== "reset") expect(renderer.draw.mock.calls.at(-1)![0]).toEqual(saved);
    else {
      const { DEFAULT_MEMORY_CAMERA } = await import("../src/features/memory-workspace/memory-3d.js");
      expect(renderer.draw.mock.calls.at(-1)![0]).toEqual(DEFAULT_MEMORY_CAMERA);
    }
  });

  it("bounds initial-load tasks at the settled draw and keeps intervening activity out of either measured phase", async () => {
    window.history.replaceState({}, "", "/demo-workspace?memoryGraphBenchmark=1");
    let clock = 20;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    Object.defineProperty(performance, "getEntriesByName", { configurable: true, value: () => [{ startTime: 10 }] });
    let emit!: (entries: Array<{ startTime: number; duration: number }>) => void;
    vi.stubGlobal("PerformanceObserver", class {
      static supportedEntryTypes = ["longtask"];
      constructor(callback: PerformanceObserverCallback) {
        emit = entries => callback({ getEntries: () => entries } as unknown as PerformanceObserverEntryList, this as unknown as PerformanceObserver);
      }
      observe = vi.fn(); disconnect = vi.fn(); takeRecords = () => [];
    });
    render(<MemoryGraph3D {...graph()} />);
    await settle(); clock = 50; await frame();
    clock = 200;
    fireEvent.click(screen.getByRole("button", { name: "Run graph benchmark" }));
    emit([{ startTime: 15, duration: 80 }, { startTime: 110, duration: 60 }, { startTime: 220, duration: 65 }]);
    for (let index = 0; index < 211; index++) { clock += 16; await frame(); }
    const report = JSON.parse(screen.getByLabelText("Graph benchmark results").textContent!);
    expect(report.initialLoad).toEqual({ startMs: 10, settledAtMs: 50, maxLongTaskMs: 80, longTasks: [{ start: 15, duration: 80 }] });
    expect(report.interactionLongTasks).toEqual([{ start: 220, duration: 65 }]);
    expect(report.maxInteractionLongTaskMs).toBe(65);
    expect(report.longTaskApiSupported).toBe(true);
  });
});
