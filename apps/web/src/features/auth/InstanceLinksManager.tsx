import { useEffect, useState } from "react";
import { api, type InstanceLink } from "../../api.js";
import { SPACE_CLIPBOARD_CAPTURE_OPT_OUT_ATTRIBUTE } from "../clipboard-dock/clipboard-events.js";
import { uiText, useUiLanguage } from "../ui-language/ui-language.js";

const WRAP = { display: "flex", flexWrap: "wrap", gap: "0.5rem 0.75rem", alignItems: "center" } as const;
const day = (value: string) => new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * Settings > Account > Linked SpaceApps (Space Link, ADR-014): the other SpaceApps this one's Nous manages. Paste the code another
 * SpaceApp shows under Mobile app (Copy code for another SpaceApp); that SpaceApp's person then allows the link under Devices. The code
 * field is kept out of the Space clipboard and masked in agents' pictures. Hidden where the server has no such route (a USER account).
 */
export function InstanceLinksManager() {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [links, setLinks] = useState<InstanceLink[] | null>(null);
  const [hidden, setHidden] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    const result = await api.linkInstance(code.trim());
    setCode("");
    put(result.link);
    setNote(t("Linked {name}. It only reads until its person allows it there, in Settings > Account > Devices.", { name: result.link.label }));
  });
  const check = (entry: InstanceLink) => run(async () => {
    const result = await api.checkInstanceLink(entry.id);
    put(result.link);
    setNote(t("{name} answered in {ms} ms; this SpaceApp may {scopes} there.", { name: entry.label, ms: result.rttMs, scopes: result.scopes.join(", ") }));
  });
  const remove = (entry: InstanceLink) => run(async () => {
    if (!window.confirm(t("Remove {name}? This SpaceApp forgets its key at once; revoke it there too, in Settings > Account > Devices.", { name: entry.label }))) return;
    await api.removeInstanceLink(entry.id);
    setLinks((current) => (current ?? []).filter((item) => item.id !== entry.id));
  });

  if (hidden) return null;
  return <section aria-label={t("Linked SpaceApps")} className="google-accounts-manager">
    <div className="settings-flat-row" style={{ gridTemplateColumns: "1fr" }}>
      <span className="settings-flat-row-copy"><strong>{t("Linked SpaceApps")}</strong>
        <small>{t("Other SpaceApps this one's Nous manages. In the other SpaceApp, open Settings > Account > Mobile app, Pair a phone, Copy code for another SpaceApp, and paste it here within 2 minutes.")}</small></span>
    </div>
    <form className="settings-flat-row" style={WRAP} {...{ [SPACE_CLIPBOARD_CAPTURE_OPT_OUT_ATTRIBUTE]: "off" }} onSubmit={(event) => { event.preventDefault(); void link(); }}>
      <label className="settings-flat-row-copy" style={{ flex: "1 1 100%" }}><small>{t("Pairing code")}</small>
        <input data-sensitive-masked="pairing" autoComplete="off" spellCheck={false} placeholder="SPACEAPP-PAIR:1:…" value={code} onChange={(event) => setCode(event.target.value)} /></label>
      <button type="submit" className="button" disabled={busy || !code.trim()}>{t("Link SpaceApp")}</button>
    </form>
    {links !== null && links.length === 0 ? <p className="settings-flat-note">{t("No SpaceApp is linked.")}</p> : null}
    {(links ?? []).map((entry) => <div className="settings-flat-row" key={entry.id} style={WRAP}>
      <span className="settings-flat-row-copy" style={{ minWidth: 0, flex: "1 1 12rem" }}>
        <strong>{entry.label}</strong>
        <small>{entry.origins.join(", ")} · {t("may {scopes}", { scopes: entry.scopes.join(", ") })} · {entry.lastSeenAt ? t("last connected {when}", { when: day(entry.lastSeenAt) }) : t("not connected yet")}</small>
      </span>
      <button type="button" className="button" disabled={busy} aria-label={`${t("Check")} ${entry.label}`} onClick={() => void check(entry)}>{t("Check")}</button>
      <button type="button" className="button" disabled={busy} aria-label={`${t("Remove")} ${entry.label}`} onClick={() => void remove(entry)}>{t("Remove")}</button>
    </div>)}
    {note ? <p className="settings-flat-note" role="status">{note}</p> : null}
    {error ? <p className="settings-flat-note" role="alert">{error}</p> : null}
  </section>;
}
