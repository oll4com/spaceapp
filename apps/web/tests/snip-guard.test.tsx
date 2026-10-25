// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import {
  isSnipToolTarget,
  isSnipToolActive,
  shouldPreserveForSnipTool
} from "../src/features/snip-tool/snip-guard.js";
import { CliPlansMenu } from "../src/features/terminal-pane/CliPlansMenu.js";
import { api } from "../src/api.js";

vi.mock("../src/api.js", () => ({
  api: {
    clipboardItems: vi.fn().mockResolvedValue({
      data: [
        {
          id: "plan-1",
          source: "PLAN",
          title: "Test Plan Title",
          text: "Step 1: Test the snip guard functionality\nStep 2: Verify success",
          isCompleted: false,
          executionStatus: "IN_PROGRESS",
          createdAt: new Date().toISOString()
        }
      ]
    })
  }
}));

describe("snip-guard utility", () => {
  afterEach(() => {
    cleanup();
    document.body.removeAttribute("data-snip-tool-active");
  });

  it("detects snip tool rail buttons, action buttons, and overlay elements", () => {
    const railBtn = document.createElement("button");
    railBtn.setAttribute("data-rail-id", "snip-tool");
    const svgIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    svgIcon.appendChild(path);
    railBtn.appendChild(svgIcon);
    document.body.appendChild(railBtn);

    const actionBtn = document.createElement("button");
    actionBtn.setAttribute("data-action-id", "snip-tool");
    document.body.appendChild(actionBtn);

    const overlay = document.createElement("div");
    overlay.className = "snip-tool-overlay snip-direct";
    const hud = document.createElement("div");
    hud.className = "snip-tool-hud";
    overlay.appendChild(hud);
    document.body.appendChild(overlay);

    const otherBtn = document.createElement("button");
    otherBtn.setAttribute("data-rail-id", "layout");
    document.body.appendChild(otherBtn);

    expect(isSnipToolTarget(railBtn)).toBe(true);
    expect(isSnipToolTarget(svgIcon)).toBe(true);
    expect(isSnipToolTarget(path)).toBe(true);
    expect(isSnipToolTarget(actionBtn)).toBe(true);
    expect(isSnipToolTarget(overlay)).toBe(true);
    expect(isSnipToolTarget(hud)).toBe(true);
    expect(isSnipToolTarget(otherBtn)).toBe(false);
    expect(isSnipToolTarget(document.body)).toBe(false);
    expect(isSnipToolTarget(null)).toBe(false);

    document.body.removeChild(railBtn);
    document.body.removeChild(actionBtn);
    document.body.removeChild(overlay);
    document.body.removeChild(otherBtn);
  });

  it("detects active snip tool via data attribute or DOM overlay", () => {
    expect(isSnipToolActive()).toBe(false);

    document.body.setAttribute("data-snip-tool-active", "true");
    expect(isSnipToolActive()).toBe(true);
    document.body.removeAttribute("data-snip-tool-active");

    const overlay = document.createElement("div");
    overlay.className = "snip-tool-overlay";
    document.body.appendChild(overlay);
    expect(isSnipToolActive()).toBe(true);
    document.body.removeChild(overlay);

    expect(isSnipToolActive()).toBe(false);
  });

  it("shouldPreserveForSnipTool returns true when snip tool is targeted or active", () => {
    const railBtn = document.createElement("button");
    railBtn.setAttribute("data-rail-id", "snip-tool");
    document.body.appendChild(railBtn);

    const outsideDiv = document.createElement("div");
    document.body.appendChild(outsideDiv);

    // When inactive and clicking outside element: false
    expect(shouldPreserveForSnipTool({ target: outsideDiv })).toBe(false);

    // When clicking snip rail button: true
    expect(shouldPreserveForSnipTool({ target: railBtn })).toBe(true);

    // When focus blurs to snip rail button: true
    expect(shouldPreserveForSnipTool({ target: outsideDiv, relatedTarget: railBtn })).toBe(true);

    // When snip tool active attribute is set: always true
    document.body.setAttribute("data-snip-tool-active", "true");
    expect(shouldPreserveForSnipTool({ target: outsideDiv })).toBe(true);

    document.body.removeAttribute("data-snip-tool-active");
    document.body.removeChild(railBtn);
    document.body.removeChild(outsideDiv);
  });

  it("prevents CliPlansMenu from closing when snip tool is clicked or active", async () => {
    vi.stubGlobal("PointerEvent", MouseEvent);

    // Render CliPlansMenu with an outside trigger button and snip button
    const snipButton = document.createElement("button");
    snipButton.setAttribute("data-rail-id", "snip-tool");
    snipButton.textContent = "Snip Tool";
    document.body.appendChild(snipButton);

    const outsidePane = document.createElement("div");
    outsidePane.setAttribute("data-pane-id", "test-pane");
    document.body.appendChild(outsidePane);

    const onSelectPlan = vi.fn();
    render(<CliPlansMenu active={true} disabled={false} onSelectPlan={onSelectPlan} />);

    // Open the plans popover
    const plansTrigger = screen.getByRole("button", { name: /open plans/i });
    fireEvent.click(plansTrigger);

    // Ensure the dialog opened
    const dialog = await screen.findByRole("dialog", { name: "Open plans" });
    expect(dialog).toBeDefined();

    // Click on snip tool button: should NOT close CliPlansMenu!
    fireEvent.pointerDown(snipButton);
    expect(screen.queryByRole("dialog", { name: "Open plans" })).not.toBeNull();

    // While snip tool is active (overlay mounted): should NOT close CliPlansMenu!
    document.body.setAttribute("data-snip-tool-active", "true");
    fireEvent.pointerDown(outsidePane);
    expect(screen.queryByRole("dialog", { name: "Open plans" })).not.toBeNull();
    document.body.removeAttribute("data-snip-tool-active");

    // Click on outside pane when snip tool is not active: SHOULD close CliPlansMenu!
    fireEvent.pointerDown(outsidePane);
    expect(screen.queryByRole("dialog", { name: "Open plans" })).toBeNull();

    document.body.removeChild(snipButton);
    document.body.removeChild(outsidePane);
  });
});
