import { useEffect, useState } from "react";
import type { ConnectorCapability, ConnectorsStatus } from "@space/contracts";
import { api } from "../../api.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";

/** What a Dot can ask Google for; organizing mail belongs to Job Copilot, so Dots do not offer it. */
const dotCapabilities: ConnectorCapability[] = ["MAIL_READ", "MAIL_COMPOSE", "CALENDAR"];
const capabilityLabels: Record<ConnectorCapability, string> = { MAIL_READ: "Read email", MAIL_COMPOSE: "Draft and send email", CALENDAR: "Calendar", MAIL_ORGANIZE: "Label and archive email" };
const providerLabels = { GOOGLE: "Google", MICROSOFT: "Microsoft" } as const;
export function connectorStartUrl(provider: "GOOGLE" | "MICROSOFT", capabilities: ConnectorCapability[]): string {
  return `/api/connectors/${provider.toLowerCase()}/start?capabilities=${encodeURIComponent(capabilities.join(","))}`;
}

/** A service the server is not set up for: a plain sentence, the admin's setup steps folded below. */
export function UnavailableProvider({ label, reason }: { label: string; reason: string | null }) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  return <div className="dots-connect-unavailable">
    <span>{t("{label}: not set up on this server yet.", { label })}</span>
    {reason ? <details className="dots-setup-details"><summary>{t("How to set it up")}</summary><p>{reason}</p></details> : null}
  </div>;
}

/** Email and calendar accounts connected to Space, shared by the user's Dots. */
export function DotConnections({ read = api.connectors, disconnect = api.disconnectConnector }: {
  read?: typeof api.connectors; disconnect?: typeof api.disconnectConnector;
}) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [status, setStatus] = useState<ConnectorsStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const [chosen, setChosen] = useState<ConnectorCapability[]>(["MAIL_READ", "MAIL_COMPOSE", "CALENDAR"]);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void Promise.resolve().then(() => read()).then((value) => { if (current) { setStatus(value); setFailed(false); } })
      .catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [revision, read]);
  async function remove(accountId: string) {
    setNotice(null);
    try { await disconnect(accountId); setConfirming(null); setNotice(t("Disconnected. Space no longer has access to that account.")); setRevision((value) => value + 1); }
    catch (error) { setNotice(error instanceof Error ? error.message : t("The account could not be disconnected.")); }
  }
  if (failed && !status) return <section className="dots-connections" aria-label={t("Connected accounts")}><h4>{t("Connected accounts")}</h4><p>{t("Connections unavailable.")}</p></section>;
  if (!status) return <section className="dots-connections" aria-label={t("Connected accounts")}><h4>{t("Connected accounts")}</h4><p role="status">{t("Loading connections…")}</p></section>;
  const toggle = (capability: ConnectorCapability) => setChosen((current) => current.includes(capability)
    ? current.filter((item) => item !== capability) : [...current, capability]);
  return <section className="dots-connections" aria-label={t("Connected accounts")}>
    <h4>{t("Connected accounts")}</h4>
    <p className="dots-panel-hint">{t("Dots read and draft email and check calendars only through accounts you connect here. Sending email and creating events wait for your approval unless you turn that off in Settings → Dots.")}</p>
    {status.accounts.length ? <ul className="dots-records">{status.accounts.map((account) => <li key={account.accountId}>
      <strong>{account.email}</strong>
      <span>{providerLabels[account.provider]} · {account.capabilities.length ? account.capabilities.map((capability) => t(capabilityLabels[capability])).join(", ") : t("No permissions granted")}</span>
      {confirming === account.accountId ? <div className="dots-memory-actions" role="group" aria-label={t("Confirm disconnecting")}>
        <span>{t("Disconnect {email}? Space deletes its stored access.", { email: account.email })}</span>
        <button type="button" className="dots-memory-forget" onClick={() => void remove(account.accountId)}>{t("Disconnect")}</button>
        <button type="button" onClick={() => setConfirming(null)}>{t("Keep")}</button>
      </div> : <div className="dots-memory-actions"><button type="button" onClick={() => setConfirming(account.accountId)}>{t("Disconnect")}</button></div>}
    </li>)}</ul> : <p>{t("No accounts connected.")}</p>}
    <div className="dots-permissions-label">{t("Permissions to ask for")}</div>
    <div className="dots-memory-scopes" role="group" aria-label={t("Permissions to request")}>
      {dotCapabilities.map((capability) => <button key={capability} type="button" aria-pressed={chosen.includes(capability)}
        onClick={() => toggle(capability)}>{t(capabilityLabels[capability])}</button>)}
    </div>
    <div className="dots-connection-providers">
      {status.providers.map((provider) => provider.configured && chosen.length
        ? <a key={provider.provider} className="dots-connect-link" href={connectorStartUrl(provider.provider, chosen)}>{t("Connect {provider}", { provider: providerLabels[provider.provider] })}</a>
        : provider.configured
          ? <span key={provider.provider} className="dots-connect-unavailable">{t("{provider}: choose at least one permission", { provider: providerLabels[provider.provider] })}</span>
          : <UnavailableProvider key={provider.provider} label={providerLabels[provider.provider]} reason={provider.reason} />)}
    </div>
    {status.providers.some((provider) => provider.provider === "GOOGLE" && provider.configured) ? <details className="dots-connect-help">
      <summary>{t("Google says “Access blocked”?")}</summary>
      <p>{t("While the server's Google Cloud app is in Testing, only its test users can connect. In Google Cloud Console open Google Auth Platform → Audience and add the account under Test users, or publish the app. Enable the Gmail API and Google Calendar API for the same project. Access granted in Testing ends after seven days; Space then asks you to reconnect.")}</p>
    </details> : null}
    {notice ? <p role="status">{notice}</p> : null}
  </section>;
}
