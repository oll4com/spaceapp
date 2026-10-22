import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Stacked copilot panes (phones) draw the main surface and the rail body in one grid cell; while the main surface
// is shown, the rail body must be hidden or it covers the browser (Job Copilot) or the mailbox (Mail Copilot).
const src = resolve(dirname(fileURLToPath(import.meta.url)), "../src/features");
const css = readFileSync(resolve(src, "copilot-kit/copilot-pane.css"), "utf8");
const hideRule = css.split("\n").find((line) => line.includes(".jc-rail-body { visibility: hidden; pointer-events: none; }"))!;

describe("stacked copilot surfaces", () => {
  it.each([
    ["job-apply-pane/JobCopilotPane.tsx", "data-browser"],
    ["mail-copilot-pane/MailCopilotPane.tsx", "data-mail"]
  ])("%s marks its shown surface with %s and the rail body gives way to it", (file, attribute) => {
    expect(readFileSync(resolve(src, file), "utf8")).toContain(`${attribute}={`);
    expect(hideRule).toContain(`[${attribute}="visible"]`);
    expect(css).toMatch(new RegExp(`\\[${attribute}="hidden"\\][^{]*\\.jc-rail-body \\{ z-index: 1; \\}`));
  });
});

// Copilot panes at phone width (operator report 2026-10-18): nothing may push the bar, a tab or a panel past the pane.
describe("narrow copilot panes", () => {
  it("lets copilot text wrap although pane cards keep strong text on one line", () => {
    expect(css).toContain(".jc-pane strong { overflow: visible; white-space: normal; text-overflow: clip; }");
  });

  it("gives the stacked bar's counters a row of their own", () => {
    expect(css).toMatch(/\.jc-pane\[data-layout="stacked"\] \.jc-counters \{ grid-area: 3 \/ 1 \/ 4 \/ -1;/);
    expect(css).toContain('.jc-pane[data-layout="stacked"] .jc-counters:empty { display: none; }');
  });

  it("measures the pane, not the 44px collapsed rail, when it turns the collapsed rail's tabs into a row", () => {
    expect(css).toContain("container: jc-pane / inline-size;");
    expect(css).toMatch(/@container jc-pane \(max-width: 900px\) \{[^@]*\.jc-rail\[data-collapsed="true"\] \.jc-rail-tabs \{ flex-direction: row; \}/);
  });

  it("puts a narrow Setup's step labels under their discs", () => {
    expect(css).toMatch(/@container jc-steps \(max-width: 520px\) \{[^}]*\.jc-step \{ flex-direction: column;/);
  });

  it("stacks the mailbox when the rail leaves it too narrow for the list and the conversation", () => {
    expect(readFileSync(resolve(src, "mail-copilot-pane/MailClient.tsx"), "utf8")).toContain('useCopilotLayout(clientRef) === "stacked" || paneStacked');
  });
});
