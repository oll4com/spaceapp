import { describe, expect, it } from "vitest";
import {
  createTaskItemRequestSchema,
  listTaskItemsQuerySchema,
  saveAgentTaskItemInputSchema,
  spaceAgentTaskActionEnvelopeSchema,
  taskItemSchema,
  taskScheduleNextRunAt,
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

  it("keeps today's owed daily or weekly run when a schedule is set again (R71)", () => {
    const at = (iso: string) => Date.parse(iso);
    // Cleo/Kate 4/11: the 00:05 run waited on a draft; its time nudged to 00:10 at 04:04 moved it to 5/11 with no run.
    const kate = { recurrence: { kind: "DAILY" as const, time: "00:05" }, timeZone: "UTC", nextRunAt: "2026-11-04T00:05:00.000Z", lastRunAt: "2026-11-03T00:05:40.620Z", lastOutcome: null };
    expect(taskScheduleNextRunAt({ recurrence: { kind: "DAILY", time: "00:10" }, timeZone: "UTC" }, "OPEN", at("2026-11-04T04:04:24Z"), kate,
      { createdAt: "2026-11-02T21:19:33Z", lastRunAt: kate.lastRunAt })).toBe("2026-11-04T00:10:00.000Z");
    // Bruno/Oscar 4/11: rebound and scheduled again at 04:45 (from no schedule): the 09:00 Bangkok run of that day is still owed.
    const oscar = { createdAt: "2026-10-29T08:04:22Z", lastRunAt: "2026-11-03T05:25:41.756Z" };
    expect(taskScheduleNextRunAt({ recurrence: { kind: "DAILY", time: "09:00" }, timeZone: "Asia/Bangkok" }, "OPEN", at("2026-11-04T04:45:07Z"), null, oscar))
      .toBe("2026-11-04T02:00:00.000Z");
    expect(taskScheduleNextRunAt({ recurrence: { kind: "WEEKLY", days: [3], time: "09:00" }, timeZone: "Asia/Bangkok" }, "OPEN", at("2026-11-04T04:45:07Z"), null, oscar))
      .toBe("2026-11-04T02:00:00.000Z");
    // Not owed: a day that already ran, a run more than 12 h ago, a task made after it, or no task row: the next one after now.
    expect(taskScheduleNextRunAt({ recurrence: { kind: "DAILY", time: "09:30" }, timeZone: "UTC" }, "OPEN", at("2026-11-04T10:00:00Z"), null,
      { createdAt: "2026-10-01T00:00:00Z", lastRunAt: "2026-11-04T09:00:30Z" })).toBe("2026-11-05T09:30:00.000Z");
    expect(taskScheduleNextRunAt({ recurrence: { kind: "DAILY", time: "09:00" }, timeZone: "Asia/Bangkok" }, "OPEN", at("2026-11-04T14:30:00Z"), null, oscar))
      .toBe("2026-11-05T02:00:00.000Z");
    expect(taskScheduleNextRunAt({ recurrence: { kind: "DAILY", time: "09:00" }, timeZone: "Asia/Bangkok" }, "OPEN", at("2026-11-04T04:45:07Z"), null,
      { createdAt: "2026-11-04T04:45:07Z", lastRunAt: null })).toBe("2026-11-05T02:00:00.000Z");
    expect(taskScheduleNextRunAt({ recurrence: { kind: "DAILY", time: "09:00" }, timeZone: "Asia/Bangkok" }, "OPEN", at("2026-11-04T04:45:07Z")))
      .toBe("2026-11-05T02:00:00.000Z");
    // Reopening a done task (same schedule, no pending run) resumes at its next occurrence.
    expect(taskScheduleNextRunAt({ recurrence: { kind: "DAILY", time: "09:00" }, timeZone: "Asia/Bangkok" }, "OPEN", at("2026-11-04T04:45:07Z"),
      { recurrence: { kind: "DAILY", time: "09:00" }, timeZone: "Asia/Bangkok", nextRunAt: null, lastRunAt: oscar.lastRunAt, lastOutcome: null }, oscar))
      .toBe("2026-11-05T02:00:00.000Z");
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
