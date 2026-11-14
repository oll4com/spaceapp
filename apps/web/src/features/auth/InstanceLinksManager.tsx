import { Fragment, useEffect, useState } from "react";
import { api, type InstanceLink, type InstanceLinkEvent } from "../../api.js";
import { SPACE_CLIPBOARD_CAPTURE_OPT_OUT_ATTRIBUTE } from "../clipboard-dock/clipboard-events.js";
import { uiText, useUiLanguage } from "../ui-language/ui-language.js";
import { SettingsLabel } from "../settings/SettingsLabel.js";
import { InfoTip } from "../ui-controls/InfoTip.js";

const WRAP = { display: "flex", flexWrap: "wrap", gap: "0.5rem 0.75rem", alignItems: "center" } as const;
const day = (value: string) => new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * Settings > Account > Linked SpaceApps (Space Link, ADR-014): the other SpaceApps this one's Nous manages. Paste the code another
 * SpaceApp shows under Mobile app (Copy code for another SpaceApp); that SpaceApp's person then allows the link under Devices. The code
 * field is kept out of the Space clipboard and masked in agents' pictures. Hidden where the server has no such route (a USER account).
 * History lists what this SpaceApp's Nous did through a link (Λ4), each act with the trace id the other SpaceApp audits it under.
 */
export function InstanceLinksManager() {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [links, setLinks] = useState<InstanceLink[] | null>(null);
  const [hidden, setHidden] = useState(false);
  const [code, setCode] = useState("");
  // Behind Cloudflare Access: the Vault key ids of its service token (Vault > Keys shows each key's id).
  const [access, setAccess] = useState({ clientId: "", clientSecret: "" });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<{ id: string; events: InstanceLinkEvent[] } | null>(null);

  useEffect(() => {
    let disposed = false;
    void Promise.resolve().then(() => api.listInstanceLinks()).then((result) => { if (!disposed) setLinks(result.links); }, () => { if (!disposed) setHidden(true); });
    return () => { disposed = true; };
  }, []);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNote(null);
    try { await work(); } catch (failure) { setError(failure instanceof Error ? failure.message : t("That did not work.")); } finally { setBusy(false); }
  }
  const put = (link: InstanceLink) => setLinks((current) => [...(current ?? []).filter((entry) => entry.id !== link.id), link]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  const link = () => run(async () => {
    const clientId = access.clientId.trim(), clientSecret = access.clientSecret.trim();
    const result = await api.linkInstance(code.trim(), clientId || clientSecret ? { clientId, clientSecret } : undefined);
    setCode("");
    setAccess({ clientId: "", clientSecret: "" });
    put(result.link);
    setNote(t("Linked {name}. It only reads until its person allows it there, in Settings > Account > Devices.", { name: result.link.label }));
  });
  const check = (entry: InstanceLink) => run(async () => {
    const result = await api.checkInstanceLink(entry.id);
    put(result.link);
    setNote(t("{name} answered in {ms} ms; this SpaceApp may {scopes} there.", { name: entry.label, ms: result.rttMs, scopes: result.scopes.join(", ") }));
  });
  const showHistory = (entry: InstanceLink) => history?.id === entry.id ? setHistory(null)
    : void run(async () => setHistory({ id: entry.id, events: (await api.instanceLinkHistory(entry.id)).events }));
  const remove = (entry: InstanceLink) => run(async () => {
    if (!window.confirm(t("Remove {name}? This SpaceApp forgets its key at once; revoke it there too, in Settings > Account > Devices.", { name: entry.label }))) return;
    await api.removeInstanceLink(entry.id);
    setLinks((current) => (current ?? []).filter((item) => item.id !== entry.id));
  });

  if (hidden) return null;
  return <section aria-label={t("Linked SpaceApps")} className="google-accounts-manager">
    <div className="settings-flat-row" style={{ gridTemplateColumns: "1fr" }}>
      <SettingsLabel label="Linked SpaceApps" help="Other SpaceApps this one's Nous manages. In the other SpaceApp, open Settings > Account > Mobile app, Pair a phone, Copy code for another SpaceApp, and paste it here within 2 minutes." />
    </div>
    <form {...{ [SPACE_CLIPBOARD_CAPTURE_OPT_OUT_ATTRIBUTE]: "off" }} onSubmit={(event) => { event.preventDefault(); void link(); }}>
      <div className="settings-flat-row" style={WRAP}>
        <label className="settings-flat-row-copy" style={{ flex: "1 1 100%" }}><small>{t("Pairing code")}</small>
          <input data-sensitive-masked="pairing" autoComplete="off" spellCheck={false} placeholder="SPACEAPP-PAIR:1:…" value={code} onChange={(event) => setCode(event.target.value)} /></label>
        <details style={{ flex: "1 1 100%" }}>
          <summary><small>{t("Behind Cloudflare Access")}</small><InfoTip text={t("Fill these only when the other SpaceApp sits behind Cloudflare Access: the Vault key ids of its service token's client id and secret.")}
            label={t("About {label}", { label: t("Behind Cloudflare Access") })} /></summary>
          <div style={WRAP}>
            {(["clientId", "clientSecret"] as const).map((field) => <label key={field} className="settings-flat-row-copy" style={{ flex: "1 1 14rem" }}>
              <small>{t(field === "clientId" ? "Service token client id (Vault key id)" : "Service token secret (Vault key id)")}</small>
              <input autoComplete="off" spellCheck={false} placeholder="vault_key:…" value={access[field]}
                onChange={(event) => setAccess((current) => ({ ...current, [field]: event.target.value }))} /></label>)}
          </div>
        </details>
      </div>
      <div className="settings-flat-actions">
        <button type="submit" className="button" disabled={busy || !code.trim()}>{t("Link SpaceApp")}</button>
      </div>
      {/* 13/11 13:30 UTC: the operator filled the two Access fields and could not tell why Link SpaceApp stayed grey. */}
      {code.trim() ? null : <small>{t("Link SpaceApp turns on once the pairing code is in. Get a new code from the other SpaceApp when you are on this page: it lasts 2 minutes.")}</small>}
    </form>
    {links !== null && links.length === 0 ? <p className="settings-flat-note">{t("No SpaceApp is linked.")}</p> : null}
    {(links ?? []).map((entry) => <Fragment key={entry.id}>
      <div className="settings-flat-row" style={{ gridTemplateColumns: "1fr" }}>
        <span className="settings-flat-row-copy" style={{ minWidth: 0 }}>
          <strong>{entry.label}</strong>
          <small>{entry.origins.join(", ")} · {t("may {scopes}", { scopes: entry.scopes.join(", ") })} · {entry.access ? `${t("through Cloudflare Access")} · ` : ""}{entry.lastSeenAt ? t("last connected {when}", { when: day(entry.lastSeenAt) }) : t("not connected yet")}</small>
        </span>
      </div>
      <div className="settings-flat-actions">
        <button type="button" className="button" disabled={busy} aria-label={`${t("Check")} ${entry.label}`} onClick={() => void check(entry)}>{t("Check")}</button>
        <button type="button" className="button" disabled={busy} aria-expanded={history?.id === entry.id} aria-label={`${t("History")} ${entry.label}`}
          onClick={() => showHistory(entry)}>{t("History")}</button>
        <button type="button" className="button" disabled={busy} aria-label={`${t("Remove")} ${entry.label}`} onClick={() => void remove(entry)}>{t("Remove")}</button>
      </div>
      {history?.id === entry.id ? <ul aria-label={t("History of {name}", { name: entry.label })} className="settings-flat-note" style={{ margin: 0 }}>
        {history.events.length ? history.events.map((event) => <li key={event.id}>{day(event.createdAt)} · {event.action === "instance_link.paired" ? t("Linked")
          : `${event.metadata?.method ?? ""} ${event.metadata?.path ?? ""} → ${event.metadata?.status ?? t("no answer")}`} · <code>{event.requestId}</code></li>)
          : <li>{t("Nothing in the history period.")}</li>}
      </ul> : null}
    </Fragment>)}
    {note ? <p className="settings-flat-note" role="status">{note}</p> : null}
    {error ? <p className="settings-flat-note" role="alert">{error}</p> : null}
  </section>;
}
