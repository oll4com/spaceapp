import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";

// ARCH-002: "a room deletion result adds up: matched = deleted + failed, failed = the failed ids, ok = nothing failed" is
// one business rule that the media and Agent Files deletion results share. This pins what each answers (messages, order,
// path), so moving the rule changes nothing.
type Parse = { safeParse(input: unknown): { success: boolean; error?: { issues: Array<{ message: string; path: unknown[] }> } } };
const cases = [
  { name: "deleteRoomMediaResponseSchema", schema: contracts.deleteRoomMediaResponseSchema as Parse, messages: [
    "Matched media count must equal deleted plus failed counts.",
    "Failed media count must equal the failed artifact ID count.",
    "Room media deletion is successful only when no artifacts failed."
  ] },
  { name: "deleteRoomAgentFilesResponseSchema", schema: contracts.deleteRoomAgentFilesResponseSchema as Parse, messages: [
    "Matched agent files must equal deleted plus failed counts.",
    "Failed agent file count must equal the failed artifact ID count.",
    "Room agent file deletion is successful only when no artifacts failed."
  ] }
];
const result = (input: object) => ({ ok: true, roomId: "room:room0001", matchedCount: 2, deletedCount: 2, failedCount: 0, failedArtifactIds: [], ...input });

describe("room deletion results whose counts must add up", () => {
  for (const item of cases) {
    it(`${item.name}: each broken count is refused with its message, consistent results pass`, () => {
      const issues = (input: object) => item.schema.safeParse(result(input)).error?.issues.map((issue) => [issue.message, issue.path]) ?? [];
      const [matched, failed, ok] = item.messages;
      expect(issues({})).toEqual([]);
      expect(issues({ ok: false, deletedCount: 1, failedCount: 1, failedArtifactIds: ["art:file0001"] })).toEqual([]);
      expect(issues({ matchedCount: 3 })).toEqual([[matched, []]]);
      expect(issues({ ok: false, deletedCount: 1, failedCount: 1 })).toEqual([[failed, []]]);
      expect(issues({ ok: false })).toEqual([[ok, []]]);
      expect(issues({ matchedCount: 5, failedCount: 1 })).toEqual([[matched, []], [failed, []], [ok, []]]);
    });
  }
});
