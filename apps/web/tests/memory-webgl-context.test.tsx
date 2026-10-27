import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryGraph3D } from "../src/features/memory-workspace/MemoryGraph3D.js";

const state = vi.hoisted(() => ({ lost: false, fail: false, scenes: vi.fn() }));
vi.mock("../src/features/memory-workspace/memory-webgl.js", () => ({
  supportsMemoryWebGL2: () => true,
  MemoryWebGLRenderer: class {
    gl = { isContextLost: () => state.lost };
    constructor() { if (state.fail) throw new Error("initialization failed"); }
    setScene = state.scenes;
    resize() {}
    destroy() {}
    setFocus() {}
    draw() { return 1; }
  },
}));
vi.mock("../src/features/memory-workspace/MemoryGraph3DCanvas.js", () => ({
  MemoryGraph3DCanvas: () => <span data-testid="fallback" />,
}));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); state.lost = false; state.fail = false; state.scenes.mockReset(); });

function setup() {
  state.scenes.mockResolvedValue(true);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ setTransform() {}, clearRect() {} } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const onRendererAvailable = vi.fn();
  const props = { nodes: [], edges: [], positions: new Map(), coordinates: new Map(), showTitles: true, selectedNodeId: null, onSelectNode: vi.fn(), loading: false, resetToken: 0, onRendererAvailable };
  return { ...render(<MemoryGraph3D {...props} />), onRendererAvailable };
}

it("keeps renderer capability and graph data while a lost context is restored", async () => {
  const view = setup();
  await waitFor(() => expect(state.scenes).toHaveBeenCalled());
  const callsBeforeLoss = state.scenes.mock.calls.length;
  const scene = state.scenes.mock.calls.at(-1);
  const canvas = view.container.querySelector("canvas[data-renderer=webgl2]")!;
  act(() => { state.lost = true; canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true })); });
  expect(view.getByTestId("fallback")).toBeTruthy();
  expect(view.onRendererAvailable.mock.calls).toEqual([[true]]);
  act(() => { state.lost = false; canvas.dispatchEvent(new Event("webglcontextrestored")); });
  await waitFor(() => expect(view.queryByTestId("fallback")).toBeNull());
  expect(state.scenes).toHaveBeenCalledTimes(callsBeforeLoss + 1);
  expect(state.scenes.mock.calls.at(-1)).toEqual(scene);
  expect(view.onRendererAvailable.mock.calls).toEqual([[true]]);
});

it("reports a permanent initialization failure so the caller can reduce the fetch limit", async () => {
  state.fail = true;
  const view = setup();
  await waitFor(() => expect(view.onRendererAvailable).toHaveBeenLastCalledWith(false));
  expect(view.getByTestId("fallback")).toBeTruthy();
});
