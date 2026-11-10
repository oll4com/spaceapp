import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";

// ARCH-002: two rules each sister copilot pair repeated word for word. A finished change on a host (Security, Monitoring)
// needs its verification, SUPERSEDED its evidence; a review sent back (Marketing, Freelance) needs a note. This pins what
// each schema answers (message and path), so moving the rules changes nothing.
type Parse = { safeParse(input: unknown): { success: boolean; error?: { issues: Array<{ message: string; path: unknown[] }> } } };
const issues = (schema: Parse, input: unknown) => schema.safeParse(input).error?.issues.map((issue) => [issue.message, issue.path]) ?? [];

describe("a finished change carries its proof", () => {
  const refused = [["SUPERSEDED needs evidence; VERIFIED, FAILED and ROLLED_BACK need the verification.", []]];
  for (const [name, schema] of [["securityActionFinishSchema", contracts.securityActionFinishSchema], ["monitoringActionFinishSchema", contracts.monitoringActionFinishSchema]] as const) {
    it(name, () => {
      expect(issues(schema as Parse, { status: "VERIFIED", verification: "nginx -t ok, 200 on /" })).toEqual([]);
      expect(issues(schema as Parse, { status: "FAILED", verification: "restart failed" })).toEqual([]);
      expect(issues(schema as Parse, { status: "VERIFIED" })).toEqual(refused);
      expect(issues(schema as Parse, { status: "ROLLED_BACK" })).toEqual(refused);
      expect(issues(schema as Parse, { status: "SUPERSEDED", evidence: "php 8.4.14 already installed" })).toEqual([]);
      expect(issues(schema as Parse, { status: "SUPERSEDED", verification: "already there" })).toEqual([]);
      expect(issues(schema as Parse, { status: "SUPERSEDED" })).toEqual(refused);
    });
  }
});

describe("a review sent back carries a note", () => {
  const refused = [["Tell the copilot what to change.", []]];
  for (const [name, schema] of [["marketingPostReviewDecisionSchema", contracts.marketingPostReviewDecisionSchema], ["freelanceMessageReviewDecisionSchema", contracts.freelanceMessageReviewDecisionSchema]] as const) {
    it(name, () => {
      expect(issues(schema as Parse, { decision: "revise", note: "Shorter, no emoji." })).toEqual([]);
      expect(issues(schema as Parse, { decision: "revise" })).toEqual(refused);
      expect(issues(schema as Parse, { decision: "revise", note: "   " })).toEqual(refused);
      expect(issues(schema as Parse, { decision: "approve" })).toEqual([]);
      expect(issues(schema as Parse, { decision: "reject" })).toEqual([]);
    });
  }
});

describe("the Job Copilot's day counts take a real IANA zone", () => {
  it("jobApplyStatsQuerySchema", () => {
    const schema = contracts.jobApplyStatsQuerySchema as Parse;
    expect(issues(schema, { tz: "Asia/Bangkok" })).toEqual([]);
    expect(issues(schema, {})).toEqual([]);
    expect((schema as unknown as { parse(input: unknown): { tz: string } }).parse({}).tz).toBe("UTC");
    expect(issues(schema, { tz: "Mars/Base" })).toEqual([["Unknown time zone", ["tz"]]]);
  });
});
