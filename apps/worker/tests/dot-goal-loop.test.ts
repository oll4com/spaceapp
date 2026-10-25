import { describe, expect, it, vi } from "vitest";
import { runDotGoalLoop } from "../src/dot-goal-loop.js";
import { dotGoalObserve, dotGoalStep } from "../src/activities.js";

describe("Dot Goal loop", () => {
  it("runs one step at a time, waits for each run, and stops when the API reports the Goal done", async () => {
    const steps = [{ state: "STARTED", runId: "run:1", goalStatus: "ACTIVE" }, { state: "BUSY", runId: "run:1", goalStatus: "ACTIVE" },
      { state: "STARTED", runId: "run:2", goalStatus: "ACTIVE" }, { state: "DONE", runId: null, goalStatus: "COMPLETED" }];
    const runs: Record<string, string[]> = { "run:1": ["RUNNING", "COMPLETED", "COMPLETED"], "run:2": ["QUEUED", "FAILED"] };
    const io = {
      step: vi.fn(async () => steps.shift()!),
      observe: vi.fn(async (_goal: string, runId: string) => ({ run: runs[runId]!.shift()!, goalStatus: "ACTIVE" })),
      wait: vi.fn(async () => undefined)
    };
    expect(await runDotGoalLoop("dot_goal:abcdefgh", io, 50)).toEqual({ goalStatus: "COMPLETED" });
    expect(io.step).toHaveBeenCalledTimes(4);
    expect(io.observe.mock.calls.map(([, runId]) => runId)).toEqual(["run:1", "run:1", "run:1", "run:2", "run:2"]);
  });

  it("waits long while paused and briefly while waiting for approval or capacity, without observing runs", async () => {
    const steps = [{ state: "PAUSED", runId: null, goalStatus: "PAUSED" }, { state: "WAITING", runId: null, goalStatus: "ACTIVE" },
      { state: "DONE", runId: null, goalStatus: "CANCELLED" }];
    const io = { step: vi.fn(async () => steps.shift()!), observe: vi.fn(), wait: vi.fn(async () => undefined) };
    expect(await runDotGoalLoop("dot_goal:abcdefgh", io, 50)).toEqual({ goalStatus: "CANCELLED" });
    expect(io.wait.mock.calls.map(([timeout]) => timeout)).toEqual(["1 hour", "30 seconds"]);
    expect(io.observe).not.toHaveBeenCalled();
  });

  it("continues as new when history grows, even in the middle of waiting for a run", async () => {
    let checks = 0;
    const io = { step: vi.fn(async () => ({ state: "STARTED", runId: "run:1", goalStatus: "ACTIVE" })),
      observe: vi.fn(async () => ({ run: "RUNNING", goalStatus: "ACTIVE" })), wait: vi.fn(async () => undefined),
      shouldContinueAsNew: () => ++checks > 4 };
    expect(await runDotGoalLoop("dot_goal:abcdefgh", io, 50)).toEqual({ goalStatus: null });
    expect(io.step).toHaveBeenCalledTimes(1);
  });

  it("returns null after its iteration budget so the workflow continues as new", async () => {
    const io = { step: vi.fn(async () => ({ state: "WAITING", runId: null, goalStatus: "ACTIVE" })), observe: vi.fn(), wait: vi.fn(async () => undefined) };
    expect(await runDotGoalLoop("dot_goal:abcdefgh", io, 3)).toEqual({ goalStatus: null });
    expect(io.step).toHaveBeenCalledTimes(3);
  });
});

describe("Dot Goal activities", () => {
  it("call the internal API with the worker token and map a missing Goal to done", async () => {
    process.env.SPACE_INTERNAL_API_TOKEN = "goal-token";
    process.env.SPACE_INTERNAL_API_BASE_URL = "http://api.goal.test";
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect((init!.headers as Record<string, string>)["x-space-internal-token"]).toBe("goal-token");
      if (String(url).endsWith("/step")) return Response.json({ state: "STARTED", runId: "run:9", goal: { status: "ACTIVE" } });
      return Response.json({ run: "COMPLETED", goal: { status: "ACTIVE" } });
    }) as unknown as typeof fetch;
    expect(await dotGoalStep("dot_goal:abcdefgh", fetchImpl)).toEqual({ state: "STARTED", runId: "run:9", goalStatus: "ACTIVE" });
    expect(await dotGoalObserve("dot_goal:abcdefgh", "run:9", fetchImpl)).toEqual({ run: "COMPLETED", goalStatus: "ACTIVE" });
    const missing = vi.fn(async () => Response.json({ error: { code: "DOT_GOAL_NOT_FOUND" } }, { status: 404 })) as unknown as typeof fetch;
    expect(await dotGoalStep("dot_goal:abcdefgh", missing)).toEqual({ state: "DONE", runId: null, goalStatus: "MISSING" });
    const otherMissing = vi.fn(async () => Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 })) as unknown as typeof fetch;
    await expect(dotGoalStep("dot_goal:abcdefgh", otherMissing)).rejects.toThrow(/HTTP 404/);
    const failing = vi.fn(async () => Response.json({}, { status: 503 })) as unknown as typeof fetch;
    await expect(dotGoalStep("dot_goal:abcdefgh", failing)).rejects.toThrow(/HTTP 503/);
  });
});
