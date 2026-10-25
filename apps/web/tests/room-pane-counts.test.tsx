import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveSpaceApp as App } from "../src/live/LiveSpaceApp.js";
import { resetCliVpnRoutingStatusForTests } from "../src/cli-vpn-routing.js";
import { __dirname, installFetchFixture, pane, reviewPanes, setViewport, setWarmRoomTelemetry } from "./responsive-shell-fixture.js";

describe("Room pane totals", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/");
    window.localStorage.setItem("space.uiTheme.v1", "classic");
    setWarmRoomTelemetry({ hardwareConcurrency: 4 });
  });
  afterEach(() => {
    resetCliVpnRoutingStatusForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("counts minimized and non-CLI panes in active and unloaded rooms", async () => {
    setViewport(1440, 900);
    window.localStorage.setItem("space.warmRoom.enabled.v1", "false");
    installFetchFixture({
      rooms: [{ id: "room:alpha", name: "Alpha" }, { id: "room:beta", name: "Beta" }],
      panesByRoom: {
        "room:alpha": reviewPanes("room:alpha", 2).map((pane, index) => ({ ...pane, isMinimized: index === 1 })),
        "room:beta": [
          pane({ id: "pane:chat", roomId: "room:beta", order: 0, title: "Chat", mode: "CHAT" }),
          pane({ id: "pane:cli", roomId: "room:beta", order: 1, title: "CLI", mode: "TERMINAL", isMinimized: true }),
          pane({ id: "pane:browser", roomId: "room:beta", order: 2, title: "Browser", mode: "BROWSER" }),
          { ...pane({ id: "pane:closed", roomId: "room:beta", order: 3, title: "Closed" }), isClosed: true }
        ]
      },
      paneRequestDeferredByRoom: { "room:beta": new Promise(() => {}) },
      cliCountsByRoom: { "room:alpha": 0, "room:beta": 1 }
    });
    render(<App />);
    const alpha = await screen.findByRole("button", { name: "Open Alpha" });
    const beta = await screen.findByRole("button", { name: "Open Beta" });
    await waitFor(() => expect(alpha.querySelector(".room-cli-badge")?.textContent).toBe("Panes 2"));
    await waitFor(() => expect(beta.querySelector(".room-cli-badge")?.textContent).toBe("Panes 3"));
    expect(screen.queryByLabelText("Browser agent 3")).toBeNull();
  });

  it.each([320, 768, 1024, 1440])("shows total panes independently of running CLI beside an ellipsized long room name at %ipx", async (width) => {
    setViewport(width, width <= 768 ? 844 : 900);
    const roomId = "room:long-name";
    const roomName = "A very long room name that must yield space without shrinking the total panes badge";
    installFetchFixture({
      roomId,
      roomName,
      panes: [],
      cliCountsByRoom: { [roomId]: 12 }
    });

    render(<App />);

    await screen.findByRole("heading", { name: roomName });
    if (width <= 1100) {
      fireEvent.click(screen.getByRole("button", { name: "Open rooms" }));
    }
    const roomsSurface = await screen.findByLabelText("Rooms");
    const roomButton = within(roomsSurface).getByRole("button", { name: `Open ${roomName}` });
    expect(roomButton.getAttribute("data-room-id")).toBe(roomId);
    const heading = roomButton;
    expect(heading?.querySelector(".room-name")?.textContent).toBe(roomName);
    await waitFor(() => expect(heading?.querySelector(".room-cli-badge")?.textContent?.trim()).toBe("Panes 0"));
    expect(within(roomsSurface).getByRole("button", { name: "New room" })).toBeTruthy();
    for (const count of [2, 3, 6, 8, 16]) {
      expect(within(roomsSurface).queryByTitle(`Create ${count}-pane room`)).toBeNull();
    }

    const css = readFileSync(resolve(__dirname, "../src/features/rooms-dock/rooms-dock.css"), "utf8");
    expect(css).toMatch(/\.room-select-text\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-width:\s*0;/);
    expect(css).toMatch(/\.room-name\s*\{[^}]*text-overflow:\s*ellipsis;/);
    expect(css).toMatch(/\.room-cli-badge\s*\{[^}]*flex:\s*0 0 auto;/);
  });

});
