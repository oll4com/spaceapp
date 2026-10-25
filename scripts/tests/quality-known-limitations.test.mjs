import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderKnownLimitations } from "../quality-known-limitations.mjs";

const root = new URL("../../", import.meta.url);
const register = JSON.parse(readFileSync(new URL("docs/quality/review-findings.json", root), "utf8"));
const resolutions = new Set(["fixed", "partial", "open", "accepted-tradeoff", "product-decision", "not-a-defect"]);

test("every finding has a resolution and KNOWN_LIMITATIONS.md matches the register", () => {
  for (const finding of register.findings) assert.ok(resolutions.has(finding.resolution), `${finding.id}: resolution ${finding.resolution}`);
  assert.equal(readFileSync(new URL("docs/quality/KNOWN_LIMITATIONS.md", root), "utf8"), renderKnownLimitations(register),
    "run node scripts/quality-known-limitations.mjs");
});
