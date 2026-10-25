import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DotGoal, DotProfile } from "@space/contracts";
import { DotGoalDialog, DotGoalStrip } from "../src/features/agent-pane/DotGoals.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

vi.setConfig({ testTimeout: 30_000 });
beforeEach(() => installSpaceRuntime(liveRuntime));
afterEach(cleanup);
const dot = { dotId: `dot:${"1".repeat(32)}`, name: "Luna" } as DotProfile;
const at = "2026-10-10T10:00:00.000Z";
const goal = (overrides: Partial<DotGoal> = {}): DotGoal => ({ goalId: "dot_goal:abcdefgh1", dotId: dot.dotId, ownerUserId: "user:1", roomId: "room:1",
  sessionId: "agent_session:1", objective: "Prepare the supplier report", milestones: [{ id: "m1", title: "Collect quotes", status: "DONE", note: null },
    { id: "m2", title: "Build spreadsheet", status: "IN_PROGRESS", note: null }], criteria: ["Spreadsheet shared"],
  budget: { maxSteps: 20, maxMinutes: 180 }, usage: { steps: 3, lastRunId: "run:3", lastStepAt: at, consecutiveFailures: 0 }, status: "ACTIVE",
  statusReason: null, steering: [], evidence: null, workflowId: "dot-goal:dot_goal:abcdefgh1", createdAt: at, updatedAt: at, completedAt: null, ...overrides });

describe("Dot Goals UI", () => {
  it("starts a Goal with milestones, criteria and a bounded budget", async () => {
    const create = vi.fn(async () => ({ goal: goal() }));
    const onCreated = vi.fn();
    render(<DotGoalDialog dot={dot} sessionId="agent_session:1" onClose={vi.fn()} onCreated={onCreated} create={create} />);
    expect(screen.getByRole("dialog", { name: "Set a goal for Luna" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close goal editor" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Start goal" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Goal objective" }), { target: { value: "Prepare the supplier report" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Goal milestones" }), { target: { value: "Collect quotes\n\nBuild spreadsheet" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Goal completion criteria" }), { target: { value: "Spreadsheet shared" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Max hours" }), { target: { value: "1.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Start goal" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith(dot.dotId, { sessionId: "agent_session:1", objective: "Prepare the supplier report",
      milestones: ["Collect quotes", "Build spreadsheet"], criteria: ["Spreadsheet shared"], budget: { maxSteps: 20, maxMinutes: 90 } });
  });

  it("shows progress and lets the owner guide, pause and cancel with confirmation", async () => {
    const read = vi.fn(async () => ({ dotId: dot.dotId, items: [goal()] }));
    const control = vi.fn(async (_dot: string, _goal: string, action: string) => ({ goal: goal({ status: action === "PAUSE" ? "PAUSED" : "CANCELLED" }) }));
    const steer = vi.fn(async () => ({ goal: goal() }));
    render(<DotGoalStrip dot={dot} sessionId="agent_session:1" refreshKey="1" read={read} control={control} steer={steer} />);
    expect(await screen.findByText("Prepare the supplier report")).toBeTruthy();
    expect(screen.getByText(/1\/2 milestones · Step 3 of 20/)).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Guide Luna's goal" }), { target: { value: "Prefer EU suppliers" } });
    fireEvent.click(screen.getByRole("button", { name: "Guide" }));
    await waitFor(() => expect(steer).toHaveBeenCalledWith(dot.dotId, "dot_goal:abcdefgh1", "Prefer EU suppliers"));
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(await screen.findByRole("button", { name: "Resume" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel goal" }));
    expect(control).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Confirm cancel" }));
    await waitFor(() => expect(control).toHaveBeenLastCalledWith(dot.dotId, "dot_goal:abcdefgh1", "CANCEL"));
    expect(await screen.findByText("Cancelled")).toBeTruthy();
  });

  it("asks for the user's answer when blocked, and can be dismissed once finished", async () => {
    const read = vi.fn(async () => ({ dotId: dot.dotId, items: [goal({ status: "BLOCKED", statusReason: "Which currency should the report use?" })] }));
    const control = vi.fn(async () => ({ goal: goal({ status: "ACTIVE" }) }));
    const { unmount } = render(<DotGoalStrip dot={dot} sessionId="agent_session:1" refreshKey="1" read={read} control={control} />);
    expect(await screen.findByText(/Luna needs you: Which currency should the report use\?/)).toBeTruthy();
    expect(screen.getByText("Needs you")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(control).toHaveBeenCalledWith(dot.dotId, "dot_goal:abcdefgh1", "RESUME"));
    unmount();
    const finished = vi.fn(async () => ({ dotId: dot.dotId, items: [goal({ status: "BUDGET_EXHAUSTED", statusReason: "The Goal used its step or time budget." })] }));
    render(<DotGoalStrip dot={dot} sessionId="agent_session:1" refreshKey="2" read={finished} />);
    expect(await screen.findByText("Out of budget")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss goal" }));
    expect(screen.queryByText("Out of budget")).toBeNull();
  });
});
