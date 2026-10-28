import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BrowserSelectList, parseBrowserSelectState } from "../src/features/browser-pane/BrowserSelectOverlay.js";

// Option D (plan clipboard:gHaiX_8yanVA): the live view draws the open native dropdown Chrome keeps in a popup no frame shows.
const state = { selectedIndex: 0, box: { x: 100, y: 50, width: 200, height: 30 }, labels: ["Choose a country", "Greece", "Oman", "Thailand"], disabled: [0, 2], truncated: false };

afterEach(cleanup);

describe("the live view's dropdown list", () => {
  it("reads the host's answer and ignores anything else", () => {
    expect(parseBrowserSelectState(JSON.stringify(state))).toEqual(state);
    for (const text of [null, undefined, "", "null", "{", JSON.stringify({ labels: "x" })]) expect(parseBrowserSelectState(text)).toBeNull();
  });

  it("moves over enabled options only, picks with Enter and closes with Escape", () => {
    const onChoose = vi.fn();
    const onDismiss = vi.fn();
    render(<BrowserSelectList state={state} viewport={{ width: 1440, height: 900 }} onChoose={onChoose} onDismiss={onDismiss} />);
    const list = screen.getByRole("listbox", { name: "Dropdown options" });
    expect(document.activeElement).toBe(list);
    expect(screen.getByRole("option", { name: "Choose a country" }).getAttribute("aria-disabled")).toBe("true");
    // The selected option is disabled, so the first enabled one is active; ArrowDown skips "Oman".
    expect(list.getAttribute("aria-activedescendant")).toBe(screen.getByRole("option", { name: "Greece" }).id);
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(list.getAttribute("aria-activedescendant")).toBe(screen.getByRole("option", { name: "Thailand" }).id);
    fireEvent.keyDown(list, { key: "Enter" });
    expect(onChoose).toHaveBeenCalledWith(3);
    fireEvent.keyDown(list, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("ignores a click on a disabled option and says when options were left out", () => {
    const onChoose = vi.fn();
    render(<BrowserSelectList state={{ ...state, truncated: true }} viewport={{ width: 1440, height: 900 }} onChoose={onChoose} onDismiss={vi.fn()} />);
    fireEvent.click(screen.getByRole("option", { name: "Oman" }));
    expect(onChoose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("option", { name: "Greece" }));
    expect(onChoose).toHaveBeenCalledWith(1);
    expect(screen.getByText("More options not shown: close this list and use the arrow keys.")).toBeTruthy();
  });
});
