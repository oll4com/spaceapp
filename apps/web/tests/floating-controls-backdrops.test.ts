import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const css = readFileSync(resolve(src, "styles.css"), "utf8");
const rule = css.match(/\.space-shell:has\(\.side-surface-drawer\)[^{]+\{\s*display: none;/)![0];
const selector = rule.slice(0, rule.indexOf("{"));
function backdropClasses(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return backdropClasses(path);
    if (!/\.[jt]sx?$/.test(entry.name)) return [];
    return [...readFileSync(path, "utf8").matchAll(/\b([a-z][a-z0-9-]*-backdrop)\b/g)].map(match => match[1]!);
  });
}

describe("floating controls overlay visibility", () => {
  it("does not make terminal class changes invalidate a whole-shell substring search", () => {
    expect(selector).not.toContain('[class*=');
  });
  it.each([...new Set(backdropClasses(src))])("continues hiding controls behind %s", backdrop => {
    const shell = document.createElement("div");
    shell.className = "space-shell";
    const controls = document.createElement("div");
    controls.className = "room-toolbar-floating-controls";
    const overlay = document.createElement("div");
    overlay.className = backdrop;
    shell.append(controls, overlay);
    document.body.append(shell);
    try {
      expect(controls.matches(selector)).toBe(true);
      overlay.remove();
      expect(controls.matches(selector)).toBe(false);
    } finally { shell.remove(); }
  });
});
