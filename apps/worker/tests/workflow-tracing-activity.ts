import { Context } from "@temporalio/activity";
import type { TraceFixtureInput } from "./workflow-tracing-fixture.js";

export async function recordTraceActivity(label: string, input: TraceFixtureInput): Promise<void> {
  // Keep the prompt in workflow/activity arguments to prove it is never exported.
  void input.prompt;
  if (label === "retry" && Context.current().info.attempt === 1) {
    throw Object.assign(new Error("PRIVATE ERROR MESSAGE: never export this"), { code: "UPSTREAM_RETRYABLE_UNAVAILABLE" });
  }
  if (Context.current().info.attempt < 1) throw new Error("Unexpected attempt number.");
}
