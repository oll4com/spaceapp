import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DemoModeOverlay } from "../src/features/demo-mode/DemoModeOverlay.js";
import { DEMO_MODE_STEPS } from "../src/features/demo-mode/demo-mode-steps.js";

afterEach(cleanup);

describe("DemoModeOverlay", () => {
  it("does not render when isOpen is false", () => {
    const { container } = render(
      <DemoModeOverlay isOpen={false} onClose={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders tour overlay, topbar, and first step when isOpen is true", () => {
    const onClose = vi.fn();
    render(<DemoModeOverlay isOpen={true} onClose={onClose} />);

    expect(screen.getByRole("dialog", { name: "Space App Demo Mode Tour" })).toBeTruthy();
    expect(screen.getByText("Demo Mode")).toBeTruthy();
    expect(screen.getByText("1 of 10")).toBeTruthy();
    expect(screen.getByText(DEMO_MODE_STEPS[0]!.title)).toBeTruthy();
    expect(screen.getByText(DEMO_MODE_STEPS[0]!.badge)).toBeTruthy();
  });

  it("advances to next step and returns to previous step", () => {
    render(<DemoModeOverlay isOpen={true} onClose={vi.fn()} />);

    expect(screen.getByText("1 of 10")).toBeTruthy();
    expect(screen.getByText(DEMO_MODE_STEPS[0]!.title)).toBeTruthy();

    const nextButtons = screen.getAllByRole("button", { name: /Next/i });
    fireEvent.click(nextButtons[0]!);

    expect(screen.getByText("2 of 10")).toBeTruthy();
    expect(screen.getByText(DEMO_MODE_STEPS[1]!.title)).toBeTruthy();

    const prevButton = screen.getByRole("button", { name: "Previous Step" });
    fireEvent.click(prevButton);

    expect(screen.getByText("1 of 10")).toBeTruthy();
    expect(screen.getByText(DEMO_MODE_STEPS[0]!.title)).toBeTruthy();
  });

  it("jumps directly to a step when clicking its dot", () => {
    render(<DemoModeOverlay isOpen={true} onClose={vi.fn()} />);

    const step7Dot = screen.getByRole("button", {
      name: `Jump to Step 7: ${DEMO_MODE_STEPS[6]!.title}`
    });
    fireEvent.click(step7Dot);

    expect(screen.getByText("7 of 10")).toBeTruthy();
    expect(screen.getByText(DEMO_MODE_STEPS[6]!.title)).toBeTruthy();
    expect(screen.getByText(DEMO_MODE_STEPS[6]!.badge)).toBeTruthy();
  });

  it("calls onClose when clicking exit button or pressing Escape", () => {
    const onClose = vi.fn();
    render(<DemoModeOverlay isOpen={true} onClose={onClose} />);

    const exitButton = screen.getByRole("button", { name: "Exit Demo Mode" });
    fireEvent.click(exitButton);
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("supports keyboard arrow navigation", () => {
    render(<DemoModeOverlay isOpen={true} onClose={vi.fn()} />);

    expect(screen.getByText("1 of 10")).toBeTruthy();

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByText("2 of 10")).toBeTruthy();

    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(screen.getByText("1 of 10")).toBeTruthy();
  });

  it("invokes preview callback when preview button is clicked", () => {
    const onActionPreview = vi.fn();
    render(
      <DemoModeOverlay
        isOpen={true}
        onClose={vi.fn()}
        onActionPreview={onActionPreview}
      />
    );

    // Step 2 has an actionId
    const step2Dot = screen.getByRole("button", {
      name: `Jump to Step 2: ${DEMO_MODE_STEPS[1]!.title}`
    });
    fireEvent.click(step2Dot);

    const previewBtn = screen.getByRole("button", {
      name: DEMO_MODE_STEPS[1]!.actionLabel!
    });
    fireEvent.click(previewBtn);

    expect(onActionPreview).toHaveBeenCalledWith(DEMO_MODE_STEPS[1]!.actionId);
  });
});
