import { describe, expect, it } from "vitest";
import { codexTurnTrace } from "../src/providers/codex/turn-trace.js";

const body = (value: unknown) => ({ client_metadata: { "x-codex-turn-metadata": value } });
describe("native Codex turn trace", () => {
  it("reads only bounded valid IDs from the native nested metadata", () => {
    expect(codexTurnTrace(body(JSON.stringify({ space_request_id: "x".repeat(120), turn_id: "native-turn:1", unrelated: "ignored" }))))
      .toEqual({ requestId: "x".repeat(120), nativeTurnId: "native-turn:1" });
  });
  it.each([
    null, [], {}, { client_metadata: [] }, body(null), body({ space_request_id: "req:one", turn_id: "turn:one" }),
    body("["), body("[]"), body("null"), body(" ".repeat(8193)),
    ...["", "x".repeat(121), "has space", "\n", 12, undefined].map(space_request_id => body(JSON.stringify({ space_request_id, turn_id: "turn:one" }))),
    ...["", "x".repeat(121), "has space", "\n", 12, undefined].map(turn_id => body(JSON.stringify({ space_request_id: "req:one", turn_id })))
  ])("ignores malformed metadata without exposing it (%#)", value => {
    expect(codexTurnTrace(value)).toBeNull();
  });
});
