import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";

// ARCH-002: "an agent action request's toolId must be the tool of its action type" is one business rule that every
// space-agent action request schema shares. This pins what each answers for a mismatched and a matching tool id
// (message and path), so moving the rule out of the schema file changes nothing.
type Parse = { safeParse(input: unknown): { success: boolean; error?: { issues: Array<{ message: string; path: unknown[] }> } } };
const pane = "pane:target01";
const cases = [
  { name: "spaceAgentBrowserActionRequestSchema", schema: contracts.spaceAgentBrowserActionRequestSchema, extra: { targetPaneId: pane }, action: { type: "screenshot" }, ok: "browser:screenshot", wrong: "browser:navigate", message: "toolId browser:navigate does not match browser action type screenshot." },
  { name: "spaceAgentBrowserActionRequestSchema (live view only)", schema: contracts.spaceAgentBrowserActionRequestSchema, extra: { targetPaneId: pane }, action: { type: "select_state" }, ok: null, wrong: "browser:screenshot", message: "Browser action type select_state belongs to the operator's live view." },
  { name: "spaceAgentClipboardActionRequestSchema", schema: contracts.spaceAgentClipboardActionRequestSchema, extra: {}, action: { type: "get", clipboardItemId: "clip:item0001" }, ok: "clipboard:get", wrong: "clipboard:list", message: "toolId clipboard:list does not match clipboard action type get." },
  { name: "spaceAgentTaskActionRequestSchema", schema: contracts.spaceAgentTaskActionRequestSchema, extra: {}, action: { type: "list" }, ok: "tasks:list", wrong: "tasks:get", message: "toolId tasks:get does not match task action type list." },
  { name: "spaceAgentMemoryActionRequestSchema", schema: contracts.spaceAgentMemoryActionRequestSchema, extra: {}, action: { type: "search", q: "deploy" }, ok: "memory:search", wrong: "memory:save", message: "toolId memory:save does not match memory action type search." },
  { name: "spaceAgentSkillActionRequestSchema", schema: contracts.spaceAgentSkillActionRequestSchema, extra: {}, action: { type: "read", skillId: "space-progress" }, ok: "skills:read", wrong: "skills:list", message: "toolId skills:list does not match skill action type read." },
  { name: "spaceAgentChatActionRequestSchema", schema: contracts.spaceAgentChatActionRequestSchema, extra: {}, action: { type: "read" }, ok: "chat:read", wrong: "chat:send", message: "toolId chat:send does not match shared chat action type read." }
] as const;

describe("agent action requests whose toolId must match the action type", () => {
  for (const item of cases) {
    it(`${item.name}: a mismatched toolId is refused at toolId, the matching one passes`, () => {
      const schema = item.schema as Parse;
      const mismatched = schema.safeParse({ ...item.extra, toolId: item.wrong, action: item.action });
      expect(mismatched.success).toBe(false);
      expect(mismatched.error?.issues.map((issue) => [issue.message, issue.path])).toEqual([[item.message, ["toolId"]]]);
      if (item.ok) expect(schema.safeParse({ ...item.extra, toolId: item.ok, action: item.action }).error?.issues ?? []).toEqual([]);
    });
  }
});
