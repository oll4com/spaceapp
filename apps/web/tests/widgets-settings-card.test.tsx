import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WidgetsSettingsCard, WIDGET_DEFINITIONS } from "../src/features/settings/WidgetsSettingsCard.js";
import {
  WIDGETS_HIDDEN_STORAGE_KEY,
  readHiddenWidgetIds,
  writeHiddenWidgetIds,
  normalizeHiddenWidgetIds,
  loadWidgetStates,
  saveWidgetStates
} from "../src/features/desktop-widgets/index.js";

afterEach(cleanup);

describe("useWidgetsVisibility helpers", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("normalizes hidden widget ids by filtering invalid ids", () => {
    expect(normalizeHiddenWidgetIds(["clock", "invalid-id", "countdown-timer", "clock"])).toEqual([
      "clock",
      "countdown-timer"
    ]);
    expect(normalizeHiddenWidgetIds(null)).toEqual([]);
    expect(normalizeHiddenWidgetIds("string")).toEqual([]);
  });

  it("reads and writes hidden widget ids to localStorage", () => {
    expect(readHiddenWidgetIds(localStorage)).toEqual([]);
    writeHiddenWidgetIds(["clock", "pushup-reminder"], localStorage);
    expect(readHiddenWidgetIds(localStorage)).toEqual(["clock", "pushup-reminder"]);
    writeHiddenWidgetIds([], localStorage);
    expect(readHiddenWidgetIds(localStorage)).toEqual([]);
    expect(localStorage.getItem(WIDGETS_HIDDEN_STORAGE_KEY)).toBeNull();
  });
});

describe("WidgetsSettingsCard", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("renders all 7 desktop widgets and their visibility toggle switches (enabled by default)", () => {
    render(<WidgetsSettingsCard />);

    expect(screen.getByText("Desktop widgets")).toBeTruthy();
    expect(screen.getByText(/Choose which desktop widgets appear in your tools menu/)).toBeTruthy();

    for (const widget of WIDGET_DEFINITIONS) {
      expect(screen.getByText(widget.label)).toBeTruthy();
      const toggle = screen.getByRole("switch", { name: `Toggle ${widget.label} visibility` });
      expect(toggle).toBeTruthy();
      expect((toggle as HTMLInputElement).checked).toBe(true);
    }
  });

  it("hides and unhides a widget when its toggle is switched", () => {
    render(<WidgetsSettingsCard />);

    const clockToggle = screen.getByRole("switch", {
      name: "Toggle Clock widget visibility"
    }) as HTMLInputElement;
    expect(clockToggle.checked).toBe(true);

    // Disable (hide)
    fireEvent.click(clockToggle);
    expect(clockToggle.checked).toBe(false);
    expect(readHiddenWidgetIds(localStorage)).toContain("clock");

    // Enable (show)
    fireEvent.click(clockToggle);
    expect(clockToggle.checked).toBe(true);
    expect(readHiddenWidgetIds(localStorage)).not.toContain("clock");
  });

  it("disables the floating widget if it was floating when disabled in settings", () => {
    const states = loadWidgetStates();
    states.clock.enabled = true;
    saveWidgetStates(states);

    render(<WidgetsSettingsCard />);

    const clockToggle = screen.getByRole("switch", {
      name: "Toggle Clock widget visibility"
    }) as HTMLInputElement;

    fireEvent.click(clockToggle);
    expect(clockToggle.checked).toBe(false);

    const statesAfter = loadWidgetStates();
    expect(statesAfter.clock.enabled).toBe(false);
  });

  it("resets all widgets to visible when the reset button is clicked", () => {
    writeHiddenWidgetIds(["clock", "countdown-timer", "pushup-reminder"], localStorage);
    render(<WidgetsSettingsCard />);

    const clockToggle = screen.getByRole("switch", {
      name: "Toggle Clock widget visibility"
    }) as HTMLInputElement;
    expect(clockToggle.checked).toBe(false);

    const resetBtn = screen.getByRole("button", { name: "Reset widget visibility to defaults" });
    fireEvent.click(resetBtn);

    expect(clockToggle.checked).toBe(true);
    expect(readHiddenWidgetIds(localStorage)).toEqual([]);
  });
});
