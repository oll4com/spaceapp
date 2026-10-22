import { expect, it } from "vitest";
import * as contracts from "../src/t3code.js";
// Imported with the module, not inside the test: transforming the large schema module
// under a loaded full run took longer than the 5 s test timeout.
import { paneSchema } from "../src/schemas.js";

const selection = { environmentId: "env-live", projectId: "project-live", threadId: "thread-live", draftId: null };
const metadata = { version: 1, revision: 1, generation: "75578f14-5020-4576-bfdf-0cc0831ecda4", lastSequence: 0, selection };
const schemas = contracts as Record<string, any>;

it("rejects ambiguous selections, unsafe IDs and credential-bearing messages", () => {
  expect(schemas.t3CodeSelectionSchema, "Selection contract is missing").toBeDefined();
  expect(schemas.t3CodeSelectionSchema.safeParse(selection).success).toBe(true);
  for (const bad of [
    { ...selection, draftId: "draft-also" }, { ...selection, threadId: null },
    { ...selection, projectId: "../outside" }, { ...selection, environmentId: "https://foreign.test" },
    { ...selection, token: "synthetic-private-marker" }
  ]) expect(schemas.t3CodeSelectionSchema.safeParse(bad).success).toBe(false);
  const message = { version: 1, type: "selection.changed", paneId: "pane:owned123", generation: metadata.generation,
    sequence: 1, requestId: "75578f14-5020-4576-bfdf-0cc0831ecda5", payload: selection };
  expect(schemas.t3CodeSelectionMessageSchema.safeParse(message).success).toBe(true);
  for (const bad of [{ ...message, version: 2 }, { ...message, sequence: -1 }, { ...message, payload: { ...selection, url: "/secret" } }])
    expect(schemas.t3CodeSelectionMessageSchema.safeParse(bad).success).toBe(false);
});

it("round-trips versioned pane metadata without changing legacy pane defaults", () => {
  expect(schemas.t3CodePaneMetadataSchema, "Persistent metadata contract is missing").toBeDefined();
  expect(schemas.t3CodePaneMetadataSchema.parse(metadata)).toEqual(metadata);
  const pane = { id: "pane:owned123", roomId: "room:owned123", title: "T3 Code", mode: "T3CODE", status: "IDLE", providerId: null,
    modelId: null, cwd: null, order: 0, columnSpan: 1, isMaximized: false, isMinimized: false, isClosed: false,
    split: { parentId: null, direction: null, size: null }, createdAt: "2026-10-09T00:00:00.000Z", updatedAt: "2026-10-09T00:00:00.000Z" };
  expect(paneSchema.parse({ ...pane, t3CodeMetadata: metadata }).t3CodeMetadata).toEqual(metadata);
  expect(paneSchema.parse(pane).t3CodeMetadata ?? null).toBeNull();
});

it("accepts T3 0.1.0's own thread ids with colons and still refuses path or markup characters", () => {
  for (const threadId of ["thread:project:9f99c9ff-f72c-4dbe-af75-bc88aaac86a3:c69c5fb7-d17e-486a-9655-188b7d29554b", "cmd-1:fork"]) {
    expect(contracts.t3CodeSelectionSchema.safeParse({ ...selection, threadId }).success, threadId).toBe(true);
  }
  for (const threadId of ["thread/../x", "a b", "<x>", "a%3Ab", "x".repeat(201)]) {
    expect(contracts.t3CodeSelectionSchema.safeParse({ ...selection, threadId }).success, threadId).toBe(false);
  }
});
