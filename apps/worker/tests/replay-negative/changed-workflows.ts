import { proxyActivities, sleep } from "@temporalio/workflow";

const { recordReplayFixtureActivity } = proxyActivities<{ recordReplayFixtureActivity(): Promise<string> }>({
  startToCloseTimeout: "1 minute"
});

export async function replayDeterminismFixtureWorkflow(): Promise<string> {
  const result = await recordReplayFixtureActivity();
  await sleep("1 second");
  return result;
}
