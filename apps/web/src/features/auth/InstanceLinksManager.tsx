import { Fragment, useEffect, useState } from "react";
import { api, type InstanceLink, type InstanceLinkEvent, type InstanceLinkSyncCategory, type InstanceLinkVersion } from "../../api.js";
import { SPACE_CLIPBOARD_CAPTURE_OPT_OUT_ATTRIBUTE } from "../clipboard-dock/clipboard-events.js";
import { uiText, useUiLanguage } from "../ui-language/ui-language.js";
import { SettingsLabel } from "../settings/SettingsLabel.js";
import { InfoTip } from "../ui-controls/InfoTip.js";
import { STATUS_LABELS } from "../nous/NousRequests.js";
import { signVaultOperatorRequest } from "../vault/vault-client.js";
import { vaultSessionKeys } from "../vault/vault-session.js";

const WRAP = { display: "flex", flexWrap: "wrap", gap: "0.5rem 0.75rem", alignItems: "center" } as const;
const short = (commit: string | null) => commit?.slice(0, 10) ?? "?";
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
  // Space Link version sync (operator nous_msg:2c4707988f754da5b0719dd5): each linked SpaceApp follows the commit this one runs.
  const [versions, setVersions] = useState<Awaited<ReturnType<typeof api.instanceLinkVersions>> | null>(null);

  useEffect(() => {
    let disposed = false;
    void Promise.resolve().then(() => api.listInstanceLinks()).then((result) => { if (!disposed) setLinks(result.links); }, () => { if (!disposed) setHidden(true); });
    void Promise.resolve().then(() => api.instanceLinkVersions()).then((result) => { if (!disposed) setVersions(result); }, () => undefined);
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
  // Plan clipboard:TcX66vjNuZDv step 6: the Vault, settings, memory and sign-ins of this link at once, without waiting for the next pass.
  const syncNow = (entry: InstanceLink) => run(async () => {
    const result = await api.syncInstanceLink(entry.id);
    put(result.link);
    setNote(result.link.sync?.waiting ? t("{name} runs another version: settings and memory sync once both run the same.", { name: entry.label })
      : t("{name} synced now; each category shows what matches.", { name: entry.label }));
  });
  const upgrade = (entry: InstanceLink) => run(async () => {
    const result = await api.upgradeInstanceLink(entry.id);
    setVersions((current) => current ? { ...current, links: { ...current.links, [entry.id]: result } } : current);
    if (result.error) throw new Error(result.error);
    setNote(t("{name} is upgrading to {commit}; it checks the commit itself and rolls back if it does not verify.", { name: entry.label, commit: short(versions?.local.commit ?? null) }));
  });
  const lendAi = (entry: InstanceLink) => run(async () => {
    const result = await api.setInstanceLinkAi(entry.id, !entry.ai);
    put({ ...entry, ai: result.ai, aiError: result.aiError });
    if (result.aiError) throw new Error(result.aiError);
    setNote(t(result.ai ? "{name}'s Claude, Gemini and Copilot panes use the AI accounts this SpaceApp's Gateway serves, through the link; its Gateway key's limits under Gateway > Keys are its budget."
      : "{name} no longer uses this SpaceApp's AI accounts.", { name: entry.label }));
  });
  // Vault→Vault (plan clipboard:TcX66vjNuZDv step 2): the unlocked Vault signs the consent here; no key or secret leaves the browser.
  const syncVault = (entry: InstanceLink) => run(async () => {
    if (entry.vault) {
      const result = await api.setInstanceLinkVault(entry.id, { on: false });
      put({ ...entry, vault: null });
      if (result.error) throw new Error(result.error);
      return setNote(t("{name} no longer receives this Vault; agent access to it is off there.", { name: entry.label }));
    }
    const state = await api.instanceLinkVault(entry.id);
    if (!state.peer) throw new Error(state.peerError ?? t("{name} did not answer.", { name: entry.label }));
    if (!state.signingKey) throw new Error(t("This SpaceApp's Vault broker is not running."));
    // Root pinned both brokers for this link (space-transfer.mjs vault-link-pin): no unlock (operator rule 4d47dcab), the server checks the pins.
    const keys = state.pinned ? null : vaultSessionKeys();
    if (!state.pinned && !keys) throw new Error(t("Unlock the Vault first: its key signs your consent."));
    if (keys && state.peer.ownerUserId !== keys.ownerUserId) throw new Error(t("{name} belongs to another person.", { name: entry.label }));
    if (keys && state.peer.vaultId && state.peer.vaultId !== keys.vaultId) throw new Error(t("{name} has another Vault; only the same Vault syncs.", { name: entry.label }));
    const result = await api.setInstanceLinkVault(entry.id, keys ? { on: true, consent: await signVaultOperatorRequest(keys, "link-sync",
      { linkId: entry.id, transportKey: state.peer.transportKey, signingKey: state.signingKey, issuedAt: new Date().toISOString() }) } : { on: true });
    put({ ...entry, vault: { syncedAt: null, error: result.error } });
    if (result.error) throw new Error(result.error);
    setNote(t("{name}'s Vault follows this one: every change reaches it sealed to its broker, never in clear.", { name: entry.label }));
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
    {versions ? <p className="settings-flat-note">{t("This SpaceApp runs {version} ({commit}).", { version: versions.local.version, commit: short(versions.local.commit) })}
      {versions.local.syncing ? "" : ` ${t("Linked SpaceApps do not follow it from here.")}`}</p> : null}
    {links !== null && links.length === 0 ? <p className="settings-flat-note">{t("No SpaceApp is linked.")}</p> : null}
    {(links ?? []).map((entry) => <Fragment key={entry.id}>
      <div className="settings-flat-row" style={{ gridTemplateColumns: "1fr" }}>
        <span className="settings-flat-row-copy" style={{ minWidth: 0 }}>
          <strong>{entry.label}</strong>
          <VersionLine entry={versions?.links[entry.id]} t={t} />
          <small>{entry.origins.join(", ")} · {t("may {scopes}", { scopes: entry.scopes.join(", ") })} · {entry.access ? `${t("through Cloudflare Access")} · ` : ""}{entry.lastSeenAt ? t("last connected {when}", { when: day(entry.lastSeenAt) }) : t("not connected yet")}{entry.ai ? ` · ${t("lends it AI accounts")}` : ""}{entry.scopes.includes("nous") && !entry.nousError ? ` · ${t("its Nous answers to this one")}` : ""}{entry.vault ? ` · ${entry.vault.syncedAt ? t("Vault synced {when}", { when: day(entry.vault.syncedAt) }) : t("Vault syncing")}` : ""}{entry.sync?.waiting ? ` · ${t("settings and memory wait for the same version")}` : entry.sync?.syncedAt ? ` · ${t("settings and memory synced {when}", { when: day(entry.sync.syncedAt) })}` : ""}</small>
          {entry.sync && !entry.sync.waiting ? <small>{SYNC_CATEGORIES.map(([key, name]) => `${t(name)}: ${t(categoryState(entry.sync?.[key]))}`).join(" · ")}</small> : null}
          {entry.aiError ? <small role="alert">{entry.aiError}</small> : null}
          {entry.nousError ? <small role="alert">{entry.nousError}</small> : null}
          {entry.nousReport ? <small>{t("Its Nous: {status} \u201c{text}\u201d, {when}", { status: t(STATUS_LABELS[entry.nousReport.status]), text: entry.nousReport.text, when: day(entry.nousReport.at) })}</small> : null}
          {entry.vault?.error ? <small role="alert">{entry.vault.error}</small> : null}
          {SYNC_CATEGORIES.map(([key, name]) => entry.sync?.[key]?.error ? <small key={key} role="alert">{t(name)}: {entry.sync[key]!.error}</small> : null)}
          {entry.sync?.error && !SYNC_CATEGORIES.some(([key]) => entry.sync?.[key]?.error) ? <small role="alert">{entry.sync.error}</small> : null}
        </span>
      </div>
      <div className="settings-flat-actions">
        <button type="button" className="button" disabled={busy} aria-label={`${t("Check")} ${entry.label}`} onClick={() => void check(entry)}>{t("Check")}</button>
        <button type="button" className="button" disabled={busy} aria-label={`${t("Sync now")} ${entry.label}`} onClick={() => void syncNow(entry)}>{t("Sync now")}</button>
        {entry.ai !== undefined ? <button type="button" className="button" disabled={busy} aria-label={`${t(entry.ai ? "Stop lending AI accounts" : "Lend AI accounts")} ${entry.label}`}
          onClick={() => void lendAi(entry)}>{t(entry.ai ? "Stop lending AI accounts" : "Lend AI accounts")}</button> : null}
        {entry.vault !== undefined ? <button type="button" className="button" disabled={busy} aria-label={`${t(entry.vault ? "Stop syncing the Vault" : "Sync the Vault")} ${entry.label}`}
          onClick={() => void syncVault(entry)}>{t(entry.vault ? "Stop syncing the Vault" : "Sync the Vault")}</button> : null}
        {versions?.local.syncing && versions.local.commit && versions.links[entry.id]?.commit && versions.links[entry.id]?.commit !== versions.local.commit
          ? <button type="button" className="button" disabled={busy || versions.links[entry.id]?.last?.state === "running"} aria-label={`${t("Upgrade to this version")} ${entry.label}`}
            onClick={() => void upgrade(entry)}>{t("Upgrade to this version")}</button> : null}
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

const SYNC_CATEGORIES = [["settings", "Settings"], ["memory", "Space Memory"], ["signins", "Site sign-ins"]] as const;
const categoryState = (entry: InstanceLinkSyncCategory | undefined) => entry?.error ? "failed" : entry?.same === true ? "matches" : entry?.same === false ? "differs" : "not compared yet";

const SYNC_STATE: Record<NonNullable<InstanceLinkVersion["last"]>["state"], string> = { running: "updating to {commit} since {when}",
  ok: "updated to {commit} {when}", refused: "refused {commit} {when}", failed: "update to {commit} failed {when}", "rolled-back": "rolled back from {commit} {when}" };

/** What a linked SpaceApp runs, its last update to this SpaceApp's commit and why one failed or was refused. */
function VersionLine({ entry, t }: { entry: InstanceLinkVersion | undefined; t: (text: string, vars?: Record<string, string | number>) => string }) {
  if (!entry) return null;
  const last = entry.last;
  return <small>{entry.commit ? t("runs {version} ({commit})", { version: entry.version ?? "?", commit: short(entry.commit) }) : t("version unknown")}
    {last ? ` · ${t(SYNC_STATE[last.state], { commit: short(last.target), when: day(last.finishedAt ?? last.startedAt) })}${last.reason ? `: ${last.reason}` : ""}` : ""}
    {entry.error ? ` · ${entry.error}` : ""}</small>;
}
