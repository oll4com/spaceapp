import { describe, expect, it } from "vitest";
import { createTerminalOutputCompatibilityParser } from "../src/features/terminal-pane/terminal-output-coordinator.js";

describe("terminal output compatibility parser", () => {
  it("renders OpenCode OSC 66 explicit-width Greek glyphs as plain Unicode", () => {
    const parser = createTerminalOutputCompatibilityParser();
    const styled = "\u001b[38;2;238;238;238m\u001b[48;2;30;30;30m";

    expect(parser.push(`${styled}\u001b]66;w=1;λ\u001b\\${styled}\u001b]66;w=1;ω\u001b\\`)).toBe(
      `${styled}λ${styled}ω`
    );
    expect(parser.flush()).toBe("");
  });

  it("handles fragmented prefixes, payloads, and string terminators", () => {
    const parser = createTerminalOutputCompatibilityParser();

    expect(parser.push("draft\u001b]6")).toBe("draft");
    expect(parser.push("6;w=1;ελ")).toBe("");
    expect(parser.push("λ\u001b")).toBe("");
    expect(parser.push("\\ done")).toBe("ελλ done");
    expect(parser.flush()).toBe("");
  });

  it("supports BEL termination and preserves unrelated or unsafe OSC output", () => {
    const parser = createTerminalOutputCompatibilityParser();
    const unrelated = "\u001b]0;title\u0007";
    const unsafe = "\u001b]66;w=1;safe\u001b[31m\u001b\\";

    expect(parser.push(`\u001b]66;s=2;界\u0007${unrelated}${unsafe}`)).toBe(`界${unrelated}${unsafe}`);
  });

  it("fails open when an incomplete sequence exceeds the pending limit", () => {
    const parser = createTerminalOutputCompatibilityParser({ maxPendingChars: 256 });
    const incomplete = `\u001b]66;w=1;${"x".repeat(300)}`;

    expect(parser.push(incomplete)).toBe(incomplete);
    expect(parser.flush()).toBe("");
  });
});
