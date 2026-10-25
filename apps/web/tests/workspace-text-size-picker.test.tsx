import { fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceTextSizePicker } from "../src/features/workspace-text-size-picker/WorkspaceTextSizePicker.js";

function PickerHarness({ initialValue = 12 }: { initialValue?: number }) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(initialValue);

  return (
    <>
      <button ref={anchorRef} type="button" onClick={() => setOpen((current) => !current)}>
        Workspace text size
      </button>
      <button type="button">Outside control</button>
      <output aria-label="Selected text size">{value}</output>
      <WorkspaceTextSizePicker
        anchorRef={anchorRef}
        open={open}
        value={value}
        onChange={setValue}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("WorkspaceTextSizePicker", () => {
  it("shows five centered integer values and keeps the picker open after selection", () => {
    render(<PickerHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Workspace text size" }));

    const picker = screen.getByRole("listbox", { name: "Workspace text size" });
    expect(picker).toBe(document.activeElement);
    expect(screen.getAllByRole("option").map((option) => option.getAttribute("aria-label"))).toEqual(["10 px", "11 px", "12 px", "13 px", "14 px"]);

    fireEvent.click(screen.getByRole("option", { name: "14 px" }));
    expect(screen.getByLabelText("Selected text size").textContent).toBe("14");
    expect(screen.getByRole("listbox", { name: "Workspace text size" })).toBeTruthy();
    expect(screen.getAllByRole("option").map((option) => option.getAttribute("aria-label"))).toEqual(["12 px", "13 px", "14 px", "15 px", "16 px"]);
  });

  it("normalizes wheel movement at 40px and resets partial movement after 150ms", () => {
    vi.useFakeTimers();
    render(<PickerHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Workspace text size" }));
    const picker = screen.getByRole("listbox", { name: "Workspace text size" });

    fireEvent.wheel(picker, { deltaY: 20, deltaMode: WheelEvent.DOM_DELTA_PIXEL });
    expect(screen.getByLabelText("Selected text size").textContent).toBe("12");
    fireEvent.wheel(picker, { deltaY: 20, deltaMode: WheelEvent.DOM_DELTA_PIXEL });
    expect(screen.getByLabelText("Selected text size").textContent).toBe("13");

    fireEvent.wheel(picker, { deltaY: -20, deltaMode: WheelEvent.DOM_DELTA_PIXEL });
    vi.advanceTimersByTime(151);
    fireEvent.wheel(picker, { deltaY: -20, deltaMode: WheelEvent.DOM_DELTA_PIXEL });
    expect(screen.getByLabelText("Selected text size").textContent).toBe("13");
    fireEvent.wheel(picker, { deltaY: -20, deltaMode: WheelEvent.DOM_DELTA_PIXEL });
    expect(screen.getByLabelText("Selected text size").textContent).toBe("12");
  });

  it("supports arrow, home, and end keys while clamping to 10–20px", () => {
    render(<PickerHarness initialValue={10} />);
    fireEvent.click(screen.getByRole("button", { name: "Workspace text size" }));
    const picker = screen.getByRole("listbox", { name: "Workspace text size" });

    fireEvent.keyDown(picker, { key: "ArrowUp" });
    expect(screen.getByLabelText("Selected text size").textContent).toBe("10");
    fireEvent.keyDown(picker, { key: "End" });
    expect(screen.getByLabelText("Selected text size").textContent).toBe("20");
    fireEvent.keyDown(picker, { key: "ArrowDown" });
    expect(screen.getByLabelText("Selected text size").textContent).toBe("20");
    fireEvent.keyDown(picker, { key: "Home" });
    expect(screen.getByLabelText("Selected text size").textContent).toBe("10");
  });

  it("restores trigger focus on Escape and dismisses on outside pointer or focus loss", () => {
    render(<PickerHarness />);
    const trigger = screen.getByRole("button", { name: "Workspace text size" });
    const outside = screen.getByRole("button", { name: "Outside control" });

    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("listbox", { name: "Workspace text size" }), { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Workspace text size" })).toBeNull();
    expect(trigger).toBe(document.activeElement);

    fireEvent.click(trigger);
    fireEvent.pointerDown(outside);
    expect(screen.queryByRole("listbox", { name: "Workspace text size" })).toBeNull();

    fireEvent.click(trigger);
    fireEvent.blur(screen.getByRole("listbox", { name: "Workspace text size" }), { relatedTarget: outside });
    expect(screen.queryByRole("listbox", { name: "Workspace text size" })).toBeNull();
  });

  it("clamps to a mobile viewport, opens above when needed, and repositions below on desktop", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 320 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 300 });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("workspace-text-size-picker")) {
        return { bottom: 228, height: 228, left: 0, right: 112, top: 0, width: 112, x: 0, y: 0, toJSON: () => ({}) };
      }
      if (this.textContent === "Workspace text size") {
        return { bottom: 294, height: 44, left: 300, right: 344, top: 250, width: 44, x: 300, y: 250, toJSON: () => ({}) };
      }
      return { bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) };
    });

    render(<PickerHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Workspace text size" }));
    const picker = screen.getByRole("listbox", { name: "Workspace text size" });
    expect(picker.getAttribute("data-placement")).toBe("above");
    expect(picker.style.left).toBe("200px");
    expect(picker.style.top).toBe("14px");

    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1440 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 900 });
    fireEvent(window, new Event("resize"));
    expect(picker.getAttribute("data-placement")).toBe("below");
    expect(picker.style.left).toBe("266px");
    expect(picker.style.top).toBe("302px");
  });
});
