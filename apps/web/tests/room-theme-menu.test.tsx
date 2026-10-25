import { createRef } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  computeRoomThemeMenuPosition,
  RoomThemeMenu
} from "../src/features/room-theme/RoomThemeMenu.js";

describe("RoomThemeMenu", () => {
  it("anchors below the trigger and clamps to the viewport edge", () => {
    expect(
      computeRoomThemeMenuPosition(
        { bottom: 80, height: 40, left: 280, right: 320, top: 40, width: 40 },
        { height: 220, width: 176 },
        { height: 640, width: 320 }
      )
    ).toEqual({ left: 136, placement: "below", top: 88 });
  });

  it("flips above the trigger when the menu would overflow below", () => {
    expect(
      computeRoomThemeMenuPosition(
        { bottom: 620, height: 40, left: 120, right: 160, top: 580, width: 40 },
        { height: 220, width: 176 },
        { height: 640, width: 320 }
      )
    ).toEqual({ left: 52, placement: "above", top: 352 });
  });

  it("selects a palette, closes, and restores focus with Escape", () => {
    const triggerRef = createRef<HTMLButtonElement>();
    const onClose = vi.fn();
    const onSelect = vi.fn();

    render(
      <>
        <button ref={triggerRef}>Room theme</button>
        <RoomThemeMenu
          currentTheme="graphite"
          mobile={false}
          onClose={onClose}
          onSelect={onSelect}
          triggerRef={triggerRef}
        />
      </>
    );

    const menu = screen.getByRole("menu", { name: "Room theme options" });
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Copper" }));
    expect(onSelect).toHaveBeenCalledWith("copper");
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(menu, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(triggerRef.current);
  });
});
