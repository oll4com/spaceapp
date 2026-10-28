import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  calculateRailScale,
  applyRailScaleToShell,
  syncRailScale,
  MAX_RAIL_SCALE,
  MIN_RAIL_SCALE,
  BASE_CONTROL_SIZE,
  MIN_CONTROL_SIZE,
} from "../src/features/ui-theme/rail-dynamic-scaling.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("Rail icon dynamic scaling based on required icon space", () => {
  it("defines dynamic CSS custom properties for downscaled rail and preserves standard unscaled rules", () => {
    const css = readFileSync(
      resolve(__dirname, "../src/features/ui-theme/workspace-chrome.css"),
      "utf8"
    );

    // Dynamic downscaling is driven by [data-rail-downscaled="true"]
    expect(css).toContain('.space-shell[data-rail-downscaled="true"]');

    // Verify downscaled control size uses dynamic custom property with fallback
    expect(css).toContain("--toolbar-control-size: var(--toolbar-control-size, 31px) !important;");

    // Verify downscaled rail width uses dynamic custom property with fallback
    expect(css).toContain("width: var(--rail-width, 36px) !important;");

    // Verify standard unscaled rules exist for when window is enlarged / not downscaled
    expect(css).toContain(
      '.space-shell:is([data-shell-mode="desktop"], [data-shell-mode="tablet"], [data-shell-mode="mobile"]) .room-toolbar-collapsed,'
    );
    expect(css).toContain("width: 50px;");
  });

  describe("calculateRailScale", () => {
    it("returns MAX_RAIL_SCALE (1.0) when window has plenty of room for all icons", () => {
      // Large enlarged window (e.g. 1034px as in user's request) with 6 health items + 6 toolbar buttons
      const scale = calculateRailScale({
        viewportHeight: 1034,
        toolbarButtonCount: 6,
        isHealthExpanded: true,
        healthItemCount: 6,
        hasLiveOrb: true,
      });

      expect(scale).toBe(MAX_RAIL_SCALE);
    });

    it("returns MAX_RAIL_SCALE (1.0) when resource indicators are collapsed", () => {
      // Normal 800px window with collapsed health indicators (only 1 expander)
      const scale = calculateRailScale({
        viewportHeight: 800,
        toolbarButtonCount: 6,
        isHealthExpanded: false,
        healthItemCount: 0,
        hasLiveOrb: true,
      });

      expect(scale).toBe(MAX_RAIL_SCALE);
    });

    it("dynamically calculates proportional scale based on required space vs available space", () => {
      // 14 items (6 health + 8 toolbar): naturalItemsHeight = 14 * 46 = 644px.
      // Insets = 12 + 12 = 24px. Live orb slot = 68px. Total overhead = 92px. Total needed = 736px.
      // At 600px: availableForItems = 600 - 92 = 508px.
      // rawScale = 508 / 644 = 0.789.
      const scale600 = calculateRailScale({
        viewportHeight: 600,
        toolbarButtonCount: 8,
        isHealthExpanded: true,
        healthItemCount: 6,
        hasLiveOrb: true,
      });

      expect(scale600).toBeCloseTo(0.789, 2);
      expect(scale600).toBeLessThan(MAX_RAIL_SCALE);
      expect(scale600).toBeGreaterThan(MIN_RAIL_SCALE);

      // At 650px: more available space, so scale increases smoothly
      const scale650 = calculateRailScale({
        viewportHeight: 650,
        toolbarButtonCount: 8,
        isHealthExpanded: true,
        healthItemCount: 6,
        hasLiveOrb: true,
      });

      expect(scale650).toBeGreaterThan(scale600);
      expect(scale650).toBeLessThanOrEqual(MAX_RAIL_SCALE);
    });

    it("clamps scale to MIN_RAIL_SCALE (0.70 / 30% reduction) when space is extremely constrained", () => {
      const scaleTiny = calculateRailScale({
        viewportHeight: 400,
        toolbarButtonCount: 8,
        isHealthExpanded: true,
        healthItemCount: 6,
        hasLiveOrb: true,
      });

      expect(scaleTiny).toBe(MIN_RAIL_SCALE);
    });

    it("returns MAX_RAIL_SCALE when there are no items", () => {
      const scale = calculateRailScale({
        viewportHeight: 800,
        toolbarButtonCount: 0,
        isHealthExpanded: false,
        healthItemCount: 0,
        hasHealthRail: false,
      });

      expect(scale).toBe(MAX_RAIL_SCALE);
    });
  });

  describe("applyRailScaleToShell", () => {
    let shell: HTMLElement;

    beforeEach(() => {
      shell = document.createElement("div");
      shell.className = "space-shell";
      document.body.appendChild(shell);
    });

    afterEach(() => {
      shell.remove();
    });

    it("removes all overrides and dataset when scale is 1.0 (enlarged window)", () => {
      // First set downscaled state
      applyRailScaleToShell(shell, 0.80);
      expect(shell.dataset.railDownscaled).toBe("true");
      expect(shell.style.getPropertyValue("--toolbar-control-size")).toBeTruthy();

      // Now apply scale 1.0 (e.g. user enlarged window)
      applyRailScaleToShell(shell, 1.0);
      expect(shell.dataset.railDownscaled).toBeUndefined();
      expect(shell.style.getPropertyValue("--toolbar-control-size")).toBe("");
      expect(shell.style.getPropertyValue("--rail-width")).toBe("");
      expect(shell.style.getPropertyValue("--rail-scale")).toBe("");
    });

    it("sets interpolated CSS variables when scale is downscaled", () => {
      applyRailScaleToShell(shell, 0.70);
      expect(shell.dataset.railDownscaled).toBe("true");
      expect(shell.style.getPropertyValue("--toolbar-control-size")).toBe(`${MIN_CONTROL_SIZE}px`);
      expect(shell.style.getPropertyValue("--rail-width")).toBe("36px");

      applyRailScaleToShell(shell, 0.85);
      expect(shell.dataset.railDownscaled).toBe("true");
      // Midpoint between 31px and 44px
      const controlPx = parseFloat(shell.style.getPropertyValue("--toolbar-control-size"));
      expect(controlPx).toBeGreaterThan(MIN_CONTROL_SIZE);
      expect(controlPx).toBeLessThan(BASE_CONTROL_SIZE);
    });
  });

  describe("syncRailScale", () => {
    let shell: HTMLElement;

    beforeEach(() => {
      shell = document.createElement("div");
      shell.className = "space-shell";
      document.body.appendChild(shell);
    });

    afterEach(() => {
      shell.remove();
    });

    it("queries DOM and updates shell scale accordingly", () => {
      // Setup collapsed toolbar with 5 buttons
      const toolbar = document.createElement("div");
      toolbar.className = "room-toolbar-collapsed";
      for (let i = 0; i < 5; i++) {
        toolbar.appendChild(document.createElement("button"));
      }
      shell.appendChild(toolbar);

      // Setup health rail with 5 indicators + expander
      const healthRail = document.createElement("div");
      healthRail.className = "health-indicator-rail is-expanded";
      const items = document.createElement("div");
      items.className = "health-rail-items";
      for (let i = 0; i < 5; i++) {
        items.appendChild(document.createElement("button"));
      }
      healthRail.appendChild(items);
      const expander = document.createElement("button");
      expander.className = "health-rail-expander";
      healthRail.appendChild(expander);
      shell.appendChild(healthRail);

      // Large innerHeight -> scale 1.0
      vi.stubGlobal("innerHeight", 1200);
      const scaleLarge = syncRailScale(shell);
      expect(scaleLarge).toBe(1.0);
      expect(shell.dataset.railDownscaled).toBeUndefined();

      // Constrained innerHeight -> scale < 1.0
      vi.stubGlobal("innerHeight", 500);
      const scaleSmall = syncRailScale(shell);
      expect(scaleSmall).toBeLessThan(1.0);
      expect(shell.dataset.railDownscaled).toBe("true");
      expect(shell.style.getPropertyValue("--toolbar-control-size")).toBeTruthy();

      vi.unstubAllGlobals();
    });

    it("does not double-count live orb and does not downscale when height (e.g. 744px) is sufficient for all icons", () => {
      // Simulate titlebar
      const titlebar = document.createElement("div");
      titlebar.className = "desktop-window-titlebar";
      shell.appendChild(titlebar);

      // Collapsed toolbar with 10 regular buttons + 1 live orb button
      const toolbar = document.createElement("div");
      toolbar.className = "room-toolbar-collapsed";
      for (let i = 0; i < 10; i++) {
        const btn = document.createElement("button");
        btn.className = "room-toolbar-visibility-button";
        toolbar.appendChild(btn);
      }
      const orb = document.createElement("button");
      orb.className = "room-toolbar-visibility-button room-live-rail-button";
      toolbar.appendChild(orb);
      shell.appendChild(toolbar);

      // Collapsed health rail with minToggle + expander
      const healthRail = document.createElement("div");
      healthRail.className = "health-indicator-rail";
      const minToggle = document.createElement("button");
      minToggle.className = "minimized-pane-bar-toggle";
      healthRail.appendChild(minToggle);
      const expander = document.createElement("button");
      expander.className = "health-rail-expander";
      healthRail.appendChild(expander);
      const items = document.createElement("div");
      items.className = "health-rail-items";
      items.style.display = "none";
      healthRail.appendChild(items);
      shell.appendChild(healthRail);

      // Window height 744px has 68px of clearance (676px needed <= 744px)
      vi.stubGlobal("innerHeight", 744);
      const scale = syncRailScale(shell);
      expect(scale).toBe(1.0);
      expect(shell.dataset.railDownscaled).toBeUndefined();

      vi.unstubAllGlobals();
    });

    it("applies important priority to inline properties when downscaling", () => {
      applyRailScaleToShell(shell, 0.70);
      expect(shell.style.getPropertyPriority("--toolbar-control-size")).toBe("important");
      expect(shell.style.getPropertyPriority("--rail-width")).toBe("important");
    });
  });

  describe("Unified upper and lower icon sizing invariant", () => {
    it("ensures health indicators, expander, and toolbar buttons share exact square control sizing and icon sizing across unscaled and downscaled modes", () => {
      const css = readFileSync(
        resolve(__dirname, "../src/features/ui-theme/workspace-chrome.css"),
        "utf8"
      );

      // Unscaled mode: upper health rail and lower toolbar rail define identical custom properties
      expect(css).toContain(".space-shell:not([data-rail-downscaled=\"true\"]) .health-indicator-rail {\n  --toolbar-control-size: 44px;");
      expect(css).toContain(".space-shell:not([data-rail-downscaled=\"true\"]) .room-toolbar-collapsed {\n  --toolbar-control-size: 44px;");
      expect(css).toContain("--toolbar-icon-size: 20px;");
      expect(css).toContain("--rail-width: 50px;");

      // Downscaled mode: both health indicator rail and collapsed toolbar define matching 31px properties
      expect(css).toContain(".space-shell[data-rail-downscaled=\"true\"] .health-indicator-rail");
      expect(css).toContain("--toolbar-control-size: var(--toolbar-control-size, 31px) !important;");
      expect(css).toContain(".space-shell[data-rail-downscaled=\"true\"] .room-toolbar-collapsed {\n  --toolbar-control-size: var(--toolbar-control-size, 31px) !important;");

      // Unscaled mode: upper expander and lower toolbar buttons share unified card sizing rules
      expect(css).toContain(".space-shell :is(\n  .health-indicator-rail .health-rail-expander,");
      expect(css).toContain("width: var(--toolbar-control-size, 44px);");
      expect(css).toContain("height: var(--toolbar-control-size, 44px);");
      expect(css).toContain("width: var(--toolbar-icon-size, 20px);");
      expect(css).toContain("height: var(--toolbar-icon-size, 20px);");

      // Downscaled rules must size indicators and expander using --toolbar-control-size
      expect(css).toContain(".space-shell[data-rail-downscaled=\"true\"] .health-indicator {");
      expect(css).toContain("width: var(--toolbar-control-size, 31px) !important;");
      expect(css).toContain("height: var(--toolbar-control-size, 31px) !important;");

      expect(css).toContain(".space-shell[data-rail-downscaled=\"true\"] .health-rail-expander {");
      expect(css).toContain(".space-shell[data-rail-downscaled=\"true\"] .health-indicator-rail .minimized-pane-bar-toggle {");

      // Downscaled icon sizing: expander and toolbar buttons share unified --toolbar-icon-size (14px)
      expect(css).toContain(".space-shell[data-rail-downscaled=\"true\"] .health-rail-expander svg {\n  width: var(--toolbar-icon-size, 14px) !important;");
      expect(css).toContain(".space-shell[data-rail-downscaled=\"true\"] .room-toolbar-collapsed svg {\n  width: var(--toolbar-icon-size, 14px) !important;");

      // Upper and lower rails must share the same rail width
      expect(css).toContain(".space-shell[data-rail-downscaled=\"true\"] .health-indicator-rail");
      expect(css).toContain("width: var(--rail-width, 36px) !important;");

      // Expander must remain hidden by default on desktop outside media queries
      expect(css).toContain(".space-shell .health-rail-expander { display: none; }");
      expect(css).not.toContain(".space-shell .health-indicator-rail:not(.is-expanded) .health-rail-expander");

      // Health indicator rail flex column and gap layout
      expect(css).toContain("display: flex;\n  flex-direction: column;\n  top: max(8px, env(safe-area-inset-top));");

      // Fullscreen and minimized bar horizontal alignment
      expect(css).toContain(".space-shell:has(#minimized-pane-bar):not([data-browser-fullscreen=\"true\"]) .health-indicator-rail");
      expect(css).toContain("top: max(0px, env(safe-area-inset-top)) !important;\n  padding-top: 0 !important;");
    });
  });
});
