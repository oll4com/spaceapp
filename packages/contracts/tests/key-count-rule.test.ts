import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";

// ARCH-002: "a record holds between min and max keys" is one business rule that mail contact attributes, a marketing
// post's metrics and a Jev decision's questions share. This pins what each answers (message, path and both bounds),
// so moving the rule into one helper changes nothing.
type Parse = { safeParse(input: unknown): { success: boolean; error?: { issues: Array<{ message: string; path: unknown[] }> } } };
const field = (schema: unknown, key: string) => (schema as { shape: Record<string, Parse> }).shape[key]!;
const issues = (schema: Parse, input: unknown) => schema.safeParse(input).error?.issues.map((issue) => [issue.message, issue.path]) ?? [];
const keys = (count: number, value: (index: number) => unknown) =>
  Object.fromEntries(Array.from({ length: count }, (_, index) => [`k${index}`, value(index)]));

const question = () => ({ type: "noul", instructions: "Is it ready?" });
const cases = [
  { name: "mailContactSchema.attributes", schema: field(contracts.mailContactSchema, "attributes"), min: 0, max: 40,
    message: "At most 40 attributes.", value: () => "v" },
  { name: "mailContactInputSchema.attributes", schema: field(contracts.mailContactInputSchema, "attributes"), min: 0, max: 40,
    message: "At most 40 attributes.", value: () => "v" },
  { name: "marketingPostMetricsRecordSchema.metrics", schema: field(contracts.marketingPostMetricsRecordSchema, "metrics"), min: 1,
    max: 12, message: "Report 1 to 12 metrics.", value: (index: number) => index },
  { name: "jevDecideInputSchema.questions", schema: field(contracts.jevDecideInputSchema, "questions"), min: 1, max: 16,
    message: "Provide 1 through 16 questions.", value: question }
];

describe("records bounded by their number of keys", () => {
  for (const item of cases) {
    it(`${item.name}: ${item.min} to ${item.max} keys pass, outside is refused with its message`, () => {
      expect(issues(item.schema, keys(item.max, item.value))).toEqual([]);
      expect(issues(item.schema, keys(Math.max(item.min, 1), item.value))).toEqual([]);
      expect(issues(item.schema, keys(item.max + 1, item.value))).toEqual([[item.message, []]]);
      expect(issues(item.schema, {})).toEqual(item.min > 0 ? [[item.message, []]] : []);
    });
  }

  it("mailContactInputSchema.attributes defaults to no attributes", () => {
    expect(field(contracts.mailContactInputSchema, "attributes").safeParse(undefined)).toEqual({ success: true, data: {} });
  });
});
