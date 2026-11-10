import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Since 2026-10-29 (2258cf2226) the browser's own control icon is the handoff affordance: no strip or overlay sits on
// the live browser, so its tabs and address bar stay visible.
const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/features/copilot-kit/copilot-pane.css"), "utf8");

describe("copilot handoff", () => {
  // Operator request 2026-10-15: a waiting copilot never freezes the browser. The browser's control icon pulses;
  // nothing in the handoff styles covers or blurs the page.
  it("never covers the browser while the agent waits, and pulses the control icon", () => {
    expect(css).not.toMatch(/\.jc-handoff(-strip)? \{/);
    expect(css).not.toMatch(/\.jc-handoff[\w-]*[^{]*\{[^}]*(inset:\s*0|backdrop-filter)/);
    expect(css).toMatch(/\.jc-pane\[data-handoff="requested"\] \.browser-control-toggle \{[^}]*animation: jc-pulse/);
    expect(css).toMatch(/\.jc-browser, \.jc-main \{[^}]*flex-direction: column;/);
  });
});
