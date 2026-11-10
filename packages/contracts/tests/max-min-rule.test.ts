import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";

// ARCH-002: "a pane is never maximized and minimized at once" is one business rule that the pane update and the Room
// Agent's room:layout action share. This pins what each answers (message and path), so moving the rule changes nothing.
type Parse = { safeParse(input: unknown): { success: boolean; error?: { issues: Array<{ message: string; path: unknown[] }> } } };
const issues = (schema: unknown, input: object) => (schema as Parse).safeParse(input).error?.issues.map((issue) => [issue.message, issue.path]) ?? [];
const cases = [
  { name: "updatePaneInputSchema", schema: contracts.updatePaneInputSchema, wrap: (flags: object) => flags, refused: [["A pane cannot be maximized and minimized at the same time.", []]] },
  { name: "spaceAgentRoomActionRequestSchema room:layout", schema: contracts.spaceAgentRoomActionRequestSchema,
    wrap: (flags: object) => ({ toolId: "room:layout", action: { type: "layout", paneId: "pane:target01", ...flags } }),
    refused: [["A pane cannot be minimized and maximized together.", ["action"]]] }
];

describe("panes that cannot be maximized and minimized at once", () => {
  for (const item of cases) {
    it(`${item.name}: both flags on are refused, any other pair passes`, () => {
      expect(issues(item.schema, item.wrap({ isMaximized: true, isMinimized: true }))).toEqual(item.refused);
      for (const flags of [{ isMaximized: true, isMinimized: false }, { isMaximized: false, isMinimized: true }, { isMaximized: true }, { isMinimized: true }, {}]) {
        expect(issues(item.schema, item.wrap(flags))).toEqual([]);
      }
    });
  }
});
