import { describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { skipEmptySelectionRedraw } from "../src/features/terminal-pane/terminal-selection-redraw.js";

// Freeze report 22/11 (operator-approved): 25.7 s of 104 s frozen was xterm's selection redraw.
describe("skipEmptySelectionRedraw", () => {
  it("skips the full-terminal redraw only when no selection exists before or after", () => {
    window.matchMedia = vi.fn().mockImplementation(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const host = document.createElement("div");
    document.body.append(host);
    const terminal = new Terminal({ cols: 80, rows: 20 });
    terminal.open(host);
    const renderService = (terminal as unknown as { _core: { _renderService: {
      _renderer: { value: { handleSelectionChanged: (...args: unknown[]) => void } };
      _selectionState: { start?: [number, number]; end?: [number, number] };
      handleSelectionChanged: (start?: [number, number], end?: [number, number], column?: boolean) => void;
    } } })._core._renderService;
    const redraw = vi.spyOn(renderService._renderer.value, "handleSelectionChanged").mockImplementation(() => {});

    expect(skipEmptySelectionRedraw(terminal)).toBe(true);
    renderService.handleSelectionChanged(undefined, undefined, false);
    renderService.handleSelectionChanged([3, 1], [3, 1], false);
    expect(redraw).not.toHaveBeenCalled();
    expect(renderService._selectionState.start).toEqual([3, 1]);

    renderService.handleSelectionChanged([0, 0], [5, 0], false);
    expect(redraw).toHaveBeenCalledTimes(1);
    // Clearing a real selection must still erase it on screen.
    renderService.handleSelectionChanged(undefined, undefined, false);
    expect(redraw).toHaveBeenCalledTimes(2);
    renderService.handleSelectionChanged(undefined, undefined, false);
    expect(redraw).toHaveBeenCalledTimes(2);

    terminal.dispose();
    host.remove();
  });

  it("leaves a terminal without a render service alone", () => {
    expect(skipEmptySelectionRedraw({})).toBe(false);
    expect(skipEmptySelectionRedraw(null)).toBe(false);
  });
});
