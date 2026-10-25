import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocksSettingsCard } from "../src/features/settings/DocksSettingsCard.js";
import {
  DOCKS_HIDDEN_STORAGE_KEY,
  DOCKS_VISIBILITY_EVENT,
  dockOrderRank,
  readDockOrder,
  readHiddenDockIds,
  writeDockOrder,
  writeHiddenDockIds,
  normalizeHiddenDockIds
} from "../src/features/docks/use-docks-visibility.js";
import { SOURCE_CONTROL_CONNECTION_EVENT } from "../src/features/source-control/client.js";

afterEach(cleanup);

describe("useDocksVisibility helpers", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("normalizes hidden dock ids by filtering invalid ids, locked docks (settings), and removing duplicates", () => {
    expect(normalizeHiddenDockIds(["rooms", "invalid-id", "settings", "rooms", "media"])).toEqual(["rooms", "media"]);
    expect(normalizeHiddenDockIds(null)).toEqual([]);
    expect(normalizeHiddenDockIds("string")).toEqual([]);
  });

  it("reads and writes hidden dock ids to localStorage", () => {
    expect(readHiddenDockIds(localStorage)).toEqual([]);
    writeHiddenDockIds(["media", "clipboard"], localStorage);
    expect(readHiddenDockIds(localStorage)).toEqual(["media", "clipboard"]);
    writeHiddenDockIds([], localStorage);
    expect(readHiddenDockIds(localStorage)).toEqual([]);
    expect(localStorage.getItem(DOCKS_HIDDEN_STORAGE_KEY)).toBeNull();
  });
});

describe("DocksSettingsCard", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders all default docks and their visibility toggles", () => {
    render(<DocksSettingsCard gitPluginsActive={true} isAdmin={true} />);

    expect(screen.getByText("Workspace docks")).toBeTruthy();
    expect(screen.getByText("Rooms")).toBeTruthy();
    expect(screen.getByText("Room Agent")).toBeTruthy();
    expect(screen.getByText("Council")).toBeTruthy();
    expect(screen.getByText("Media")).toBeTruthy();
    expect(screen.getByText("Agent Files")).toBeTruthy();
    expect(screen.getByText("Clipboard")).toBeTruthy();
    expect(screen.getByText("Tasks")).toBeTruthy();
    expect(screen.getByText("Links")).toBeTruthy();
    expect(screen.getByText("CLI tools")).toBeTruthy();
    expect(screen.getByText("Sessions")).toBeTruthy();
    expect(screen.getByText("Source Control")).toBeTruthy();
    expect(screen.queryByText("Health")).toBeNull();
    expect(screen.getByText("Settings")).toBeTruthy();
    expect(screen.getByText("Streaming")).toBeTruthy();

    const mediaToggle = screen.getByRole("switch", { name: "Toggle Media dock visibility" });
    expect(mediaToggle).toBeTruthy();
    expect((mediaToggle as HTMLInputElement).checked).toBe(true);
    expect((mediaToggle as HTMLInputElement).disabled).toBe(false);
  });

  it("hides and unhides a dock when its toggle is switched", () => {
    render(<DocksSettingsCard gitPluginsActive={true} isAdmin={false} />);

    const mediaToggle = screen.getByRole("switch", { name: "Toggle Media dock visibility" }) as HTMLInputElement;
    expect(mediaToggle.checked).toBe(true);

    fireEvent.click(mediaToggle);
    expect(mediaToggle.checked).toBe(false);
    expect(readHiddenDockIds(localStorage)).toContain("media");

    fireEvent.click(mediaToggle);
    expect(mediaToggle.checked).toBe(true);
    expect(readHiddenDockIds(localStorage)).not.toContain("media");
  });

  it("resets all docks to visible when the reset button is clicked", () => {
    writeHiddenDockIds(["rooms", "media", "clipboard"], localStorage);
    writeDockOrder(["media", "rooms"], localStorage);
    render(<DocksSettingsCard gitPluginsActive={true} isAdmin={false} />);

    const mediaToggle = screen.getByRole("switch", { name: "Toggle Media dock visibility" }) as HTMLInputElement;
    expect(mediaToggle.checked).toBe(false);

    const resetBtn = screen.getByRole("button", { name: "Reset dock visibility and order to defaults" });
    fireEvent.click(resetBtn);

    expect(mediaToggle.checked).toBe(true);
    expect(readHiddenDockIds(localStorage)).toEqual([]);
    expect(readDockOrder(localStorage)).toEqual([]);
  });

  it("ranks saved docks first and the rest in the Docks menu's default order", () => {
    expect(readDockOrder(localStorage)).toEqual([]);
    writeDockOrder(["media", "rooms"], localStorage);
    localStorage.setItem("space:docks-order:v1", JSON.stringify(["media", "bogus", "media", "rooms"]));
    expect(readDockOrder(localStorage)).toEqual(["media", "rooms"]);
    const rank = dockOrderRank(["media", "rooms"]);
    expect(["settings", "rooms", "tasks", "media", "room-agent"].sort((a, b) => rank(a) - rank(b)))
      .toEqual(["media", "rooms", "room-agent", "tasks", "settings"]);
  });

  const dockRows = () => Array.from(document.querySelectorAll<HTMLElement>("[data-dock-id]")).map((row) => row.dataset.dockId);

  it("moves a dock with the arrow keys and saves the order", () => {
    render(<DocksSettingsCard gitPluginsActive={true} isAdmin={false} />);
    expect(dockRows().slice(0, 2)).toEqual(["rooms", "nous"]);

    fireEvent.keyDown(screen.getByRole("button", { name: /^Move Nous dock/ }), { key: "ArrowUp" });
    expect(dockRows().slice(0, 2)).toEqual(["nous", "rooms"]);
    expect(readDockOrder(localStorage).slice(0, 2)).toEqual(["nous", "rooms"]);
    expect(dockRows()).not.toContain("streaming");
  });

  it("drops a dragged dock onto another dock's place", () => {
    render(<DocksSettingsCard gitPluginsActive={true} isAdmin={true} />);
    const target = document.querySelector<HTMLElement>('[data-dock-id="tasks"]')!;
    const elementFromPoint = vi.fn(() => target);
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: elementFromPoint });

    fireEvent.pointerDown(screen.getByRole("button", { name: /^Move Rooms dock/ }), { button: 0 });
    fireEvent.pointerMove(window, { clientX: 10, clientY: 200 });
    expect(target.classList.contains("is-drag-over")).toBe(true);
    fireEvent.pointerUp(window);

    const order = dockRows();
    expect(order.indexOf("rooms")).toBe(order.indexOf("tasks") + 1);
    expect(readDockOrder(localStorage)).toEqual(order);
    expect(elementFromPoint).toHaveBeenCalled();
  });

  it("keeps Source Control available without a connected provider and honours the personal hide setting", () => {
    render(<DocksSettingsCard gitPluginsActive={false} isAdmin={false} />);

    const sourceToggle = screen.getByRole("switch", { name: "Toggle Source Control dock visibility" }) as HTMLInputElement;
    expect(sourceToggle.disabled).toBe(false);
    expect(sourceToggle.checked).toBe(true);
    expect(screen.queryByText("Default hidden")).toBeNull();

    fireEvent.click(sourceToggle);
    expect(sourceToggle.checked).toBe(false);
    expect(readHiddenDockIds(localStorage)).toContain("source-control");

    fireEvent.click(sourceToggle);
    expect(sourceToggle.checked).toBe(true);
    expect(readHiddenDockIds(localStorage)).not.toContain("source-control");
  });

  it("omits streaming dock for non-admin users and shows it for admin users", () => {
    const { unmount } = render(<DocksSettingsCard gitPluginsActive={true} isAdmin={false} />);
    expect(screen.queryByText("Streaming")).toBeNull();
    unmount();

    render(<DocksSettingsCard gitPluginsActive={true} isAdmin={true} />);
    expect(screen.getByText("Streaming")).toBeTruthy();
  });

  it("locks the settings dock so it cannot be hidden and always remains visible", () => {
    render(<DocksSettingsCard gitPluginsActive={true} isAdmin={false} />);

    const settingsToggle = screen.getByRole("switch", { name: "Toggle Settings dock visibility" }) as HTMLInputElement;
    expect(settingsToggle.checked).toBe(true);
    expect(settingsToggle.disabled).toBe(true);
    expect(screen.getByText("Always visible")).toBeTruthy();

    fireEvent.click(settingsToggle);
    expect(settingsToggle.checked).toBe(true);
    expect(readHiddenDockIds(localStorage)).not.toContain("settings");
  });
});
