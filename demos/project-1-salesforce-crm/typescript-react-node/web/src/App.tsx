import { useCallback, useState } from "react";
import {
  emptyForm,
  requestJson,
  useCreateOperation,
  useSalesforceDemo,
  type CreateFormState,
  type OperationRow
} from "./api";

const syncTone: Record<string, string> = {
  SYNCED: "chip chip-ok",
  PENDING: "chip chip-pending",
  RUNNING: "chip chip-pending",
  PARTIAL: "chip chip-warn",
  FAILED: "chip chip-error"
};

export function App() {
  const demo = useSalesforceDemo();
  const [form, setForm] = useState<CreateFormState>(emptyForm);
  const [search, setSearch] = useState("");
  const [retryNotice, setRetryNotice] = useState<string | null>(null);

  const afterCreate = useCallback(async () => {
    setForm(emptyForm);
    demo.setPage(1);
    await demo.refresh("", 1);
  }, [demo]);

  const create = useCreateOperation(afterCreate);
  const error = create.error ?? demo.error;
  const pageCount = Math.max(1, Math.ceil(demo.accountsTotal / demo.pageSize));
  const badge = demo.config ? `${demo.config.mode} · ${demo.config.variantId}` : "loading";

  async function retry(record: OperationRow): Promise<void> {
    create.clearError();
    setRetryNotice(null);
    try {
      const payload = await requestJson<{ operationKey: string }>(`api/records/${encodeURIComponent(record.id)}/retry`, {
        method: "POST",
        body: JSON.stringify({})
      });
      setRetryNotice(`Retry accepted for ${payload.operationKey}; only the missing step is repeated.`);
      await demo.refresh(search, demo.page);
    } catch (cause) {
      demo.setError(cause instanceof Error ? cause.message : "Could not retry the operation.");
    }
  }

  return (
    <div className="demo-shell">
      <header className="demo-header">
        <div>
          <h1>Salesforce CRM → Google Sheets</h1>
          <p className="demo-subtitle">Project 1 · TypeScript · React · Node.js</p>
        </div>
        <span className={`badge ${demo.config?.mode === "LIVE" ? "badge-live" : "badge-sample"}`}>{badge}</span>
      </header>

      {demo.config?.mode === "LIVE" && demo.status !== null && !demo.liveReady ? (
        <p className="alert alert-warn">
          Connection required: finish the Salesforce and Google Sheets connections in the Demo Projects pane, then restart this
          run.
        </p>
      ) : null}

      <form
        className="card"
        onSubmit={(event) => {
          event.preventDefault();
          void create.submit(form, demo.config?.mode);
        }}
      >
        <div className="grid">
          <label className="field">
            <span>Account Name *</span>
            <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} maxLength={200} />
          </label>
          <label className="field">
            <span>Contact Last Name *</span>
            <input
              value={form.contactLastName}
              onChange={(event) => setForm({ ...form, contactLastName: event.target.value })}
              maxLength={200}
            />
          </label>
          <label className="field">
            <span>First Name</span>
            <input value={form.firstName} onChange={(event) => setForm({ ...form, firstName: event.target.value })} maxLength={160} />
          </label>
          <label className="field">
            <span>Email</span>
            <input value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} maxLength={300} />
          </label>
          <label className="field">
            <span>Phone</span>
            <input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} maxLength={60} />
          </label>
          <label className="field">
            <span>Website</span>
            <input value={form.website} onChange={(event) => setForm({ ...form, website: event.target.value })} maxLength={300} />
          </label>
        </div>
        <div className="row spread">
          <p className="hint">Typed client and compiled server; the Sheets row records both real Salesforce ids.</p>
          <button
            type="submit"
            disabled={create.submitting || form.name.trim().length < 2 || form.contactLastName.trim().length < 2}
          >
            {create.submitting ? "Submitting…" : "Create Account"}
          </button>
        </div>
      </form>

      {error ? <p className="alert alert-error">{error}</p> : null}
      {create.notice ? <p className="alert alert-ok">{create.notice}</p> : null}
      {retryNotice ? <p className="alert alert-ok">{retryNotice}</p> : null}

      <section className="card">
        <div className="row spread">
          <h2>
            Existing accounts ({demo.accountsTotal}) · {demo.config?.mode === "LIVE" ? "Salesforce API" : "sample dataset"}
          </h2>
          <div className="row">
            <input className="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search accounts" />
            <button type="button" className="ghost" onClick={() => void demo.refresh(search, demo.page)}>
              Refresh
            </button>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th>Account ID</th>
              <th>Contact</th>
              <th>Contact ID</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {demo.accounts.map((account) => (
              <tr key={account.id}>
                <td>{account.name}</td>
                <td className="mono">{account.id}</td>
                <td>{account.contactName ?? "—"}</td>
                <td className="mono">{account.contactId ?? "—"}</td>
                <td className="mono">{account.createdAt ? new Date(account.createdAt).toLocaleString() : "—"}</td>
              </tr>
            ))}
            {demo.accounts.length === 0 ? (
              <tr>
                <td colSpan={5} className="empty">
                  No accounts returned yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <div className="row spread">
          <button
            type="button"
            className="ghost"
            disabled={demo.page <= 1}
            onClick={() => demo.setPage(Math.max(1, demo.page - 1))}
          >
            Previous
          </button>
          <span className="hint">
            Page {demo.page} of {pageCount}
          </span>
          <button
            type="button"
            className="ghost"
            disabled={demo.page >= pageCount}
            onClick={() => demo.setPage(demo.page + 1)}
          >
            Next
          </button>
        </div>
      </section>

      <section className="card">
        <div className="row spread">
          <h2>Operations ({demo.records.length})</h2>
          <span className="hint">
            {demo.config?.mode === "LIVE"
              ? "Salesforce and Google Sheets are separate external steps; a failure keeps the ids already created."
              : "Sample records are written inside this run workspace only."}
          </span>
        </div>
        <table>
          <thead>
            <tr>
              <th>Operation</th>
              <th>Account</th>
              <th>Contact ID</th>
              <th>Sheet row</th>
              <th>Sync</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {demo.records.map((record) => (
              <tr key={record.id}>
                <td className="mono">{record.operationKey}</td>
                <td>
                  {record.name}
                  <div className="mono">{record.accountId ?? "—"}</div>
                </td>
                <td className="mono">{record.contactId ?? "—"}</td>
                <td className="mono">{record.sheetRow ?? "—"}</td>
                <td>
                  <span className={syncTone[record.syncStatus] ?? "chip"}>{record.syncStatus}</span>
                  {record.lastError ? <div className="hint">{record.lastError}</div> : null}
                </td>
                <td>
                  {demo.config?.mode === "LIVE" && (record.syncStatus === "FAILED" || record.syncStatus === "PARTIAL") ? (
                    <button type="button" className="ghost" onClick={() => void retry(record)}>
                      Retry sync
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
            {demo.records.length === 0 ? (
              <tr>
                <td colSpan={6} className="empty">
                  No operations yet.
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
