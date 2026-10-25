import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DotEvalReport, DotProfile } from "@space/contracts";
import { DotEvaluationSection } from "../src/features/agent-pane/DotEvaluation.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime, SpaceApiError } from "../src/runtime/SpaceRuntime.js";

vi.setConfig({ testTimeout: 30_000 });
beforeEach(() => installSpaceRuntime(liveRuntime));
afterEach(cleanup);
const dot = { dotId: `dot:${"1".repeat(32)}`, name: "Luna" } as DotProfile;
const counts = { PENDING: 0, RUNNING: 0, DONE: 18, SKIPPED: 6, FAILED: 1, CANCELLED: 0 };
const run = { evalRunId: "dot_eval:0123456789abcdef", datasetVersion: "dots-v1", modelConfigId: null, createdAt: "2026-10-11T08:00:00.000Z", counts };

describe("Dot evaluation section", () => {
  it("stays hidden for anyone the server does not allow", async () => {
    const readRuns = vi.fn(async () => { throw new SpaceApiError("Evaluations require ADMIN.", { status: 403 }); });
    const { container } = render(<DotEvaluationSection dot={dot} roomId="room:1" readRuns={readRuns} />);
    await waitFor(() => expect(readRuns).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector(".dots-evaluation")).toBeNull());
  });

  it("starts the chosen cases in this room, lists runs and shows a report without claiming release", async () => {
    const readRuns = vi.fn(async () => ({ runs: [run] }));
    const start = vi.fn(async () => ({ evalRunId: run.evalRunId, paneId: "pane:eval", cases: 24, skipped: 6 }));
    const report: DotEvalReport = { evalRunId: run.evalRunId, datasetVersion: "dots-v1", modelConfigId: null, running: false, calibrationComplete: false,
      families: { mcp: { cases: 4, passed: 3, failed: 1, notRun: 0 } }, results: [], note: "One run alone proves nothing." };
    const readReport = vi.fn(async () => report);
    render(<DotEvaluationSection dot={dot} roomId="room:1" readRuns={readRuns} start={start} readReport={readReport} stop={vi.fn()} />);
    expect(await screen.findByText(/18 done · 6 skipped · 1 failed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Tuning" }));
    expect(screen.getByRole("button", { name: "Tuning" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Run evaluation" }));
    await waitFor(() => expect(start).toHaveBeenCalledWith(dot.dotId, { dataset: "dots-v1", split: "tuning", roomId: "room:1" }));
    expect(await screen.findByText("Started 24 cases in a new pane; 6 need connections you have not made and are skipped.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(await screen.findByRole("rowheader", { name: "mcp" })).toBeTruthy();
    expect(screen.getByText(/not yet calibrated by people\. One run alone proves nothing\./)).toBeTruthy();
  });

  it("refreshes while a run is in progress and can stop it", async () => {
    const live = { ...run, counts: { ...counts, RUNNING: 1, PENDING: 3 } };
    const readRuns = vi.fn(async () => ({ runs: [live] }));
    const stop = vi.fn(async () => ({ stopped: true }));
    render(<DotEvaluationSection dot={dot} roomId="room:1" readRuns={readRuns} stop={stop} pollMs={20} />);
    expect(await screen.findByText(/4 left/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Run evaluation" }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(readRuns.mock.calls.length).toBeGreaterThan(2));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(stop).toHaveBeenCalledWith(dot.dotId, run.evalRunId));
    expect(await screen.findByText("Stopping after the current case.")).toBeTruthy();
  });
});
