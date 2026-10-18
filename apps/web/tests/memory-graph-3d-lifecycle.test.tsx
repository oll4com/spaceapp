import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryGraphNode } from "@space/contracts";
import { MemoryGraph3D } from "../src/features/memory-workspace/MemoryGraph3D.js";
import type { MemoryCamera3D } from "../src/features/memory-workspace/memory-3d.js";

const lifecycle = vi.hoisted(() => ({ created: vi.fn(), disposed: vi.fn(), uploaded: vi.fn(), rendered: vi.fn(), delayPreparation: false, prepareGates: [] as Array<() => void> }));
vi.mock("../src/features/memory-workspace/memory-webgl-renderer.js", async importOriginal => {
  const original = await importOriginal<typeof import("../src/features/memory-workspace/memory-webgl-renderer.js")>();
  return { ...original, prepareMemoryRenderDataAsync: async (...args: Parameters<typeof original.prepareMemoryRenderDataAsync>) => {
    if (lifecycle.delayPreparation) await new Promise<void>(resolve => lifecycle.prepareGates.push(resolve));
    return original.prepareMemoryRenderDataAsync(...args);
  }, MemoryWebGLRenderer: class {
    gpuMs = null;
    constructor() { lifecycle.created(); }
    setData(data: unknown) { lifecycle.uploaded(data); }
    render(camera: MemoryCamera3D) { lifecycle.rendered({ ...camera }); }
    dispose() { lifecycle.disposed(); }
  } };
});

describe("3D memory renderer lifecycle", () => {
  const context = { clearRect: vi.fn(), setTransform: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), arc: vi.fn(), fill: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(), measureText: () => ({ width: 60 }) };
  beforeEach(() => {
    vi.clearAllMocks();
    lifecycle.delayPreparation = false; lifecycle.prepareGates.length = 0;
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
    vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 1000, height: 700, left: 0, top: 0, right: 1000, bottom: 700, x: 0, y: 0, toJSON() {} });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((kind: string) => kind === "2d" ? context : { getExtension: () => null, getParameter: () => "test GPU" }) as unknown as typeof HTMLCanvasElement.prototype.getContext);
  });
  afterEach(() => { cleanup(); for (const resolve of lifecycle.prepareGates) resolve(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("cancels deferred initial and restored GPU startup when unmounted", async () => {
    const nodes: MemoryGraphNode[] = [{ id: "root", type: "SOURCE", label: "space.md", sourcePath: null, recordId: null }];
    const props = { nodes, edges: [], positions: new Map(), coordinates: new Map([["root", { x: 0, y: 0, z: 0 }]]), showTitles: false, selectedNodeId: null, onSelectNode: vi.fn(), loading: false, resetToken: 0 };
    const first = render(<MemoryGraph3D {...props} />);
    expect(lifecycle.created).not.toHaveBeenCalled();
    first.unmount(); await new Promise(resolve => setTimeout(resolve, 5));
    expect(lifecycle.created).not.toHaveBeenCalled();
    const second = render(<MemoryGraph3D {...props} />), canvas = second.getByRole("application") as HTMLCanvasElement;
    await waitFor(() => expect(canvas.dataset.renderer).toBe("webgl2"));
    expect(lifecycle.created).toHaveBeenCalledTimes(1);
    fireEvent(canvas, new Event("webglcontextlost", { cancelable: true }));
    fireEvent(canvas, new Event("webglcontextrestored"));
    second.unmount(); await new Promise(resolve => setTimeout(resolve, 5));
    expect(lifecycle.created).toHaveBeenCalledTimes(1);
    expect(lifecycle.disposed).toHaveBeenCalledTimes(1);
  });

  it("commits an in-flight streamed layout before preparing the newest queued coordinates", async () => {
    lifecycle.delayPreparation = true;
    const nodes: MemoryGraphNode[] = [{ id: "root", type: "SOURCE", label: "space.md", sourcePath: null, recordId: null }];
    const positions = new Map(), edges: [] = [];
    const coordinates = (x: number) => new Map([["root", { x, y: 0, z: 0 }]]);
    const props = { nodes, edges, positions, showTitles: true, selectedNodeId: null, onSelectNode: vi.fn(), loading: false, resetToken: 0 };
    const result = render(<MemoryGraph3D {...props} coordinates={coordinates(1)} />), canvas = result.getByRole("application") as HTMLCanvasElement;
    await waitFor(() => expect(lifecycle.prepareGates).toHaveLength(1));
    result.rerender(<MemoryGraph3D {...props} coordinates={coordinates(2)} />);
    result.rerender(<MemoryGraph3D {...props} coordinates={coordinates(3)} />);
    lifecycle.prepareGates[0]!();
    await waitFor(() => { expect(canvas.dataset.nodeCount).toBe("1"); expect(lifecycle.prepareGates).toHaveLength(2); });
    expect(canvas.getAttribute("aria-busy")).toBe("true");
    expect(lifecycle.uploaded.mock.lastCall?.[0].nodes[0].point.x).toBe(1);
    lifecycle.prepareGates[1]!();
    await waitFor(() => expect(canvas.getAttribute("aria-busy")).toBe("false"));
    await waitFor(() => expect(lifecycle.uploaded.mock.lastCall?.[0].nodes[0].point.x).toBe(3));
    expect(lifecycle.prepareGates).toHaveLength(2);
  });

  it("zooms with +/- and unshifted key variants, clamps both bounds and resets the camera", async () => {
    const nodes: MemoryGraphNode[] = [{ id: "root", type: "SOURCE", label: "space.md", sourcePath: null, recordId: null }];
    const props = { nodes, edges: [], positions: new Map(), coordinates: new Map([["root", { x: 0, y: 0, z: 0 }]]), showTitles: false, selectedNodeId: null, onSelectNode: vi.fn(), loading: false, resetToken: 0 };
    const result = render(<MemoryGraph3D {...props} />), canvas = result.getByRole("application");
    await waitFor(() => expect(canvas.getAttribute("aria-busy")).toBe("false"));
    expect(canvas.getAttribute("aria-label")).toContain("plus and minus keys");
    expect(result.container.querySelector(".memory-3d-hint")?.textContent).toContain("+/- to zoom");
    const zoom = async (keys: string[], expected: number) => {
      const before = lifecycle.rendered.mock.calls.length;
      for (const key of keys) {
        const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
        fireEvent(canvas, event); expect(event.defaultPrevented).toBe(true);
      }
      await waitFor(() => expect(lifecycle.rendered.mock.calls.length).toBeGreaterThan(before));
      expect(lifecycle.rendered.mock.lastCall?.[0].zoom).toBeCloseTo(expected);
    };
    await zoom(["+"], 1.2); await zoom(["-"], 1);
    await zoom(["="], 1.2); await zoom(["_"], 1);
    await zoom(Array(30).fill("+"), 5); await zoom(Array(40).fill("-"), 0.35);
    result.rerender(<MemoryGraph3D {...props} resetToken={1} />);
    await waitFor(() => expect(lifecycle.rendered.mock.lastCall?.[0].zoom).toBe(1));
  });

  it("retains keyboard/ARIA, caps context-loss fallback, restores full WebGL and releases resources", async () => {
    const nodes: MemoryGraphNode[] = Array.from({ length: 2005 }, (_, index) => ({ id: `node-${index}`, type: index === 0 ? "SOURCE" : "MEMORY", label: index === 0 ? "space.md" : `Memory ${index}`, sourcePath: null, recordId: null }));
    const coordinates = new Map(nodes.map((node, index) => [node.id, { x: Math.sin(index) * 200, y: Math.cos(index * 0.6) * 200, z: Math.sin(index * 0.3) * 200 }]));
    const onSelectNode = vi.fn();
    const props = { nodes, coordinates, edges: [], positions: new Map(), showTitles: true, selectedNodeId: nodes[0]!.id, onSelectNode, loading: false, resetToken: 0 };
    const result = render(<MemoryGraph3D {...props} />), canvas = result.getByRole("application") as HTMLCanvasElement;
    await waitFor(() => { expect(canvas.dataset.renderer).toBe("webgl2"); expect(canvas.dataset.nodeCount).toBe("2005"); expect(canvas.getAttribute("aria-busy")).toBe("false"); });
    expect(canvas.tabIndex).toBe(0); expect(canvas.getAttribute("aria-label")).toContain("arrow keys");
    const original = canvas.dataset.rotation; fireEvent.keyDown(canvas, { key: "ArrowRight" });
    await waitFor(() => expect(canvas.dataset.rotation).not.toBe(original));
    fireEvent.keyDown(canvas, { key: "Enter" }); expect(onSelectNode).toHaveBeenCalledWith(nodes[0]!.id);
    const loss = new Event("webglcontextlost", { cancelable: true }); fireEvent(canvas, loss);
    expect(loss.defaultPrevented).toBe(true);
    await waitFor(() => { expect(canvas.dataset.renderer).toBe("canvas2d"); expect(canvas.dataset.nodeCount).toBe("2000"); });
    expect(lifecycle.disposed).toHaveBeenCalledTimes(1);
    fireEvent(canvas, new Event("webglcontextrestored"));
    await waitFor(() => { expect(canvas.dataset.renderer).toBe("webgl2"); expect(canvas.dataset.nodeCount).toBe("2005"); });
    expect(lifecycle.created).toHaveBeenCalledTimes(2);
    result.rerender(<MemoryGraph3D {...props} showTitles={false} />);
    await waitFor(() => expect(canvas.dataset.labelCount).toBe("0"));
    expect(canvas.dataset.titlesVisible).toBe("false"); expect(canvas.dataset.layoutVolume).toBeDefined();
    result.unmount(); expect(lifecycle.disposed).toHaveBeenCalledTimes(2);
  });
});
