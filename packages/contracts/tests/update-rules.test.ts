import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";
import { atLeastOneField } from "../src/update-rules.js";

// ARCH-002: "an update must change at least one field" is one business rule that 23 update schemas and the Mail rule condition share. This pins
// which exported schemas enforce it and with which message, so moving the rule out of the schema file changes nothing.
const pinned: Array<[string, string]> = [
  ["agentPaneSettingsInputSchema", "Agent pane settings update must include at least one field."],
  ["gatewayAccountUpdateRequestSchema", "Nothing to update."],
  ["gatewayApiKeyUpdateRequestSchema", "Nothing to update."],
  ["gatewaySettingsUpdateRequestSchema", "Nothing to update."],
  ["mailRuleConditionSchema", "A rule needs at least one condition."],
  ["updateAdminOperationRunInputSchema", "An admin operation update must change at least one field."],
  ["updateAgentPaneBindingInputSchema", "Agent pane binding update must include at least one field."],
  ["updateArtifactRetentionInputSchema", "Artifact retention update must include at least one field."],
  ["updateBrowserCaptureJobInputSchema", "Browser capture job update must include at least one field."],
  ["updateBrowserCaptureSegmentInputSchema", "Browser capture segment update must include at least one field."],
  ["updateBrowserControlLeaseInputSchema", "Browser control lease update must include at least one field."],
  ["updateCliMaintenanceAuthHandoffInputSchema", "A CLI auth handoff update must change at least one field."],
  ["updateDotProfileSchema", "Provide a profile change."],
  ["updateDotUserSettingsSchema", "Provide a settings change."],
  ["updatePaneBrowserSessionInputSchema", "Browser session update must include at least one field."],
  ["updatePaneBrowserSessionRequestSchema", "Browser session update must include at least one field."],
  ["updatePaneCliSessionInputSchema", "CLI session update must include at least one field."],
  ["updateProviderSettingsInputSchema", "Provider settings update must include at least one field."],
  ["updateRoomAgentActionInputSchema", "Room agent action update must include at least one field."],
  ["updateRoomAgentMissionInputSchema", "Room agent mission update must include at least one field."],
  ["updateSpaceAgentMessageInputSchema", "Space agent message update must include at least one field."],
  ["updateSpaceAgentRunInputSchema", "Space agent run update must include at least one field."],
  ["updateSpaceAgentSessionInputSchema", "Space agent session update must include at least one field."],
  ["updateUserLinkRequestSchema", "Link update must include at least one field."]
];

function enforcing(): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(contracts)) {
    const schema = value as { safeParse?: (input: unknown) => { success: boolean; error?: { issues: Array<{ message: string }> } } };
    if (typeof schema?.safeParse !== "function") continue;
    let result;
    try { result = schema.safeParse({}); } catch { continue; }
    const message = result.error?.issues.find((issue) => /at least one field|Nothing to update\.|Provide a (settings|profile) change\.|A rule needs at least one condition\./.test(issue.message))?.message;
    if (!result.success && message) found.push([name, message]);
  }
  return found.sort(([a], [b]) => a.localeCompare(b));
}

describe("update schemas that need at least one field", () => {
  // Parses every exported schema: 1.5 s alone, past the 5 s default inside the parallel contracts suite.
  it("keeps the schemas and messages that enforce the rule", () => {
    expect(enforcing()).toEqual(pinned);
  }, 20_000);

  it("atLeastOneField accepts any object with a key and rejects an empty one", () => {
    const [check, message] = atLeastOneField("Thing update must include at least one field.");
    expect(message).toBe("Thing update must include at least one field.");
    expect(check({})).toBe(false);
    expect(check({ a: undefined })).toBe(true);
    expect(check({ a: 1 })).toBe(true);
  });
});
