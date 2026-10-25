import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { compressCode, initCodeAware, type DocstringMode } from "../src/compression/code-aware/index.js";

interface Fixture {
  config: { docstring_mode: DocstringMode; max_body_lines: number; min_tokens_for_compression: number; semantic_analysis: boolean; target_compression_rate: number;
    language_hint: string | null };
  input: string;
  output: { compressed: string; original_tokens: number; compressed_tokens: number; compression_ratio: number; language: string; language_confidence: number;
    preserved_imports: number; preserved_signatures: number; compressed_bodies: number; syntax_valid: boolean; cache_key: string | null; symbol_scores: Record<string, number> };
}

const directory = join(import.meta.dirname, "fixtures", "headroom-parity", "code_aware_compressor");
const fixtures = readdirSync(directory).filter((name) => name.endsWith(".json"))
  .map((name) => ({ name, ...(JSON.parse(readFileSync(join(directory, name), "utf8")) as Fixture) }));

beforeAll(async () => {
  await initCodeAware(join(import.meta.dirname, "..", "grammars"));
});

describe("CodeAwareCompressor parity with Headroom 0.37 fixtures", () => {
  it("has the thirty recorded fixtures", () => {
    expect(fixtures).toHaveLength(30);
  });

  for (const fixture of fixtures) {
    it(`${fixture.name} (${fixture.output.language})`, () => {
      const result = compressCode(fixture.input, { config: { docstringMode: fixture.config.docstring_mode, maxBodyLines: fixture.config.max_body_lines,
        minTokensForCompression: fixture.config.min_tokens_for_compression, semanticAnalysis: fixture.config.semantic_analysis,
        targetCompressionRate: fixture.config.target_compression_rate, languageHint: fixture.config.language_hint } });
      expect(result.compressed).toBe(fixture.output.compressed);
      expect(result.language).toBe(fixture.output.language);
      expect(result.languageConfidence).toBeCloseTo(fixture.output.language_confidence, 12);
      expect(result.originalTokens).toBe(fixture.output.original_tokens);
      expect(result.compressedTokens).toBe(fixture.output.compressed_tokens);
      expect(result.compressionRatio).toBeCloseTo(fixture.output.compression_ratio, 12);
      expect(result.preservedImports).toBe(fixture.output.preserved_imports);
      expect(result.preservedSignatures).toBe(fixture.output.preserved_signatures);
      expect(result.compressedBodies).toBe(fixture.output.compressed_bodies);
      expect(result.syntaxValid).toBe(fixture.output.syntax_valid);
      expect(result.symbolScores).toEqual(fixture.output.symbol_scores);
    });
  }
});
