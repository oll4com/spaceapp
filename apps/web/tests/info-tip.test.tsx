import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { InfoTip } from "../src/features/ui-controls/InfoTip.js";
import { SettingsLabel } from "../src/features/settings/SettingsLabel.js";
import { SpaceToggle } from "../src/features/ui-controls/SpaceToggle.js";
import { announceUiLanguage } from "../src/features/ui-language/ui-language.js";

afterEach(() => {
  cleanup();
  act(() => announceUiLanguage("en"));
});

const tipOf = (button: HTMLElement) => document.getElementById(button.getAttribute("aria-describedby")!)!;
const isOpen = (button: HTMLElement) => !tipOf(button).hidden && button.getAttribute("aria-expanded") === "true";

describe("InfoTip (Settings ⓘ help)", () => {
  it("describes its button and opens while a mouse hovers it", () => {
    render(<InfoTip text="What it does." label="About Engine" />);
    const button = screen.getByRole("button", { name: "About Engine" });
    expect(tipOf(button).textContent).toBe("What it does.");
    expect(tipOf(button).getAttribute("role")).toBe("tooltip");
    expect(isOpen(button)).toBe(false);
    fireEvent.pointerEnter(button.parentElement!, { pointerType: "mouse" });
    expect(isOpen(button)).toBe(true);
    fireEvent.pointerLeave(button.parentElement!, { pointerType: "mouse" });
    expect(isOpen(button)).toBe(false);
  });

  it("a tap holds it open; a second tap or a tap outside closes it", () => {
    render(<><InfoTip text="Help" label="About Engine" /><p>outside</p></>);
    const button = screen.getByRole("button", { name: "About Engine" });
    fireEvent.pointerEnter(button.parentElement!, { pointerType: "touch" });
    expect(isOpen(button)).toBe(false);
    fireEvent.click(button);
    expect(isOpen(button)).toBe(true);
    fireEvent.click(button);
    expect(isOpen(button)).toBe(false);
    fireEvent.click(button);
    fireEvent.pointerDown(screen.getByText("outside"));
    expect(isOpen(button)).toBe(false);
  });

  it("is reachable by keyboard: focus opens it, Enter pins it, Esc closes it without reaching the dock", () => {
    let dockSawEscape = false;
    const onWindowKey = (event: KeyboardEvent) => { if (event.key === "Escape") dockSawEscape = true; };
    window.addEventListener("keydown", onWindowKey);
    render(<InfoTip text="Help" label="About Engine" />);
    const button = screen.getByRole("button", { name: "About Engine" });
    expect(button.tabIndex).toBe(0);
    act(() => button.focus());
    expect(isOpen(button)).toBe(true);
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.blur(button);
    expect(isOpen(button)).toBe(true);
    fireEvent.keyDown(button, { key: "Escape" });
    expect(isOpen(button)).toBe(false);
    expect(dockSawEscape).toBe(false);
    window.removeEventListener("keydown", onWindowKey);
  });

  it("inside a <label> it never takes the label's control, and a tap on it does not reach the control", () => {
    render(<label><SettingsLabel label="Engine" help="Help" /><select aria-label="engine"><option>A</option></select></label>);
    const button = screen.getByRole("button", { name: "About Engine" });
    expect(button.tagName).toBe("SPAN");
    fireEvent.click(button);
    expect(document.activeElement).not.toBe(screen.getByRole("combobox"));
    expect(isOpen(button)).toBe(true);
  });

  it("shows the label, its help and a switch's help in the interface language", () => {
    act(() => announceUiLanguage("el"));
    render(<><SettingsLabel label="Provider" help="About {label}" /><SpaceToggle label="Voice input" help="About {label}" checked={false} onChange={() => {}} /></>);
    expect(screen.getByText("Πάροχος")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Σχετικά με: Πάροχος" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Σχετικά με: Voice input" })).toBeTruthy();
  });
});
