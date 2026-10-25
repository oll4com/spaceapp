import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const stylesCss = readFileSync(resolve(testDir, "../src/styles.css"), "utf8");
const modernCss = readFileSync(resolve(testDir, "../src/features/ui-theme/modern-theme.css"), "utf8");
const workingTimeCss = readFileSync(resolve(testDir, "../src/features/pane-working-time/pane-working-time.css"), "utf8");
const workspaceChromeCss = readFileSync(resolve(testDir, "../src/features/ui-theme/workspace-chrome.css"), "utf8");
// The pane header lives in PaneCard, moved verbatim out of App.tsx.
const appTsx = readFileSync(resolve(testDir, "../src/App.tsx"), "utf8") +
  readFileSync(resolve(testDir, "../src/features/pane-card/PaneCard.tsx"), "utf8");

describe("Pane header responsive adaptation & toolbox contract", () => {
  it("never completely hides the pane title block in container queries", () => {
    // The previous rule at max-width: 300px hid .pane-title-block completely.
    // Ensure that rule is removed across styles.css, modern-theme.css, and workspace-chrome.css so pane titles are always visible.
    expect(stylesCss).not.toMatch(/@container\s+pane-card\s*\(\s*max-width:\s*300px\s*\)\s*\{[^}]*pane-title-block[^}]*display:\s*none/s);
    expect(modernCss).not.toMatch(/@container\s+pane-card\s*\(\s*max-width:\s*300px\s*\)\s*\{[^}]*pane-title-block[^}]*display:\s*none/s);
    expect(workspaceChromeCss).not.toMatch(/@container\s+pane-card\s*\(\s*max-width:\s*300px\s*\)\s*\{[^}]*pane-title-block[^}]*display:\s*none/s);
    expect(modernCss).not.toMatch(/pane-title-block[^}]*display:\s*none/s);
    expect(workspaceChromeCss).not.toMatch(/pane-title-block[^}]*display:\s*none/s);
  });

  it("maintains 3-column header grid (badge title fixed) on compact containers", () => {
    expect(modernCss).toMatch(/@container\s+pane-card\s*\(\s*max-width:\s*420px\s*\)\s*\{[^}]*grid-template-areas:\s*"badge title fixed"/s);
    expect(workspaceChromeCss).toMatch(/@container\s+pane-card\s*\(\s*max-width:\s*420px\s*\)\s*\{[^}]*grid-template-areas:\s*"badge title fixed"/s);
  });

  it("adapts the toolbox compactly when container width shrinks", () => {
    // Buttons scale down compactly at 380px
    expect(stylesCss).toContain("@container pane-card (max-width: 380px)");
    expect(modernCss).toContain("@container pane-card (max-width: 380px)");

    // Minimize button collapses into the '...' overflow menu at <= 340px
    expect(stylesCss).toMatch(/@container\s+pane-card\s*\(\s*max-width:\s*340px\s*\)\s*\{[^}]*\.pane-minimize-button\s*\{[^}]*display:\s*none/s);
    expect(modernCss).toMatch(/@container\s+pane-card\s*\(\s*max-width:\s*340px\s*\)\s*\{[^}]*\.pane-minimize-button\s*\{[^}]*display:\s*none/s);

    // Maximize button collapses into '...' at <= 270px
    expect(stylesCss).toMatch(/@container\s+pane-card\s*\(\s*max-width:\s*270px\s*\)\s*\{[^}]*\.pane-maximize-toggle\s*\{[^}]*display:\s*none/s);
    expect(modernCss).toMatch(/@container\s+pane-card\s*\(\s*max-width:\s*270px\s*\)\s*\{[^}]*\.pane-maximize-toggle\s*\{[^}]*display:\s*none/s);
  });

  it("ensures pane working time badge yields space to the pane title name", () => {
    expect(workingTimeCss).toMatch(/\.pane-working-time-badge\s*\{[^}]*flex-shrink:\s*1/s);
    expect(workingTimeCss).toMatch(/\.pane-working-time-badge\s*\{[^}]*min-width:\s*0/s);
    expect(workingTimeCss).toMatch(/\.pane-working-time-digits\s*\{[^}]*text-overflow:\s*ellipsis/s);
    expect(workingTimeCss).toContain("@container pane-card (max-width: 220px)");
    expect(workingTimeCss).toMatch(/@container\s+pane-card\s*\(\s*max-width:\s*220px\s*\)\s*\{[\s\S]*?\.pane-working-time-digits\s*\{[^}]*display:\s*none/);
    expect(stylesCss).toContain("@container pane-card (max-width: 220px)");
    expect(stylesCss).toMatch(/@container\s+pane-card\s*\(\s*max-width:\s*220px\s*\)\s*\{[\s\S]*?\.pane-working-time-digits\s*\{[^}]*display:\s*none/);
  });

  it("ensures pane-title-details and pane-title-text protect name visibility", () => {
    expect(workspaceChromeCss).toMatch(/\.space-shell\s+\.pane-title-details\s*\{[^}]*min-width:\s*2\.2rem/s);
    expect(workspaceChromeCss).toMatch(/\.space-shell\s+\.pane-title-details\s+\.pane-title-text\s*\{[^}]*text-overflow:\s*ellipsis/s);
    expect(modernCss).toMatch(/\.space-shell\[data-ui-theme="modern"\]\s+\.pane-title-text\s*\{[^}]*text-overflow:\s*ellipsis/s);
  });

  it("exposes Maximize and Minimize commands in the overflow menu when collapsed from the fixed strip", () => {
    expect(appTsx).toContain('id: "pane-maximize-command"');
    expect(appTsx).toContain('id: "pane-minimize-command"');
    expect(appTsx).toContain('className="pane-minimize-button"');
    expect(appTsx).toContain('className="pane-close-button"');
  });
});
