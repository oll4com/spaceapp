import assert from "node:assert/strict";
import test from "node:test";
import { buildTrivySummary } from "../trivy-report-summary.mjs";

test("Trivy summary separates fixable and unfixable findings by severity", () => {
  const summary = buildTrivySummary({
    Results: [{
      Vulnerabilities: [
        { VulnerabilityID: "CVE-FIX", Severity: "HIGH", FixedVersion: "2.0.0" },
        { VulnerabilityID: "CVE-OPEN", Severity: "MEDIUM", FixedVersion: "" },
        { VulnerabilityID: "CVE-LOW", Severity: "LOW" }
      ]
    }]
  }, "spaceapp-core");

  assert.match(summary, /^### Trivy full report: spaceapp-core$/m);
  assert.match(summary, /\| HIGH \| 1 \| 0 \|/);
  assert.match(summary, /\| MEDIUM \| 0 \| 1 \|/);
  assert.match(summary, /\| LOW \| 0 \| 1 \|/);
  assert.match(summary, /\*\*Total:\*\* 3 \(1 fixable, 2 unfixable\)/);
});
