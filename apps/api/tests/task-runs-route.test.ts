import { describe, expect, it } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { createCsrfToken, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";

// GET /api/tasks/runs (operator 1/11 03:32 BKK, plan clipboard:GA__W4qBxSPR): every run of the owner's scheduled tasks, ADMIN only.
describe("GET /api/tasks/runs", () => {
  const sessionSecret = "task-runs-route-secret";
  function headers(role: "OPERATOR" | "ADMIN") {
    const session = signSession({ id: "user:taskruns", email: "taskruns@space.local", role }, sessionSecret);
    return { cookie: `space_session=${session}`, "x-space-csrf-token": createCsrfToken(session, sessionSecret)! };
  }

  it("answers only ADMIN, newest first, with paging, filters and counts", async () => {
    const store = new InMemorySpaceStore();
    const app = await createApp({ store, config: getApiConfig({}), auth: { sessionSecret, devLogin: false, secureCookies: false } });
    try {
      const refused = await app.inject({ method: "GET", url: "/api/tasks/runs", headers: headers("OPERATOR") });
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error.code).toBe("ADMIN_REQUIRED");

      const empty = await app.inject({ method: "GET", url: "/api/tasks/runs", headers: headers("ADMIN") });
      expect(empty.statusCode).toBe(200);
      expect(empty.json()).toMatchObject({ runs: [], hasMore: false, tasks: [], counts: { RUNNING: 0, SUCCEEDED: 0 } });

      const owner = (await store.upsertUser({ id: "user:taskruns", email: "taskruns@space.local", role: "ADMIN" } as never)).id;
      const task = store.upsertTaskItem({ ownerUserId: owner, title: "Stretch", objective: "Stretch.", status: "OPEN", source: "MANUAL",
        schedule: { recurrence: { kind: "INTERVAL", minutes: 60 }, timeZone: "UTC" } });
      const due = task.schedule!.nextRunAt!;
      const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
      store.claimTaskSchedule(task.id, due, { nextRunAt: "2030-01-01T00:00:00.000Z", outcome: "Old reminder.", status: "REMINDER", at: ago(20) });
      store.claimTaskSchedule(task.id, "2030-01-01T00:00:00.000Z", { nextRunAt: "2031-01-01T00:00:00.000Z", outcome: "Reminder due.", status: "REMINDER", at: ago(2) });
      store.claimTaskSchedule(task.id, "2031-01-01T00:00:00.000Z", { nextRunAt: "2032-01-01T00:00:00.000Z", outcome: "Skipped.", status: "SKIPPED", at: ago(1) });
      // Only the owner's history period shows (operator 1/11 03:37 BKK): 14 days hides the 20-day-old run, which the prune then removes.
      expect((await app.inject({ method: "PATCH", url: "/api/user-settings", headers: headers("ADMIN"), payload: { history: { periodDays: 120 } } })).statusCode).toBe(422);
      expect((await app.inject({ method: "PATCH", url: "/api/user-settings", headers: headers("ADMIN"), payload: { history: { periodDays: 14 } } })).statusCode).toBe(200);
      expect(store.listTaskRuns(owner, { limit: 100 }).runs).toHaveLength(3);

      const all = (await app.inject({ method: "GET", url: "/api/tasks/runs?limit=1", headers: headers("ADMIN") })).json();
      expect(all).toMatchObject({ hasMore: true, counts: { REMINDER: 1, SKIPPED: 1 }, tasks: [{ taskId: task.id, title: "Stretch", runs: 2 }] });
      expect(all.runs.map((run: { status: string }) => run.status)).toEqual(["SKIPPED"]);
      const older = (await app.inject({ method: "GET", url: `/api/tasks/runs?before=${all.runs[0].id}`, headers: headers("ADMIN") })).json();
      expect(older).toMatchObject({ hasMore: false, runs: [{ status: "REMINDER", detail: "Reminder due.", typed: false }] });
      const reminders = (await app.inject({ method: "GET", url: `/api/tasks/runs?status=REMINDER&taskId=${encodeURIComponent(task.id)}`, headers: headers("ADMIN") })).json();
      expect(reminders.runs).toHaveLength(1);
      expect((await app.inject({ method: "GET", url: "/api/tasks/runs?status=DONE", headers: headers("ADMIN") })).statusCode).toBe(422);
      expect(store.pruneTaskRuns(new Date().toISOString())).toBe(1);
      expect(store.listTaskRuns(owner, { limit: 100 }).runs.map((run) => run.detail)).toEqual(["Skipped.", "Reminder due."]);
    } finally {
      await app.close();
    }
  });
});
