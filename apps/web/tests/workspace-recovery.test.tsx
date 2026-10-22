import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SurfaceErrorBoundary } from "../src/features/SurfaceErrorBoundary.js";
import { registerLocalCliDraftReloadGuard } from "../src/features/terminal-pane/local-cli-draft.js";
import { readDockSession, writeDockSession, WORKSPACE_DOCK_SESSION_KEY } from "../src/features/workspace-session.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); sessionStorage.clear(); });

describe("workspace recovery", () => {
  it.each([true, false])("restores the actual dock and visibility (%s) in this tab", (open) => {
    const state = { surface: "clipboard", desktopOpen: open, compactOpen: !open };
    writeDockSession(sessionStorage, state);
    expect(readDockSession(sessionStorage, ["rooms", "clipboard"])).toEqual(state);
  });

  it("ignores malformed, retired and inaccessible storage", () => {
    for (const value of ["broken", "null", '{"surface":"removed"}', '{"surface":"rooms","desktopOpen":"false","compactOpen":false}']) {
      sessionStorage.setItem(WORKSPACE_DOCK_SESSION_KEY, value);
      expect(readDockSession(sessionStorage, ["rooms"])).toBeNull();
    }
    expect(readDockSession({ getItem() { throw Error("Blocked"); } }, ["rooms"])).toBeNull();
  });

  it("contains a broken view, retains sibling pane DOM, retries and recovers on navigation", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let broken = true;
    function View() { if (broken) throw Error("View failed"); return <p>Working view</p>; }
    const content = (key: string) => <><input aria-label="Pane input" defaultValue="Unsent text" /><SurfaceErrorBoundary resetKey={key}><View /></SurfaceErrorBoundary></>;
    const { rerender } = render(content("settings"));
    const pane = screen.getByRole("textbox");
    expect(screen.getByRole("alert")).toBeTruthy();
    broken = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("Working view")).toBeTruthy();
    expect(screen.getByRole("textbox")).toBe(pane);
    broken = true;
    rerender(content("settings"));
    expect(screen.getByRole("alert")).toBeTruthy();
    broken = false;
    rerender(content("clipboard"));
    expect(screen.getByText("Working view")).toBeTruthy();
    expect(screen.getByRole("textbox")).toBe(pane);
  });

  it("shows a deliberate reload action for a failed module instead of an empty screen", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    function Broken(): never { throw Error("Failed to fetch dynamically imported module"); }
    render(<SurfaceErrorBoundary><Broken /></SurfaceErrorBoundary>);
    expect(screen.getByRole("button", { name: "Reload Space" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("checks unsaved drafts before reloading a failed surface", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    function Broken(): never { throw Error("Failed to fetch dynamically imported module"); }
    const guard = vi.fn(() => false);
    const unregister = registerLocalCliDraftReloadGuard(guard);
    try {
      render(<SurfaceErrorBoundary><Broken /></SurfaceErrorBoundary>);
      fireEvent.click(screen.getByRole("button", { name: "Reload Space" }));
      await waitFor(() => expect(guard).toHaveBeenCalledOnce());
    } finally { unregister(); }
  });
});
