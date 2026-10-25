import { useCallback, useEffect, useState } from "react";

type TaskStatus = "TODO" | "DOING" | "DONE";

interface TaskRow {
  id: string;
  operationKey: string;
  title: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
}

interface ListResponse {
  data: TaskRow[];
  page: number;
  pageSize: number;
  totalItems: number;
  source: "sample" | "salesforce";
  refreshedAt: string;
}

interface RuntimeConfig {
  projectId: string;
  variantId: string;
  mode: "SAMPLE" | "LIVE";
  runId: string;
}

interface ApiError {
  error?: { code?: string; message?: string };
}

const statuses: readonly TaskStatus[] = ["TODO", "DOING", "DONE"];

function newOperationKey(): string {
  return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function messageOf(payload: ApiError, fallback: string): string {
  return payload.error?.message ?? fallback;
}

export function App() {
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [records, setRecords] = useState<TaskRow[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [search, setSearch] = useState("");
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState<TaskStatus>("TODO");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async (searchTerm: string): Promise<void> => {
    const query = new URLSearchParams({ page: "1", pageSize: "25" });
    if (searchTerm.trim().length > 0) query.set("search", searchTerm.trim());
    try {
      const response = await fetch(`api/records?${query.toString()}`, { headers: { accept: "application/json" } });
      const payload = (await response.json()) as ListResponse;
      if (!response.ok) throw new Error(`List failed with ${response.status}`);
      setRecords(payload.data ?? []);
      setTotalItems(payload.totalItems ?? 0);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load tasks.");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("api/config", { headers: { accept: "application/json" } });
        const payload = (await response.json()) as RuntimeConfig;
        if (!cancelled) setConfig(payload);
      } catch {
        if (!cancelled) setError("Could not read the runtime configuration.");
      }
      if (!cancelled) await refresh("");
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  async function createTask(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setNotice(null);
    setError(null);
    try {
      const response = await fetch("api/records", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationKey: newOperationKey(), title, status })
      });
      const payload = (await response.json().catch(() => ({}))) as Partial<TaskRow> & ApiError;
      if (!response.ok) throw new Error(messageOf(payload, `Create failed with ${response.status}`));
      setTitle("");
      setNotice(`Task ${payload.id ?? ""} stored in this run workspace.`);
      await refresh("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the task.");
    } finally {
      setPending(false);
    }
  }

  async function updateStatus(record: TaskRow, next: TaskStatus): Promise<void> {
    setError(null);
    try {
      const response = await fetch(`api/records/${encodeURIComponent(record.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: next })
      });
      if (!response.ok) throw new Error(`Update failed with ${response.status}`);
      await refresh(search);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update the task.");
    }
  }

  async function remove(record: TaskRow): Promise<void> {
    setError(null);
    try {
      const response = await fetch(`api/records/${encodeURIComponent(record.id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(`Delete failed with ${response.status}`);
      await refresh(search);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete the task.");
    }
  }

  const badge = config ? `${config.mode} · ${config.variantId}` : "loading";

  return (
    <div className="demo-shell">
      <header className="demo-header">
        <div>
          <h1>CRUD Playground</h1>
          <p className="demo-subtitle">Project 2 · TypeScript · React · Node.js</p>
        </div>
        <span className={`badge ${config?.mode === "LIVE" ? "badge-live" : "badge-sample"}`}>{badge}</span>
      </header>

      <form className="card" onSubmit={createTask}>
        <div className="row">
          <label className="field">
            <span>Task title</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Review the Salesforce sync" maxLength={160} />
          </label>
          <label className="field small">
            <span>Status</span>
            <select value={status} onChange={(event) => setStatus(event.target.value as TaskStatus)}>
              {statuses.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={pending || title.trim().length < 3}>
            {pending ? "Creating…" : "Create task"}
          </button>
        </div>
        <p className="hint">Compiled TypeScript server, typed React client, workspace-local persistence.</p>
      </form>

      {error ? <p className="alert alert-error">{error}</p> : null}
      {notice ? <p className="alert alert-ok">{notice}</p> : null}

      <section className="card">
        <div className="row spread">
          <h2>Tasks ({totalItems})</h2>
          <div className="row">
            <input className="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search title" />
            <button type="button" className="ghost" onClick={() => void refresh(search)}>
              Refresh
            </button>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Title</th>
              <th>Status</th>
              <th>Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {records.map((record) => (
              <tr key={record.id}>
                <td className="mono">{record.id}</td>
                <td>{record.title}</td>
                <td>
                  <select value={record.status} onChange={(event) => void updateStatus(record, event.target.value as TaskStatus)}>
                    {statuses.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="mono">{new Date(record.updatedAt).toLocaleTimeString()}</td>
                <td>
                  <button type="button" className="ghost danger" onClick={() => void remove(record)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {records.length === 0 ? (
              <tr>
                <td colSpan={5} className="empty">
                  No tasks yet. Create one to prove the runtime, preview and logs.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}

export default App;
