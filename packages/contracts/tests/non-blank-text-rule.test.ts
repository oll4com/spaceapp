import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";

// ARCH-002: "a text is non-blank and holds at most N characters (code points)" is one business rule that the clipboard
// and task text fields and the shared chat content share. This pins what each answers (messages, order, path), so
// moving the rule changes nothing.
type Parse = { safeParse(input: unknown): { success: boolean; error?: { issues: Array<{ message: string; path: unknown[] }> } } };
const field = (schema: unknown, key: string) => (schema as { shape: Record<string, Parse> }).shape[key]!;
const cases = [
  { name: "updateClipboardNoteTextRequestSchema.text", schema: field(contracts.updateClipboardNoteTextRequestSchema, "text"), max: contracts.clipboardTextMaxCharacters, noun: "Clipboard text" },
  { name: "spaceAgentTaskSaveActionSchema.objective", schema: field(contracts.spaceAgentTaskSaveActionSchema, "objective"), max: contracts.taskObjectiveMaxCharacters, noun: "Clipboard text" },
  { name: "spaceAgentChatSendActionSchema.content", schema: field(contracts.spaceAgentChatSendActionSchema, "content"), max: contracts.sharedChatMessageContentMaxCharacters, noun: "Shared chat text" }
];

describe("non-blank texts with a character cap", () => {
  for (const item of cases) {
    it(`${item.name}: blank and over-long texts are refused with their messages, others pass`, () => {
      const issues = (text: string) => item.schema.safeParse(text).error?.issues.map((issue) => [issue.message, issue.path]) ?? [];
      const tooLong = `${item.noun} may contain at most ${item.max} characters.`;
      const blank = `${item.noun} must contain a non-whitespace character.`;
      expect(issues("note")).toEqual([]);
      expect(issues("😀".repeat(item.max))).toEqual([]);
      expect(issues("😀".repeat(item.max + 1))).toEqual([[tooLong, []]]);
      expect(issues("   ")).toEqual([[blank, []]]);
      expect(issues(" ".repeat(item.max + 1))).toEqual([[tooLong, []], [blank, []]]);
      expect(issues("")).toEqual([["Too small: expected string to have >=1 characters", []], [blank, []]]);
    });
  }
});
