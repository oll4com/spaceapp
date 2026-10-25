import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SettingsActionMenu } from "../src/features/settings/SettingsActionMenu.js";
import { RefreshCw, Trash2 } from "../src/features/ui-theme/app-icons.js";

describe("SettingsActionMenu", () => {
  it("supports keyboard navigation, Escape dismissal and focus restoration", async () => {
    render(
      <SettingsActionMenu
        label="Example actions"
        actions={[
          { id: "refresh", label: "Refresh", icon: RefreshCw, onSelect: vi.fn() },
          { id: "remove", label: "Remove", icon: Trash2, danger: true, onSelect: vi.fn() }
        ]}
      />
    );

    const trigger = screen.getByRole("button", { name: "Example actions" });
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu", { name: "Example actions" });
    const refresh = screen.getByRole("menuitem", { name: "Refresh" });
    const remove = screen.getByRole("menuitem", { name: "Remove" });
    await waitFor(() => expect(document.activeElement).toBe(refresh));

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(remove);
    fireEvent.keyDown(menu, { key: "Escape" });

    expect(screen.queryByRole("menu", { name: "Example actions" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("runs the selected action and closes the menu", () => {
    const onSelect = vi.fn();
    render(
      <SettingsActionMenu
        label="Example actions"
        actions={[{ id: "refresh", label: "Refresh", icon: RefreshCw, onSelect }]}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Example actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Refresh" }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu", { name: "Example actions" })).toBeNull();
  });

  it("preserves the active Modern palette on the portalled menu", () => {
    render(
      <main data-ui-theme="modern" data-color-mode="light" data-room-theme="forest">
        <SettingsActionMenu
          label="Theme-aware actions"
          actions={[{ id: "refresh", label: "Refresh", icon: RefreshCw, onSelect: vi.fn() }]}
        />
      </main>
    );

    fireEvent.click(screen.getByRole("button", { name: "Theme-aware actions" }));
    const menu = screen.getByRole("menu", { name: "Theme-aware actions" });

    expect(menu.getAttribute("data-ui-theme")).toBe("modern");
    expect(menu.getAttribute("data-color-mode")).toBe("light");
    expect(menu.getAttribute("data-room-theme")).toBe("forest");
    expect(menu.parentElement).toBe(document.body);
  });
});
