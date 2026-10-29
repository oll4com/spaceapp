import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Live rail orb", () => {
  it("is the rail's round top end, pinned there whatever the rail order or scroll", () => {
    const css = readFileSync(resolve(__dirname, "../src/features/ui-theme/workspace-chrome.css"), "utf8");
    const orb = css.match(/\.space-shell \.room-toolbar-collapsed \.room-live-rail-button \{[^}]*\}/)?.[0] ?? "";

    expect(orb).toMatch(/position:\s*sticky;/);
    expect(orb).toMatch(/top:\s*0;/);
    expect(orb).toMatch(/order:\s*-1 !important;/);
    expect(css).not.toMatch(/\.room-live-rail-button[^{]*\{[^}]*position:\s*fixed;/);
    expect(css).toContain(".space-shell .room-toolbar-collapsed:has(> .room-live-rail-button) {\n  border-top-left-radius: calc(var(--rail-width, 50px) / 2);\n  border-top-right-radius: calc(var(--rail-width, 50px) / 2);");
  });
});
