/* @vitest-environment node */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Phone 1/11: the room toolbar (z-index 70) painted over Space Gateway's full-screen cover (z-index 20) and hid its Close.
describe("workspace cover", () => {
  it("hides the inert workspace's room toolbar while a cover is open", () => {
    const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.workspace\[inert\] \.board-toolbar \{\s*visibility: hidden;\s*\}/);
  });
});
