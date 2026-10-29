/* @vitest-environment node */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Operator request 2026-10-21: every native dropdown in SpaceApp, also future ones, opens with the theme's colors (it showed
// light text on a white list). The base stylesheet styles every select; a component may theme its options too, but never
// only one of the two colors, which is what turned a list unreadable.
const src = fileURLToPath(new URL("../src/", import.meta.url));
const cssFiles = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? cssFiles(path) : path.endsWith(".css") ? [path] : [];
});

describe("native select styling", () => {
  it("is set once for every select in the base stylesheet", () => {
    const base = readFileSync(join(src, "styles.css"), "utf8");
    expect(base).toMatch(/select \{ color-scheme: dark; \}/);
    expect(base).toMatch(/select option,\s*select optgroup \{\s*background-color: var\(--modern-surface-raised, #1b1d1e\);\s*color: var\(--modern-text, #f4efe5\);/);
    expect(base).toMatch(/\[data-color-mode="light"\] select \{ color-scheme: light; \}/);
  });

  it("never sets only the text or only the background of options in a component", () => {
    const halfStyled = cssFiles(src).flatMap((file) => [...readFileSync(file, "utf8").matchAll(/([^{}]*\boption\b[^{}]*)\{([^}]*)\}/g)]
      .filter(([, selector, body]) => /(^|[\s,>])option(\s|,|:|$)/.test(selector!.trim()) && /(^|;)\s*color\s*:/.test(body!) !== /background(-color)?\s*:/.test(body!))
      .map(([, selector]) => `${file.slice(src.length)}: ${selector!.trim()}`));
    expect(halfStyled).toEqual([]);
  });
});
