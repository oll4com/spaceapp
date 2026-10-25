import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectContentType } from "../src/compression/content-detector.js";

const directory = join(import.meta.dirname, "fixtures", "headroom-parity", "content_detector");
const fixtures = readdirSync(directory).filter((name) => name.endsWith(".json")).map((name) => ({
  name, ...(JSON.parse(readFileSync(join(directory, name), "utf8")) as { input: string; output: { content_type: string; confidence: number; metadata: Record<string, unknown> } })
}));

describe("content detector (Headroom 0.37 parity fixtures)", () => {
  it("has the upstream fixtures", () => expect(fixtures.length).toBe(21));
  for (const fixture of fixtures) {
    it(`matches ${fixture.name}`, () => {
      const result = detectContentType(fixture.input);
      expect(result.contentType).toBe(fixture.output.content_type);
      expect(result.confidence).toBeCloseTo(fixture.output.confidence, 12);
      expect(result.metadata).toEqual(fixture.output.metadata);
    });
  }
});
