import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";

// ARCH-002: "a range's end is not before its start" (strict: not at it either) is one business rule that eight object
// schemas share. This pins what each answers for a reversed, an equal and an ordered range (message and path), so moving
// the rule out of the schema files changes nothing.
type Parse = { safeParse(input: unknown): { success: boolean; error?: { issues: Array<{ message: string; path: unknown[] }> } } };
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 7, 12, minutes)).toISOString();
const receipt = { id: "receipt:task-1", runId: "run:owner-1", taskId: "task:prepare", featureId: "agent:opencode",
  checkVersion: "agent-task-v1", subjectFingerprint: "a".repeat(64), outcome: "PASSED", evidenceRef: "proof:bounded-1" };
const cases = [
  { name: "videoClipSchema", schema: contracts.videoClipSchema, base: { sourceIndex: 0 }, start: "inSec", end: "outSec", low: 1, high: 5, strict: true, issue: ["A clip ends after it starts.", []] },
  { name: "videoOverlaySchema", schema: contracts.videoOverlaySchema, base: { artifactId: "artifact:abcdef" }, start: "fromSec", end: "toSec", low: 1, high: 5, strict: true, issue: ["An overlay ends after it starts.", []] },
  { name: "mailCampaignScheduleSchema", schema: contracts.mailCampaignScheduleSchema, base: {}, start: "fromHour", end: "toHour", low: 9, high: 18, strict: true, issue: ["fromHour must be before toHour", ["toHour"]] },
  { name: "setupReadinessReceiptSchema", schema: contracts.setupReadinessReceiptSchema, base: receipt, start: "completedAt", end: "expiresAt", low: at(0), high: at(15), strict: true, issue: ["Readiness receipt must expire after its completed check.", []] },
  { name: "jobApplyPaneSettingsSchema", schema: contracts.jobApplyPaneSettingsSchema, base: {}, start: "minDelayMs", end: "maxDelayMs", low: 1_000, high: 2_000, strict: false, issue: ["Minimum delay must not exceed the maximum delay.", []] },
  { name: "nousGoalsSettingsSchema", schema: contracts.nousGoalsSettingsSchema, base: {}, start: "backoffMinutes", end: "backoffMaxMinutes", low: 30, high: 120, strict: false, issue: ["The longest back-off must not be shorter than the first one.", ["backoffMaxMinutes"]] },
  { name: "nousLowSpendSettingsSchema", schema: contracts.nousLowSpendSettingsSchema, base: {}, start: "criticalBudgetRemainingPercent", end: "lowBudgetRemainingPercent", low: 20, high: 40, strict: false, issue: ["The critical budget threshold must not exceed the low budget threshold.", ["criticalBudgetRemainingPercent"]] },
  { name: "vaultGeneratePolicySchema", schema: contracts.vaultGeneratePolicySchema, base: {}, start: "minLength", end: "maxLength", low: 12, high: 20, strict: false, issue: ["minLength is above maxLength.", []] }
] as const;
const issues = (schema: unknown, input: object) => ((schema as Parse).safeParse(input).error?.issues ?? []).map((issue) => [issue.message, issue.path]);

describe("schemas whose range must be ordered", () => {
  for (const item of cases) {
    it(`${item.name}: a reversed range is refused with its message and path, an ordered one passes, an equal one ${item.strict ? "is refused" : "passes"}`, () => {
      const range = (from: unknown, to: unknown) => ({ ...item.base, [item.start]: from, [item.end]: to });
      expect(issues(item.schema, range(item.high, item.low))).toEqual([item.issue]);
      expect(issues(item.schema, range(item.low, item.high))).toEqual([]);
      expect(issues(item.schema, range(item.low, item.low))).toEqual(item.strict ? [item.issue] : []);
    });
  }

  it("a missing bound is that field's issue alone; a bound that fails only its own check still meets the range rule", () => {
    expect(issues(contracts.videoClipSchema, { sourceIndex: 0, outSec: 5 })).toEqual([["Invalid input: expected number, received undefined", ["inSec"]]]);
    expect(issues(contracts.setupReadinessReceiptSchema, { ...receipt, completedAt: "soon", expiresAt: at(15) }).map(([, path]) => path))
      .toEqual([["completedAt"], []]);
    expect(issues(contracts.vaultGeneratePolicySchema, { minLength: 200, maxLength: 20 }).map(([message]) => message).at(-1)).toBe("minLength is above maxLength.");
  });

  it("vaultGeneratePolicySchema: a policy with only one bound, or none, passes", () => {
    expect(issues(contracts.vaultGeneratePolicySchema, { minLength: 20 })).toEqual([]);
    expect(issues(contracts.vaultGeneratePolicySchema, { maxLength: 12 })).toEqual([]);
    expect(issues(contracts.vaultGeneratePolicySchema, {})).toEqual([]);
  });

  it("schemas with defaults keep their ordered defaults", () => {
    expect(issues(contracts.mailCampaignScheduleSchema, {})).toEqual([]);
    expect(issues(contracts.mailCampaignScheduleSchema, { fromHour: 18 })).toEqual([["fromHour must be before toHour", ["toHour"]]]);
    expect(issues(contracts.jobApplyPaneSettingsSchema, {})).toEqual([]);
    expect(issues(contracts.nousGoalsSettingsSchema, { backoffMinutes: 121 })).toEqual([["The longest back-off must not be shorter than the first one.", ["backoffMaxMinutes"]]]);
  });
});
