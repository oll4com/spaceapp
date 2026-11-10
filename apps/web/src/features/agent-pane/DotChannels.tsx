import { useEffect, useState } from "react";
import type { ChannelProvider, ChannelsStatus } from "@space/contracts";
import { api } from "../../api.js";
import { UnavailableProvider } from "./DotConnections.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";

const providerLabels: Record<ChannelProvider, string> = { SLACK: "Slack", TEAMS: "Teams" };

/**
 * Space Dots Stage 6: Slack and Teams accounts linked to Space. A one-time
 * code, sent to the Space app in a direct message, links an account; each
 * thread there is one conversation with one Dot.
 */
export function DotChannels({ read = api.channels, createCode = api.createChannelLinkCode, unlink = api.unlinkChannelIdentity }: {
  read?: typeof api.channels; createCode?: typeof api.createChannelLinkCode; unlink?: typeof api.unlinkChannelIdentity;
}) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [status, setStatus] = useState<ChannelsStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void Promise.resolve().then(() => read()).then((value) => { if (current) { setStatus(value); setFailed(false); } })
      .catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [revision, read]);
  async function link() {
    setNotice(null);
    try { setCode(await createCode()); } catch (error) { setNotice(error instanceof Error ? error.message : t("A link code could not be created.")); }
  }
  async function remove(identityId: string) {
    setNotice(null);
    try { await unlink(identityId); setConfirming(null); setNotice(t("Unlinked. Space no longer accepts messages from that account.")); setRevision((value) => value + 1); }
    catch (error) { setNotice(error instanceof Error ? error.message : t("The account could not be unlinked.")); }
  }
  const title = <h4>{t("Slack and Teams")}</h4>;
  if (failed && !status) return <section className="dots-connections" aria-label={t("Slack and Teams")}>{title}<p>{t("Slack and Teams unavailable.")}</p></section>;
  if (!status) return <section className="dots-connections" aria-label={t("Slack and Teams")}>{title}<p role="status">{t("Loading Slack and Teams…")}</p></section>;
  const configured = status.providers.filter((provider) => provider.configured);
  // The one-time code sits in its own <code>: the sentence is translated whole, split at the marker.
  const [codeBefore, codeAfter = ""] = t("Send {command} to the Space app in a direct message in {where} before {time}. The code works once.", {
    command: "\u0001", where: configured.map((provider) => providerLabels[provider.provider]).join(` ${t("or")} `),
    time: code ? new Date(code.expiresAt).toLocaleTimeString("en-US") : "" }).split("\u0001");
  return <section className="dots-connections" aria-label={t("Slack and Teams")}>
    {title}
    <p className="dots-panel-hint">{t("Message your Dots from Slack or Teams. Start a message with a Dot's name, for example \"Orbit: summarize my day\". In shared conversations, answers come to you directly unless you write \"reply here\" in the thread. Approvals are always decided in Space.")}</p>
    {status.identities.length ? <ul className="dots-records">{status.identities.map((identity) => <li key={identity.identityId}>
      <strong>{providerLabels[identity.provider]}{identity.displayName ? ` · ${identity.displayName}` : ""}</strong>
      <span>{t("Linked {when} · {count} threads", { when: new Date(identity.linkedAt).toLocaleString("en-US"),
        count: status.threads.filter((thread) => thread.provider === identity.provider).length })}</span>
      {confirming === identity.identityId ? <div className="dots-memory-actions" role="group" aria-label={t("Confirm unlinking")}>
        <span>{t("Unlink this {provider} account? Its threads stop reaching your Dots.", { provider: providerLabels[identity.provider] })}</span>
        <button type="button" className="dots-memory-forget" onClick={() => void remove(identity.identityId)}>{t("Unlink")}</button>
        <button type="button" onClick={() => setConfirming(null)}>{t("Keep")}</button>
      </div> : <div className="dots-memory-actions"><button type="button" onClick={() => setConfirming(identity.identityId)}>{t("Unlink")}</button></div>}
    </li>)}</ul> : <p>{t("No Slack or Teams account linked.")}</p>}
    <div className="dots-connection-providers">
      {configured.length ? <button type="button" onClick={() => void link()}>{t("Create link code")}</button> : null}
      {status.providers.filter((provider) => !provider.configured).map((provider) =>
        <UnavailableProvider key={provider.provider} label={providerLabels[provider.provider]} reason={provider.reason} />)}
    </div>
    {code ? <p role="status" className="dots-channel-code">{codeBefore}<code>link {code.code}</code>{codeAfter}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
  </section>;
}
