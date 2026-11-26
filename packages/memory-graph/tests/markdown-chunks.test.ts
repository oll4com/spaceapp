// The monthly file is parsed a chunk at a time (one 8.6 MB parse ran the maintenance worker out of heap, 2026-11-22):
// the blocks must stay exactly those of one whole parse, positions included, wherever a chunk could end.
import { fromMarkdown } from "mdast-util-from-markdown";
import { expect, it } from "vitest";
import { parseTopLevelMarkdown } from "../src/parser.js";

const record = (n: number, body: string) =>
  `<!-- space-memory:id=space_memory:${String(n).padStart(24, "0")} -->\n## 2026-11-${String(n % 28 + 1).padStart(2, "0")} - Record ${n}\n${body}\n`;

const tricky = [
  "- Plain list item\n  continued line",
  "Paragraph\n```\n## not a heading inside a column-0 fence\n<!-- space-memory:id=space_memory:fenced -->\n```",
  "- item with its own fence\n  ```bash\n  echo hi\n  ```\n- next",
  "~~~~\n# tilde fence\n~~~\n~~~~",
  "  <!-- space-memory:id=space_memory:indented -->",
  "Text with `inline` code and a #hash"
];

it("chunked parsing gives the same top-level blocks as one whole parse", () => {
  const content = "# Space Memory 2026-11\n" + Array.from({ length: 120 }, (_, n) => record(n, tricky[n % tricky.length]!)).join("");
  for (const chunk of [64, 512, 4096]) expect(parseTopLevelMarkdown(content, chunk)).toEqual(fromMarkdown(content).children);
});

it("stops chunking where only a whole parse knows the structure", () => {
  // A list item's fence left by a less indented line, a multi-line html block and a link reference definition.
  for (const odd of ["- item\n  ```\n  code\n<!-- c -->\n## after\n```\n<!-- inside -->\n```", "<div>\n\n## in html? no\n</div>", "[ref]: https://example.com\n## [ref]"]) {
    const content = Array.from({ length: 40 }, (_, n) => record(n, n === 10 ? odd : "- body")).join("");
    expect(parseTopLevelMarkdown(content, 64)).toEqual(fromMarkdown(content).children);
  }
});
