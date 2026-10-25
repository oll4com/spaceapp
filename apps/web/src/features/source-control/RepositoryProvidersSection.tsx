import React, { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "../ui-theme/app-icons.js";
import type { RepositoryProviderId, RepositoryProviderState } from "@space/contracts";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { SOURCE_CONTROL_CONNECTION_EVENT, repositoryProviderSettings, sourceControlClient, type SourceControlClient } from "./client.js";
import { ProviderConnectForm } from "./ProviderConnectForm.js";
import { ProviderIcon, availabilityLabel, providerAvailability } from "./ProviderIcon.js";
import "./repository-providers.css";

/** Plugins group: one card per repository service with its own personal toggle, credentials, test and status. */
export function RepositoryProvidersSection({ client = sourceControlClient, filter = "" }: { client?: SourceControlClient; filter?: string }) {
  const [states, setStates] = useState<RepositoryProviderState[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState<RepositoryProviderId | null>(null);
  const [busy, setBusy] = useState<RepositoryProviderId | null>(null);
  const [messages, setMessages] = useState<Partial<Record<RepositoryProviderId, { tone: "ok" | "error"; text: string }>>>({});
  const load = useCallback(async (signal?: AbortSignal) => {
    try { const next = await client.providers(signal); if (!signal?.aborted) { setStates(next); setLoadError(null); } }
    catch (error) { if (!signal?.aborted) setLoadError(error instanceof Error ? error.message : "Repository providers could not load."); }
  }, [client]);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const refresh = () => void load();
    window.addEventListener(SOURCE_CONTROL_CONNECTION_EVENT, refresh);
    return () => { controller.abort(); window.removeEventListener(SOURCE_CONTROL_CONNECTION_EVENT, refresh); };
  }, [load]);
  const run = async (provider: RepositoryProviderId, action: () => Promise<{ tone: "ok" | "error"; text: string } | void>) => {
    if (busy) return;
    setBusy(provider);
    try { const message = await action(); if (message) setMessages(current => ({ ...current, [provider]: message })); }
    catch (error) { setMessages(current => ({ ...current, [provider]: { tone: "error", text: error instanceof Error ? error.message : "The request failed." } })); }
    finally { setBusy(null); repositoryProviderSettings.changed(); }
  };
  const needle = filter.trim().toLowerCase();
  const visible = (states ?? []).filter(state => !needle || state.label.toLowerCase().includes(needle) || "repository provider git".includes(needle));
  if (states && !visible.length) return null;
  return (
    <section className="repository-providers-section" aria-labelledby="repository-providers-heading">
      <div className="repository-providers-heading">
        <h3 id="repository-providers-heading">Repository Providers</h3>
        <p>Personal accounts for cloning, Source Control and publishing. Turning one off hides it from pickers without removing its account or projects.</p>
      </div>
      {loadError ? <p role="alert" className="repository-provider-error">{loadError}</p> : null}
      {!states && !loadError ? <p role="status" className="repository-provider-muted">Loading repository providers…</p> : null}
      <div className="repository-providers-grid">
        {visible.map(state => {
          const availability = providerAvailability(state), connected = state.connection.status === "CONNECTED";
          const message = messages[state.id];
          return (
            <article key={state.id} className={`repository-provider-card is-${availability}`} data-provider-id={state.id} aria-label={`${state.label} repository provider`}>
              <header>
                <span className="repository-provider-icon"><ProviderIcon provider={state.id} size={18} /></span>
                <span className="repository-provider-title">
                  <strong>{state.label}</strong>
                  <small>{connected ? `${state.connection.accountLogin ?? "Connected"}${state.connection.serverUrl && !["github", "bitbucket"].includes(state.id) ? ` · ${state.connection.serverUrl.replace(/^https?:\/\//, "")}` : ""}` : state.connection.status === "ERROR" ? state.connection.error || "The saved credentials need attention." : "Not connected"}</small>
                </span>
                <span className={`repository-provider-status is-${availability}`}>{availabilityLabel[availability]}</span>
              </header>
              <SpaceToggle className="repository-provider-toggle" label="Show in project pickers" checked={state.enabled} disabled={busy === state.id}
                ariaLabel={`Enable ${state.label}`}
                detail={state.enabled ? "Available in Source Control and Open project." : "Hidden. The account and projects are kept."}
                onChange={enabled => void run(state.id, async () => { await repositoryProviderSettings.setEnabled(state.id, enabled); })} />
              <div className="repository-provider-actions">
                {connected ? <>
                  <button type="button" disabled={busy === state.id} onClick={() => void run(state.id, async () => {
                    const result = await repositoryProviderSettings.test(state.id);
                    return { tone: result.ok ? "ok" : "error", text: result.message };
                  })}><RefreshCw size={13} aria-hidden="true" className={busy === state.id ? "spin" : undefined} />Test connection</button>
                  <button type="button" disabled={busy === state.id} onClick={() => setOpen(current => current === state.id ? null : state.id)} aria-expanded={open === state.id}>Change token</button>
                  <button type="button" className="is-danger" disabled={busy === state.id} onClick={() => void run(state.id, async () => {
                    await repositoryProviderSettings.disconnect(state.id);
                    return { tone: "ok", text: `${state.label} disconnected. Local projects and Git history are unchanged.` };
                  })}>Disconnect</button>
                </> : state.connection.status === "ERROR" ? <>
                  {/* A saved account in error may only be facing a provider outage: retry before replacing the token. */}
                  <button type="button" disabled={busy === state.id} onClick={() => void run(state.id, async () => {
                    const result = await repositoryProviderSettings.test(state.id);
                    return { tone: result.ok ? "ok" : "error", text: result.message };
                  })}><RefreshCw size={13} aria-hidden="true" className={busy === state.id ? "spin" : undefined} />Retry</button>
                  <button type="button" className="is-primary" disabled={busy === state.id} onClick={() => setOpen(current => current === state.id ? null : state.id)} aria-expanded={open === state.id}>Reconnect</button>
                  <button type="button" className="is-danger" disabled={busy === state.id} onClick={() => void run(state.id, async () => {
                    await repositoryProviderSettings.disconnect(state.id);
                    return { tone: "ok", text: `${state.label} disconnected. Local projects and Git history are unchanged.` };
                  })}>Disconnect</button>
                </> : <button type="button" className="is-primary" disabled={busy === state.id} onClick={() => setOpen(current => current === state.id ? null : state.id)} aria-expanded={open === state.id}>
                  Connect
                </button>}
              </div>
              {message ? <p role={message.tone === "error" ? "alert" : "status"} className={message.tone === "error" ? "repository-provider-error" : "repository-provider-ok"}>{message.text}</p> : null}
              {open === state.id ? <ProviderConnectForm state={state} autoFocus openDockOnConnect reconnect={state.connection.status !== "NOT_CONNECTED"}
                onCancel={() => setOpen(null)} onConnected={async () => { setOpen(null); setMessages(current => ({ ...current, [state.id]: { tone: "ok", text: `${state.label} connected.` } })); await load(); }} /> : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
