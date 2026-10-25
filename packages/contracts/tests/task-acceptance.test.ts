import { describe, expect, it } from "vitest";
import { taskAcceptanceSchema, validateTaskResult } from "../src/task-acceptance.js";

const acceptance = (check: unknown) => taskAcceptanceSchema.parse({ version: 1, checks: [{ id: "answer", ...check as object }] });
describe("Declared task result checks", () => {
  it("compares the entire text with explicit normalization and preserves Greek", () => {
    const check = acceptance({ kind: "TEXT_EQUALS", expected: "Εντάξει", normalization: "TRIM" });
    expect(validateTaskResult(check, "\nΕντάξει\n")[0]?.passed).toBe(true);
    expect(validateTaskResult(check, "Εντάξει, αλλά...")[0]?.passed).toBe(false);
    expect(validateTaskResult(acceptance({ kind: "TEXT_EQUALS", expected: "Εντάξει" }), " Εντάξει")[0]?.passed).toBe(false);
  });
  it("never extracts a number from an unsupported claim or non-finite answer", () => {
    const check = acceptance({ kind: "NUMBER_EQUALS", expected: 42 });
    for (const result of ["The answer is 42", "NaN", "Infinity", "1e309", "0x2a", "", "42 and 100"]) {
      expect(validateTaskResult(check, result)[0]?.passed).toBe(false);
    }
    expect(validateTaskResult(check, "4.2e1")[0]?.passed).toBe(true);
    expect(validateTaskResult(acceptance({ kind: "NUMBER_EQUALS", expected: 0.3, tolerance: 0.001 }), "0.30001")[0]?.passed).toBe(true);
  });
  it("checks structured JSON regardless of property order and handles RFC6901 escaping", () => {
    const check = acceptance({ kind: "JSON_EQUALS", pointer: "/a~1b/~0key", expected: { value: [1, true, null], status: "ok" } });
    expect(validateTaskResult(check, '{"a/b":{"~key":{"status":"ok","value":[1,true,null]}}}')[0]?.passed).toBe(true);
    for (const result of ['{"a/b":{"~key":{"status":"ok","value":[1,true]}}}', '```json\n{}\n```', '{}']) {
      expect(validateTaskResult(check, result)[0]?.passed).toBe(false);
    }
  });
  it("never follows prototypes or accepts malformed JSON as null", () => {
    expect(validateTaskResult(acceptance({ kind: "JSON_EQUALS", pointer: "/constructor/name", expected: "Object" }), '{}')[0]?.passed).toBe(false);
    expect(validateTaskResult(acceptance({ kind: "JSON_EQUALS", pointer: "", expected: null }), 'invalid')[0]?.passed).toBe(false);
    expect(validateTaskResult(acceptance({ kind: "JSON_EQUALS", pointer: "", expected: null }), 'null')[0]?.passed).toBe(true);
    expect(validateTaskResult(acceptance({ kind: "JSON_EQUALS", pointer: "/length", expected: 2 }), '[1,2]')[0]?.passed).toBe(false);
  });
  it("rejects duplicate IDs, executable fields, invalid pointers and oversized contracts", () => {
    const check = { id: "same", kind: "TEXT_INCLUDES", expected: "ok" };
    for (const value of [ { version: 1, checks: [check, check] },
      { version: 1, checks: [{ ...check, script: "return true" }] },
      { version: 1, checks: [{ id: "json", kind: "JSON_EQUALS", pointer: "/bad~2", expected: true }] },
      { version: 1, checks: [{ id: "json", kind: "JSON_EQUALS", pointer: "", expected: "x".repeat(8001) }] }]) {
      expect(taskAcceptanceSchema.safeParse(value).success).toBe(false);
    }
  });
  it("bounds nested values and rejects repeated invalid pointer segments without backtracking", () => {
    let expected: unknown = true;
    for (let index = 0; index < 20; index++) expected = { nested: expected };
    expect(taskAcceptanceSchema.safeParse({ version: 1, checks: [{ id: "json", kind: "JSON_EQUALS", pointer: "", expected }] }).success).toBe(false);
    expect(taskAcceptanceSchema.safeParse({ version: 1, checks: [{ id: "json", kind: "JSON_EQUALS", pointer: "/a".repeat(90) + "~2", expected: 1 }] }).success).toBe(false);
  });
});
