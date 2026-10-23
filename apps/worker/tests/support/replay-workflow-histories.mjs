import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Worker } from "@temporalio/worker";
import proto from "@temporalio/proto";
import { fixtureDirectory, workflowNames, workflowPaths } from "./temporal-sandbox.mjs";

export async function loadHistories() {
  const files = (await readdir(fixtureDirectory)).filter(name => name.endsWith(".json")).sort();
  const histories = await Promise.all(files.map(async filename => {
    const json = JSON.parse(await readFile(join(fixtureDirectory, filename), "utf8"));
    const workflowName = json.events[0]?.workflowExecutionStartedEventAttributes?.workflowType?.name;
    assert.ok(workflowNames.includes(workflowName), `Unknown workflow in ${filename}: ${workflowName}`);
    return { filename, workflowName, json, history: proto.temporal.api.history.v1.History.fromObject(json) };
  }));
  for (const name of workflowNames) assert.ok(histories.some(history => history.workflowName === name), `Missing replay fixture: ${name}`);
  assert.ok(histories.some(history => history.filename.includes(".legacy.") && history.workflowName === "roomAgentSupervisorWorkflow"
    && !history.json.events.some(event => event.markerRecordedEventAttributes?.markerName === "core_patch")),
  "Missing pre-patch supervisor history without a patch marker");
  return histories;
}

export async function replayHistories(histories, paths = workflowPaths) {
  const groups = new Map();
  for (const history of histories) {
    const key = history.workflowName === "memoryMutationWorkflow" ? "mutation"
      : history.workflowName.startsWith("memory") ? "maintenance" : "turns";
    const group = groups.get(key) ?? [];
    group.push(history); groups.set(key, group);
  }
  let count = 0;
  for (const [key, group] of groups) {
    const results = Worker.runReplayHistories({ workflowsPath: paths[key],
      bundlerOptions: { webpackConfigHook: config => ({ ...config, stats: "errors-only" }) }
    }, group.map(history => ({ workflowId: history.filename, history: history.history })));
    for await (const result of results) {
      const fixture = group.find(history => history.filename === result.workflowId);
      assert.ok(fixture, `Unknown replay result: ${result.workflowId}`);
      if (result.error) throw new Error(`Replay failed for ${fixture.workflowName} in ${fixture.filename}: ${result.error.message}`, { cause: result.error });
      count++;
    }
  }
  assert.equal(count, histories.length, "Temporal must replay every fixture");
  return count;
}
