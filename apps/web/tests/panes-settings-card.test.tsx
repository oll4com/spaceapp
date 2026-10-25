import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PanesSettingsCard } from "../src/features/settings/PanesSettingsCard.js";
import {
  PANES_HIDDEN_STORAGE_KEY,
  PANES_VISIBILITY_EVENT,
  readHiddenPaneIds,
  writeHiddenPaneIds,
  normalizeHiddenPaneIds
} from "../src/features/pane-visibility/use-panes-visibility.js";

afterEach(cleanup);

describe("usePanesVisibility helpers", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("normalizes hidden pane ids by filtering invalid ids and resolving action ids to pane ids", () => {
    expect(normalizeHiddenPaneIds(["chat", "invalid-id", "add-browser", "chat", "vnc"])).toEqual([
      "chat",
      "browser",
      "vnc"
    ]);
    expect(normalizeHiddenPaneIds(null)).toEqual([]);
    expect(normalizeHiddenPaneIds("string")).toEqual([]);
  });

  it("reads and writes hidden pane ids to localStorage", () => {
    expect(readHiddenPaneIds(localStorage)).toEqual([]);
    writeHiddenPaneIds(["browser", "youtube"], localStorage);
    expect(readHiddenPaneIds(localStorage)).toEqual(["browser", "youtube"]);
    writeHiddenPaneIds([], localStorage);
    expect(readHiddenPaneIds(localStorage)).toEqual([]);
    expect(localStorage.getItem(PANES_HIDDEN_STORAGE_KEY)).toBeNull();
  });
});

describe("PanesSettingsCard", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders all default non-CLI panes and their visibility toggles", () => {
    render(<PanesSettingsCard isHarnessEnabled={true} />);

    expect(screen.getByText("Workspace panes")).toBeTruthy();
    expect(screen.getByText("Chat")).toBeTruthy();
    expect(screen.getByText("Browser")).toBeTruthy();
    expect(screen.getByText("File Manager")).toBeTruthy();
    expect(screen.getByText("Databases")).toBeTruthy();
    expect(screen.getByText("Demo Projects")).toBeTruthy();
    expect(screen.getByText("YouTube")).toBeTruthy();
    expect(screen.getByText("VNC")).toBeTruthy();
    expect(screen.getByText("Live audio")).toBeTruthy();
    expect(screen.getByText("DeepSeek Harness")).toBeTruthy();

    const browserToggle = screen.getByRole("switch", { name: "Toggle Browser pane visibility" });
    expect(browserToggle).toBeTruthy();
    expect((browserToggle as HTMLInputElement).checked).toBe(true);
    expect((browserToggle as HTMLInputElement).disabled).toBe(false);
  });

  it("hides and unhides a pane when its toggle is switched", () => {
    render(<PanesSettingsCard isHarnessEnabled={true} />);

    const browserToggle = screen.getByRole("switch", {
      name: "Toggle Browser pane visibility"
    }) as HTMLInputElement;
    expect(browserToggle.checked).toBe(true);

    fireEvent.click(browserToggle);
    expect(browserToggle.checked).toBe(false);
    expect(readHiddenPaneIds(localStorage)).toContain("browser");

    fireEvent.click(browserToggle);
    expect(browserToggle.checked).toBe(true);
    expect(readHiddenPaneIds(localStorage)).not.toContain("browser");
  });

  it("resets all panes to visible when the reset button is clicked", () => {
    writeHiddenPaneIds(["browser", "youtube", "vnc"], localStorage);
    render(<PanesSettingsCard isHarnessEnabled={true} />);

    const browserToggle = screen.getByRole("switch", {
      name: "Toggle Browser pane visibility"
    }) as HTMLInputElement;
    expect(browserToggle.checked).toBe(false);

    const resetBtn = screen.getByRole("button", { name: "Reset pane visibility to defaults" });
    fireEvent.click(resetBtn);

    expect(browserToggle.checked).toBe(true);
    expect(readHiddenPaneIds(localStorage)).toEqual([]);
  });

  it("disables DeepSeek Harness toggle and marks it disabled when harness is not enabled", () => {
    render(<PanesSettingsCard isHarnessEnabled={false} />);

    const harnessToggle = screen.getByRole("switch", {
      name: "Toggle DeepSeek Harness pane visibility"
    }) as HTMLInputElement;
    expect(harnessToggle.disabled).toBe(true);
    expect(harnessToggle.checked).toBe(false);
    expect(screen.getByText("Harness disabled")).toBeTruthy();
  });

  it("enables DeepSeek Harness toggle when harness is enabled", () => {
    render(<PanesSettingsCard isHarnessEnabled={true} />);

    const harnessToggle = screen.getByRole("switch", {
      name: "Toggle DeepSeek Harness pane visibility"
    }) as HTMLInputElement;
    expect(harnessToggle.disabled).toBe(false);
    expect(harnessToggle.checked).toBe(true);
    expect(screen.queryByText("Harness disabled")).toBeNull();
  });
});
