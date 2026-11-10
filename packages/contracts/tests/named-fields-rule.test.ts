import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";

// ARCH-002: "an update must set at least one of these named fields" is one business rule that several update schemas
// share (a field counts when it is not undefined; null counts). This pins what each answers with none of its fields and
// with one (message and path), so moving the rule out of the schema file changes nothing.
type Parse = { safeParse(input: unknown): { success: boolean; error?: { issues: Array<{ message: string; path: unknown[] }> } } };
const cases = [
  { name: "agentPaneSettingsInputSchema", schema: contracts.agentPaneSettingsInputSchema, none: { fullAccessConfirmed: true }, one: { selectedModelConfigId: null }, message: "Agent pane settings update must include at least one field." },
  { name: "updatePaneCliTerminalControlLeaseInputSchema", schema: contracts.updatePaneCliTerminalControlLeaseInputSchema, none: { expectedStatus: "ACTIVE" }, one: { expectedStatus: "ACTIVE", ttlSeconds: 30 }, message: "CLI terminal control lease update must include a status or heartbeat lifetime." },
  { name: "spaceAgentTaskUpdateActionSchema", schema: contracts.spaceAgentTaskUpdateActionSchema, none: { type: "update", taskItemId: "task:item0001" }, one: { type: "update", taskItemId: "task:item0001", status: "DONE" }, message: "Task update must include status or objective." },
  { name: "updateCodexGoalTaskInputSchema", schema: contracts.updateCodexGoalTaskInputSchema, none: {}, one: { objective: "Ship it" }, message: "Codex goal update must include status or objective." },
  { name: "updateTaskItemInputSchema", schema: contracts.updateTaskItemInputSchema, none: {}, one: { schedule: null }, message: "Task update must include title, objective, status, or schedule." }
] as const;

describe("update schemas that need one of their named fields", () => {
  for (const item of cases) {
    it(`${item.name}: none of the fields is refused with its message, one passes`, () => {
      const schema = item.schema as Parse;
      const none = schema.safeParse(item.none);
      expect(none.success).toBe(false);
      expect(none.error?.issues.map((issue) => [issue.message, issue.path])).toEqual([[item.message, []]]);
      expect(schema.safeParse(item.one).error?.issues ?? []).toEqual([]);
    });
  }
});
