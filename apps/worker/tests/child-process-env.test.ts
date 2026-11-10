import { expect, it } from "vitest";
import { scanChildProcessEnv } from "./support/child-process-env-scan.mjs";

// INT5-C-F5: a spread-only guard missed children with no env at all.
// The privileged run-with-space-env -> maintenance runner is intentionally excluded.
it("keeps worker and audited utility children off the inherited process environment", () => {
  const { offenders, excepted, expectedExceptions } = scanChildProcessEnv();
  expect(offenders).toEqual([]);
  expect(excepted).toEqual(expectedExceptions);
});
