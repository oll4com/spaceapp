import { ApplicationFailure, Context } from "@temporalio/activity";

export interface FlakyProbeInput {
  roomId?: string;
  paneId?: string;
  missionId?: string;
  turnId?: string;
  actionId?: string;
  secretPrompt?: string;
  modelOutput?: string;
  filePath?: string;
  url?: string;
}

export interface EchoProbeInput {
  message?: string;
  secretPrompt?: string;
  modelOutput?: string;
  turn?: {
    traceparent?: string;
    secretToken?: string;
  };
}

export async function flakyProbeActivity(input: FlakyProbeInput = {}): Promise<{ status: string; probeOutput: string }> {
  const attempt = Context.current().info.attempt;
  if (attempt === 1) {
    throw ApplicationFailure.retryable("Simulated transient failure on attempt 1", "SIMULATED_PROBE_ERROR");
  }
  return { status: "COMPLETED", probeOutput: "probe-success" };
}

export async function echoProbeActivity(input: EchoProbeInput = {}): Promise<{ status: string; echoed: string }> {
  return { status: "COMPLETED", echoed: input.message ?? "echo-ok" };
}

export async function failingProbeActivity(input: { reasonCode?: string; secretData?: string } = {}): Promise<never> {
  throw ApplicationFailure.nonRetryable(
    "Simulated non-retryable failure",
    input.reasonCode ?? "PERMANENT_PROBE_ERROR"
  );
}
