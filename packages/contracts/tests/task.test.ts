import { describe, expect, it } from "vitest";
import {
  createTaskItemRequestSchema,
  listTaskItemsQuerySchema,
  saveAgentTaskItemInputSchema,
  spaceAgentTaskActionEnvelopeSchema,
  taskItemSchema,
  updateTaskItemInputSchema,
  upsertTaskItemInputSchema
} from "../src/index.js";

describe("task contracts", () => {
  it("accepts the complete task item contract", () => {
    expect(
      taskItemSchema.parse({
        id: "task:one",
        title: "Refactor checkout",
        objective: "  Move the payment gate behind a stable interface.  ",
        status: "OPEN",
        source: "MANUAL",
        roomId: "room:one",
        paneId: "pane:one",
        paneTitle: "Drafts and Sync",
        occurrenceCount: 2,
        characterCount: 14,
        createdAt: "2026-07-15T10:00:00.000Z",
        lastUsedAt: "2026-07-15T10:05:00.000Z"
      })
    ).toMatchObject({ title: "Refactor checkout", status: "OPEN", source: "MANUAL", occurrenceCount: 2 });
  });

  it("allows only MANUAL source on the public create contract", () => {
    expect(
      createTaskItemRequestSchema.parse({ title: "Ship v2", objective: "Release the next version." })
    ).toEqual({ title: "Ship v2", objective: "Release the next version." });
    expect(
      createTaskItemRequestSchema.parse({
        title: "Ship v2",
        objective: "Release the next version.",
        status: "RUNNING"
      }).status
    ).toBe("RUNNING");
    expect(() =>
      createTaskItemRequestSchema.parse({ title: "forged", objective: "x", source: "AGENT" })
    ).toThrow();
    expect(() =>
      createTaskItemRequestSchema.parse({
        title: "forged owner",
        objective: "x",
        ownerUserId: "user:other"
      })
    ).toThrow();
  });

  it("rejects blank, oversized, and untitled tasks", () => {
    expect(createTaskItemRequestSchema.parse({ title: "T", objective: "  ok  " }).objective).toBe("  ok  ");
    expect(() => createTaskItemRequestSchema.parse({ title: "  ", objective: "x" })).toThrow();
    expect(() => createTaskItemRequestSchema.parse({ title: "x".repeat(161), objective: "y" })).toThrow();
    expect(() => createTaskItemRequestSchema.parse({ title: "T", objective: " \n\t " })).toThrow();
    expect(
      createTaskItemRequestSchema.parse({ title: "T", objective: "x".repeat(10_000) }).objective
    ).toHaveLength(10_000);
    expect(() =>
      createTaskItemRequestSchema.parse({ title: "T", objective: "x".repeat(10_001) })
    ).toThrow();
  });

  it("caps agent-created tasks and fixes their source server-side", () => {
    expect(saveAgentTaskItemInputSchema.parse({ title: "Agent task", objective: "x".repeat(10_000) }).objective)
      .toHaveLength(10_000);
    expect(() => saveAgentTaskItemInputSchema.parse({ title: "Agent task", objective: "x".repeat(10_001) })).toThrow();
    expect(() => saveAgentTaskItemInputSchema.parse({ title: "Agent task", objective: "note", source: "MANUAL" })).toThrow();
  });

  it("requires a non-empty change on update", () => {
    expect(
      updateTaskItemInputSchema.parse({ status: "DONE" }).status
    ).toBe("DONE");
    expect(
      updateTaskItemInputSchema.parse({ title: "Renamed task" }).title
    ).toBe("Renamed task");
    expect(
      updateTaskItemInputSchema.parse({ objective: "  new objective  " }).objective
    ).toBe("  new objective  ");
    expect(() => updateTaskItemInputSchema.parse({})).toThrow();
    expect(() => updateTaskItemInputSchema.parse({ status: "NOPE" })).toThrow();
  });

  it("normalizes pagination, search, and status filters", () => {
    expect(listTaskItemsQuerySchema.parse({ q: "  fallback ", status: "RUNNING", page: "2", pageSize: "40" }))
      .toEqual({ q: "fallback", status: "RUNNING", page: 2, pageSize: 40 });
    expect(() => listTaskItemsQuerySchema.parse({ pageSize: "101" })).toThrow();
  });

  it("validates strict task list, get, save, and update action/tool pairs", () => {
    expect(spaceAgentTaskActionEnvelopeSchema.parse({
      version: 1,
      actions: [
        { toolId: "tasks:list", action: { type: "list", q: "fallback", pageSize: 5 } },
        { toolId: "tasks:get", action: { type: "get", taskItemId: "task:one" } },
        { toolId: "tasks:save", action: { type: "save", title: "Agent task", objective: "agent objective" } }
      ]
    }).actions).toHaveLength(3);
    expect(spaceAgentTaskActionEnvelopeSchema.parse({
      version: 1,
      actions: [{ toolId: "tasks:update", action: { type: "update", taskItemId: "task:one", status: "DONE" } }]
    }).actions).toHaveLength(1);
    expect(() => spaceAgentTaskActionEnvelopeSchema.parse({
      version: 1,
      actions: [{ toolId: "tasks:list", action: { type: "get", taskItemId: "task:one" } }]
    })).toThrow();
    expect(() => spaceAgentTaskActionEnvelopeSchema.parse({
      version: 1,
      actions: [{ toolId: "tasks:save", action: { type: "save", title: "T", objective: "x".repeat(10_001) } }]
    })).toThrow();
    expect(() => spaceAgentTaskActionEnvelopeSchema.parse({
      version: 1,
      actions: [{ toolId: "tasks:update", action: { type: "update", taskItemId: "task:one" } }]
    })).toThrow();
    expect(upsertTaskItemInputSchema.parse({
      ownerUserId: "user:operator",
      title: "Task",
      objective: "objective",
      status: "OPEN",
      source: "MANUAL"
    }).source).toBe("MANUAL");
  });
});
