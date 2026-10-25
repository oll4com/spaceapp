import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const stylesCss = readFileSync(resolve(testDir, "../src/styles.css"), "utf8");
const modernCss = readFileSync(resolve(testDir, "../src/features/ui-theme/modern-theme.css"), "utf8");
const motionCss = readFileSync(resolve(testDir, "../src/features/ui-theme/motion-theme.css"), "utf8");
// The room title row (rename form included) moved from App.tsx to its own component.
const appTsx = readFileSync(resolve(testDir, "../src/features/room-toolbar/RoomTitleBar.tsx"), "utf8");

describe("Room rename toolbar controls styling and contrast", () => {
  it("includes room-title-form button in base icon button sizing and grid alignment", () => {
    expect(stylesCss).toContain(".room-title-form button");
    expect(stylesCss).toMatch(/\.room-title-form button\s*\{[^}]*width:\s*var\(--toolbar-control-size\);[^}]*height:\s*var\(--toolbar-control-size\);/);
    expect(stylesCss).toMatch(/\.room-title-form button\s*\{[^}]*display:\s*inline-grid;[^}]*place-items:\s*center;/);
  });

  it("defines modern theme styles for room-title-form buttons", () => {
    expect(modernCss).toContain('.space-shell[data-ui-theme="modern"] .room-title-form button');
    expect(modernCss).toMatch(/\.space-shell\[data-ui-theme="modern"\] \.room-title-form button:hover:not\(:disabled\)/);
  });

  it("defines accessible unhovered and high-contrast hover styles for motion theme toolbar buttons", () => {
    expect(motionCss).toContain(':root[data-interface-theme="motion"] .space-shell .board-toolbar .room-title-form button');
    expect(motionCss).toMatch(
      /:root\[data-interface-theme="motion"\] \.space-shell \.board-toolbar :is\([\s\S]*?\.room-title-form button[\s\S]*?\):is\(:hover/
    );
    expect(motionCss).toMatch(
      /:root\[data-interface-theme="motion"\] \.space-shell \.board-toolbar :is\([\s\S]*?\.room-title-form button[\s\S]*?\):is\(:hover[^{]*\{[^}]*color:\s*#ffe600 !important;/
    );
  });

  it("renders Save and Cancel room rename buttons with explicit classes and accessible labels", () => {
    expect(appTsx).toContain('className="room-title-save"');
    expect(appTsx).toContain('title="Save room name"');
    expect(appTsx).toContain('aria-label="Save room name"');
    expect(appTsx).toContain('className="room-title-cancel"');
    expect(appTsx).toContain('title="Cancel room rename"');
    expect(appTsx).toContain('aria-label="Cancel room rename"');
  });

  it("keeps room-title-edit rename icon visible across screen widths, styles it compactly with spacing from room title, and high contrast in motion theme", () => {
    const chromeCss = readFileSync(resolve(testDir, "../src/features/ui-theme/workspace-chrome.css"), "utf8");
    expect(chromeCss).not.toMatch(/@media\s*\(max-width:\s*1100px\)[\s\S]*?\.room-title-edit\s*\{[^}]*display:\s*none/);
    expect(chromeCss).toMatch(/\.space-shell \.board-title-heading\s*\{[^}]*gap:\s*0\.625rem;/);
    expect(stylesCss).toMatch(/\.board-title-heading\s*\{[^}]*gap:\s*0\.625rem;/);
    expect(stylesCss).toMatch(/\.room-title-edit\s*\{[^}]*width:\s*22px;[^}]*height:\s*22px;[^}]*min-width:\s*22px;[^}]*flex:\s*0 0 22px;/);
    expect(stylesCss).toMatch(/\.room-title-edit svg\s*\{[^}]*width:\s*12px;[^}]*height:\s*12px;/);
    expect(motionCss).toMatch(/:root\[data-interface-theme="motion"\] \.space-shell \.board-title-heading\s*\{[^}]*gap:\s*0\.625rem;/);
    expect(motionCss).toMatch(/:root\[data-interface-theme="motion"\] \.space-shell \.room-title-edit\s*\{[^}]*width:\s*22px;[^}]*height:\s*22px;[^}]*flex:\s*0 0 22px;/);
    expect(motionCss).toMatch(/:root\[data-interface-theme="motion"\] \.space-shell \.room-title-edit svg\s*\{[^}]*width:\s*12px;[^}]*height:\s*12px;/);
    expect(motionCss).toMatch(/:root\[data-interface-theme="motion"\] \.space-shell \.room-title-edit\s*\{[^}]*background:\s*rgba\(0,\s*0,\s*0,\s*0\.08\);/);
  });
});
