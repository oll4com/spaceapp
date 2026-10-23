import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { temporal } from "@temporalio/proto";
import type { WorkflowHandle } from "@temporalio/client";

/** Recording is explicit: ordinary tests must never bless changed workflow behavior. */
export async function recordWorkflowHistory(handle: WorkflowHandle, fixtureName: string): Promise<void> {
  if (process.env.SPACE_RECORD_TEMPORAL_HISTORIES !== "1") return;
  if (!/^[a-z0-9-]+$/.test(fixtureName)) throw new Error("Invalid synthetic history fixture name");
  const directory = fileURLToPath(new URL("../fixtures/workflow-histories/", import.meta.url));
  await mkdir(directory, { recursive: true });
  const history = await handle.fetchHistory();
  // Host identities and host stack paths are diagnostic only. Event IDs,
  // commands, payloads and ordering remain the real test-server output.
  // Use the generated message conversion consistently. The pinned dependency
  // tree contains separate protobufjs instances, whose reflected Type objects
  // cannot be exchanged by the SDK's historyToJSON helper.
  const History = temporal.api.history.v1.History;
  const original = History.fromObject(history);
  const json = History.toObject(original, { longs: String, enums: String, bytes: String });
  const restored = History.fromObject(JSON.parse(JSON.stringify(json)));
  if (!Buffer.from(History.encode(original).finish()).equals(Buffer.from(History.encode(restored).finish()))) {
    throw new Error("History JSON did not preserve the real server's protobuf bytes");
  }
  const sanitized = JSON.stringify({ workflowId: handle.workflowId, history: json }, (key, value) => key === "identity"
    ? "spaceapp-synthetic-tests" : key === "stackTrace" ? "" : value, 2);
  await writeFile(`${directory}/${fixtureName}.json`, `${sanitized}\n`, "utf8");
}
