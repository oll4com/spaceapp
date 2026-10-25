import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { ServerActionsMenu, type ServerActionCommand } from "../src/features/server-actions/ServerActionsMenu.js";
import { ServerCog, Wrench } from "../src/features/ui-theme/app-icons.js";

describe("ServerActionsMenu", () => {
  it("renders section headers and category groups correctly", () => {
    const triggerRef = createRef<HTMLButtonElement>();
    const handleClose = vi.fn();
    const handleSelect1 = vi.fn();
    const handleSelect2 = vi.fn();

    const actions: ServerActionCommand[] = [
      {
        id: "restart-server",
        categoryHeader: "Services & Runtimes",
        label: "Restart server",
        description: "Restart the Space core services",
        icon: ServerCog,
        onSelect: handleSelect1
      },
      {
        id: "space-cli-maintenance",
        categoryHeader: "Maintenance & Speed",
        label: "Space & CLI maintenance",
        description: "Run Space health and doctor",
        icon: Wrench,
        onSelect: handleSelect2
      }
    ];

    render(
      <ServerActionsMenu
        actions={actions}
        mobile={false}
        onClose={handleClose}
        triggerRef={triggerRef}
      />
    );

    for (const name of ["Maintenance", "Connections", "Services", "Administration"]) expect(screen.getByText(name)).toBeTruthy();
    fireEvent.click(screen.getByText("Services"));
    expect(screen.getByText("Restart server")).toBeTruthy();
    expect(screen.queryByText("Space & CLI maintenance")).toBeNull();
    fireEvent.click(screen.getByText("← All sections"));
    fireEvent.click(screen.getByText("Maintenance"));
    expect(screen.getByText("Space & CLI maintenance")).toBeTruthy();
  });

  it("filters actions via search and executes on click", async () => {
    const { fireEvent } = await import("@testing-library/react");
    const triggerRef = createRef<HTMLButtonElement>();
    const handleClose = vi.fn();
    const handleSelect = vi.fn();

    const actions: ServerActionCommand[] = [
      {
        id: "restart-server",
        label: "Restart server",
        description: "Restart the Space core services",
        icon: ServerCog,
        onSelect: handleSelect
      },
      {
        id: "space-cli-maintenance",
        label: "Space & CLI maintenance",
        description: "Run Space health and doctor",
        icon: Wrench,
        onSelect: vi.fn()
      }
    ];

    render(
      <ServerActionsMenu
        actions={actions}
        mobile={false}
        onClose={handleClose}
        triggerRef={triggerRef}
      />
    );

    const searchInput = screen.getByRole("textbox", { name: "Find an action" });
    fireEvent.change(searchInput, { target: { value: "maintenance" } });

    expect(screen.queryByText("Restart server")).toBeNull();
    expect(screen.getByText("Space & CLI maintenance")).toBeTruthy();

    const closeBtn = screen.getByRole("button", { name: "Close Manage" });
    fireEvent.click(closeBtn);
    expect(handleClose).toHaveBeenCalled();
  });
});
