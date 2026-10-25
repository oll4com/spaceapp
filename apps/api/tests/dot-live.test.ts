import { describe, expect, it, vi } from "vitest";
import type { DotProfile, Pane } from "@space/contracts";
import { SpaceConflictError } from "@space/runtime";
import { createDotLiveService, findLiveDot } from "../src/dot-live.js";

const dots = ["Orbit", "Νόβα"].map((name, index) => ({ dotId: `dot:${String(index + 1).repeat(32)}`, name, slot: index + 1 }) as DotProfile);
const pane = (id: string) => ({ id, roomId: "room:1", mode: "CHAT", isClosed: false, title: id }) as Pane;
function fixture(options: { existing?: boolean; busy?: boolean; goal?: { status: string } | null } = {}) {
  const sessions = new Map<string, { sessionId: string; dotId: string; updatedAt: string }>(options.existing
    ? [["pane:old", { sessionId: "session:old", dotId: dots[0]!.dotId, updatedAt: "2026-10-11T08:00:00.000Z" }]] : []);
  const deps = {
    store: {
      getRoom: vi.fn(async (roomId: string) => ({ id: roomId, ownerUserId: "user:1" })),
      listPanes: vi.fn(async () => [...sessions.keys()].map(pane)),
      getActiveSpaceAgentSession: vi.fn(async (paneId: string) => sessions.get(paneId) ?? null),
      getLatestSpaceAgentRun: vi.fn(async () => ({ runId: "run:1", status: "COMPLETED", responseMessageId: "msg:1" })),
      listSpaceAgentMessages: vi.fn(async () => [{ messageId: "msg:1", content: "The report is ready." }])
    } as never,
    dots: { list: vi.fn(async () => dots) },
    openPane: vi.fn(async (input: { title: string }) => ({ ...pane("pane:new"), title: input.title })),
    startSession: vi.fn(async () => { sessions.set("pane:new", { sessionId: "session:new", dotId: dots[0]!.dotId, updatedAt: new Date().toISOString() }); return { sessionId: "session:new" }; }),
    send: vi.fn(async () => { if (options.busy) throw new SpaceConflictError("busy"); }),
    openGoal: vi.fn(async () => options.goal ? { goalId: "dot_goal:1", objective: "Compare suppliers", statusReason: "Which city?", steps: 3, maxSteps: 8, ...options.goal } : null),
    steerGoal: vi.fn(async () => undefined),
    pendingApprovals: vi.fn(async () => [{ summary: "Send an email to a@b.c" }]),
    watch: vi.fn(async () => "control_watch:1")
  };
  return { service: createDotLiveService(deps), deps };
}
const request = { roomId: "room:1", dot: "orbit", text: "Prepare the weekly report", liveSessionId: "live-session-1", requestId: "call-1" };

describe("Live and Dots", () => {
  it("finds Dots by name in any case, by number or id", () => {
    expect(findLiveDot(dots, "ORBIT")?.name).toBe("Orbit");
    expect(findLiveDot(dots, "νόβα")?.name).toBe("Νόβα");
    expect(findLiveDot(dots, "2")?.name).toBe("Νόβα");
    expect(findLiveDot(dots, "Luna")).toBeNull();
  });

  it("continues in the Dot's existing conversation, idempotently per Live call, and watches for the result", async () => {
    const f = fixture({ existing: true });
    expect(await f.service.ask("user:1", request)).toMatchObject({ status: "SENT", dot: "Orbit", paneId: "pane:old", watchId: "control_watch:1" });
    expect(f.deps.openPane).not.toHaveBeenCalled();
    const sent = f.deps.send.mock.calls[0]![0] as unknown as { content: string; requestKey: string };
    expect(sent.content).toBe("(Voice) Prepare the weekly report");
    // A repeated Live call returns the first answer and does nothing again.
    expect(await f.service.ask("user:1", request)).toMatchObject({ status: "SENT", watchId: "control_watch:1" });
    expect(f.deps.send).toHaveBeenCalledTimes(1);
    expect(f.deps.watch).toHaveBeenCalledTimes(1);
    await f.service.ask("user:1", { ...request, requestId: "call-2" });
    expect((f.deps.send.mock.calls[1]![0] as unknown as { requestKey: string }).requestKey).not.toBe(sent.requestKey);
    expect(f.deps.watch).toHaveBeenCalledWith("user:1", "room:1", "pane:old");
  });

  it("opens the Dot's own pane when it has no conversation in the room", async () => {
    const f = fixture();
    expect(await f.service.ask("user:1", request)).toMatchObject({ status: "SENT", paneId: "pane:new" });
    expect(f.deps.openPane).toHaveBeenCalledWith({ owner: "user:1", roomId: "room:1", title: "Orbit · Live" });
  });

  it("keeps voice out of Slack and Teams conversations", async () => {
    const f = fixture({ existing: true });
    const service = (await import("../src/dot-live.js")).createDotLiveService({ ...(f.deps as never), isChannelSession: async () => true });
    expect(await service.ask("user:1", request)).toMatchObject({ status: "SENT", paneId: "pane:new" });
  });

  it("answers a waiting Goal, steers a busy one and reports a busy Dot without queuing silently", async () => {
    const blocked = fixture({ existing: true, goal: { status: "BLOCKED" } });
    expect(await blocked.service.ask("user:1", request)).toMatchObject({ status: "ANSWERED" });
    expect(blocked.deps.steerGoal).toHaveBeenCalledWith("user:1", dots[0]!.dotId, "dot_goal:1", "Prepare the weekly report", true);
    expect(blocked.deps.send).not.toHaveBeenCalled();
    const steered = fixture({ existing: true, busy: true, goal: { status: "ACTIVE" } });
    expect(await steered.service.ask("user:1", request)).toMatchObject({ status: "STEERED" });
    expect(steered.deps.steerGoal).toHaveBeenCalledWith("user:1", dots[0]!.dotId, "dot_goal:1", "Prepare the weekly report", false);
    expect(await fixture({ existing: true, busy: true }).service.ask("user:1", request)).toMatchObject({ status: "BUSY" });
    expect(await fixture().service.ask("user:1", { ...request, dot: "Luna" })).toMatchObject({ status: "UNKNOWN_DOT", message: expect.stringMatching(/Orbit, Νόβα/) });
    await expect(fixture().service.ask("user:2", request)).rejects.toThrow(/not available/);
  });

  it("summarizes the last answer, the Goal and waiting approvals for speech", async () => {
    const f = fixture({ existing: true, goal: { status: "BLOCKED" } });
    const status = await f.service.status("user:1", "room:1", "Orbit");
    expect(status).toMatchObject({ status: "OK", runStatus: "COMPLETED", goalStatus: "BLOCKED", pendingApprovals: 1 });
    expect(status.message).toBe("Orbit's last answer: The report is ready. Goal \"Compare suppliers\" is blocked after 3 of 8 steps; it asks: Which city? 1 action waits for approval in Space, for example: Send an email to a@b.c.");
    expect(await fixture().service.status("user:1", "room:1", "Orbit")).toMatchObject({ status: "IDLE" });
  });
});
