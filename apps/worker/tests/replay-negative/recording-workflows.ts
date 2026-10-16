import { proxyActivities } from "@temporalio/workflow";

const { recordReplayFixtureActivity } = proxyActivities<{ recordReplayFixtureActivity(): Promise<string> }>({
  startToCloseTimeout: "1 minute"
});

export async function replayDeterminismFixtureWorkflow(): Promise<string> {
  return recordReplayFixtureActivity();
}
