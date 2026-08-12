import type {
  SourceControlConnection,
  SourceControlProvider
} from "@space/contracts";
import { CheckCircle2, GitBranch, Loader2, RefreshCw, Unplug } from "../ui-theme/app-icons.js";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../../api.js";
import { SettingsActionMenu } from "../settings/SettingsActionMenu.js";
import "./source-control-publishing.css";

export interface SourceControlPublishingClient {
  listSourceControlConnections(): Promise<{ data: SourceControlConnection[] }>;
  replaceSourceControlConnection(
    provider: SourceControlProvider,
    token: string
  ): Promise<SourceControlConnection>;
  verifySourceControlConnection(provider: SourceControlProvider): Promise<SourceControlConnection>;
  disconnectSourceControlConnection(provider: SourceControlProvider): Promise<SourceControlConnection>;
}

const providers: SourceControlProvider[] = ["gitea", "github"];

function providerLabel(provider: SourceControlProvider): string {
  return provider === "gitea" ? "Gitea" : "GitHub";
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message.trim() ? reason.message : fallback;
}

export function SourceControlPublishingCard({
  canManage,
  client = api
}: {
  canManage: boolean;
  client?: SourceControlPublishingClient;
}) {
  const [connections, setConnections] = useState<SourceControlConnection[]>([]);
  const [tokens, setTokens] = useState<Record<SourceControlProvider, string>>({
    gitea: "",
    github: ""
  });
  const [loading, setLoading] = useState(false);
  const [pendingProvider, setPendingProvider] = useState<SourceControlProvider | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState<SourceControlProvider | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    if (!canManage) return;
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const response = await client.listSourceControlConnections();
      if (requestId === requestIdRef.current) setConnections(response.data);
    } catch (reason) {
      if (requestId === requestIdRef.current) {
        setError(errorMessage(reason, "Source-control publishing settings could not be loaded."));
      }
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [canManage, client]);

  useEffect(() => {
    void load();
    return () => {
      requestIdRef.current += 1;
    };
  }, [load]);

  if (!canManage) return null;

  function updateConnection(next: SourceControlConnection) {
    setConnections((current) => [
      ...current.filter((connection) => connection.provider !== next.provider),
      next
    ].sort((left, right) => providers.indexOf(left.provider) - providers.indexOf(right.provider)));
  }

  async function save(provider: SourceControlProvider, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = tokens[provider].trim();
    if (pendingProvider || token.length < 20) return;
    setPendingProvider(provider);
    setError(null);
    setFeedback(null);
    try {
      updateConnection(await client.replaceSourceControlConnection(provider, token));
      setFeedback(`${providerLabel(provider)} publishing credential was verified and stored securely.`);
    } catch (reason) {
      setError(errorMessage(reason, `${providerLabel(provider)} publishing credential was rejected.`));
    } finally {
      setTokens((current) => ({ ...current, [provider]: "" }));
      setPendingProvider(null);
    }
  }

  async function verify(provider: SourceControlProvider) {
    if (pendingProvider) return;
    setPendingProvider(provider);
    setError(null);
    setFeedback(null);
    try {
      updateConnection(await client.verifySourceControlConnection(provider));
      setFeedback(`${providerLabel(provider)} publishing credential is valid.`);
    } catch (reason) {
      await load();
      setError(errorMessage(reason, `${providerLabel(provider)} verification failed.`));
    } finally {
      setPendingProvider(null);
    }
  }

  async function disconnect(provider: SourceControlProvider) {
    if (pendingProvider) return;
    setPendingProvider(provider);
    setError(null);
    setFeedback(null);
    try {
      updateConnection(await client.disconnectSourceControlConnection(provider));
      setFeedback(`${providerLabel(provider)} publishing credential was removed.`);
      setConfirmDisconnect(null);
    } catch (reason) {
      setError(errorMessage(reason, `${providerLabel(provider)} could not be disconnected.`));
    } finally {
      setPendingProvider(null);
    }
  }

  return (
    <section className="agent-settings-card settings-flat-card source-control-publishing-card" aria-label="Source control publishing">
      <div className="agent-settings-section-title settings-flat-heading source-control-publishing-title">
        <GitBranch aria-hidden="true" />
        <span>
          <strong>Source control publishing</strong>
          <small>Protected credentials for fixed Gitea and GitHub repositories.</small>
        </span>
        <SettingsActionMenu
          label="Source control publishing actions"
          disabled={loading || Boolean(pendingProvider)}
          actions={[{
            id: "refresh",
            label: "Refresh connections",
            icon: RefreshCw,
            onSelect: () => void load()
          }]}
        />
      </div>

      <div className="source-control-provider-list">
        {providers.map((provider) => {
          const label = providerLabel(provider);
          const connection = connections.find((candidate) => candidate.provider === provider);
          const connected = connection?.status === "CONNECTED";
          const pending = pendingProvider === provider;
          return (
            <section className="source-control-provider settings-flat-provider" key={provider} aria-label={`${label} publishing connection`}>
              <div className="source-control-provider-heading">
                <span>
                  <strong>{label}</strong>
                  <small>{connection ? `${connection.repositoryOwner}/${connection.repositoryName}` : "spaceapp-owner/spaceapp"}</small>
                </span>
                <div className="settings-flat-heading-actions">
                  <span className={`source-control-status ${connection?.status.toLowerCase() ?? "disconnected"}`}>
                    {connected ? <CheckCircle2 aria-hidden="true" /> : <Unplug aria-hidden="true" />}
                    {connection?.status === "ERROR" ? "Error" : connected ? "Connected" : "Disconnected"}
                  </span>
                  {connection?.secretConfigured ? (
                    <SettingsActionMenu
                      label={`${label} publishing actions`}
                      disabled={Boolean(pendingProvider)}
                      actions={[
                        {
                          id: "verify",
                          label: `Verify ${label}`,
                          icon: RefreshCw,
                          onSelect: () => void verify(provider)
                        },
                        {
                          id: "disconnect",
                          label: `Disconnect ${label}`,
                          icon: Unplug,
                          danger: true,
                          onSelect: () => setConfirmDisconnect(provider)
                        }
                      ]}
                    />
                  ) : null}
                </div>
              </div>

              {connection?.secretConfigured ? (
                <p className="source-control-account">
                  Account <strong>{connection.accountLogin}</strong> · credential stored securely
                </p>
              ) : null}

              <form aria-label={`Connect ${label} publishing`} onSubmit={(event) => void save(provider, event)}>
                <label>
                  <span>{label} access token</span>
                  <input
                    type="password"
                    name={`source-control-${provider}-token`}
                    aria-label={`${label} access token`}
                    autoComplete="new-password"
                    spellCheck={false}
                    value={tokens[provider]}
                    disabled={Boolean(pendingProvider)}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setTokens((current) => ({ ...current, [provider]: value }));
                    }}
                  />
                </label>
                <button
                  type="submit"
                  aria-label={`${connected ? "Replace and verify" : "Save and verify"} ${label} credential`}
                  title={connected ? "Replace and verify credential" : "Save and verify credential"}
                  disabled={Boolean(pendingProvider) || tokens[provider].trim().length < 20}
                >
                  {pending ? <Loader2 className="spin" aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
                </button>
              </form>

              {confirmDisconnect === provider ? (
                <div className="source-control-disconnect-confirmation" role="alertdialog" aria-label={`Confirm ${label} disconnect`}>
                  <p>Remove the stored {label} publishing credential?</p>
                  <div>
                    <button type="button" disabled={Boolean(pendingProvider)} onClick={() => setConfirmDisconnect(null)}>
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="is-danger"
                      aria-label={`Confirm ${label} disconnect`}
                      disabled={Boolean(pendingProvider)}
                      onClick={() => void disconnect(provider)}
                    >
                      Disconnect
                    </button>
                  </div>
                </div>
              ) : null}
            </section>
          );
        })}
      </div>

      {error ? <p className="source-control-feedback error" role="alert">{error}</p> : null}
      {feedback ? <p className="source-control-feedback success" role="status" aria-live="polite">{feedback}</p> : null}
      <p className="settings-flat-note">
        Tokens are write-only: Space verifies them before storage and never returns them to the browser.
      </p>
    </section>
  );
}
