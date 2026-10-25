import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { countO200k, countO200kBounded, createTokenCounter, estimateTokens } from "../src/compression/tokenizer.js";

const directory = join(import.meta.dirname, "fixtures", "headroom-parity", "tokenizer");
const fixtures = readdirSync(directory).filter((name) => name.endsWith(".json")).map((name) => ({
  name, ...(JSON.parse(readFileSync(join(directory, name), "utf8")) as { input: string; output: number })
}));

describe("tokenizer (Headroom 0.37 parity fixtures)", () => {
  // Loading the o200k ranks takes about a second, more on a busy host; keep it out of the first fixture's time limit.
  beforeAll(() => { countO200k("warm up"); }, 60_000);
  it("has the upstream fixtures", () => expect(fixtures.length).toBe(40));
  for (const fixture of fixtures) {
    it(`matches ${fixture.name}`, () => expect(countO200k(fixture.input)).toBe(fixture.output));
  }

  it("counts special-token text as ordinary text", () => {
    expect(countO200k("<|endoftext|>")).toBeGreaterThan(1);
  });

  it("estimates large texts from slices within a few percent", () => {
    const rows = Array.from({ length: 4000 }, (_, index) => ({ id: index, status: index % 31 === 0 ? "error" : "ok", path: `/api/items/${index}`, ms: index % 17 }));
    const text = JSON.stringify(rows);
    expect(text.length).toBeGreaterThan(64 * 1024);
    const exact = countO200k(text);
    expect(Math.abs(countO200kBounded(text) - exact) / exact).toBeLessThan(0.05);
  });

  it("estimates Claude tokens like Headroom: 3.5 characters per token, dense scripts at 1.5", () => {
    expect(estimateTokens("", 3.5)).toBe(0);
    expect(estimateTokens("a", 3.5)).toBe(1);
    expect(estimateTokens("abcdefg", 3.5)).toBe(2);
    expect(estimateTokens("日本語のテキスト", 3.5)).toBe(Math.trunc(8 / 1.5 + 0.5));
    expect(createTokenCounter("claude").count("x".repeat(35))).toBe(10);
  });

  it("estimates Gemini tokens with the same counter at 3.8 characters per token", () => {
    const gemini = createTokenCounter("gemini");
    expect(gemini.count("")).toBe(0);
    expect(gemini.count("x".repeat(38))).toBe(10);
    expect(gemini.count("日本語のテキスト")).toBe(Math.trunc(8 / 1.5 + 0.5));
  });
});
