import { expect, it } from "vitest";
import { dotIdSchema, updateDotProfileSchema, createSpaceAgentSessionInputSchema, agentPaneGoalSchema } from "../src/index.js";
it("preserves optional dot identity on Chat sessions and native Goals without requiring it from old clients", () => {
  const input = { paneId: "pane:test-one", roomId: "room:test-one", title: "Chat", selectedProviderId: null, selectedModelId: null,
    selectedModelConfigId: null, selectedProviderName: null, selectedModelName: null, selectedReasoningKey: null };
  expect(createSpaceAgentSessionInputSchema.safeParse(input).success).toBe(true);
  const dotId = `dot:${"a".repeat(32)}`;
  expect(createSpaceAgentSessionInputSchema.parse({ ...input, dotId }).dotId).toBe(dotId);
  expect(agentPaneGoalSchema.shape.dotId).toBeDefined();
});
it("rejects privilege and ownership fields, invalid identities and unbounded profile data", () => {
  expect(dotIdSchema.safeParse("user:operator").success).toBe(false);
  for (const input of [{}, { ownerUserId: "someone" }, { permissions: { mode: "ADMIN" } }, { name: " " },
    { preferences: { unexpected: "instruction" } }, { workLimits: { maxConcurrentTasks: 1000, dailyBudgetUsd: -1 } }]) {
    expect(updateDotProfileSchema.safeParse(input).success).toBe(false);
  }
});
