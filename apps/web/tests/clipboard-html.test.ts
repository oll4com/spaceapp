import { describe, expect, it } from "vitest";
import { extractClipboardImageDataUrls } from "../src/features/terminal-pane/clipboard-html.js";

describe("extractClipboardImageDataUrls", () => {
  it("extracts only src data URLs from bounded img tags", () => {
    expect(
      extractClipboardImageDataUrls([
        '<script src="data:image/png;base64,c2NyaXB0"></script>',
        '<IMG alt="one" SRC="data:image/png;base64,b25l">',
        "<img src='data:image/jpeg;base64,dHdv' onerror='throw new Error()'>",
        "<svg><image href=\"data:image/webp;base64,dGhyZWU\"></image></svg>"
      ].join(""))
    ).toEqual([
      "data:image/png;base64,b25l",
      "data:image/jpeg;base64,dHdv"
    ]);
  });

  it("rejects malformed tags, non-image URLs, and oversized clipboard HTML", () => {
    expect(extractClipboardImageDataUrls('<img src="https://example.test/image.png">')).toEqual([]);
    expect(extractClipboardImageDataUrls('<img srcset="data:image/png;base64,bm8=">')).toEqual([]);
    expect(extractClipboardImageDataUrls(`<img src="data:image/png;base64,${"a".repeat(2_000_000)}">`)).toEqual([]);
    expect(extractClipboardImageDataUrls("x".repeat(2_000_000))).toEqual([]);
  });

  it("caps the number of extracted images", () => {
    const html = Array.from(
      { length: 40 },
      (_, index) => `<img src="data:image/png;base64,aW1hZ2Ut${index}">`
    ).join("");
    expect(extractClipboardImageDataUrls(html)).toHaveLength(20);
  });
});
