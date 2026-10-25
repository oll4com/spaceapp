import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaneSpanAllMenu } from "../src/features/pane-layout/PaneSpanAllMenu.js";

afterEach(() => cleanup());

describe("PaneSpanAllMenu", () => {
  it("renders one option per active column count", () => {
    render(
      <PaneSpanAllMenu
        activeColumnCount={3}
        currentSpan={null}
        error={null}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        pending={false}
        triggerRef={createRef<HTMLButtonElement>()}
        visiblePaneCount={6}
      />
    );

    const options = screen.getAllByRole("menuitemradio");
    expect(options).toHaveLength(3);
    expect(screen.getByRole("menuitemradio", { name: "1 column" })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "2 columns" })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "3 columns" })).toBeTruthy();
    expect(screen.queryByRole("menuitemradio", { name: "4 columns" })).toBeNull();
  });

  it("caps options at four columns and at visible pane count", () => {
    render(
      <PaneSpanAllMenu
        activeColumnCount={4}
        currentSpan={null}
        error={null}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        pending={false}
        triggerRef={createRef<HTMLButtonElement>()}
        visiblePaneCount={8}
      />
    );

    expect(screen.getAllByRole("menuitemradio")).toHaveLength(4);
    expect(screen.getByRole("menuitemradio", { name: "4 columns" })).toBeTruthy();
  });

  it("marks the shared current span as checked", () => {
    render(
      <PaneSpanAllMenu
        activeColumnCount={3}
        currentSpan={2}
        error={null}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        pending={false}
        triggerRef={createRef<HTMLButtonElement>()}
        visiblePaneCount={4}
      />
    );

    const option = screen.getByRole("menuitemradio", { name: "2 columns" });
    expect(option.getAttribute("aria-checked")).toBe("true");
    expect(within(option).getByText("2 columns")).toBeTruthy();
  });

  it("selects a span on click", () => {
    const onSelect = vi.fn();
    render(
      <PaneSpanAllMenu
        activeColumnCount={3}
        currentSpan={null}
        error={null}
        onClose={vi.fn()}
        onSelect={onSelect}
        pending={false}
        triggerRef={createRef<HTMLButtonElement>()}
        visiblePaneCount={4}
      />
    );

    fireEvent.click(screen.getByRole("menuitemradio", { name: "3 columns" }));
    expect(onSelect).toHaveBeenCalledWith(3);
  });

  it("supports arrow-key navigation, selection, and Escape focus return", () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    const triggerRef = createRef<HTMLButtonElement>();
    const container = document.createElement("div");
    const button = document.createElement("button");
    container.appendChild(button);
    document.body.appendChild(container);
    triggerRef.current = button;

    render(
      <PaneSpanAllMenu
        activeColumnCount={3}
        currentSpan={null}
        error={null}
        onClose={onClose}
        onSelect={onSelect}
        pending={false}
        triggerRef={triggerRef}
        visiblePaneCount={4}
      />,
      { container }
    );

    const firstOption = screen.getAllByRole("menuitemradio")[0]!;
    firstOption.focus();
    fireEvent.keyDown(firstOption, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "2 columns" }));
    fireEvent.keyDown(document.activeElement as HTMLButtonElement, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(2);
    fireEvent.keyDown(document.activeElement as HTMLButtonElement, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("disables options while pending and shows error", () => {
    render(
      <PaneSpanAllMenu
        activeColumnCount={2}
        currentSpan={null}
        error="1 pane could not be updated."
        onClose={vi.fn()}
        onSelect={vi.fn()}
        pending={true}
        triggerRef={createRef<HTMLButtonElement>()}
        visiblePaneCount={2}
      />
    );

    expect(screen.getByRole("menuitemradio", { name: "1 column" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("could not be updated");
  });
});
