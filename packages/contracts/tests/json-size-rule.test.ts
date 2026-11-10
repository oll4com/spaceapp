import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";

// ARCH-002: "a value's JSON text is at most N characters" is one business rule that the memory state metadata, a Space
// Control request and a task's acceptance checks share. This pins what each answers (message, path, the exact bound,
// and the acceptance checks' issue order), so moving the rule into one helper changes nothing.
type Issues = Array<{ message: string; path: unknown[] }>;
type Parse = { safeParse(input: unknown): { success: boolean; data?: unknown; error?: { issues: Issues } } };
const field = (schema: unknown, key: string) => (schema as { shape: Record<string, Parse> }).shape[key]!;
const issues = (schema: Parse, input: unknown) => schema.safeParse(input).error?.issues.map((issue) => [issue.message, issue.path]) ?? [];
// The parsed value is what the rule measures (defaults included), so the padding is computed from it.
const sized = (schema: Parse, make: (pad: string) => unknown, max: number, extra: number) => {
  const base = JSON.stringify(schema.safeParse(make("")).data).length;
  return make("x".repeat(max - base + extra));
};

const metadata = "Memory state metadata exceeds its aggregate bound.";
const record = (pad: string) => ({ t: pad });
const control = (pad: string) => ({ roomId: "room:a", requestId: "request:test",
  actions: [{ kind: "resource", operation: "panes.open", input: { t: pad } }] });
const check = (id: string, expected: string) => ({ id, kind: "TEXT_EQUALS", expected });
const acceptance = (pad: string) => ({ version: 1, checks: [check("a", "x".repeat(4000)), check("b", "x".repeat(3000) + pad)] });

describe("values bounded by their JSON length", () => {
  for (const [name, schema] of [
    ["memoryConsolidationRunSchema.metrics", field(contracts.memoryConsolidationRunSchema, "metrics")],
    ["updateMemoryConsolidationRunInputSchema.metrics", field(contracts.updateMemoryConsolidationRunInputSchema, "metrics")],
    ["memoryAiAuditResultSchema.evidence", field(contracts.memoryAiAuditResultSchema, "evidence")]
  ] as const) {
    it(`${name}: 65,536 JSON characters pass, one more is refused`, () => {
      expect(issues(schema, sized(schema, record, 65_536, 0))).toEqual([]);
      expect(issues(schema, sized(schema, record, 65_536, 1))).toEqual([[metadata, []]]);
    });
  }

  it("controlExecuteSchema: 500,000 JSON characters pass, one more is refused", () => {
    const schema = contracts.controlExecuteSchema as Parse;
    expect(issues(schema, sized(schema, control, 500_000, 0))).toEqual([]);
    expect(issues(schema, sized(schema, control, 500_000, 1))).toEqual([["Control request is too large.", []]]);
  });

  it("taskAcceptanceSchema: 8000 JSON characters pass, one more is refused, after the unique-id check", () => {
    const schema = contracts.taskAcceptanceSchema as Parse;
    const size = "Acceptance checks exceed the 8000-character limit.";
    expect(issues(schema, sized(schema, acceptance, 8000, 0))).toEqual([]);
    expect(issues(schema, sized(schema, acceptance, 8000, 1))).toEqual([[size, []]]);
    const repeated = { version: 1, checks: [check("a", "x".repeat(4000)), check("a", "x".repeat(4000))] };
    expect(issues(schema, repeated)).toEqual([["Acceptance check IDs must be unique.", []], [size, []]]);
  });
});
