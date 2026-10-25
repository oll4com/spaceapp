import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEMO_TOUR_STEPS, DemoGuide, INSTALL_COMMAND, INSTALL_GUIDE_URL } from "../src/demo/DemoGuide.js";

afterEach(cleanup);

describe("public demo guide", () => {
  it("walks through every tour step and ends on the install panel", () => {
    render(<DemoGuide />);
    fireEvent.click(screen.getByRole("button", { name: "Take the tour" }));
    for (const [index, step] of DEMO_TOUR_STEPS.entries()) {
      expect(screen.getByRole("heading", { name: step.title })).toBeTruthy();
      expect(screen.getByText(`${index + 1} of ${DEMO_TOUR_STEPS.length}`)).toBeTruthy();
      if (index < DEMO_TOUR_STEPS.length - 1) fireEvent.click(screen.getByRole("button", { name: "Next" }));
    }
    fireEvent.click(screen.getAllByRole("button", { name: "Install your own" }).at(-1)!);
    expect(screen.getByRole("heading", { name: "Run SpaceApp on your machine" })).toBeTruthy();
    expect(screen.getByText(INSTALL_COMMAND)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Installation guide" }).getAttribute("href")).toBe(INSTALL_GUIDE_URL);
  });

  it("copies the install command and closes with Escape", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<DemoGuide />);
    fireEvent.click(screen.getByRole("button", { name: "Install your own" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("npx --yes run-spaceapp@latest install");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
