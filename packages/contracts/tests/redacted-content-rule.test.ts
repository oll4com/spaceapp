import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";

// ARCH-002: "transcript content is stored only already redacted" is one business rule that the transcript chunk and the
// host output schemas share. This pins what each content field answers for unredacted and redacted text (message and
// path), so moving the rule changes nothing.
type Parse = { safeParse(input: unknown): { success: boolean; error?: { issues: Array<{ message: string; path: unknown[] }> } } };
const field = (schema: unknown, key: string) => (schema as { shape: Record<string, Parse> }).shape[key]!;
const fields = [
  { name: "paneCliTranscriptChunkSchema.content", schema: field(contracts.paneCliTranscriptChunkSchema, "content") },
  { name: "createPaneCliHostOutputInputSchema.content", schema: field(contracts.createPaneCliHostOutputInputSchema, "content") }
];

describe("transcript content that must be redacted before persistence", () => {
  for (const item of fields) {
    it(`${item.name}: unredacted text is refused with its message, redacted text passes`, () => {
      for (const secret of ["key sk-abcdefgh123", "password=hunter22", "a\0b", "spacecontrol.v1.abc.def"]) {
        expect(item.schema.safeParse(secret).error?.issues.map((issue) => [issue.message, issue.path])).toEqual([["Transcript chunks must be redacted before persistence.", []]]);
      }
      for (const clean of ["", "plain output", "key [REDACTED]", "password:[REDACTED]"]) {
        expect(item.schema.safeParse(clean).error?.issues ?? []).toEqual([]);
      }
    });
  }
});
