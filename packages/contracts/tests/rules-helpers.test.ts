import { describe, expect, it } from "vitest";
import { z } from "zod";
import { noRepeatedValues } from "../src/array-rules.js";
import { planOnlyFields } from "../src/clipboard-rules.js";
import { finishedChangeHasProof, revisionHasNote } from "../src/copilot-rules.js";
import { deletionCountsAddUp } from "../src/deletion-rules.js";
import { fieldOnlyWhen } from "../src/field-rules.js";
import { httpLinksOpenInNewTab, webUrlWithoutCredentials } from "../src/link-rules.js";
import { maximizedAndMinimized } from "../src/pane-rules.js";
import { orderedRange } from "../src/range-rules.js";
import { boundedJsonRecord, jsonFitsWithin, keyCountWithin } from "../src/record-rules.js";
import { operatorRunNeedsActor } from "../src/run-rules.js";
import { noopExactlyWhenEmpty } from "../src/status-rules.js";
import { nonBlankText } from "../src/text-rules.js";
import { toolIdMatchesAction } from "../src/tool-id-rules.js";
import { atLeastOneOf } from "../src/update-rules.js";

// ARCH-002 business rules shared by many schemas; each was only covered through the schemas that use it. Pins each helper's own edge cases.
const issues = (schema: z.ZodType, value: unknown) => {
  const result = schema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join(".")}:${issue.message}`);
};
const any = z.record(z.string(), z.unknown());

describe("Shared contract rules helpers", () => {
  it("noRepeatedValues refuses a repeat and carries its message only when given", () => {
    expect(noRepeatedValues()).toHaveLength(1);
    const [check, message] = noRepeatedValues("No repeats.");
    expect([check([1, 2, 3]), check([1, 2, 1]), check([]), message]).toEqual([true, false, true, "No repeats."]);
  });

  it("finishedChangeHasProof and revisionHasNote", () => {
    const [proof] = finishedChangeHasProof();
    expect(proof({ status: "VERIFIED", verification: "ok" })).toBe(true);
    expect(proof({ status: "FAILED" })).toBe(false);
    expect(proof({ status: "SUPERSEDED", verification: "v" })).toBe(true);
    expect(proof({ status: "SUPERSEDED" })).toBe(false);
    const [note] = revisionHasNote();
    expect([note({ decision: "revise" }), note({ decision: "revise", note: "shorter" }), note({ decision: "approve" })]).toEqual([false, true, true]);
  });

  it("deletionCountsAddUp names each count that does not add up", () => {
    const schema = any.superRefine(deletionCountsAddUp({ matched: "m", failed: "f", ok: "o" }) as never);
    expect(issues(schema, { ok: true, matchedCount: 2, deletedCount: 2, failedCount: 0, failedArtifactIds: [] })).toEqual([]);
    expect(issues(schema, { ok: true, matchedCount: 3, deletedCount: 1, failedCount: 1, failedArtifactIds: [] })).toEqual([":m", ":f", ":o"]);
  });

  it("fieldOnlyWhen requires the field when the condition holds and refuses it otherwise", () => {
    const schema = any.superRefine((value, ctx) => fieldOnlyWhen(ctx, { when: value.on === true, present: value.x != null, path: "x", required: "need", forbidden: "no" }));
    expect(issues(schema, { on: true, x: 1 })).toEqual([]);
    expect(issues(schema, { on: false })).toEqual([]);
    expect(issues(schema, { on: true })).toEqual(["x:need"]);
    expect(issues(schema, { on: false, x: 1 })).toEqual(["x:no"]);
  });

  it("httpLinksOpenInNewTab and webUrlWithoutCredentials", () => {
    const schema = any.superRefine((value, ctx) => httpLinksOpenInNewTab(value as { url: string; openMode: string }, ctx));
    expect(issues(schema, { url: "http://a.test", openMode: "NEW_TAB" })).toEqual([]);
    expect(issues(schema, { url: "https://a.test", openMode: "PANE" })).toEqual([]);
    expect(issues(schema, { url: "http://a.test", openMode: "PANE" })).toEqual(["openMode:HTTP links can only open in a new tab."]);
    expect(webUrlWithoutCredentials(new URL("https://a.test"))).toBe(true);
    expect(webUrlWithoutCredentials(new URL("http://a.test"))).toBe(false);
    expect(webUrlWithoutCredentials(new URL("http://a.test"), true)).toBe(true);
    expect(webUrlWithoutCredentials(new URL("https://user:pw@a.test"))).toBe(false);
    expect(webUrlWithoutCredentials(new URL("ftp://a.test"), true)).toBe(false);
  });

  it("maximizedAndMinimized only when both are true", () => {
    expect([maximizedAndMinimized({ isMaximized: true, isMinimized: true }), maximizedAndMinimized({ isMaximized: true }), maximizedAndMinimized({})]).toEqual([true, false, false]);
  });

  it("orderedRange compares numbers and ISO dates, lets an unset bound pass and honours strict", () => {
    const [check] = orderedRange("from", "to", "bad");
    const [strict] = orderedRange("from", "to", "bad", true);
    expect([check({ from: 1, to: 1 }), strict({ from: 1, to: 1 }), check({ from: 2, to: 1 }), check({ from: 1 })]).toEqual([true, false, false, true]);
    expect(strict({ from: "2026-11-23T00:00:00Z", to: "2026-11-23T00:00:01Z" })).toBe(true);
    expect(check({ from: "2026-11-24T00:00:00Z", to: "2026-11-23T00:00:00Z" })).toBe(false);
  });

  it("boundedJsonRecord, jsonFitsWithin and keyCountWithin", () => {
    const schema = any.superRefine(boundedJsonRecord("Arguments", "support"));
    expect(issues(schema, { a: 1 })).toEqual([]);
    expect(issues(schema, Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`k${index}`, 1])))).toEqual([":Arguments support at most 50 top-level keys."]);
    expect(issues(schema, { a: "x".repeat(8000) })).toEqual([":Arguments must fit within 8000 JSON characters."]);
    expect(issues(schema, { a: 1n })).toEqual([":Arguments must be JSON serializable."]);
    const [fits] = jsonFitsWithin(7, "big");
    expect([fits({ a: 1 }), fits({ a: 12 })]).toEqual([true, false]);
    const [count] = keyCountWithin(1, 2, "keys");
    expect([count({}), count({ a: 1 }), count({ a: 1, b: 2, c: 3 })]).toEqual([false, true, false]);
  });

  it("operatorRunNeedsActor, noopExactlyWhenEmpty and atLeastOneOf", () => {
    const run = any.superRefine((value, ctx) => operatorRunNeedsActor(value as { triggerKind: string; actorUserId: string | null }, ctx));
    expect(issues(run, { triggerKind: "OPERATOR", actorUserId: null })).toEqual(["actorUserId:Operator runs require an actor."]);
    expect(issues(run, { triggerKind: "SCHEDULE", actorUserId: null })).toEqual([]);
    const noop = z.object({ status: z.string(), count: z.number() }).superRefine(noopExactlyWhenEmpty((response) => response.count > 0, "noop"));
    expect([issues(noop, { status: "NOOP", count: 0 }), issues(noop, { status: "COMPLETED", count: 2 })]).toEqual([[], []]);
    expect([issues(noop, { status: "NOOP", count: 2 }), issues(noop, { status: "COMPLETED", count: 0 })]).toEqual([["status:noop"], ["status:noop"]]);
    const [oneOf] = atLeastOneOf(["a", "b"], "none");
    expect([oneOf({}), oneOf({ c: 1 }), oneOf({ b: null })]).toEqual([false, false, true]);
  });

  it("nonBlankText counts code points and refuses whitespace only", () => {
    const text = nonBlankText("Note", 3);
    expect(issues(text, "😀😀😀")).toEqual([]);
    expect(issues(text, "abcd")).toEqual([":Note may contain at most 3 characters."]);
    expect(issues(text, "  ")).toEqual([":Note must contain a non-whitespace character."]);
    expect(issues(text, "")).toHaveLength(2);
  });

  it("toolIdMatchesAction names the mismatch, or the operator's live view for a type with no tool", () => {
    const schema = z.object({ toolId: z.string(), action: z.object({ type: z.string() }) })
      .superRefine(toolIdMatchesAction<string>("browser", (type) => (type === "click" ? "space_browser_click" : null)));
    expect(issues(schema, { toolId: "space_browser_click", action: { type: "click" } })).toEqual([]);
    expect(issues(schema, { toolId: "x", action: { type: "click" } })).toEqual(["toolId:toolId x does not match browser action type click."]);
    expect(issues(schema, { toolId: "x", action: { type: "view" } })).toEqual(["toolId:Browser action type view belongs to the operator's live view."]);
  });

  it("planOnlyFields keeps plan fields to PLAN items and requires a PLAN's minimum model", () => {
    const schema = (dependsOnAndDueAt: boolean) => any.superRefine((value, ctx) => planOnlyFields(value as { source: string }, ctx, { dependsOnAndDueAt }));
    expect(issues(schema(true), { source: "PLAN", title: "t", minimumModel: "opus", dueAt: "2026-11-24T00:00:00Z" })).toEqual([]);
    expect(issues(schema(true), { source: "PLAN", minimumModel: " " })).toEqual(["minimumModel:Minimum model is required for PLAN items."]);
    expect(issues(schema(true), { source: "NOTE", title: "t", dueAt: "x", minimumReasoning: "high", minimumModel: "opus" }).map((issue) => issue.split(":")[0]))
      .toEqual(["title", "dueAt", "minimumReasoning", "minimumModel"]);
    expect(issues(schema(false), { source: "NOTE", dueAt: "x" })).toEqual([]);
  });
});
