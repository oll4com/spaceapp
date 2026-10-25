/**
 * Space Dots Goal sequencing, kept free of Temporal APIs so it is testable.
 * The workflow supplies durable timers and activities; PostgreSQL (through the
 * API) owns all Goal state, so a replay only re-asks the API.
 */
export interface DotGoalLoopIo {
  step(goalId: string): Promise<{ state: string; runId: string | null; goalStatus: string }>;
  observe(goalId: string, runId: string): Promise<{ run: string; goalStatus: string }>;
  /** Waits for the timeout or an early wake-up signal. */
  wait(timeout: "15 seconds" | "30 seconds" | "1 hour"): Promise<void>;
  /** True when workflow history is large enough to continue as new. */
  shouldContinueAsNew?(): boolean;
}
export async function runDotGoalLoop(goalId: string, io: DotGoalLoopIo, maxIterations: number): Promise<{ goalStatus: string | null }> {
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (io.shouldContinueAsNew?.()) return { goalStatus: null };
    const step = await io.step(goalId);
    if (step.state === "DONE") return { goalStatus: step.goalStatus };
    if (step.state === "PAUSED" || step.state === "WAITING" || !step.runId) {
      await io.wait(step.state === "PAUSED" ? "1 hour" : "30 seconds");
      continue;
    }
    for (let polls = 0; polls < 2000; polls++) {
      if (io.shouldContinueAsNew?.()) return { goalStatus: null };
      await io.wait("15 seconds");
      const observed = await io.observe(goalId, step.runId);
      if (observed.run !== "QUEUED" && observed.run !== "RUNNING") break;
    }
  }
  return { goalStatus: null };
}
