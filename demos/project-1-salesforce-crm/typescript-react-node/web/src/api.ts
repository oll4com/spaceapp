import { useCallback, useEffect, useMemo, useState } from "react";

type DemoMode = "SAMPLE" | "LIVE";

export interface AccountRow {
  id: string;
  name: string;
  contactName: string | null;
  contactId: string | null;
  email?: string | null;
  createdAt: string | null;
  source: "salesforce" | "sample";
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
  steps: Array<{ key: string; status: string; message: string | null; externalId?: string | null }>;
  lastError: string | null;
  source: "salesforce" | "sample";
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeConfig {
  projectId: string;
  variantId: string;
  mode: DemoMode;
  sampleData: boolean;
  source: "salesforce" | "sample";
  runId: string;
}

export interface ConnectorStatus {
  mode: DemoMode;
  accountsSource: "salesforce" | "sample";
  sheetsReady: boolean;
  salesforceInstanceUrl: string | null;
  sampleData: boolean;
  pending: number;
  failed: number;
}

export interface AccountsResponse {
  data: AccountRow[];
  page: number;
  pageSize: number;
  totalItems: number;
  source: "salesforce" | "sample";
  refreshedAt: string;
}

export interface RecordsResponse {
  data: OperationRow[];
  pending?: number;
  failed?: number;
}

export interface CreateFormState {
  name: string;
  contactLastName: string;
  firstName: string;
  email: string;
  phone: string;
  website: string;
}

export interface CreateResult {
  id: string;
  operationKey: string;
  syncStatus: string;
  duplicate?: boolean;
}

interface ApiErrorPayload {
  error?: { code?: string; message?: string };
}

export async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}), ...(init?.headers ?? {}) }
    });
  } catch (err) {
    throw new Error(err instanceof Error ? `Connection error: ${err.message}` : "Network connection failed.");
  }
  const text = await response.text();
  let payload: (T & ApiErrorPayload) | null = null;
  try {
    payload = (text.length > 0 ? JSON.parse(text) : {}) as T & ApiErrorPayload;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `Request failed with HTTP ${response.status}`);
  }
  return payload as T;
}

export const emptyForm: CreateFormState = {
  name: "",
  contactLastName: "",
  firstName: "",
  email: "",
  phone: "",
  website: ""
};

export function newOperationKey(): string {
  return `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function useSalesforceDemo() {
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [status, setStatus] = useState<ConnectorStatus | null>(null);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [accountsTotal, setAccountsTotal] = useState(0);
  const [records, setRecords] = useState<OperationRow[]>([]);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const pageSize = 10;

  const loadAccounts = useCallback(async (search: string, targetPage: number): Promise<AccountsResponse> => {
    const query = new URLSearchParams({ page: String(targetPage), pageSize: String(pageSize) });
    if (search.trim().length > 0) query.set("search", search.trim());
    return requestJson<AccountsResponse>(`api/accounts?${query.toString()}`);
  }, []);

  const refresh = useCallback(
    async (search: string, targetPage: number): Promise<void> => {
      try {
        const [accountPayload, recordPayload, statusPayload] = await Promise.all([
          loadAccounts(search, targetPage),
          requestJson<RecordsResponse>("api/records"),
          requestJson<ConnectorStatus>("api/status").catch(() => null)
        ]);
        setAccounts(accountPayload.data ?? []);
        setAccountsTotal(accountPayload.totalItems ?? 0);
        setRecords(recordPayload.data ?? []);
        if (statusPayload !== null) {
          setStatus(statusPayload);
        }
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not load the demo data.");
      }
    },
    [loadAccounts]
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [configPayload, statusPayload] = await Promise.all([
          requestJson<RuntimeConfig>("api/config"),
          requestJson<ConnectorStatus>("api/status").catch(() => null)
        ]);
        if (!cancelled) {
          setConfig(configPayload);
          if (statusPayload !== null) setStatus(statusPayload);
        }
      } catch {
        if (!cancelled) setError("Could not read the runtime configuration.");
      }
      if (!cancelled) await refresh("", 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const liveReady = useMemo(
    () => (status ? status.sheetsReady && status.accountsSource === "salesforce" : false),
    [status]
  );

  return {
    config,
    status,
    accounts,
    accountsTotal,
    records,
    page,
    pageSize,
    error,
    liveReady,
    setPage,
    setError,
    refresh
  };
}

export function useCreateOperation(onCreated: () => Promise<void>) {
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (form: CreateFormState, mode: DemoMode | undefined): Promise<void> => {
      setSubmitting(true);
      setNotice(null);
      setError(null);
      try {
        const result = await requestJson<CreateResult>("api/records", {
          method: "POST",
          body: JSON.stringify({ ...form, operationKey: newOperationKey() })
        });
        setNotice(
          result.duplicate
            ? "The same operation key already exists; the original record was reused."
            : mode === "LIVE"
              ? `Queued as ${result.id}. Salesforce Account, Contact and the Google Sheets row are processed in order.`
              : `Created locally as ${result.id} with sample ids.`
        );
        await onCreated();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not create the record.");
      } finally {
        setSubmitting(false);
      }
    },
    [onCreated]
  );

  return { submitting, notice, error, submit, clearError: () => setError(null) };
}
