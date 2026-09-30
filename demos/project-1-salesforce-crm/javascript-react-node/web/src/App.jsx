import { useCallback, useEffect, useMemo, useState } from "react";

const emptyForm = {
  name: "",
  contactLastName: "",
  firstName: "",
  email: "",
  phone: "",
  website: ""
};

const syncTone = {
  SYNCED: "chip chip-ok",
  PENDING: "chip chip-pending",
  RUNNING: "chip chip-pending",
  PARTIAL: "chip chip-warn",
  FAILED: "chip chip-error"
};

function newOperationKey() {
  return `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function App() {
  const [config, setConfig] = useState(null);
  const [status, setStatus] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [accountsTotal, setAccountsTotal] = useState(0);
  const [accountsError, setAccountsError] = useState(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [records, setRecords] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const pageSize = 10;

  const loadConfig = useCallback(async () => {
    const response = await fetch("api/config", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`Config failed with ${response.status}`);
    return response.json();
  }, []);

  const loadStatus = useCallback(async () => {
    const response = await fetch("api/status", { headers: { accept: "application/json" } });
    if (!response.ok) return null;
    return response.json();
  }, []);

  const loadAccounts = useCallback(
    async (searchTerm, targetPage) => {
      const query = new URLSearchParams({ page: String(targetPage), pageSize: String(pageSize) });
      if (searchTerm.trim().length > 0) query.set("search", searchTerm.trim());
      const response = await fetch(`api/accounts?${query.toString()}`, { headers: { accept: "application/json" } });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error?.message ?? `Accounts failed with ${response.status}`);
      return payload;
    },
    []
  );

  const loadRecords = useCallback(async () => {
    const response = await fetch("api/records", { headers: { accept: "application/json" } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error?.message ?? `Records failed with ${response.status}`);
    return payload;
  }, []);

  const refreshAll = useCallback(
    async (searchTerm = search, targetPage = page) => {
      try {
        const [accountPayload, recordPayload, statusPayload] = await Promise.all([
          loadAccounts(searchTerm, targetPage),
          loadRecords(),
          loadStatus()
        ]);
        setAccounts(accountPayload.data ?? []);
        setAccountsTotal(accountPayload.totalItems ?? 0);
        setRecords(recordPayload.data ?? []);
        if (statusPayload !== null) {
          setStatus(statusPayload);
        }
        setAccountsError(null);
      } catch (cause) {
        setAccountsError(cause instanceof Error ? cause.message : "Could not load accounts.");
      }
    },
    [loadAccounts, loadRecords, loadStatus, page, search]
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [configPayload, statusPayload] = await Promise.all([
          loadConfig(),
          loadStatus()
        ]);
        if (!cancelled) {
          setConfig(configPayload);
          if (statusPayload !== null) setStatus(statusPayload);
        }
      } catch {
        if (!cancelled) setError("Could not read the runtime configuration.");
      }
      if (!cancelled) await refreshAll("", 1);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!config) return undefined;
    const timer = setInterval(() => {
      void refreshAll(search, page);
    }, config.mode === "LIVE" ? 6_000 : 20_000);
    return () => clearInterval(timer);
  }, [config, page, refreshAll, search]);

  async function submit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("api/records", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...form, operationKey: newOperationKey() })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error?.message ?? `Create failed with ${response.status}`);
      setNotice(
        payload.duplicate
          ? "The same operation key already exists; the original record was reused."
          : config?.mode === "LIVE"
            ? `Queued as ${payload.id}. Salesforce Account, Contact and the Google Sheets row are processed in order.`
            : `Created locally as ${payload.id} with sample ids.`
      );
      setForm(emptyForm);
      setPage(1);
      await refreshAll("", 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the record.");
    } finally {
      setSubmitting(false);
    }
  }

  async function retry(record) {
    setError(null);
    try {
      const response = await fetch(`api/records/${encodeURIComponent(record.id)}/retry`, { method: "POST" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error?.message ?? `Retry failed with ${response.status}`);
      setNotice(`Retry accepted for ${payload.operationKey}; only the missing step is repeated.`);
      await refreshAll();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not retry the operation.");
    }
  }

  async function deleteAccount(account) {
    setError(null);
    setConfirmDeleteId(null);
    try {
      const response = await fetch(`api/accounts/${encodeURIComponent(account.id)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contactId: account.contactId ?? null })
      });
      if (!response.ok && response.status !== 204) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload?.error?.message ?? `Delete failed with ${response.status}`);
      }
      setNotice(`Account "${account.name}" deleted successfully.`);
      const nextPage = page > 1 && accounts.length === 1 ? page - 1 : page;
      setPage(nextPage);
      await refreshAll(search, nextPage);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete the account.");
    }
  }

  const pageCount = Math.max(1, Math.ceil(accountsTotal / pageSize));
  const liveReady = status ? status.sheetsReady && status.accountsSource === "salesforce" : false;
  const badge = useMemo(() => (config ? `${config.mode} · ${config.variantId}` : "loading"), [config]);

  return (
    <div className="demo-shell">
      <header className="demo-header">
        <div>
          <h1>Salesforce CRM → Google Sheets</h1>
          <p className="demo-subtitle">Project 1 · JavaScript · React · Node.js</p>
        </div>
        <span className={`badge ${config?.mode === "LIVE" ? "badge-live" : "badge-sample"}`}>{badge}</span>
      </header>

      {config?.mode === "LIVE" && status !== null && !liveReady ? (
        <p className="alert alert-warn">
          Connection required: finish the Salesforce and Google Sheets connections in the Demo Projects pane, then restart
          this run.
        </p>
      ) : null}

      <form className="card" onSubmit={submit}>
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
          <p className="hint">
            Account and Contact are created as separate Salesforce records; the Google Sheets row stores both real ids.
          </p>
          <button type="submit" disabled={submitting || form.name.trim().length < 2 || form.contactLastName.trim().length < 2}>
            {submitting ? "Submitting…" : "Create Account"}
          </button>
        </div>
      </form>

      {error ? <p className="alert alert-error">{error}</p> : null}
      {notice ? <p className="alert alert-ok">{notice}</p> : null}

      <section className="card">
        <div className="row spread">
          <h2>
            Existing accounts ({accountsTotal}) · {config?.mode === "LIVE" ? "Salesforce API" : "sample dataset"}
          </h2>
          <div className="row">
            <input className="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search accounts" />
            <button type="button" className="ghost" onClick={() => refreshAll(search, page)}>
              Refresh
            </button>
          </div>
        </div>
        {accountsError ? <p className="alert alert-error">{accountsError}</p> : null}
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th>Account ID</th>
              <th>Contact</th>
              <th>Contact ID</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => (
              <tr key={account.id}>
                <td>{account.name}</td>
                <td className="mono">{account.id}</td>
                <td>{account.contactName ?? "—"}</td>
                <td className="mono">{account.contactId ?? "—"}</td>
                <td className="mono">{account.createdAt ? new Date(account.createdAt).toLocaleString() : "—"}</td>
                <td>
                  {confirmDeleteId === account.id ? (
                    <span className="inline-confirm">
                      <span className="hint">Delete?</span>
                      <button type="button" className="ghost danger" onClick={() => deleteAccount(account)}>
                        Yes, delete
                      </button>
                      <button type="button" className="ghost" onClick={() => setConfirmDeleteId(null)}>
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button type="button" className="ghost danger" onClick={() => setConfirmDeleteId(account.id)}>
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {accounts.length === 0 ? (
              <tr>
                <td colSpan={6} className="empty">
                  No accounts returned yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <div className="row spread">
          <button type="button" className="ghost" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
            Previous
          </button>
          <span className="hint">
            Page {page} of {pageCount}
          </span>
          <button type="button" className="ghost" disabled={page >= pageCount} onClick={() => setPage((value) => value + 1)}>
            Next
          </button>
        </div>
      </section>

      <section className="card">
        <div className="row spread">
          <h2>Operations ({records.length})</h2>
          <span className="hint">
            {config?.mode === "LIVE"
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
            {records.map((record) => (
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
                  {config?.mode === "LIVE" && (record.syncStatus === "FAILED" || record.syncStatus === "PARTIAL") ? (
                    <button type="button" className="ghost" onClick={() => retry(record)}>
                      Retry sync
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
            {records.length === 0 ? (
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
