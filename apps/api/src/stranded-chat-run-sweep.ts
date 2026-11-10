import type { FastifyInstance } from "fastify";
import { Client, Connection, WorkflowNotFoundError } from "@temporalio/client";
import { nowIso, type SpaceStore } from "@space/runtime";
import type { SpaceApiConfig } from "./config.js";
import { sweepStrandedChatRuns as sweepStrandedChatRunsOnce, type StrandedChatRunSweepDeps } from "./stranded-chat-runs.js";

/**
 * The periodic stranded Chat run sweep (stranded-chat-runs.ts) with its Temporal side: one connection per sweep, opened
 * only when a candidate run needs checking; while Temporal is unreachable every run of that sweep stays as it is.
 */
export function createStrandedChatRunSweep(app: FastifyInstance, options: {
  config: SpaceApiConfig;
  store: SpaceStore;
  dotsRepository: StrandedChatRunSweepDeps["repository"] | null;
}) {
  const { config, store, dotsRepository } = options;
  async function sweepStrandedChatRuns(): Promise<void> {
    if (!dotsRepository || !config.enableCodexTurns) return;
    // One Temporal connection per sweep, opened only when a candidate run needs
    // checking. If Temporal is unreachable, every run of this sweep stays as it is.
    const temporal: { client: Client | null; connection: Connection | null; unreachable: boolean } =
      { client: null, connection: null, unreachable: false };
    try {
      await sweepStrandedChatRunsOnce({
        repository: dotsRepository, store, now: nowIso,
        warn: (fields, message) => app.log.warn(fields, message),
        workflowState: async (workflowId) => {
          if (temporal.unreachable) return "UNKNOWN";
          try {
            if (!temporal.client) {
              temporal.connection = await Connection.connect({ address: config.temporalAddress, connectTimeout: "5s" })
                .catch((error: unknown) => { temporal.unreachable = true; throw error; });
              temporal.client = new Client({ connection: temporal.connection, namespace: config.temporalNamespace });
            }
            return (await temporal.client.workflow.getHandle(workflowId).describe()).status.name === "RUNNING" ? "RUNNING" : "CLOSED";
          } catch (error) {
            return error instanceof WorkflowNotFoundError ? "NOT_FOUND" : "UNKNOWN";
          }
        }
      });
    } finally { await temporal.connection?.close(); }
  }

  return { sweepStrandedChatRuns };
}
