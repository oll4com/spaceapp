// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { LiveRailContextMenu } from "../src/features/live-pane/LiveRailContextMenu.js";

afterEach(cleanup);

describe("LiveRailContextMenu", () => {
  it("renders all context menu options including 'Disable' when graphic is active", () => {
    const onClose = vi.fn();
    const onToggle = vi.fn();

    render(
      <LiveRailContextMenu
        x={100}
        y={100}
        onClose={onClose}
        isGraphicDisabled={false}
        onToggleGraphic={onToggle}
      />
    );

    expect(screen.getByRole("menuitem", { name: "Show Live conversation window" })).toBeDefined();
    expect(screen.getByRole("menuitem", { name: "Show Live statistics" })).toBeDefined();
    expect(screen.getByRole("menuitem", { name: "Clear conversation" })).toBeDefined();
    const disableBtn = screen.getByRole("menuitem", { name: "Disable" });
    expect(disableBtn).toBeDefined();

    fireEvent.click(disableBtn);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders 'Enable' when graphic is disabled and toggles back", () => {
    const onClose = vi.fn();
    const onToggle = vi.fn();

    render(
      <LiveRailContextMenu
        x={100}
        y={100}
        onClose={onClose}
        isGraphicDisabled={true}
        onToggleGraphic={onToggle}
      />
    );

    const enableBtn = screen.getByRole("menuitem", { name: "Enable" });
    expect(enableBtn).toBeDefined();

    fireEvent.click(enableBtn);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("dispatches space-live-rail-graphic-toggle event when onToggleGraphic is omitted", () => {
    const onClose = vi.fn();
    const eventSpy = vi.fn();
    window.addEventListener("space-live-rail-graphic-toggle", eventSpy);

    render(
      <LiveRailContextMenu
        x={100}
        y={100}
        onClose={onClose}
        isGraphicDisabled={false}
      />
    );

    const disableBtn = screen.getByRole("menuitem", { name: "Disable" });
    fireEvent.click(disableBtn);

    expect(eventSpy).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);

    window.removeEventListener("space-live-rail-graphic-toggle", eventSpy);
  });
});
