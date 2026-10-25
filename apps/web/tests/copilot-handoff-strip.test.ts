import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// While the operator holds a copilot's browser, the "You hold the browser" strip sits above the live browser
// (the browser section is a flex column), so the browser's own tabs and address bar stay visible below it.
const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/features/copilot-kit/copilot-pane.css"), "utf8");
const strip = css.match(/\n\.jc-handoff-strip \{([^}]*)\}/)?.[1] ?? "";

describe("copilot handoff strip", () => {
  it("takes its own row above the live browser instead of covering its top", () => {
    expect(strip).toContain("order: -1;");
    expect(strip).toContain("flex: 0 0 auto;");
    expect(strip).not.toMatch(/position:\s*absolute/);
    expect(css).toMatch(/\.jc-browser, \.jc-main \{[^}]*flex-direction: column;/);
  });

  // Operator request 2026-10-15: a waiting copilot never freezes the browser. The request is the same strip, and the
  // browser's control icon pulses; nothing in the handoff styles covers or blurs the page.
  it("never covers the browser while the agent waits, and pulses the control icon", () => {
    expect(css).not.toMatch(/\.jc-handoff \{/);
    expect(css).not.toMatch(/\.jc-handoff[\w-]*[^{]*\{[^}]*(inset:\s*0|backdrop-filter)/);
    expect(css).toMatch(/\.jc-handoff-strip\[data-state="requested"\] \{/);
    expect(css).toMatch(/\.jc-pane\[data-handoff="requested"\] \.browser-control-toggle \{[^}]*animation: jc-pulse/);
  });
});
