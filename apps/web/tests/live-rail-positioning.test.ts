import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Live rail button balanced positioning", () => {
  it("defines dynamic balanced positioning for room-live-rail-button between upper indicators and lower toolbar", () => {
    const css = readFileSync(resolve(__dirname, "../src/features/ui-theme/workspace-chrome.css"), "utf8");

    // Must not have the old static top: 50%
    expect(css).not.toMatch(/\.room-live-rail-button\s*\{[^}]*top:\s*50%;/);

    // Must calculate top edge and bottom edge dynamically
    expect(css).toContain("--live-rail-top-edge: calc(max(8px, env(safe-area-inset-top)) + var(--resource-rail-height, 0px));");
    expect(css).toContain("--live-rail-bottom-edge: calc(100dvh - max(8px, env(safe-area-inset-bottom)) - var(--room-toolbar-collapsed-height, 420px));");

    // Must calculate midpoint between top and bottom edges
    expect(css).toContain("--live-rail-midpoint: calc((var(--live-rail-top-edge) + var(--live-rail-bottom-edge)) / 2);");

    // Must clamp to avoid overlapping upper or lower elements
    expect(css).toMatch(/top:\s*clamp\(\s*calc\(var\(--live-rail-top-edge\)\s*\+\s*34px\),\s*var\(--live-rail-midpoint\),\s*calc\(var\(--live-rail-bottom-edge\)\s*-\s*34px\)\s*\);/);

    // Must have indicator rail fallback
    expect(css).toContain(".space-shell:has(.health-indicator-rail) .room-toolbar-collapsed .room-live-rail-button {");
    expect(css).toContain("--live-rail-top-edge: calc(max(8px, env(safe-area-inset-top)) + var(--resource-rail-height, 252px));");
  });
});
