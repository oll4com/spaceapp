import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaneLayoutMenu } from "../src/features/pane-layout/PaneLayoutMenu.js";

afterEach(() => cleanup());

describe("PaneLayoutMenu", () => {
  it.each([null, 0, 1, 2, 3, 4] as const)("offers one useful option for a single pane with stored layout %s", (currentColumns) => {
    const onSelect = vi.fn();
    render(<PaneLayoutMenu automaticColumns={1} currentColumns={currentColumns} error={null} maximumColumns={4}
      onClose={vi.fn()} onSelect={onSelect} pending={false} triggerRef={createRef<HTMLButtonElement>()} visiblePaneCount={1} />);
    const options = screen.getAllByRole("menuitemradio");
    expect(options).toHaveLength(1);
    fireEvent.click(options[0]!);
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it.each([
    { visiblePaneCount: 6, columns: 3, rows: 2 },
    { visiblePaneCount: 8, columns: 4, rows: 2 },
    { visiblePaneCount: 16, columns: 4, rows: 4 }
  ])("previews all $visiblePaneCount real visible panes as $columns columns by $rows rows", ({ visiblePaneCount, columns, rows }) => {
    render(
      <PaneLayoutMenu
        automaticColumns={2}
        currentColumns={null}
        error={null}
        maximumColumns={4}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        pending={false}
        triggerRef={createRef<HTMLButtonElement>()}
        visiblePaneCount={visiblePaneCount}
      />
    );

    expect(screen.getByText(`${visiblePaneCount} visible panes`)).toBeTruthy();
    const option = screen.getByRole("menuitemradio", {
      name: `${columns} columns, ${visiblePaneCount} visible panes, ${rows} rows`
    });
    expect(option.getAttribute("aria-checked")).toBe("false");
    expect(option.getAttribute("data-preview-columns")).toBe(String(columns));
    expect(option.getAttribute("data-preview-rows")).toBe(String(rows));
    expect(within(option).getAllByTestId("pane-layout-preview-pane")).toHaveLength(visiblePaneCount);
  });

  it("supports arrow-key navigation, selection, Escape focus return, pending, and errors", () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    const triggerRef = createRef<HTMLButtonElement>();
    render(
      <>
        <button ref={triggerRef}>Pane layout</button>
        <PaneLayoutMenu
          automaticColumns={3}
          currentColumns={1}
          error="Could not update the pane layout."
          maximumColumns={4}
          onClose={onClose}
          onSelect={onSelect}
          pending={false}
          triggerRef={triggerRef}
          visiblePaneCount={3}
        />
      </>
    );

    const current = screen.getByRole("menuitemradio", { name: "1 column, 3 visible panes, 3 rows" });
    expect(current.getAttribute("aria-checked")).toBe("true");
    current.focus();
    fireEvent.keyDown(current, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "2 columns, 3 visible panes, 2 rows" }));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(2);
    expect(screen.getByRole("alert").textContent).toContain("Could not update");

    fireEvent.keyDown(screen.getByRole("menu", { name: "Pane layout presets" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(triggerRef.current);
  });

  it("disables every preset and height button while an update is pending", () => {
    render(
      <PaneLayoutMenu
        automaticColumns={1}
        currentColumns={null}
        error={null}
        maximumColumns={4}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        pending
        triggerRef={createRef<HTMLButtonElement>()}
        visiblePaneCount={2}
      />
    );

    expect(screen.getByRole("status").textContent).toContain("Applying");
    expect(screen.getAllByRole("menuitemradio").every((option) => (option as HTMLButtonElement).disabled)).toBe(true);
    for (const h of [1, 2, 3, 4]) {
      expect(screen.getByRole("button", { name: `Height ${h}` })).toHaveProperty("disabled", true);
    }
  });

  it("renders height multiplier buttons 1 to 4 and allows selecting a height", () => {
    const onSelectHeight = vi.fn();
    render(
      <PaneLayoutMenu
        automaticColumns={2}
        currentColumns={null}
        currentHeight={2}
        error={null}
        maximumColumns={4}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onSelectHeight={onSelectHeight}
        pending={false}
        triggerRef={createRef<HTMLButtonElement>()}
        visiblePaneCount={5}
      />
    );

    const btn1 = screen.getByRole("button", { name: "Height 1" });
    const btn2 = screen.getByRole("button", { name: "Height 2" });
    const btn3 = screen.getByRole("button", { name: "Height 3" });
    const btn4 = screen.getByRole("button", { name: "Height 4" });

    expect(btn1.getAttribute("aria-pressed")).toBe("false");
    expect(btn2.getAttribute("aria-pressed")).toBe("true");
    expect(btn3.getAttribute("aria-pressed")).toBe("false");
    expect(btn4.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(btn3);
    expect(onSelectHeight).toHaveBeenCalledWith(3);

    fireEvent.click(btn4);
    expect(onSelectHeight).toHaveBeenCalledWith(4);
  });

  it("offers the Fullscreen preset as a single-pane carousel preview", () => {
    const onSelect = vi.fn();
    render(
      <PaneLayoutMenu
        automaticColumns={2}
        currentColumns={null}
        error={null}
        maximumColumns={4}
        onClose={vi.fn()}
        onSelect={onSelect}
        pending={false}
        triggerRef={createRef<HTMLButtonElement>()}
        visiblePaneCount={6}
      />
    );

    const option = screen.getByRole("menuitemradio", { name: "Fullscreen, 6 visible panes, one at a time" });
    expect(option.getAttribute("aria-checked")).toBe("false");
    expect(option.getAttribute("data-preview-columns")).toBe("1");
    expect(option.getAttribute("data-preview-rows")).toBe("1");
    expect(within(option).getAllByTestId("pane-layout-preview-pane")).toHaveLength(1);
    fireEvent.click(option);
    expect(onSelect).toHaveBeenCalledWith(0);
  });

  it("marks the Fullscreen preset as current when the room uses it", () => {
    render(
      <PaneLayoutMenu
        automaticColumns={2}
        currentColumns={0}
        error={null}
        maximumColumns={4}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        pending={false}
        triggerRef={createRef<HTMLButtonElement>()}
        visiblePaneCount={4}
      />
    );

    expect(screen.getByRole("menuitemradio", { name: "Fullscreen, 4 visible panes, one at a time" }).getAttribute("aria-checked")).toBe("true");
  });

  it("hides presets that match Automatic for the current visible panes", () => {
    render(
      <PaneLayoutMenu
        automaticColumns={3}
        currentColumns={1}
        error={null}
        maximumColumns={4}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        pending={false}
        triggerRef={createRef<HTMLButtonElement>()}
        visiblePaneCount={3}
      />
    );

    expect(screen.getAllByRole("menuitemradio")).toHaveLength(4);
    expect(screen.getByRole("menuitemradio", { name: "Automatic, 3 visible panes, 1 row" })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "Fullscreen, 3 visible panes, one at a time" })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "1 column, 3 visible panes, 3 rows" })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "2 columns, 3 visible panes, 2 rows" })).toBeTruthy();
    expect(screen.queryByRole("menuitemradio", { name: "3 columns, 3 visible panes, 1 row" })).toBeNull();
    expect(screen.queryByRole("menuitemradio", { name: "4 columns, 3 visible panes, 1 row" })).toBeNull();
  });

  it("hides fixed presets that collapse to the same layout at the tablet cap", () => {
    render(
      <PaneLayoutMenu
        automaticColumns={2}
        currentColumns={1}
        error={null}
        maximumColumns={2}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        pending={false}
        triggerRef={createRef<HTMLButtonElement>()}
        visiblePaneCount={3}
      />
    );

    expect(screen.getAllByRole("menuitemradio")).toHaveLength(3);
    expect(screen.getByRole("menuitemradio", { name: "Automatic, 3 visible panes, 2 rows" })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "Fullscreen, 3 visible panes, one at a time" })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "1 column, 3 visible panes, 3 rows" })).toBeTruthy();
    expect(screen.queryByRole("menuitemradio", { name: "2 columns, 3 visible panes, 2 rows" })).toBeNull();
    expect(screen.queryByRole("menuitemradio", { name: "3 columns, 3 visible panes, 2 rows" })).toBeNull();
    expect(screen.queryByRole("menuitemradio", { name: "4 columns, 3 visible panes, 2 rows" })).toBeNull();
  });

  it("keeps the current preset as the representative of an equivalent group", () => {
    render(
      <PaneLayoutMenu
        automaticColumns={3}
        currentColumns={4}
        error={null}
        maximumColumns={4}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        pending={false}
        triggerRef={createRef<HTMLButtonElement>()}
        visiblePaneCount={3}
      />
    );

    const current = screen.getByRole("menuitemradio", { name: "4 columns, 3 visible panes, 1 row" });
    expect(current.getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("menuitemradio", { name: "Automatic, 3 visible panes, 1 row" })).toBeNull();
    expect(screen.queryByRole("menuitemradio", { name: "3 columns, 3 visible panes, 1 row" })).toBeNull();
  });

  it("does not render All panes width in PaneLayoutMenu", () => {
    const { rerender } = render(
      <PaneLayoutMenu
        automaticColumns={3}
        currentColumns={null}
        error={null}
        maximumColumns={4}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        pending={false}
        triggerRef={createRef<HTMLButtonElement>()}
        visiblePaneCount={3}
      />
    );
    expect(screen.queryByRole("group", { name: "All panes width" })).toBeNull();
    expect(screen.queryByText("All panes width")).toBeNull();

    rerender(
      <PaneLayoutMenu
        automaticColumns={4}
        currentColumns={null}
        error={null}
        maximumColumns={4}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        pending={false}
        triggerRef={createRef<HTMLButtonElement>()}
        visiblePaneCount={6}
      />
    );
    expect(screen.queryByRole("group", { name: "All panes width" })).toBeNull();
    expect(screen.queryByText("All panes width")).toBeNull();
  });

  it("deactivates selected height back to 1 when clicking the active height button", () => {
    const onSelectHeight = vi.fn();
    render(
      <PaneLayoutMenu
        automaticColumns={2}
        currentColumns={null}
        currentHeight={3}
        error={null}
        maximumColumns={4}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onSelectHeight={onSelectHeight}
        pending={false}
        triggerRef={createRef<HTMLButtonElement>()}
        visiblePaneCount={5}
      />
    );

    const btn3 = screen.getByRole("button", { name: "Height 3" });
    expect(btn3.getAttribute("aria-pressed")).toBe("true");

    // Clicking already selected height 3 deactivates back to 1
    fireEvent.click(btn3);
    expect(onSelectHeight).toHaveBeenCalledWith(1);
  });

  it("renders Empty slots row when emptySlots is provided and responds to +/- and keyboard", () => {
    const onIncrement = vi.fn();
    const onDecrement = vi.fn();
    render(
      <PaneLayoutMenu
        automaticColumns={2}
        currentColumns={null}
        error={null}
        maximumColumns={4}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        pending={false}
        triggerRef={createRef<HTMLButtonElement>()}
        visiblePaneCount={3}
        emptySlots={{
          count: 1,
          min: 0,
          max: 6,
          onIncrement,
          onDecrement
        }}
      />
    );

    const emptySlots = screen.getByRole("button", { name: "Empty slots" });
    expect(emptySlots).toBeTruthy();
    expect(screen.getByText("1 in room")).toBeTruthy();

    const minus = screen.getByRole("button", { name: "Decrease empty slots" });
    const plus = screen.getByRole("button", { name: "Increase empty slots" });

    fireEvent.click(plus);
    expect(onIncrement).toHaveBeenCalledTimes(1);

    fireEvent.click(minus);
    expect(onDecrement).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(emptySlots, { key: "ArrowRight" });
    expect(onIncrement).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(emptySlots, { key: "ArrowLeft" });
    expect(onDecrement).toHaveBeenCalledTimes(2);
  });
});
