import { Client, Connection } from "@temporalio/client";

/** The part of the Temporal workflow client the API starters use. */
export type TemporalWorkflowClient = { workflow: Pick<Client["workflow"], "start" | "signalWithStart" | "getHandle"> };

export interface TemporalClientLease {
  client: TemporalWorkflowClient;
  close(): Promise<void>;
}

/** Opens a short-lived client; injectable so tests can capture start options. */
export type TemporalClientFactory = (options: { address: string; namespace: string }) => Promise<TemporalClientLease>;

export const connectTemporalClient: TemporalClientFactory = async ({ address, namespace }) => {
  const connection = await Connection.connect({ address, connectTimeout: "5s" });
  return { client: new Client({ connection, namespace }), close: () => connection.close() };
};
