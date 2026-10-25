import { describe, expect, it } from "vitest";
import { compressBlock } from "../src/compression/engine.js";
import { decodeEntities, extractHtml } from "../src/compression/html-extractor.js";

const tokens = { count: (text: string) => Math.ceil(text.length / 4) };
const chrome = Array.from({ length: 30 }, (_, index) => `<li><a href="/section-${index}">Section ${index}</a></li>`).join("");
const page = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Release notes &amp; upgrade guide</title>
  <meta charset="utf-8"><link rel="stylesheet" href="/site.css">
  <style>body { font-family: sans-serif; } .nav { display: flex; }</style>
  <script>window.analytics = { id: "UA-0000", track: function () { return 1; } };</script>
</head>
<body>
  <nav class="nav"><ul>${chrome}</ul></nav>
  <!-- tracking pixel -->
  <main>
    <h1>Release 4.2</h1>
    <p>The release fixes the <strong>login timeout</strong> and adds export to CSV.</p>
    <h2>Upgrade steps</h2>
    <ol><li>Back up the database.</li><li>Run <code>npm run migrate</code>.</li><li>Restart the API.</li></ol>
    <p>Details are in the <a href="https://example.com/docs/upgrade">upgrade guide</a>.</p>
  </main>
  <aside>Related posts ${chrome}</aside>
  <footer>Copyright 2026 Example Inc. All rights reserved. ${chrome}</footer>
  <script src="/bundle.js"></script>
</body>
</html>`;

describe("HTML main-content extraction (Headroom html_extractor)", () => {
  it("keeps the title, headings, lists, paragraphs and link targets, and drops scripts, styles and page chrome", () => {
    const text = extractHtml(page)!;
    expect(text.startsWith("Title: Release notes & upgrade guide")).toBe(true);
    expect(text).toContain("# Release 4.2");
    expect(text).toContain("The release fixes the login timeout and adds export to CSV.");
    expect(text).toContain("## Upgrade steps");
    expect(text).toContain("- Run npm run migrate.");
    expect(text).toContain("upgrade guide (https://example.com/docs/upgrade)");
    for (const gone of ["window.analytics", "font-family", "Section 7", "Copyright", "tracking pixel", "<"]) expect(text).not.toContain(gone);
    expect(text.length).toBeLessThan(page.length / 4);
  });

  it("uses the body without its chrome when the page marks no main content, and passes empty pages through", () => {
    const body = `<html><body><nav>${chrome}</nav><div><p>${"Plain body text that matters. ".repeat(4)}</p></div><footer>footer</footer></body></html>`;
    expect(extractHtml(body)).toBe("Plain body text that matters. ".repeat(4).trim());
    expect(extractHtml(`<html><body><script>${"x".repeat(500)}</script></body></html>`)).toBeNull();
    expect(decodeEntities("&lt;a&gt; &#x41;&#66; &nbsp;&bogus;")).toBe("<a> AB  &bogus;");
  });

  it("runs in the code and prose path only when lossy transforms are allowed", () => {
    const lossy = compressBlock(page, {}, tokens, undefined, { codeText: "ON", lossy: true });
    expect(lossy.action).toMatchObject({ kind: "compressed", strategy: "html_extractor" });
    expect(lossy.replacement).toContain("# Release 4.2");
    const read = compressBlock(page, {}, tokens, undefined, { codeText: "ON", lossy: false });
    expect(read.replacement).toBeNull();
    const off = compressBlock(page, {}, tokens, undefined, { codeText: "OFF" });
    expect(off.replacement).toBeNull();
  });
});
