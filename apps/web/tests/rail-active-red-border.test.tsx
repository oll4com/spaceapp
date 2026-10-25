import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DesktopNavigation } from "../src/features/ui-theme/DesktopNavigation.js";
import { MinimizedPaneBarToggle } from "../src/features/pane-float/MinimizedPaneBarToggle.js";
import { Terminal } from "../src/features/ui-theme/app-icons.js";
import type { IconToolbarAction } from "../src/icon-toolbar.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const createAction = (id: string, label: string, pressed = false): IconToolbarAction => ({
  id,
  label,
  ariaLabel: label,
  title: label,
  icon: Terminal,
  ariaPressed: pressed,
  onClick: vi.fn()
});

describe("Rail active red border invariant", () => {
  it("marks DesktopNavigation rail trigger button as is-active and expanded when open", () => {
    const actions = [createAction("add-cli", "Add CLI pane")];
    render(
      <DesktopNavigation
        createOnly
        actions={actions}
        adminMode={false}
        canAdmin
        onModeChange={vi.fn()}
        onAction={vi.fn()}
      />
    );

    const trigger = screen.getByRole("button", { name: "Create" });
    expect(trigger.classList.contains("room-toolbar-visibility-button")).toBe(true);
    expect(trigger.classList.contains("is-active")).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);

    expect(trigger.classList.contains("is-active")).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-pressed")).toBe("true");
  });

  it("marks docks rail button as is-active only when open, not when closed even if a dock surface is open", () => {
    const actions = [
      createAction("surface-cli", "CLI dock", true),
      createAction("surface-media", "Media dock", false)
    ];

    render(
      <DesktopNavigation
        docksOnly
        actions={actions}
        adminMode={false}
        canAdmin
        onModeChange={vi.fn()}
        onAction={vi.fn()}
      />
    );

    const trigger = screen.getByRole("button", { name: "Show docks" });
    expect(trigger.classList.contains("room-toolbar-visibility-button")).toBe(true);
    // When closed, it should NOT be is-active even if dock surfaces are active
    expect(trigger.classList.contains("is-active")).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    // When clicked to open, it becomes is-active
    fireEvent.click(trigger);
    expect(trigger.classList.contains("is-active")).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-pressed")).toBe("true");
  });

  it("marks MinimizedPaneBarToggle as is-active and pressed when expanded", () => {
    const { rerender } = render(
      <MinimizedPaneBarToggle
        count={2}
        runningCount={0}
        expanded={false}
        onToggle={vi.fn()}
      />
    );

    const toggle = screen.getByRole("button", { name: /minimized pane/i });
    expect(toggle.classList.contains("room-toolbar-visibility-button")).toBe(true);
    expect(toggle.classList.contains("is-active")).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    rerender(
      <MinimizedPaneBarToggle
        count={2}
        runningCount={0}
        expanded={true}
        onToggle={vi.fn()}
      />
    );

    expect(toggle.classList.contains("is-active")).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });

  it("defines active red border across styles.css, workspace-chrome.css, and modern-theme.css and excludes room-live-rail-button", () => {
    const stylesCss = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8");
    const chromeCss = readFileSync(resolve(__dirname, "../src/features/ui-theme/workspace-chrome.css"), "utf8");
    const modernCss = readFileSync(resolve(__dirname, "../src/features/ui-theme/modern-theme.css"), "utf8");

    // styles.css targets all rail and visibility buttons, excluding room-live-rail-button
    expect(stylesCss).toContain(".space-shell .room-toolbar-visibility-button:not(.room-live-rail-button).is-active");
    expect(stylesCss).toContain(".space-shell .room-toolbar-collapsed button:not(.room-live-rail-button).is-active");
    expect(stylesCss).toContain("border: 1.5px solid var(--active-icon-border, #ff4d5e) !important;");

    // workspace-chrome.css uses red border invariant for active rail icons, excluding room-live-rail-button
    expect(chromeCss).toContain(".space-shell .room-toolbar-collapsed button[data-rail-id]:not(.room-live-rail-button):is(.is-active, [aria-pressed=\"true\"], [aria-expanded=\"true\"])");
    expect(chromeCss).toContain(".space-shell .room-toolbar-collapsed .room-toolbar-visibility-button:not(.room-live-rail-button):is(.is-active, [aria-pressed=\"true\"], [aria-expanded=\"true\"])");
    expect(chromeCss).toContain("border: 1.5px solid var(--active-icon-border, #ff4d5e) !important;");

    // modern-theme.css includes rail buttons, excluding room-live-rail-button
    expect(modernCss).toContain(".space-shell[data-ui-theme=\"modern\"] .room-toolbar-visibility-button:not(.room-live-rail-button):is(.is-active, [aria-pressed=\"true\"], [aria-expanded=\"true\"])");
    expect(modernCss).toContain("border: 1.5px solid var(--active-icon-border, #ff4d5e);");
  });
});
