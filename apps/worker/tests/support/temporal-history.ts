import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { temporal } from "@temporalio/proto";

export const historyDirectory = fileURLToPath(new URL("../fixtures/workflow-histories/", import.meta.url));

export interface RecordedWorkflowHistory {
  workflowId: string;
  workflowType: string;
  history: unknown;
}

/** Export only actual time-skipping server histories, never invented events. */
export async function recordHistory(
  handle: { workflowId: string; fetchHistory(): Promise<unknown> },
  label: string
): Promise<void> {
  if (process.env.SPACE_RECORD_TEMPORAL_HISTORIES !== "1") return;
  if (!/^[A-Za-z0-9_-]+$/.test(label)) throw new Error(`Unsafe history label: ${label}`);
  const history = await handle.fetchHistory();
  const json = temporal.api.history.v1.History.toObject(
    history as Parameters<typeof temporal.api.history.v1.History.toObject>[0],
    { longs: String, enums: String, bytes: String, json: true }
  ) as { events?: Array<{ workflowExecutionStartedEventAttributes?: { workflowType?: { name?: string } } }> };
  const workflowType = json.events?.[0]?.workflowExecutionStartedEventAttributes?.workflowType?.name;
  if (!workflowType) throw new Error(`Missing workflow type in actual history: ${label}`);
  const record: RecordedWorkflowHistory = { workflowId: handle.workflowId, workflowType, history: json };
  const destination = join(historyDirectory, `${label}.json`);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await rename(temporary, destination);
}
