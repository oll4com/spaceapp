/* @vitest-environment node */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Operator 5/11 (nous_msg:777c05f4) «δεν θελω να μπαινει αυτο το δευτερο πλαισιο όταν παταω σε οποιαδηποτε search»: a search whose wrapper
// draws the frame on :focus-within shows only that frame; its input draws no ring, border or fill there, and stand-alone inputs keep theirs.
const src = fileURLToPath(new URL("../src/", import.meta.url));
const cssFiles = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? cssFiles(path) : path.endsWith(".css") ? [path] : [];
});
const css = cssFiles(src).map((file) => readFileSync(file, "utf8").replace(/\/\*[^]*?\*\//g, "")).join("\n");
const reset = /:is\(([^)]+)\) input \{([^}]*)\}/.exec(readFileSync(join(src, "styles.css"), "utf8"));
const wrappers = reset![1]!.split(",").map((selector) => selector.trim());

describe("one frame per search", () => {
  it("draws no outline, box-shadow, border or fill on the inner input, focused or not, over every theme", () => {
    expect(reset![2]).toMatch(/outline: none !important;/);
    expect(reset![2]).toMatch(/box-shadow: none !important;/);
    expect(reset![2]).toMatch(/border-color: transparent !important;/);
    expect(reset![2]).toMatch(/background: transparent !important;/);
  });

  it("covers only wrappers that draw their own focus frame, so focus never goes unseen", () => {
    const frameless = wrappers.filter((wrapper) => ![...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].some(([, selector, body]) =>
      selector!.split(",").some((part) => part.trim().endsWith(`${wrapper.split(" ").pop()}:focus-within`) && part.includes(wrapper.split(" ")[0]!))
      && /(border-color|box-shadow|outline)\s*:/.test(body!)));
    expect(frameless).toEqual([]);
  });

  it("lists every search wrapper that draws a focus frame", () => {
    const framed = [...css.matchAll(/([^{}]+)\{[^}]*\}/g)].flatMap(([, selector]) => selector!.split(","))
      .map((part) => /\.([\w-]*search[\w-]*):focus-within\s*$/.exec(part.trim())?.[1]).filter(Boolean);
    const listed = new Set(wrappers.map((wrapper) => wrapper.split(" ").pop()!.slice(1)));
    expect([...new Set(framed)].filter((name) => !listed.has(name!))).toEqual([]);
  });
});
