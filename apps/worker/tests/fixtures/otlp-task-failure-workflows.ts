import { ApplicationFailure, condition, defineSignal, defineUpdate, proxySinks, setHandler, type Sinks } from "@temporalio/workflow";

// Counts every execution, including Temporal's retries of a failed workflow task.
export interface TaskFailureProbeSinks extends Sinks {
  taskFailureProbe: { executed(entry: string): void };
}
const { taskFailureProbe } = proxySinks<TaskFailureProbeSinks>();

// A non-Temporal error fails the workflow task, which Temporal retries; the
// workflow execution itself keeps running.
export async function traceTaskFailureWorkflow(): Promise<string> {
  taskFailureProbe.executed("workflow");
  throw new Error("synthetic non-Temporal workflow error");
}

// A Temporal failure is a terminal workflow outcome.
export async function traceTerminalFailureWorkflow(): Promise<string> {
  throw ApplicationFailure.nonRetryable("synthetic terminal failure", "TOOL_UNAVAILABLE");
}

export const plainErrorSignal = defineSignal("plainErrorSignal");
export const applicationFailureSignal = defineSignal("applicationFailureSignal");
export const plainErrorUpdate = defineUpdate<string>("plainErrorUpdate");
export const applicationFailureUpdate = defineUpdate<string>("applicationFailureUpdate");

// Signal and update handlers follow the same rule: a non-Temporal error fails
// the task; a Temporal failure fails the workflow (signal) or the update.
export async function traceHandlerFailureWorkflow(): Promise<string> {
  setHandler(plainErrorSignal, () => {
    taskFailureProbe.executed("signal");
    throw new Error("synthetic non-Temporal signal error");
  });
  setHandler(applicationFailureSignal, () => {
    throw ApplicationFailure.nonRetryable("synthetic signal failure", "TOOL_UNAVAILABLE");
  });
  setHandler(plainErrorUpdate, () => {
    taskFailureProbe.executed("update");
    throw new Error("synthetic non-Temporal update error");
  });
  setHandler(applicationFailureUpdate, () => {
    throw ApplicationFailure.nonRetryable("synthetic update failure", "TOOL_UNAVAILABLE");
  });
  await condition(() => false);
  return "unreachable";
}
