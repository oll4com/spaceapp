import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryGraph3DCanvas } from "../src/features/memory-workspace/MemoryGraph3DCanvas.js";
import { DEFAULT_MEMORY_CAMERA, projectMemoryPoint } from "../src/features/memory-workspace/memory-3d.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("keeps fallback framing on visible nodes without traversing hidden coordinates during interactions", () => {
  const context = { setTransform: vi.fn(), clearRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), arc: vi.fn(), fill: vi.fn(), fillText: vi.fn(), measureText: vi.fn(() => ({ width: 20 })) };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 800, height: 600, left: 0, top: 0 } as DOMRect);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  let frame: FrameRequestCallback | undefined;
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { frame = callback; return 1; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const point = { x: 30, y: 0, z: 0 };
  const coordinates = new Map([["visible", point], ...Array.from({ length: 50_000 }, (_, i) => [`hidden${i}`, { x: 1e9, y: 1e9, z: 1e9 }] as const)]);
  const scan = vi.spyOn(coordinates, "values").mockImplementation(() => { throw new Error("Full coordinate scan"); });
  const nodes = [{ id: "visible", type: "MEMORY" as const, label: "Visible", sourcePath: null, recordId: null }];
  const view = render(<MemoryGraph3DCanvas nodes={nodes} edges={[]} positions={new Map()} coordinates={coordinates} showTitles={false} selectedNodeId={null} onSelectNode={vi.fn()} loading={false} resetToken={0} />);
  act(() => { frame?.(0); });
  const expected = projectMemoryPoint(point, DEFAULT_MEMORY_CAMERA, 600 * 0.4 / 60, 800, 600);
  expect(context.arc.mock.calls[0]![0]).toBeCloseTo(expected.x);
  expect(context.arc.mock.calls[0]![1]).toBeCloseTo(expected.y);
  fireEvent.wheel(view.getByRole("application"), { deltaY: -10 });
  act(() => { frame?.(1); });
  expect(context.arc).toHaveBeenCalledTimes(2);
  expect(scan).not.toHaveBeenCalled();
});
