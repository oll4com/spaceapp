import { proxyActivities, sleep } from "@temporalio/workflow";

export interface ReplayProbeActivities {
  step1(): Promise<void>;
  step2(): Promise<void>;
  step3(): Promise<void>;
}

const { step1, step2, step3 } = proxyActivities<ReplayProbeActivities>({
  startToCloseTimeout: "1 minute",
});

export async function replayProbeWorkflow(): Promise<string> {
  await sleep("1 minute");
  await step1();
  await sleep("1 minute");
  await step2();
  await sleep("1 minute");
  await step3();
  return "done";
}
