/* @vitest-environment node */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Operator report 2026-11-23: the END chip rendered behind the chat composer.
const css = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8");
const zIndex = (selector: string) => Number(css.match(new RegExp(`\\n${selector.replace(/\./g, "\\.")} \\{[^}]*?z-index: (\\d+);`))?.[1]);

describe("END completion chip", () => {
  it("stacks above the chat composer and CLI bottom controls, below pane popovers", () => {
    const chip = zIndex(".pane-completion-chip");
    for (const below of [".codex-composer", ".terminal-floating-controls", ".terminal-voice-controls-stack"]) expect(chip).toBeGreaterThan(zIndex(below));
    expect(chip).toBeLessThan(zIndex(".terminal-control-strip"));
  });
});
