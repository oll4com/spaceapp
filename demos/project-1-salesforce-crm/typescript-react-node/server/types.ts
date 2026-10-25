export type DemoMode = "SAMPLE" | "LIVE";

export interface AccountRow {
  id: string;
  name: string;
  contactName: string | null;
  contactId: string | null;
  email?: string | null;
  createdAt: string | null;
  source: "salesforce" | "sample";
}

export interface SyncStep {
  key: string;
  status: string;
  message: string | null;
  externalId?: string | null;
}

export interface OperationRow {
  id: string;
  operationKey: string;
  name: string;
  accountId: string | null;
  contactId: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  sheetRow: number | null;
  syncStatus: string;
  steps: SyncStep[];
  lastError: string | null;
  source: "salesforce" | "sample";
  createdAt: string;
  updatedAt: string;
}

export interface SampleRecord {
  id: string;
  operationKey: string;
  name: string;
  accountId: string;
  contactId: string;
  contactName: string;
  email: string | null;
  phone: string | null;
  website: string | null;
  sheetRow: number;
  syncStatus: string;
  steps: SyncStep[];
  createdAt: string;
  updatedAt: string;
}

export interface DemoState {
  records: SampleRecord[];
  accounts: AccountRow[];
}

export interface ValidatedCreate {
  errors: string[];
  value: {
    name: string;
    contactLastName: string;
    operationKey: string;
    email: string | null;
    phone: string | null;
    website: string | null;
    firstName: string | null;
  };
}

export interface ConnectorOperation {
  id: string;
  operationKey: string;
  accountName: string;
  contactLastName: string;
  firstName: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  salesforceAccountId: string | null;
  salesforceContactId: string | null;
  sheetsRow: number | null;
  status: string;
  steps: Array<{ key: string; status: string; message: string | null; externalId: string | null }>;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorStatus {
  mode: DemoMode;
  accountsSource: "salesforce" | "sample";
  sheetsReady: boolean;
  sheetsRowCount: number | null;
  salesforceInstanceUrl: string | null;
  sampleData: boolean;
  pending: number;
  failed: number;
}

export interface ConnectorError extends Error {
  code?: string;
  status?: number;
}
