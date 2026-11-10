import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";

// ARCH-002: "a free-form record has at most 50 top-level keys, fits in 8000 JSON characters and is JSON serializable"
// is one business rule that the MCP tool arguments, artifact metadata and review check metadata share. This pins what
// each answers (messages, order and path), so moving the rule out of the schema file changes nothing.
type Parse = { safeParse(input: unknown): { success: boolean; error?: { issues: Array<{ message: string; path: unknown[] }> } } };
const field = (schema: unknown, key: string) => (schema as { shape: Record<string, Parse> }).shape[key]!;
const cases = [
  { name: "mcpToolArgumentsSchema", schema: contracts.mcpToolArgumentsSchema as Parse, noun: "MCP tool arguments", verb: "support" },
  { name: "createArtifactInputSchema.metadata", schema: field(contracts.createArtifactInputSchema, "metadata"), noun: "Artifact metadata", verb: "supports" },
  { name: "createReviewCheckInputSchema.metadata", schema: field(contracts.createReviewCheckInputSchema, "metadata"), noun: "Review metadata", verb: "supports" }
];
const manyKeys = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`k${index}`, 1]));
const issues = (schema: Parse, input: unknown) => schema.safeParse(input).error?.issues.map((issue) => [issue.message, issue.path]) ?? [];

describe("records bounded to 50 keys and 8000 JSON characters", () => {
  for (const item of cases) {
    it(`${item.name}: keys, size and serializability are refused with their messages, a small record passes`, () => {
      const keys = `${item.noun} ${item.verb} at most 50 top-level keys.`;
      const size = `${item.noun} must fit within 8000 JSON characters.`;
      expect(issues(item.schema, manyKeys)).toEqual([[keys, []]]);
      expect(issues(item.schema, { text: "x".repeat(8000) })).toEqual([[size, []]]);
      expect(issues(item.schema, { ...manyKeys, text: "x".repeat(8000) })).toEqual([[keys, []], [size, []]]);
      expect(issues(item.schema, { big: 1n })).toEqual([[`${item.noun} must be JSON serializable.`, []]]);
      expect(issues(item.schema, { text: "x".repeat(7980) })).toEqual([]);
      expect(issues(item.schema, undefined)).toEqual([]);
    });
  }
});
