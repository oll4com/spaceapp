import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { crushText } from "../src/compression/text-crusher/index.js";

interface Fixture {
  label: string;
  input: { content: string; context: string; target_ratio: number | null };
  output: { compressed: string; original_tokens: number; compressed_tokens: number; compression_ratio: number; kept_segments: number; total_segments: number };
}

const directory = join(import.meta.dirname, "fixtures", "headroom-parity", "text_crusher");
const fixtures = readdirSync(directory).filter((name) => name.endsWith(".json"))
  .map((name) => ({ name, ...(JSON.parse(readFileSync(join(directory, name), "utf8")) as Fixture) }));

describe("TextCrusher parity with Headroom 0.37 fixtures", () => {
  it("has the six recorded fixtures", () => {
    expect(fixtures).toHaveLength(6);
  });

  for (const fixture of fixtures) {
    it(fixture.name, () => {
      const result = crushText(fixture.input.content, fixture.input.context, fixture.input.target_ratio);
      expect(result.compressed).toBe(fixture.output.compressed);
      expect(result.originalTokens).toBe(fixture.output.original_tokens);
      expect(result.compressedTokens).toBe(fixture.output.compressed_tokens);
      expect(result.compressionRatio).toBeCloseTo(fixture.output.compression_ratio, 12);
      expect(result.keptSegments).toBe(fixture.output.kept_segments);
      expect(result.totalSegments).toBe(fixture.output.total_segments);
    });
  }
});
