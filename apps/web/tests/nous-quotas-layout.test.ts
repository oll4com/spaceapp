import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = (name: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/features/desktop-widgets", name), "utf8");

// The Nous dock adds a "resets" line under each meter; the Week meter once flowed into the label column and covered its line (operator 7/11).
describe("Nous dock quota card layout", () => {
  it("keeps every meter and resets line in the second column", () => {
    const widget = css("ai-quota-widget.css");
    expect(widget).toMatch(/\.aiq-provider-meters > :not\(\.quota-at-reset-label\) \{\s*grid-column: 2;/);
    expect(widget).toMatch(/\.aiq-provider-meters > \.quota-at-reset-label \{\s*grid-column: 1;\s*grid-row: 1 \/ span 4;/);
  });

  it("wraps the At reset line instead of clipping it", () => {
    expect(css("quota-at-reset.css")).toMatch(/\.quota-at-reset-values > span \{\s*min-width: 0;\s*overflow-wrap: anywhere;/);
  });
});
