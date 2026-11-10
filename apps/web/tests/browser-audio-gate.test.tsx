import { act, cleanup, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserPaneAudible, useBrowserPaneAudible } from "../src/features/browser-pane/browser-audio-gate.js";

// Operator 2/11 14:22 BKK: a browser pane is heard only while it is focused and in front of them.
describe("browser pane audio gate", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("plays only for the selected or maximized pane of the shown room in a focused, visible window", () => {
    expect(browserPaneAudible(true, true, "pane-card browser-pane-card is-target")).toBe(true);
    expect(browserPaneAudible(true, true, "pane-card is-maximized browser-pane-card")).toBe(true);
    expect(browserPaneAudible(true, true, "pane-card browser-pane-card")).toBe(false); // another pane is selected
    expect(browserPaneAudible(true, true, "pane-card is-minimized is-target")).toBe(false);
    expect(browserPaneAudible(true, true, "pane-card is-target is-shell-hidden")).toBe(false);
    expect(browserPaneAudible(false, true, "pane-card is-target")).toBe(false); // its room is not on screen
    expect(browserPaneAudible(true, false, "pane-card is-target")).toBe(false); // Space window blurred or hidden
  });

  function Probe() {
    const ref = useRef<HTMLElement | null>(null);
    return <section ref={ref}><output>{String(useBrowserPaneAudible(ref, true))}</output></section>;
  }

  it("follows the card's class, window focus and page visibility at once", async () => {
    let focused = true;
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const view = render(<div className="pane-card is-target"><Probe /></div>);
    expect(screen.getByText("true")).toBeTruthy();
    const card = view.container.querySelector(".pane-card")!;

    await act(async () => { card.className = "pane-card"; });
    expect(screen.getByText("false")).toBeTruthy();
    await act(async () => { card.className = "pane-card is-maximized"; });
    expect(screen.getByText("true")).toBeTruthy();
    await act(async () => { card.className = "pane-card is-maximized is-minimized"; });
    expect(screen.getByText("false")).toBeTruthy();
    await act(async () => { card.className = "pane-card is-target"; });
    expect(screen.getByText("true")).toBeTruthy();

    focused = false;
    await act(async () => { window.dispatchEvent(new Event("blur")); await new Promise((done) => setTimeout(done, 5)); });
    expect(screen.getByText("false")).toBeTruthy();
    focused = true;
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(screen.getByText("true")).toBeTruthy();

    visibility = "hidden";
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(screen.getByText("false")).toBeTruthy();
  });
});
