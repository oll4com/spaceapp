import { describe, expect, it } from "vitest";
import { parseRoomAgentMention, parseSpaceControlQuick } from "../src/space-control-quick.js";

describe("Room Agent @mentions", () => {
  it("sends the text straight to the named panes after their current turn", () => {
    expect(parseRoomAgentMention("@Bob run the API tests")).toEqual({ type: "CONTROL", actions: [{ kind: "pane", operation: "prompt",
      target: { paneNames: ["Bob"], state: "OPEN" }, text: "run the API tests", when: "AFTER_TURN" }] });
    expect(parseRoomAgentMention("@Bob, @Dana: review each other's diff")).toMatchObject({ actions: [{ target: { paneNames: ["Bob", "Dana"] }, text: "review each other's diff" }] });
    expect(parseRoomAgentMention("@Μπομπ τρέξε τα tests")).toMatchObject({ actions: [{ target: { paneNames: ["Μπομπ"] }, text: "τρέξε τα tests" }] });
    expect(parseRoomAgentMention("@Bob @Bob\nline one\nline two")).toMatchObject({ actions: [{ target: { paneNames: ["Bob"] }, text: "line one\nline two" }] });
  });

  it("leaves everything else to the Room Agent", () => {
    for (const text of ["Bob run the tests", "@Bob", "email me at a@b.c", "what does @Bob do?", "@ Bob run"]) {
      expect(parseRoomAgentMention(text), text).toBeNull();
    }
    expect(parseSpaceControlQuick("@Bob run the tests")).toBeNull();
  });
});
