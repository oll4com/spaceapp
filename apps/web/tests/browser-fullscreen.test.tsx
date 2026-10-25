import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopNavigation } from "../src/features/ui-theme/DesktopNavigation.js";
import { desktopActionDescriptions, desktopActionGroup } from "../src/features/ui-theme/desktop-navigation.js";
import { RAIL_IDS } from "../src/features/ui-theme/use-rail-order.js";
import { LOWER_RAIL_LABELS } from "../src/features/ui-theme/use-rail-visibility.js";
import { workspaceActionCategory, workspaceActionLabel, workspaceActionToggle } from "../src/features/ui-theme/workspace-actions.js";
import { helpEntries } from "../src/features/help/help-content.js";
import { Maximize2, Minimize2 } from "../src/features/ui-theme/app-icons.js";
import type { IconToolbarAction } from "../src/icon-toolbar.js";

afterEach(cleanup);

describe("Browser Fullscreen Feature", () => {
  it("includes fullscreen in rail ids and lower rail labels", () => {
    expect(RAIL_IDS).toContain("fullscreen");
    expect(LOWER_RAIL_LABELS["fullscreen"]).toBe("Full screen");
  });

  it("configures workspace category, labels and toggle badge for browser-fullscreen", () => {
    expect(workspaceActionCategory("browser-fullscreen")).toBe("toggles");
    expect(desktopActionGroup("browser-fullscreen")).toBe("workspace");
    expect(desktopActionDescriptions["browser-fullscreen"]).toContain("F11");

    const actionOn: IconToolbarAction = {
      id: "browser-fullscreen",
      label: "Full screen browser",
      title: "Exit full screen (F11)",
      ariaLabel: "Exit full screen",
      icon: Minimize2,
      ariaPressed: true,
      onClick: vi.fn()
    };
    expect(workspaceActionLabel(actionOn)).toBe("Full screen browser");
    expect(workspaceActionToggle(actionOn)).toBe(true);

    const actionOff: IconToolbarAction = {
      id: "browser-fullscreen",
      label: "Full screen browser",
      title: "Full screen browser (F11)",
      ariaLabel: "Full screen browser",
      icon: Maximize2,
      ariaPressed: false,
      onClick: vi.fn()
    };
    expect(workspaceActionToggle(actionOff)).toBe(false);
  });

  it("renders browser-fullscreen inside toolsOnly DesktopNavigation and triggers action on click", () => {
    const onAction = vi.fn();
    const fullscreenAction: IconToolbarAction = {
      id: "browser-fullscreen",
      label: "Full screen browser",
      title: "Full screen browser (F11)",
      ariaLabel: "Full screen browser",
      icon: Maximize2,
      ariaPressed: false,
      onClick: vi.fn()
    };

    render(
      <DesktopNavigation
        toolsOnly
        actions={[fullscreenAction]}
        adminMode={false}
        canAdmin={false}
        onModeChange={vi.fn()}
        onAction={onAction}
      />
    );

    const trigger = screen.getByRole("button", { name: "Workspace tools" });
    fireEvent.click(trigger);

    const item = screen.getByRole("button", { name: "Full screen browser" });
    expect(item).toBeTruthy();
    expect(within(item).getByText("Off")).toBeTruthy();

    fireEvent.click(item);
    expect(onAction).toHaveBeenCalledWith(fullscreenAction, trigger);
  });

  it("registers browser-fullscreen in the Help catalog", () => {
    const entry = helpEntries.find((e) => e.id === "browser-fullscreen");
    expect(entry).toBeTruthy();
    expect(entry?.label).toBe("Full screen browser");
    expect(entry?.description).toContain("F11");
  });
});
