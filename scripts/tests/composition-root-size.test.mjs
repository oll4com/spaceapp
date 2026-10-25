import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The composition roots may only shrink (review 2026-10-14): new code goes into a domain module
// (docs/quality/domain-boundaries.md). After an extraction, lower the budget in
// docs/quality/composition-root-budget.json to the new size.
const root = new URL("../../", import.meta.url);
const budget = JSON.parse(readFileSync(new URL("docs/quality/composition-root-budget.json", root), "utf8"));

test("composition roots do not grow past their recorded size", () => {
  for (const [path, maxLines] of Object.entries(budget)) {
    const lines = readFileSync(new URL(path, root), "utf8").split("\n").length;
    assert.ok(lines <= maxLines, `${path} has ${lines} lines; its budget is ${maxLines}. Move the new code into a domain module.`);
  }
});
