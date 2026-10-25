import { describe, expect, it } from "vitest";
import { InMemorySpaceStore, SpaceNotFoundError } from "../src/index.js";

describe("task store", () => {
  it("deduplicates exact objectives per user, moves them to the top, and updates occurrence metadata", () => {
    const store = new InMemorySpaceStore();
    const first = store.upsertTaskItem({
      ownerUserId: "user:one",
      title: "Fix login",
      objective: "Fix the login flow",
      status: "OPEN",
      source: "MANUAL"
    });
    const other = store.upsertTaskItem({
      ownerUserId: "user:one",
      title: "Write docs",
      objective: "Write API docs",
      status: "OPEN",
      source: "MANUAL"
    });
    const repeated = store.upsertTaskItem({
      ownerUserId: "user:one",
      title: "Fix login",
      objective: "Fix the login flow",
      status: "RUNNING",
      source: "AGENT",
      roomId: "room:one",
      paneId: "pane:one",
      paneTitle: "Drafts"
    });

    expect(repeated).toMatchObject({
      id: first.id,
      title: "Fix login",
      status: "RUNNING",
      source: "AGENT",
      roomId: "room:one",
      paneId: "pane:one",
      occurrenceCount: 2
    });
    expect(repeated.createdAt).toBe(first.createdAt);
    expect(store.listTaskItems("user:one", { page: 1, pageSize: 25 })).toMatchObject({
      total: 2,
      items: [{ id: first.id }, { id: other.id }]
    });
  });

  it("updates title, objective, and status independently and bumps lastUsedAt", () => {
    const store = new InMemorySpaceStore();
    const item = store.upsertTaskItem({
      ownerUserId: "user:one",
      title: "Fix login",
      objective: "Fix the login flow",
      status: "OPEN",
      source: "MANUAL"
    });

    const statusOnly = store.updateTaskItem("user:one", item.id, { status: "DONE" });
    expect(statusOnly).toMatchObject({ status: "DONE", objective: "Fix the login flow" });
    expect(statusOnly.characterCount).toBe(item.characterCount);

    const objectiveOnly = store.updateTaskItem("user:one", item.id, { objective: "Fix login and sessions" });
    expect(objectiveOnly).toMatchObject({
      status: "DONE",
      objective: "Fix login and sessions",
      characterCount: 22
    });
  });

  it("isolates list, get, update, delete, and clear operations by owner", () => {
    const store = new InMemorySpaceStore();
    const one = store.upsertTaskItem({
      ownerUserId: "user:one",
      title: "Private one",
      objective: "private one",
      status: "OPEN",
      source: "MANUAL"
    });
    const two = store.upsertTaskItem({
      ownerUserId: "user:two",
      title: "Private two",
      objective: "private two",
      status: "OPEN",
      source: "MANUAL"
    });

    expect(store.listTaskItems("user:one", { page: 1, pageSize: 25 }).items).toEqual([one]);
    expect(store.getTaskItem("user:one", two.id)).toBeNull();
    expect(() => store.updateTaskItem("user:one", two.id, { status: "DONE" })).toThrow(SpaceNotFoundError);
    expect(() => store.deleteTaskItem("user:one", two.id)).toThrow(SpaceNotFoundError);
    expect(store.clearTaskItems("user:one")).toBe(1);
    expect(store.getTaskItem("user:two", two.id)).toEqual(two);
    expect(store.snapshot().taskItems).toEqual([{ ownerUserId: "user:two", item: two }]);
  });

  it("prunes each user's finished tasks to the 100 most recently used unique objectives", () => {
    const store = new InMemorySpaceStore();
    for (let index = 0; index < 101; index += 1) {
      store.upsertTaskItem({
        ownerUserId: "user:one",
        title: `Task ${index}`,
        objective: `task ${index}`,
        status: "DONE",
        source: "MANUAL"
      });
    }

    const page = store.listTaskItems("user:one", { page: 1, pageSize: 100 });
    expect(page.total).toBe(100);
    expect(page.items[0]?.objective).toBe("task 100");
    expect(page.items.some((item) => item.objective === "task 0")).toBe(false);
  });

  it("never prunes open or scheduled tasks, only DONE/ARCHIVED ones past the cap (task loss 2026-10-19)", () => {
    const store = new InMemorySpaceStore();
    const base = { ownerUserId: "user:one", source: "MANUAL" as const };
    const kept = [
      store.upsertTaskItem({ ...base, title: "Daily review", objective: "Run the daily review", status: "OPEN", schedule: { recurrence: { kind: "DAILY", time: "09:00" }, timeZone: "Asia/Bangkok" } }),
      store.upsertTaskItem({ ...base, title: "Reminder", objective: "Call the accountant", status: "OPEN" }),
      store.upsertTaskItem({ ...base, title: "Ran once", objective: "Pay the invoice", status: "DONE", schedule: { recurrence: { kind: "ONCE", at: "2026-10-15T09:00:00.000Z" }, timeZone: "Asia/Bangkok" } })
    ];
    for (let index = 0; index < 150; index += 1) {
      store.upsertTaskItem({ ...base, title: `Done ${index}`, objective: `done ${index}`, status: index % 2 ? "DONE" : "ARCHIVED" });
    }

    for (const task of kept) expect(store.getTaskItem("user:one", task.id)).toMatchObject({ status: task.status, title: task.title });
    expect(store.listTaskItems("user:one", { page: 1, pageSize: 100 }).total).toBe(103);
    expect(store.deleteTaskItem("user:one", kept[1]!.id).id).toBe(kept[1]!.id);
  });

  it("searches case-insensitively, filters status, and paginates newest first", () => {
    const store = new InMemorySpaceStore();
    store.upsertTaskItem({
      ownerUserId: "user:one",
      title: "Fallback policy",
      objective: "Write the fallback policy",
      status: "OPEN",
      source: "MANUAL"
    });
    store.upsertTaskItem({
      ownerUserId: "user:one",
      title: "Unrelated",
      objective: "Clean the kitchen",
      status: "DONE",
      source: "MANUAL"
    });
    store.upsertTaskItem({
      ownerUserId: "user:one",
      title: "Verify FALLBACK now",
      objective: "Verify fallback works",
      status: "RUNNING",
      source: "AGENT"
    });

    expect(
      store.listTaskItems("user:one", { q: "fallback", status: "RUNNING", page: 1, pageSize: 25 })
    ).toMatchObject({ total: 1, items: [{ objective: "Verify fallback works", status: "RUNNING" }] });
    expect(store.listTaskItems("user:one", { status: "OPEN", page: 1, pageSize: 25 })).toMatchObject({
      total: 1,
      items: [{ title: "Fallback policy" }]
    });
    expect(store.listTaskItems("user:one", { page: 2, pageSize: 2 })).toMatchObject({
      total: 3,
      items: [{ objective: "Write the fallback policy" }]
    });
  });
});
