import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bestLosslessFold, collapseRuns, compactLossless, expandRuns, foldRepeatedBlocks, type LosslessKind } from "../src/compression/lossless/index.js";

/** Outputs of Headroom's own `compact_lossless` / `fold_repeated_blocks` on the same inputs. */
const { fixtures } = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "headroom-parity", "lossless_compaction", "cases.json"), "utf8")) as {
  fixtures: Array<{ name: string; kind: LosslessKind | "fold_repeated_blocks"; input: string; output: string }>;
};

describe("lossless compaction (Headroom parity)", () => {
  it.each(fixtures.map((fixture) => [`${fixture.name} / ${fixture.kind}`, fixture] as const))("%s", (_, fixture) => {
    const output = fixture.kind === "fold_repeated_blocks" ? foldRepeatedBlocks(fixture.input) : compactLossless(fixture.input, fixture.kind);
    expect(output).toBe(fixture.output);
  });

  it("folds at least one case of every kind, so the fixtures exercise each transform", () => {
    const folded = new Set(fixtures.filter((fixture) => fixture.output !== fixture.input).map((fixture) => fixture.kind));
    expect([...folded].sort()).toEqual(["config", "diff", "fold_repeated_blocks", "log", "paths", "search", "text"]);
  });

  it("keeps the fold that shrinks most and folds diffs only when the content looks like one", () => {
    const grep = ["src/a.ts:1:one", "src/a.ts:2:two", "src/a.ts:3:three"].join("\n");
    expect(bestLosslessFold(grep)).toEqual({ text: "src/a.ts\n1:one\n2:two\n3:three", kind: "search" });
    expect(bestLosslessFold("index 1234abc..5678def\nplain text")).toBeNull();
    expect(bestLosslessFold("unique\nlines")).toBeNull();
    expect(expandRuns(collapseRuns("a\na\na\nb\n"))).toBe("a\na\na\nb\n");
  });
});
