import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { WorkflowHandle } from "@temporalio/client";
import proto from "@temporalio/proto";

/** Remove test-host identifiers without changing recorded commands or payloads. */
export function redactHistoryMetadata(value: unknown, workspaceRoot: string): unknown {
  if (!workspaceRoot) throw new Error("A workspace root is required");
  if (Array.isArray(value)) return value.map(entry => redactHistoryMetadata(entry, workspaceRoot));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (key === "identity" && typeof entry === "string") return [key, "synthetic-test-worker"];
    if (key === "stackTrace" && typeof entry === "string") {
      return [key, entry.replaceAll(workspaceRoot, "/spaceapp").replaceAll(workspaceRoot.replaceAll("\\", "/"), "/spaceapp")];
    }
    return [key, redactHistoryMetadata(entry, workspaceRoot)];
  }));
}

/** Record only synthetic executions from the explicit history-recording command. */
export async function recordWorkflowHistory(name: string, handle: WorkflowHandle): Promise<void> {
  if (process.env.SPACE_RECORD_WORKFLOW_HISTORIES !== "1") return;
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(name)) throw new Error("Invalid history fixture name");
  const directory = process.env.SPACE_WORKFLOW_HISTORY_OUTPUT
    ? pathToFileURL(resolve(process.env.SPACE_WORKFLOW_HISTORY_OUTPUT) + "/")
    : new URL("../fixtures/workflow-histories/", import.meta.url);
  await mkdir(directory, { recursive: true });
  // Use the SDK's generated protobuf conversion, preserving bytes and int64s.
  // The protojson helper requires a shared protobufjs Type instance across packages.
  const history = proto.temporal.api.history.v1.History.toObject(proto.temporal.api.history.v1.History.fromObject(await handle.fetchHistory()), {
    longs: String, enums: String, bytes: String
  });
  const workspaceRoot = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/[\\/]$/, "");
  const fixture = { workflowId: handle.workflowId, history: redactHistoryMetadata(history, workspaceRoot) };
  await writeFile(fileURLToPath(new URL(`${name}.json`, directory)), JSON.stringify(fixture, null, 2) + "\n", {
    encoding: "utf8",
    flag: process.env.SPACE_REPLACE_PATCHED_HISTORIES === "1" ? "w" : "wx"
  });
}
