import { describe, expect, it, vi } from "vitest";
import { nextDotScheduleRun, type DotSchedule } from "@space/contracts";
import { createDotScheduleService, type DotScheduleServiceDeps } from "../src/dot-schedules.js";

const dotId = `dot:${"b".repeat(32)}`;
function fixture(state: { activeSession?: string | null; runStatus?: string; pendingApproval?: boolean; sendFails?: boolean; now?: number; providerId?: string } = {}) {
  let clock = state.now ?? Date.parse("2026-10-10T06:00:00.000Z");
  const rows = new Map<string, DotSchedule>();
  const session = { sessionId: "agent_session:1", paneId: "pane:1", roomId: "room:1", dotId, isActive: true, selectedProviderId: state.providerId ?? null };
  const schedules = {
    create: vi.fn(async (input: Record<string, unknown>) => {
      const row = { scheduleId: `dot_schedule:${String(rows.size + 1).padStart(32, "0")}`, ...input, status: input.createdBy === "DOT" ? "PENDING_CONFIRMATION" : "ACTIVE",
        lastRunAt: null, lastOutcome: null, createdAt: new Date(clock).toISOString(), updatedAt: new Date(clock).toISOString() } as DotSchedule;
      rows.set(row.scheduleId, row); return row;
    }),
    getOwned: vi.fn(async (owner: string, dot: string, id: string) => owner === "user:1" && dot === dotId ? rows.get(id) ?? null : null),
    due: vi.fn(async (nowIso: string) => [...rows.values()].filter((row) => row.status === "ACTIVE" && row.nextRunAt! <= nowIso)),
    claim: vi.fn(async (id: string, expected: string, next: { nextRunAt: string | null; status: DotSchedule["status"]; outcome: string; ran: boolean }) => {
      const row = rows.get(id)!; if (row.status !== "ACTIVE" || row.nextRunAt !== expected) return false;
      rows.set(id, { ...row, nextRunAt: next.nextRunAt, status: next.status, lastOutcome: next.outcome, lastRunAt: next.ran ? new Date(clock).toISOString() : row.lastRunAt });
      return true;
    }),
    setStatus: vi.fn(async (id: string, from: string[], to: DotSchedule["status"], nextRunAt?: string | null) => {
      const row = rows.get(id); if (!row || !from.includes(row.status)) return null;
      const next = { ...row, status: to, ...(nextRunAt !== undefined ? { nextRunAt } : {}) }; rows.set(id, next); return next;
    })
  };
  const deps: DotScheduleServiceDeps = {
    store: { getSpaceAgentSession: vi.fn(async () => session), getRoom: vi.fn(async () => ({ ownerUserId: "user:1" })),
      getLatestSpaceAgentRun: vi.fn(async () => state.runStatus ? { status: state.runStatus } : null) } as never,
    dots: { get: vi.fn(async (owner: string) => owner === "user:1" ? { dotId } : null), hasPendingApproval: vi.fn(async () => state.pendingApproval ?? false) } as never,
    schedules: schedules as never,
    send: vi.fn(async () => { if (state.sendFails) throw new Error("busy"); }),
    activeSessionId: vi.fn(async () => state.activeSession === undefined ? "agent_session:1" : state.activeSession),
    now: () => clock
  };
  return { service: createDotScheduleService(deps), deps, rows, advance: (ms: number) => { clock += ms; } };
}
const daily = { sessionId: "agent_session:1", title: "Morning summary", prompt: "Summarize overnight work.", recurrence: { kind: "DAILY", time: "09:00" }, timeZone: "Europe/Athens" };

describe("Dot schedules", () => {
  it("activates a user schedule at its next local occurrence and runs each occurrence once", async () => {
    const { service, deps, rows, advance } = fixture();
    const schedule = await service.create("user:1", dotId, daily, "USER");
    expect(schedule).toMatchObject({ status: "ACTIVE", nextRunAt: "2026-10-11T06:00:00.000Z" });
    expect(schedule.nextRunAt).toBe(new Date(nextDotScheduleRun({ kind: "DAILY", time: "09:00" }, "Europe/Athens", Date.parse("2026-10-10T06:00:00.000Z"))!).toISOString());
    advance(24 * 3600_000);
    expect(await service.tick()).toMatchObject({ RAN: 1 });
    const [sent] = vi.mocked(deps.send).mock.calls[0]!;
    expect(sent).toMatchObject({ paneId: "pane:1", sessionId: "agent_session:1", ownerUserId: "user:1", requestKey: expect.stringMatching(/^schedule-[a-f0-9]{40}$/) });
    expect(sent.content).toContain("Scheduled task “Morning summary” (Every day at 09:00 (Europe/Athens))");
    const after = rows.get(schedule.scheduleId)!;
    expect(Date.parse(after.nextRunAt!)).toBeGreaterThan(Date.parse(schedule.nextRunAt!));
    expect(await service.tick()).toMatchObject({ RAN: 0 });
    expect(deps.send).toHaveBeenCalledTimes(1);
  });

  it("waits while the conversation is closed, busy or awaiting approval, then skips after twelve hours", async () => {
    for (const state of [{ activeSession: "agent_session:other" }, { runStatus: "RUNNING" }, { pendingApproval: true }]) {
      const { service, deps, rows, advance } = fixture(state);
      const schedule = await service.create("user:1", dotId, daily, "USER");
      advance(Date.parse(schedule.nextRunAt!) - Date.parse("2026-10-10T06:00:00.000Z") + 60_000);
      expect(await service.tick()).toMatchObject({ WAITING: 1 });
      advance(13 * 3600_000);
      expect(await service.tick()).toMatchObject({ SKIPPED: 1 });
      expect(rows.get(schedule.scheduleId)!.lastOutcome).toMatch(/^Skipped/);
      expect(deps.send).not.toHaveBeenCalled();
    }
  });

  it("keeps an occurrence due when sending fails, and completes one-time schedules", async () => {
    const failing = fixture({ sendFails: true });
    const schedule = await failing.service.create("user:1", dotId, daily, "USER");
    failing.advance(24 * 3600_000);
    expect(await failing.service.tick()).toMatchObject({ WAITING: 1 });
    expect(failing.rows.get(schedule.scheduleId)!.nextRunAt).toBe(schedule.nextRunAt);
    const once = fixture();
    const reminder = await once.service.create("user:1", dotId, { ...daily, recurrence: { kind: "ONCE", at: "2026-10-10T10:00:00+03:00" } }, "USER");
    once.advance(2 * 3600_000);
    expect(await once.service.tick()).toMatchObject({ RAN: 1 });
    expect(once.rows.get(reminder.scheduleId)).toMatchObject({ status: "COMPLETED", nextRunAt: null });
  });

  it("requires owner confirmation for a Dot proposal and validates time zones and past times", async () => {
    const { service, rows } = fixture();
    const proposed = await service.tool({ sessionId: "agent_session:1", dotId, roomId: "room:1" }, "user:1",
      { title: "Weekly report", prompt: "Draft the weekly report.", recurrence: { kind: "WEEKLY", days: [1], time: "08:30" }, timeZone: "Europe/Athens" });
    expect(proposed).toMatchObject({ status: "PROPOSED", summary: "Schedule “Weekly report”: Every Mon at 08:30 (Europe/Athens)" });
    const id = (proposed as { schedule: DotSchedule }).schedule.scheduleId;
    expect(rows.get(id)).toMatchObject({ status: "PENDING_CONFIRMATION", nextRunAt: null });
    expect(await service.tick()).toMatchObject({ RAN: 0 });
    expect((await service.control("user:1", dotId, id, { action: "CONFIRM" })).status).toBe("ACTIVE");
    await expect(service.control("user:1", dotId, id, { action: "CONFIRM" })).rejects.toMatchObject({ status: 409 });
    expect((await service.control("user:1", dotId, id, { action: "PAUSE" })).status).toBe("PAUSED");
    await expect(service.control("user:2", dotId, id, { action: "CANCEL" })).rejects.toMatchObject({ status: 404 });
    expect(await service.tool({ sessionId: "agent_session:1", dotId, roomId: "room:1" }, "user:1", { ...daily, sessionId: undefined, timeZone: "Mars/Olympus" }))
      .toMatchObject({ status: "BLOCKED" });
    await expect(service.create("user:1", dotId, { ...daily, timeZone: "Not/AZone" }, "USER")).rejects.toMatchObject({ code: "DOT_SCHEDULE_TIMEZONE" });
    await expect(service.create("user:1", dotId, { ...daily, recurrence: { kind: "ONCE", at: "2020-01-01T00:00:00Z" } }, "USER")).rejects.toMatchObject({ code: "DOT_SCHEDULE_PAST" });
  });

  it("runs a confirmed Dot proposal as read-only proactive work and limits it to hourly", async () => {
    const { service, deps, advance } = fixture();
    const session = { sessionId: "agent_session:1", dotId, roomId: "room:1" };
    expect(await service.tool(session, "user:1", { title: "Watch", prompt: "Check the inbox.", recurrence: { kind: "INTERVAL", minutes: 15 }, timeZone: "UTC" }))
      .toMatchObject({ status: "BLOCKED", statusReason: expect.stringMatching(/every 60 minutes/) });
    const proposed = await service.tool(session, "user:1", { title: "Watch", prompt: "Check the inbox.", recurrence: { kind: "INTERVAL", minutes: 60 }, timeZone: "UTC" });
    await service.control("user:1", dotId, (proposed as { schedule: DotSchedule }).schedule.scheduleId, { action: "CONFIRM" });
    advance(61 * 60_000);
    expect(await service.tick()).toMatchObject({ RAN: 1 });
    const [sent] = vi.mocked(deps.send).mock.calls[0]!;
    expect(sent.requestKey).toMatch(/^proactive-[a-f0-9]{40}$/);
    expect(sent.content).toContain("runs read-only");
  });

  it("skips proactive occurrences once the conversation uses another provider", async () => {
    const { service, deps, rows, advance } = fixture({ providerId: "opencode" });
    const session = { sessionId: "agent_session:1", dotId, roomId: "room:1" };
    const proposed = await service.tool(session, "user:1", { title: "Watch", prompt: "Check the inbox.", recurrence: { kind: "INTERVAL", minutes: 60 }, timeZone: "UTC" });
    const id = (proposed as { schedule: DotSchedule }).schedule.scheduleId;
    await service.control("user:1", dotId, id, { action: "CONFIRM" });
    advance(61 * 60_000);
    expect(await service.tick()).toMatchObject({ SKIPPED: 1 });
    expect(rows.get(id)!.lastOutcome).toMatch(/only in a Codex conversation/);
    expect(deps.send).not.toHaveBeenCalled();
    // A schedule the user created keeps running with any provider.
    const own = fixture({ providerId: "opencode" });
    await own.service.create("user:1", dotId, daily, "USER");
    own.advance(24 * 3600_000);
    expect(await own.service.tick()).toMatchObject({ RAN: 1 });
  });
});
