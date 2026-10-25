import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("src/features/streaming/streaming.css", "utf8");

describe("streaming overlay CSS", () => {
  it("pins a click-through upward-growing overlay and switches from three to two columns", () => {
    expect(css).toMatch(/\.streaming-overlay \{[^}]*position: fixed;[^}]*bottom:[^}]*max\(1rem,[^}]*width: min\(420px,[^}]*flex-direction: column;[^}]*justify-content: flex-end;[^}]*pointer-events: none;/s);
    expect(css).toMatch(/\.streaming-metric-grid \{[^}]*grid-template-columns: repeat\(3,/s);
    expect(css).toMatch(/@media \(max-width: 700px\)[\s\S]*\.streaming-metric-grid \{[^}]*grid-template-columns: repeat\(2,/s);
    expect(css).toContain(".streaming-overlay-modern .streaming-metric-tile");
    expect(css).not.toContain("!important");
  });
});
