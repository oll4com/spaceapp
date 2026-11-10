import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";

// ARCH-002: "an array must not repeat a value" is one business rule that several schemas share. This pins what each of
// them answers for a repeated and for a distinct list (message and path), so moving the rule out of the schema files
// changes nothing.
const uuid = "123e4567-e89b-42d3-a456-426614174000";
const cases = [
  { name: "activeAgentTurnsInputSchema", schema: contracts.activeAgentTurnsInputSchema, key: "paneIds", dup: ["pane:one00001", "pane:one00001"], ok: ["pane:one00001", "pane:two00002"], extra: { cycle: 0 }, message: "Pane ids must be unique." },
  { name: "reorderRoomsInputSchema", schema: contracts.reorderRoomsInputSchema, key: "roomIds", dup: ["room:one00001", "room:one00001"], ok: ["room:one00001", "room:two00002"], extra: {}, message: "Room ids must be unique." },
  { name: "reorderPanesInputSchema", schema: contracts.reorderPanesInputSchema, key: "paneIds", dup: ["pane:one00001", "pane:one00001"], ok: ["pane:one00001", "pane:two00002"], extra: {}, message: "Pane ids must be unique." },
  { name: "maintenanceApplyRequestSchema", schema: contracts.maintenanceApplyRequestSchema, key: "selectedActionIds", dup: ["cli:codex", "cli:codex"], ok: ["cli:codex", "cli:claude"], extra: { idempotencyKey: uuid, confirmation: "APPLY MAINTENANCE" }, message: "Invalid input" },
  { name: "updateToolRoutingSchema", schema: contracts.updateToolRoutingSchema, key: "enabledRuntimeIds", dup: ["cli:codex", "cli:codex"], ok: ["cli:codex", "cli:claude"], extra: { expectedRevision: 0, overrides: [] }, message: "Duplicate routing runtime." }
] as const;

describe("schemas that reject a repeated list value", () => {
  for (const item of cases) {
    it(`${item.name}: a repeated value is refused with its message at the list, a distinct list passes`, () => {
      const schema = item.schema as { safeParse(input: unknown): { success: boolean; error?: { issues: Array<{ message: string; path: unknown[] }> } } };
      const repeated = schema.safeParse({ ...item.extra, [item.key]: item.dup });
      expect(repeated.success).toBe(false);
      expect(repeated.error?.issues.map((issue) => [issue.message, issue.path])).toEqual([[item.message, [item.key]]]);
      expect(schema.safeParse({ ...item.extra, [item.key]: item.ok }).error?.issues ?? []).toEqual([]);
    });
  }
});

// The same rule on fields of exported object schemas whose list schema is module-private.
describe("list fields behind module-private schemas", () => {
  const field = (schema: unknown, key: string) => (schema as { shape: Record<string, { safeParse(input: unknown): { success: boolean; error?: { issues: Array<{ message: string; path: unknown[] }> } } }> }).shape[key]!;
  const fields = [
    { name: "setupDraftSchema.requestedFeatureIds", schema: field(contracts.setupDraftSchema, "requestedFeatureIds"), dup: ["pane:one", "pane:one"], ok: ["pane:one", "pane:two"], message: "Feature ids must be unique." },
    { name: "setupPlanSchema.requestedFeatureIds", schema: field(contracts.setupPlanSchema, "requestedFeatureIds"), dup: ["dock:one", "dock:one"], ok: ["dock:one", "dock:two"], message: "Feature ids must be unique." },
    { name: "setupPlanSchema.effectiveFeatureIds", schema: field(contracts.setupPlanSchema, "effectiveFeatureIds"), dup: ["widget:one", "widget:one"], ok: ["widget:one", "widget:two"], message: "Feature ids must be unique." },
    { name: "vaultSignupGrantRequestSchema.sites", schema: field(contracts.vaultSignupGrantRequestSchema, "sites"), dup: ["https://example.com", "https://example.com"], ok: ["https://example.com", "https://example.org"], message: "Duplicate site." },
    { name: "vaultSignupGrantClaimsSchema.sites", schema: field(contracts.vaultSignupGrantClaimsSchema, "sites"), dup: ["https://example.com", "https://example.com"], ok: ["https://example.com", "https://example.org"], message: "Duplicate site." }
  ];
  for (const item of fields) {
    it(`${item.name}: a repeated value is refused with its message, a distinct list passes`, () => {
      const repeated = item.schema.safeParse(item.dup);
      expect(repeated.success).toBe(false);
      expect(repeated.error?.issues.map((issue) => [issue.message, issue.path])).toEqual([[item.message, []]]);
      expect(item.schema.safeParse(item.ok).error?.issues ?? []).toEqual([]);
    });
  }
});
