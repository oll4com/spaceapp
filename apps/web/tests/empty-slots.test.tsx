import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopNavigation } from "../src/features/ui-theme/DesktopNavigation.js";
import { Grid2X2 } from "../src/features/ui-theme/app-icons.js";
import type { IconToolbarAction } from "../src/icon-toolbar.js";
import { createRef } from "react";
import { resolvePaneGridPlacements, calculatePaneGridBaseRows, type PaneColumnAnchor } from "../src/App.js";
import { PaneLayoutMenu } from "../src/features/pane-layout/PaneLayoutMenu.js";
import type { Pane } from "@space/contracts";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const action = (id: string, label: string): IconToolbarAction => ({
  id,
  label,
  ariaLabel: label,
  title: label,
  icon: Grid2X2,
  onClick: vi.fn()
});

describe("Empty slots feature", () => {
  it("renders Empty slots inside PaneLayoutMenu with count stepper and responds to +/- clicks", () => {
    const onIncrement = vi.fn();
    const onDecrement = vi.fn();
    const emptySlots = {
      count: 0,
      min: 0,
      max: 6,
      onIncrement,
      onDecrement
    };

    const triggerRef = createRef<HTMLButtonElement>();

    const { rerender } = render(
      <PaneLayoutMenu
        automaticColumns={2}
        currentColumns={null}
        error={null}
        maximumColumns={4}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        pending={false}
        triggerRef={triggerRef}
        visiblePaneCount={3}
        emptySlots={emptySlots}
      />
    );

    // Verify Empty slots item is displayed
    const emptySlotsItem = screen.getByRole("button", { name: /Empty slots/ });
    expect(emptySlotsItem).toBeTruthy();
    expect(screen.getByText("0 in room")).toBeTruthy();

    // Verify stepper value
    const stepper = screen.getByRole("spinbutton", { name: "Empty slots count" });
    expect(stepper).toBeTruthy();
    expect(stepper.getAttribute("aria-valuenow")).toBe("0");

    // Minus button should be disabled since count === min (0 === 0)
    const minusBtn = screen.getByRole("button", { name: "Decrease empty slots" }) as HTMLButtonElement;
    expect(minusBtn.disabled).toBe(true);

    // Plus button should be enabled
    const plusBtn = screen.getByRole("button", { name: "Increase empty slots" }) as HTMLButtonElement;
    expect(plusBtn.disabled).toBe(false);

    // Clicking plus calls onIncrement
    fireEvent.click(plusBtn);
    expect(onIncrement).toHaveBeenCalledTimes(1);

    // Clicking minus when disabled does not call onDecrement
    fireEvent.click(minusBtn);
    expect(onDecrement).not.toHaveBeenCalled();

    // Now test with count = 3: minus should be enabled and call onDecrement
    rerender(
      <PaneLayoutMenu
        automaticColumns={2}
        currentColumns={null}
        error={null}
        maximumColumns={4}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        pending={false}
        triggerRef={triggerRef}
        visiblePaneCount={3}
        emptySlots={{ ...emptySlots, count: 3 }}
      />
    );
    expect(minusBtn.disabled).toBe(false);
    fireEvent.click(minusBtn);
    expect(onDecrement).toHaveBeenCalledTimes(1);
  });

  it("disables Plus button when empty slots reaches max 6 in PaneLayoutMenu", () => {
    const onIncrement = vi.fn();
    const onDecrement = vi.fn();
    const emptySlots = {
      count: 6,
      min: 3,
      max: 6,
      onIncrement,
      onDecrement
    };

    const triggerRef = createRef<HTMLButtonElement>();

    render(
      <PaneLayoutMenu
        automaticColumns={2}
        currentColumns={null}
        error={null}
        maximumColumns={4}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        pending={false}
        triggerRef={triggerRef}
        visiblePaneCount={3}
        emptySlots={emptySlots}
      />
    );

    const plusBtn = screen.getByRole("button", { name: "Increase empty slots" }) as HTMLButtonElement;
    expect(plusBtn.disabled).toBe(true);

    const minusBtn = screen.getByRole("button", { name: "Decrease empty slots" }) as HTMLButtonElement;
    expect(minusBtn.disabled).toBe(false);

    fireEvent.click(minusBtn);
    expect(onDecrement).toHaveBeenCalledTimes(1);
  });

  it("migrates createOrder in localStorage moving add-demos above add-vnc and stripping add-empty-slots", () => {
    const CREATE_MENU_ORDER_KEY = "space:create-menu-top-order";
    // Simulate user's existing stored order where add-demos is at the end (below add-vnc) and includes add-empty-slots
    localStorage.setItem(
      CREATE_MENU_ORDER_KEY,
      JSON.stringify(["add-cli", "add-browser", "add-chat", "add-vnc", "add-demos", "add-empty-slots"])
    );

    const actions = [
      action("add-cli", "Add CLI pane"),
      action("add-browser", "Add browser"),
      action("add-chat", "Add chat"),
      action("add-vnc", "VNC Desktop"),
      action("add-demos", "Demo Projects"),
      action("add-empty-slots", "Empty slots")
    ];

    render(
      <DesktopNavigation
        actions={actions}
        adminMode={false}
        canAdmin
        onModeChange={vi.fn()}
        onAction={vi.fn()}
      />
    );

    const saved = JSON.parse(localStorage.getItem(CREATE_MENU_ORDER_KEY) || "[]");
    expect(saved).toEqual([
      "add-cli",
      "add-browser",
      "add-chat",
      "add-demos",
      "add-vnc"
    ]);
    expect(saved).not.toContain("add-empty-slots");
  });

  it("ensures Create menu omits Empty slots and PaneLayoutMenu provides full keyboard and wheel support", () => {
    const actions = [
      action("add-cli", "Add CLI pane"),
      action("add-vnc", "VNC Desktop"),
      action("add-empty-slots", "Empty slots")
    ];

    render(
      <DesktopNavigation
        actions={actions}
        adminMode={false}
        canAdmin
        createOnly
        onModeChange={vi.fn()}
        onAction={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    // Empty slots MUST NOT be present in Create menu
    const emptySlotsAction = document.querySelector(".desktop-empty-slots-action");
    expect(emptySlotsAction).toBeNull();
    expect(screen.queryByText("Empty slots")).toBeNull();

    // Now test PaneLayoutMenu keyboard and wheel interactions
    const onIncrement = vi.fn();
    const onDecrement = vi.fn();
    const triggerRef = createRef<HTMLButtonElement>();

    const { unmount } = render(
      <PaneLayoutMenu
        automaticColumns={2}
        currentColumns={null}
        error={null}
        maximumColumns={4}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        pending={false}
        triggerRef={triggerRef}
        visiblePaneCount={3}
        emptySlots={{ count: 2, min: 1, max: 6, onIncrement, onDecrement }}
      />
    );

    const layoutEmptySlots = document.querySelector(".pane-layout-empty-slots");
    expect(layoutEmptySlots).toBeTruthy();

    // Keyboard ArrowRight / + increments
    fireEvent.keyDown(layoutEmptySlots!, { key: "ArrowRight" });
    expect(onIncrement).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(layoutEmptySlots!, { key: "+" });
    expect(onIncrement).toHaveBeenCalledTimes(2);

    // Keyboard ArrowLeft / - decrements
    fireEvent.keyDown(layoutEmptySlots!, { key: "ArrowLeft" });
    expect(onDecrement).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(layoutEmptySlots!, { key: "-" });
    expect(onDecrement).toHaveBeenCalledTimes(2);

    // Mouse wheel on stepper
    const stepper = screen.getByRole("spinbutton", { name: "Empty slots count" });
    fireEvent.wheel(stepper, { deltaY: -100 });
    expect(onIncrement).toHaveBeenCalledTimes(3);

    fireEvent.wheel(stepper, { deltaY: 100 });
    expect(onDecrement).toHaveBeenCalledTimes(3);

    unmount();
  });

  it("renders PaneLayoutMenu with 16 visible panes and layout metrics matching Image #2", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const triggerRef = createRef<HTMLButtonElement>();

    render(
      <PaneLayoutMenu
        automaticColumns={4}
        currentColumns={2}
        currentHeight={1}
        error={null}
        maximumColumns={4}
        onClose={onClose}
        onSelect={onSelect}
        pending={false}
        triggerRef={triggerRef}
        visiblePaneCount={16}
      />
    );

    // Verify 16 visible panes header
    expect(screen.getByText("16 visible panes")).toBeTruthy();

    // Verify Automatic 4 x 4
    expect(screen.getByText("Automatic")).toBeTruthy();
    expect(screen.getByText("4 × 4")).toBeTruthy();

    // Verify Fullscreen 1 x 1
    expect(screen.getByText("Fullscreen")).toBeTruthy();
    expect(screen.getByText("1 × 1")).toBeTruthy();

    // Verify 1 column 1 x 16
    expect(screen.getByText("1 column")).toBeTruthy();
    expect(screen.getByText("1 × 16")).toBeTruthy();

    // Verify 2 columns 2 x 8 (and selected)
    expect(screen.getByText("2 columns")).toBeTruthy();
    expect(screen.getByText("2 × 8")).toBeTruthy();

    // Verify 3 columns 3 x 6
    expect(screen.getByText("3 columns")).toBeTruthy();
    expect(screen.getByText("3 × 6")).toBeTruthy();
  });

  it("preserves exactly 2 rows without opening extra row when moving a pane to an empty slot", () => {
    // Scenario from User Bug (Images #1, #2, #3):
    // 4 panes in a 4-column room, with 4 empty slots configured (total 8 cells -> 2 rows).
    const mockPanes: Pane[] = [
      { id: "pane-1", roomId: "room-1", title: "P1", mode: "TERMINAL" } as Pane,
      { id: "pane-2", roomId: "room-1", title: "P2", mode: "TERMINAL" } as Pane,
      { id: "pane-3", roomId: "room-1", title: "P3", mode: "TERMINAL" } as Pane,
      { id: "pane-4", roomId: "room-1", title: "P4", mode: "TERMINAL" } as Pane,
    ];

    // Initial state: all 4 panes in row 0
    const initialPlacements = resolvePaneGridPlacements(mockPanes, 4, new Map());
    const initialResult = calculatePaneGridBaseRows({
      placements: initialPlacements,
      visiblePaneCount: 4,
      columnCount: 4,
      targetEmptySlots: 4,
    });
    expect(initialResult.naturalRows).toBe(1);
    expect(initialResult.naturalEmptySlots).toBe(0);
    expect(initialResult.actualBaseRows).toBe(2); // 4 panes + 4 empty slots = 8 cells = 2 rows
    expect(initialResult.targetEmptySlots).toBe(4);

    // After dropping pane-1 to row 1, column 4 (Image #2 -> Image #3)
    const anchors = new Map<string, PaneColumnAnchor>();
    anchors.set("pane-1", { columnStart: 4, rowIndex: 1 });

    // When reordered: panes are [pane-2, pane-3, pane-4, pane-1]
    const reorderedPanes = [mockPanes[1]!, mockPanes[2]!, mockPanes[3]!, mockPanes[0]!];
    const dropPlacements = resolvePaneGridPlacements(reorderedPanes, 4, anchors);

    const p1Placement = dropPlacements.get("pane-1");
    expect(p1Placement?.rowIndex).toBe(1);
    expect(p1Placement?.columnStart).toBe(4);

    const afterDropResult = calculatePaneGridBaseRows({
      placements: dropPlacements,
      visiblePaneCount: 4,
      columnCount: 4,
      targetEmptySlots: 4,
    });

    // The key expectation: actualBaseRows MUST REMAIN 2, NOT jump to 3!
    expect(afterDropResult.naturalRows).toBe(2);
    expect(afterDropResult.naturalEmptySlots).toBe(4);
    expect(afterDropResult.actualBaseRows).toBe(2);
    expect(afterDropResult.targetEmptySlots).toBe(4);
    expect(afterDropResult.minCount).toBe(0);
    expect(afterDropResult.maxCount).toBe(6);

    // If user increments empty slots to 5:
    const incrementResult = calculatePaneGridBaseRows({
      placements: dropPlacements,
      visiblePaneCount: 4,
      columnCount: 4,
      targetEmptySlots: 5,
    });
    expect(incrementResult.actualBaseRows).toBe(3); // 8 natural capacity + 1 extra = 9 cells -> 3 rows

    // If user decrements back to 4:
    const decrementResult = calculatePaneGridBaseRows({
      placements: dropPlacements,
      visiblePaneCount: 4,
      columnCount: 4,
      targetEmptySlots: 4,
    });
    expect(decrementResult.actualBaseRows).toBe(2);

    // If user decrements all the way down to 0:
    const zeroResult = calculatePaneGridBaseRows({
      placements: dropPlacements,
      visiblePaneCount: 4,
      columnCount: 4,
      targetEmptySlots: 0,
    });
    expect(zeroResult.minCount).toBe(0);
    expect(zeroResult.targetEmptySlots).toBe(0);
    expect(zeroResult.actualBaseRows).toBe(2);
  });

  it("supports anchoring panes to empty rows in a 1-column layout", () => {
    const mockPanes: Pane[] = [
      { id: "pane-1", roomId: "room-1", title: "P1", mode: "TERMINAL" } as Pane,
    ];

    const initialPlacements = resolvePaneGridPlacements(mockPanes, 1, new Map());
    const baseRows = calculatePaneGridBaseRows({
      placements: initialPlacements,
      visiblePaneCount: 1,
      columnCount: 1,
      targetEmptySlots: 3,
    });

    expect(baseRows.actualBaseRows).toBe(4);

    // Anchor pane-1 to row 2 in the 1-column grid (dropped onto empty slot 3)
    const anchors = new Map<string, PaneColumnAnchor>();
    anchors.set("pane-1", { columnStart: 1, rowIndex: 2 });

    const dropPlacements = resolvePaneGridPlacements(mockPanes, 1, anchors);
    const p1Placement = dropPlacements.get("pane-1");
    expect(p1Placement?.rowIndex).toBe(2);
    expect(p1Placement?.columnStart).toBe(1);
  });

  it("calculates comfortable row height for 16 panes in a compact window preserving Image #2 distance", () => {
    // 16 panes in 2 columns = 8 rows
    const mockPanes: Pane[] = Array.from({ length: 16 }, (_, i) => ({
      id: `pane-${i + 1}`,
      roomId: "room-16",
      title: `P${i + 1}`,
      mode: "TERMINAL"
    } as Pane));

    const placements = resolvePaneGridPlacements(mockPanes, 2, new Map());
    const { actualBaseRows } = calculatePaneGridBaseRows({
      placements,
      visiblePaneCount: 16,
      columnCount: 2,
      targetEmptySlots: 0,
    });
    expect(actualBaseRows).toBe(8);

    // Verify row calculation with a small window container (height: 720px, gap: 12px)
    const containerHeight = 720;
    const gapPx = 12;
    const minPaneRowPx = 320;
    const maxFittingRows = Math.max(1, Math.floor((containerHeight + gapPx) / (minPaneRowPx + gapPx)));
    expect(maxFittingRows).toBe(2);

    const viewportRows = Math.max(1, Math.min(actualBaseRows, maxFittingRows));
    expect(viewportRows).toBe(2);

    const baselineRowPx = Math.max(
      Math.round((containerHeight - (viewportRows - 1) * gapPx) / viewportRows),
      minPaneRowPx
    );
    // Exactly matches the height of a 2-row room (Image #2)
    expect(baselineRowPx).toBe(354);
    expect(baselineRowPx).toBeGreaterThanOrEqual(320);

    // Total grid height expands to accommodate all 8 rows, enabling vertical scroll
    const totalGridHeight = actualBaseRows * baselineRowPx + (actualBaseRows - 1) * gapPx;
    expect(totalGridHeight).toBe(8 * 354 + 7 * 12); // 2916px > 720px
    expect(totalGridHeight).toBeGreaterThan(containerHeight);
  });
});

