export type TaskStatus = "TODO" | "DOING" | "DONE";

export interface TaskRecord {
  id: string;
  operationKey: string;
  title: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
}

export interface DemoState {
  records: TaskRecord[];
}

export interface PublicTask {
  id: string;
  operationKey: string;
  title: string;
  name: string;
  status: TaskStatus;
  syncStatus: "SYNCED";
  source: "sample";
  accountId: null;
  contactId: null;
  sheetRow: null;
  createdAt: string;
  updatedAt: string;
}

export interface DemoRuntimeConfig {
  projectId: string;
  variantId: string;
  mode: "SAMPLE" | "LIVE";
  sampleData: boolean;
  source: "sample" | "salesforce";
  runId: string;
  runtime: { node: string; entry: string };
}

export interface ListResponse<T> {
  data: T[];
  page: number;
  pageSize: number;
  totalItems: number;
  source: "sample" | "salesforce";
  refreshedAt: string;
}
