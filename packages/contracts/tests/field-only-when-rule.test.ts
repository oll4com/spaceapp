import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";

// ARCH-002: "a field is set exactly when a condition holds" (required when it holds, refused when it does not) is one
// business rule that several schemas check inline. This pins what each answers in all four corners (message and
// path), so moving the rule out of the schema file changes nothing.
type Parse = { safeParse(input: unknown): { success: boolean; error?: { issues: Array<{ message: string; path: unknown[] }> } } };
const hash = "a".repeat(64);
const at = "2026-10-28T12:00:00.000Z";
const changeSet = {
  id: "mcs:change01", kind: "EDIT", status: "PROPOSED", sourcePath: "space_memory.md", recordIds: [], resolvesIssueIds: [],
  expectedSourceHash: hash, resultingSourceHash: null, beforeContentHash: hash, afterContentHash: hash, reason: "fix",
  statusReason: null, actorUserId: "user:operator", traceId: "trace:0000001", rollbackOfChangeSetId: null,
  rolledBackByChangeSetId: null, createdAt: at, updatedAt: at, appliedAt: null, failedAt: null, rolledBackAt: null
};
const createChangeSet = {
  kind: "EDIT", sourcePath: "space_memory.md", recordIds: ["mrec:record01"], expectedSourceHash: hash, beforeContentHash: hash,
  afterContentHash: hash, beforeSnapshot: "a", afterSnapshot: "b", reason: "fix", actorUserId: "user:operator"
};
const target = "mcs:target01";
const token = "t".repeat(24);
const cases = [
  { name: "updateCliRuntimeSettingInputSchema", schema: contracts.updateCliRuntimeSettingInputSchema, base: {}, path: "confirmationToken",
    when: { enabled: false }, otherwise: { enabled: true }, value: token,
    required: "Disabling a CLI runtime requires a confirmation token.", forbidden: "Enabling a CLI runtime does not accept a confirmation token." },
  { name: "memoryChangeSetSummarySchema", schema: contracts.memoryChangeSetSummarySchema, base: changeSet, path: "rollbackOfChangeSetId",
    when: { kind: "ROLLBACK" }, otherwise: { kind: "MERGE" }, value: target, absent: null,
    required: "Rollback change sets require a target.", forbidden: "Only rollback change sets can target another change set." },
  { name: "memoryChangeSetSchema", schema: contracts.memoryChangeSetSchema, base: { ...changeSet, beforeSnapshot: "a", afterSnapshot: "b" }, path: "rollbackOfChangeSetId",
    when: { kind: "ROLLBACK" }, otherwise: { kind: "ARCHIVE" }, value: target, absent: null,
    required: "Rollback change sets require a target.", forbidden: "Only rollback change sets can target another change set." },
  { name: "createMemoryChangeSetInputSchema", schema: contracts.createMemoryChangeSetInputSchema, base: createChangeSet, path: "rollbackOfChangeSetId",
    when: { kind: "ROLLBACK" }, otherwise: { kind: "EDIT" }, value: target, absent: null,
    required: "Rollback change sets require a target.", forbidden: "Only rollback change sets can target another change set." },
  { name: "updateMemoryChangeSetInputSchema", schema: contracts.updateMemoryChangeSetInputSchema, base: {}, path: "resultingSourceHash",
    when: { status: "APPLIED" }, otherwise: { status: "APPROVED" }, value: hash,
    required: "Applied change sets require the resulting source hash.", forbidden: "Only applied change sets can record a resulting source hash." },
  { name: "memoryMutationRecoveryResultSchema", schema: contracts.memoryMutationRecoveryResultSchema, base: { changeSetId: "mcs:change01", sourcePath: "space_memory.md", reason: null }, path: "resultingSourceHash",
    when: { status: "COMPLETE_APPLIED" }, otherwise: { status: "COMPLETE_FAILED" }, value: hash, absent: null,
    required: "Applied recovery requires a result hash.", forbidden: "Only applied recovery records a result hash." },
  { name: "memoryMutationWorkflowResultSchema", schema: contracts.memoryMutationWorkflowResultSchema, base: { changeSetId: "mcs:change01", reason: null }, path: "resultingSourceHash",
    when: { status: "APPLIED" }, otherwise: { status: "DISABLED" }, value: hash, absent: null,
    required: "Applied mutations require a result hash.", forbidden: "Only applied mutations record a result hash." },
  { name: "createMemoryEntryInputSchema", schema: contracts.createMemoryEntryInputSchema, base: { title: "t", body: "b", provenance: "p" }, path: "roomId",
    when: { scope: "ROOM" }, otherwise: { scope: "PROJECT" }, value: "room:room0001", absent: null,
    required: "ROOM memory requires roomId.", forbidden: "Only ROOM memory can include roomId." }
] as const;

describe("fields set exactly when a condition holds", () => {
  for (const item of cases) {
    it(`${item.name}: ${item.path} is required when the condition holds and refused otherwise`, () => {
      const schema = item.schema as Parse;
      const absent = "absent" in item ? { [item.path]: item.absent } : {};
      const issues = (input: object) => schema.safeParse({ ...item.base, ...input }).error?.issues.map((issue) => [issue.message, issue.path]) ?? [];
      expect(issues({ ...item.when, ...absent })).toEqual([[item.required, [item.path]]]);
      expect(issues({ ...item.when, [item.path]: item.value })).toEqual([]);
      expect(issues({ ...item.otherwise, [item.path]: item.value })).toEqual([[item.forbidden, [item.path]]]);
      expect(issues({ ...item.otherwise, ...absent })).toEqual([]);
    });
  }
});
