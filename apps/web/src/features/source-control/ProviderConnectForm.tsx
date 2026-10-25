import React, { useId, useState } from "react";
import type { RepositoryProviderState } from "@space/contracts";
import { repositoryProviderSettings } from "./client.js";
import { providerLabel } from "./ProviderIcon.js";
import "./repository-providers.css";

function initialValues(state: RepositoryProviderState): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of state.authFields) {
    if (field.type === "password") continue;
    if (field.key === "serverUrl") values[field.key] = state.connection.serverUrl || state.defaultServerUrl || "";
    if (field.key === "organization" && state.connection.status !== "NOT_CONNECTED") values[field.key] = state.connection.serverUrl;
  }
  return values;
}

/** Shared credential form for Plugins, Source Control and the project picker. Secrets are never prefilled or echoed. */
export function ProviderConnectForm({ state, onConnected, onCancel, autoFocus = false, reconnect = false, openDockOnConnect = false }: {
  state: RepositoryProviderState; onConnected: () => void | Promise<void>; onCancel?: () => void; autoFocus?: boolean; reconnect?: boolean; openDockOnConnect?: boolean;
}) {
  const id = useId();
  const [values, setValues] = useState(() => initialValues(state));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = providerLabel(state.id);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); event.stopPropagation();
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const credentials = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.trim()]).filter(([, value]) => value));
      const result = await repositoryProviderSettings.connect(state.id, credentials);
      if (result.status !== "CONNECTED") throw new Error(result.error || `${label} did not confirm the account.`);
      repositoryProviderSettings.changed(openDockOnConnect ? { openDock: true } : undefined);
      await onConnected();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `${label} could not be connected.`);
    } finally { setBusy(false); }
  };
  return (
    <form className="repository-provider-form" onSubmit={submit} aria-label={`${reconnect ? "Reconnect" : "Connect"} ${label}`} aria-busy={busy}>
      {state.authFields.map((field, index) => (
        <label key={field.key} htmlFor={`${id}-${field.key}`}>
          <span>{field.label}{field.required ? <span aria-hidden="true"> *</span> : null}</span>
          <input id={`${id}-${field.key}`} name={field.key} type={field.type === "url" ? "url" : field.type} required={field.required}
            autoComplete={field.type === "password" ? "new-password" : "off"} spellCheck={false} autoFocus={autoFocus && index === 0}
            placeholder={field.placeholder || (field.key === "serverUrl" ? state.defaultServerUrl : "")}
            value={values[field.key] ?? ""} onChange={event => setValues(current => ({ ...current, [field.key]: event.target.value }))} disabled={busy} />
          {field.description ? <small>{field.description}</small> : null}
        </label>
      ))}
      {state.id === "bitbucket" ? <small>Use an Atlassian API token with repository scopes. App passwords are not supported.</small> : null}
      {state.id === "azure-devops" ? <small>Use https://dev.azure.com/your-organization and a PAT with Code (Read &amp; write) and Project (Read) scopes.</small> : null}
      {error ? <p role="alert" className="repository-provider-error">{error}</p> : null}
      <div className="repository-provider-form-actions">
        {onCancel ? <button type="button" onClick={onCancel} disabled={busy}>Cancel</button> : null}
        <button type="submit" className="is-primary" disabled={busy}>{busy ? "Connecting…" : reconnect ? `Reconnect ${label}` : `Connect ${label}`}</button>
      </div>
    </form>
  );
}
