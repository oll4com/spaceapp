import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";

// ARCH-002: "title, minimum model and reasoning belong to PLAN items, and a PLAN needs a minimum model" is one business
// rule that the clipboard create request and the store's upsert input share (create also keeps dependencies and due
// dates to plans). This pins what each answers (messages, order, paths), so moving the rule changes nothing.
type Parse = { safeParse(input: unknown): { success: boolean; error?: { issues: Array<{ message: string; path: unknown[] }> } } };
const issues = (schema: unknown, input: object) => (schema as Parse).safeParse(input).error?.issues.map((issue) => [issue.message, issue.path]) ?? [];
const cases = [
  { name: "createClipboardItemRequestSchema", schema: contracts.createClipboardItemRequestSchema, base: { text: "note" }, deps: true },
  { name: "upsertClipboardItemInputSchema", schema: contracts.upsertClipboardItemInputSchema, base: { text: "note", ownerUserId: "user:operator" }, deps: false }
];
const title = ["Clipboard item titles are allowed only for PLAN items.", ["title"]];
const deps = (path: string) => ["Dependencies and due dates are allowed only for PLAN items.", [path]];
const modelRequired = ["Minimum model is required for PLAN items.", ["minimumModel"]];
const reasoning = ["Reasoning recommendations are allowed only for PLAN items.", ["minimumReasoning"]];
const modelAllowed = ["Minimum model is allowed only for PLAN items.", ["minimumModel"]];

describe("clipboard fields that belong to PLAN items", () => {
  for (const item of cases) {
    it(`${item.name}: plan fields on a note are refused in order, a PLAN needs its minimum model`, () => {
      const note = { ...item.base, source: "MANUAL_NOTE" };
      const plan = { ...item.base, source: "PLAN" };
      expect(issues(item.schema, note)).toEqual([]);
      expect(issues(item.schema, { ...plan, minimumModel: "opus", title: "T", minimumReasoning: "high", dependsOn: [], dueAt: null })).toEqual([]);
      expect(issues(item.schema, plan)).toEqual([modelRequired]);
      expect(issues(item.schema, { ...note, title: "T" })).toEqual([title]);
      expect(issues(item.schema, { ...note, minimumReasoning: "high" })).toEqual([reasoning]);
      expect(issues(item.schema, { ...note, minimumModel: "opus" })).toEqual([modelAllowed]);
      expect(issues(item.schema, { ...note, dueAt: null })).toEqual([]);
      expect(issues(item.schema, { ...note, dueAt: "2026-10-28T12:00:00.000Z" })).toEqual(item.deps ? [deps("dueAt")] : []);
      expect(issues(item.schema, { ...note, title: "T", dependsOn: [], minimumReasoning: "high", minimumModel: "opus" }))
        .toEqual(item.deps ? [title, deps("dependsOn"), reasoning, modelAllowed] : [title, reasoning, modelAllowed]);
    });
  }
});
