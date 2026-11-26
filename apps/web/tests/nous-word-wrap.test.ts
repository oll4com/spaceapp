import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = (path: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/features", path), "utf8");
const rule = (sheet: string, selector: string) => sheet.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`))?.[1] ?? "";

// UI review 22/11: the narrow Nous dock read "Claude Sonnet 5.!" and "On: watching e…", and a notification title broke inside a word.
describe("Nous dock and notification texts break between words", () => {
  it("wraps the hero's model and status lines instead of clipping them", () => {
    const hero = rule(css("nous/nous.css"), ".nous-hero-text > *");
    expect(hero).toContain("overflow-wrap: break-word");
    expect(hero).not.toMatch(/nowrap|ellipsis|overflow: hidden/);
  });

  // In a narrow dock a fixed three-column hero left the text 44px: "Nou|s", one word per line.
  it("moves the hero's switch and buttons under the text instead of squeezing it", () => {
    const sheet = css("nous/nous.css");
    expect(rule(sheet, ".nous-hero")).toContain("flex-wrap: wrap");
    expect(rule(sheet, ".nous-hero-text")).toContain("flex: 999 1 7.5rem");
  });

  // UI review 22/11: a docked Nous (about 264 px) showed only icons and named the open view nowhere.
  it("names the open view under the icon tabs while no tab has room for its name", () => {
    expect(css("nous/NousDock.tsx")).toContain('<p className="nous-view-name" aria-hidden="true">{t(VIEW_TITLES[tab])}</p>');
    expect(css("nous/nous.css")).toMatch(/@container \(min-width: 21rem\) \{\s*\.nous-view-name \{ display: none; \}/);
  });

  // A row may never grow past the dock: min-content tracks or break-word titles pushed the mark-read buttons out of view.
  it("keeps notification rows inside the dock", () => {
    const sheet = css("notifications/notifications.css");
    expect(sheet).not.toContain("minmax(min-content");
    expect(rule(sheet, ".notification-item-title")).toContain("overflow-wrap: anywhere");
    expect(rule(sheet, ".notification-toast-copy strong")).toContain("overflow-wrap: anywhere");
  });

  it("puts every settings switch in one column and keeps a dock's icon beside its name", () => {
    const sheet = css("settings/docks-settings.css");
    expect(rule(sheet, ".dock-item-row-container:not(:has(> .dock-order-handle))")).toContain("grid-template-columns: minmax(0, 1fr)");
    const name = rule(sheet, ".docks-toggle-label-wrap > .dock-toggle-icon + span");
    expect(name).toContain("max-width: calc(100% - 1.5rem)");
    // Without it a one-word name wider than the column ("Notifications") ran into the ⓘ.
    expect(name).toContain("min-width: min-content");
  });

  // In a narrow Tasks dock the date ran over the pill's border: the pill grows to hold its longest word.
  it("keeps a task's due date inside its chip", () => {
    const chip = rule(css("../styles.css"), "\n.task-chip");
    expect(chip).toContain("overflow-wrap: break-word");
    expect(chip).toContain("min-width: min-content");
  });
});
