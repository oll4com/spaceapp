import { workspaceAction } from "./workspace-navigation.js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DemoSpaceApp } from "../src/demo/DemoSpaceApp.js";
import { demoRuntimeBundle } from "../src/demo/demo-runtime.js";
import { STREAMING_OVERLAY_SESSION_KEY } from "../src/features/streaming/StreamingOverlay.js";

vi.mock("../src/features/terminal-pane/index.js", () => ({
  createTerminalBootstrapBarrier: () => ({
    join: () => ({ arrive: async () => undefined }),
    waitForTerminalSetupTask: async () => undefined
  }),
  TerminalPane: ({ pane }: { pane: { title: string } }) => (
    <section aria-label={`CLI pane ${pane.title}`}>Local demo terminal fixture</section>
  )
}));

describe("streaming in the shared local demo", () => {
  afterEach(() => {
    demoRuntimeBundle.runtime.reset();
    vi.restoreAllMocks();
  });

  it("uses local streaming data and persists activation only in demo session storage", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1365 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 900 });
    render(<DemoSpaceApp />);

    fireEvent.click(await workspaceAction("Show streaming dock", "Docks"));
    await act(async () => { await vi.dynamicImportSettled(); });
    const dock = await screen.findByLabelText("Streaming controls");
    expect(dock).toBeTruthy();
    expect(screen.getAllByText("Not available in the local demo")).toHaveLength(5);
    expect(screen.queryByText("DEMO_LOCAL_ONLY")).toBeNull();
    // The bot tabs open on demo data instead of crashing on missing handlers.
    fireEvent.click(within(dock).getByRole("tab", { name: "Bot" }));
    expect(await within(dock).findByText("Not available in the local demo.")).toBeTruthy();
    fireEvent.click(within(dock).getByRole("tab", { name: "Memory" }));
    expect(await within(dock).findByText("Stream schedule")).toBeTruthy();
    fireEvent.click(within(dock).getByRole("tab", { name: "Moderation" }));
    expect(await within(dock).findByText("No moderation actions yet")).toBeTruthy();

    fireEvent.click(within(dock).getByRole("tab", { name: "Display" }));
    fireEvent.click(within(dock).getByRole("switch", { name: "Overlay" }));
    const overlay = await screen.findByLabelText("Streaming overlay");
    expect(overlay).toBeTruthy();
    expect(demoRuntimeBundle.runtime.platform.sessionStorage.getItem(STREAMING_OVERLAY_SESSION_KEY)).toBe("true");
    expect(window.sessionStorage.getItem(STREAMING_OVERLAY_SESSION_KEY)).toBeNull();
  }, 20_000);

  it("preserves the active overlay across pane layout, rooms and embedded Help", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1365 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 900 });
    demoRuntimeBundle.runtime.platform.sessionStorage.setItem(STREAMING_OVERLAY_SESSION_KEY, "true");
    render(<DemoSpaceApp />);
    const overlay = await screen.findByLabelText("Streaming overlay");
    const pane = screen.getByRole("article", { name: "Release Review agent 4" });
    fireEvent.click(within(pane).getByRole("button", { name: "Maximize pane" }));
    expect(await within(pane).findByRole("button", { name: "Restore pane" })).toBeTruthy();
    expect(screen.getByLabelText("Streaming overlay")).toBe(overlay);
    fireEvent.click(within(pane).getByRole("button", { name: "Restore pane" }));

    fireEvent.click(await screen.findByRole("button", { name: "Open Research Lab" }));
    await waitFor(() => expect(document.querySelector(".space-shell")?.getAttribute("data-room-id")).toBe("room:demo-research"));
    expect(screen.getByLabelText("Streaming overlay")).toBe(overlay);

    fireEvent.click(await workspaceAction("Help", "Utilities"));
    expect(screen.getByLabelText("Streaming overlay")).toBe(overlay);
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(await screen.findByText("Space Help", { selector: "h1" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Back to workspace actions" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Back to workspace actions" }));
    expect(await screen.findByLabelText("Streaming overlay")).toBe(overlay);
  }, 20_000);
});
