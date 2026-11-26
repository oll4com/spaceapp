import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("src/styles.css", "utf8");
const pane = readFileSync("src/features/terminal-pane/TerminalPane.tsx", "utf8");
const rule = (selector: string) => css.match(new RegExp(`^${selector.replace(/[.]/g, "\\.")} \\{([^}]*)\\}`, "m"))?.[1] ?? "";

// UI review 22/11: the photos button (top left) and the account menu (top right) covered terminal output.
describe("terminal control strip", () => {
  it("keeps the photos button and account menu out of the output area", () => {
    expect(rule(".terminal-upload-preview-picker")).not.toContain("absolute");
    expect(rule(".terminal-gemini-account-picker")).not.toContain("absolute");
    expect(rule(".terminal-control-strip")).toContain("flex: 0 0 auto");
    expect(rule(".terminal-control-strip:empty")).toContain("display: none");
  });

  it("renders both controls inside the strip, before the terminal viewport", () => {
    const open = pane.indexOf('<div className="terminal-control-strip">');
    const photos = pane.indexOf('className="terminal-upload-preview-picker"');
    const accounts = pane.lastIndexOf("<CodexAccountPicker");
    const viewport = pane.indexOf("terminal-viewport ${");
    expect(open).toBeGreaterThan(-1);
    expect(open).toBeLessThan(photos);
    expect(pane.slice(accounts, viewport)).toMatch(/\/> : null\}\s*<\/div>\s*<div\s+ref=\{transcriptRef\}/);
    expect(pane.slice(open, accounts).match(/<CliAccountPicker/g)).toHaveLength(5);
  });
});
