import { useState } from "react";
import { SPACEAPP_BRAND_KIT, type DesignBrandKit, type DesignBrandKitInput, type Pane } from "@space/contracts";
import { api } from "../../api.js";
import { Plus, Trash2 } from "../ui-theme/app-icons.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";

const COLOR_ROLES = ["background", "surface", "text", "primary", "accent"] as const;
const COLOR_LABELS: Record<(typeof COLOR_ROLES)[number], string> = { background: "Background", surface: "Surface", text: "Text", primary: "Primary", accent: "Accent" };
const draftOf = (kit?: DesignBrandKit): DesignBrandKitInput => ({
  name: kit?.name ?? "", colors: { ...(kit?.colors ?? SPACEAPP_BRAND_KIT.colors) }, fonts: { ...(kit?.fonts ?? SPACEAPP_BRAND_KIT.fonts) }, logos: kit?.builtIn ? [] : [...(kit?.logos ?? [])], voice: kit?.voice ?? null
});

/** Brand kits: the built-in SpaceApp kit, and the operator's own (colours, fonts, logos uploaded to this room's Media, voice). */
export function BrandKitsTab({ pane, brandKits, onChanged }: { pane: Pane; brandKits: DesignBrandKit[]; onChanged(): void }) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<DesignBrandKitInput>(draftOf());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const start = (kit?: DesignBrandKit) => { setEditing(kit ? kit.id : "new"); setDraft(draftOf(kit)); setMessage(null); };
  async function save() {
    if (busy || !draft.name.trim()) return;
    setBusy(true);
    try {
      if (editing === "new") await api.createDesignBrandKit({ ...draft, name: draft.name.trim() });
      else if (editing) await api.updateDesignBrandKit(editing, { ...draft, name: draft.name.trim() });
      setEditing(null);
      setMessage(t("Brand kit saved."));
      onChanged();
    } catch (error) { setMessage(error instanceof Error ? error.message : t("The brand kit could not be saved.")); }
    finally { setBusy(false); }
  }
  async function uploadLogo(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    try {
      const { artifacts } = await api.uploadImages({ roomId: pane.roomId, paneId: pane.id, source: "USER_UPLOAD", files: [...files].slice(0, 1) });
      setDraft((current) => ({ ...current, logos: [...current.logos, ...artifacts.map((artifact) => artifact.id)].slice(0, 4) }));
    } catch (error) { setMessage(error instanceof Error ? error.message : t("The logo could not be uploaded.")); }
    finally { setBusy(false); }
  }
  async function remove(kit: DesignBrandKit) {
    try { await api.deleteDesignBrandKit(kit.id); setMessage(t("{name} deleted.", { name: kit.name })); onChanged(); }
    catch (error) { setMessage(error instanceof Error ? error.message : t("The brand kit could not be deleted.")); }
  }
  return (
    <div className="dz-brand-kits" role="tabpanel" id="jc-panel-brand-kits" aria-labelledby="jc-tab-brand-kits">
      <ul className="jc-list" aria-label={t("Brand kits")}>
        {brandKits.map((kit) => (
          <li key={kit.id} className="jc-card dz-kit">
            <div className="jc-row">
              <strong>{kit.name}</strong>
              {kit.builtIn ? <span className="jc-pill">{t("Built in")}</span> : (
                <span className="dz-library-actions">
                  <button type="button" className="jc-button ghost" onClick={() => start(kit)}>{t("Edit")}</button>
                  <button type="button" className="jc-icon-button" aria-label={t("Delete {name}", { name: kit.name })} title={t("Delete")} onClick={() => void remove(kit)}><Trash2 aria-hidden="true" /></button>
                </span>
              )}
            </div>
            <div className="dz-swatches" aria-label={t("{name} colours", { name: kit.name })}>
              {COLOR_ROLES.map((role) => <span key={role} className="dz-swatch" style={{ background: kit.colors[role] }} title={`${t(COLOR_LABELS[role])} ${kit.colors[role]}`} />)}
              <span className="jc-row-meta">{kit.fonts.heading} / {kit.fonts.body} · {t(kit.logos.length === 1 ? "{count} logo" : "{count} logos", { count: kit.logos.length })}</span>
            </div>
          </li>
        ))}
      </ul>
      {editing ? (
        <form className="jc-form dz-kit-form" onSubmit={(event) => { event.preventDefault(); void save(); }} aria-label={editing === "new" ? t("New brand kit") : t("Edit brand kit")}>
          <label className="jc-field"><span>{t("Name")}</span><input value={draft.name} maxLength={80} required onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
          <div className="dz-row">
            {COLOR_ROLES.map((role) => (
              <label key={role} className="jc-field"><span>{t(COLOR_LABELS[role])}</span>
                <input type="color" value={draft.colors[role]} aria-label={t("{color} colour", { color: t(COLOR_LABELS[role]) })} onChange={(event) => setDraft({ ...draft, colors: { ...draft.colors, [role]: event.target.value.toUpperCase() } })} /></label>
            ))}
          </div>
          <div className="dz-row">
            <label className="jc-field"><span>{t("Heading font")}</span><input value={draft.fonts.heading} maxLength={60} pattern="[A-Za-z0-9 \-]+" onChange={(event) => setDraft({ ...draft, fonts: { ...draft.fonts, heading: event.target.value } })} /></label>
            <label className="jc-field"><span>{t("Body font")}</span><input value={draft.fonts.body} maxLength={60} pattern="[A-Za-z0-9 \-]+" onChange={(event) => setDraft({ ...draft, fonts: { ...draft.fonts, body: event.target.value } })} /></label>
          </div>
          <label className="jc-field"><span>{t("Logo (PNG, JPEG or WebP, {count}/4)", { count: draft.logos.length })}</span>
            <input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy || draft.logos.length >= 4} onChange={(event) => void uploadLogo(event.target.files)} /></label>
          {draft.logos.length ? <button type="button" className="jc-button ghost" onClick={() => setDraft({ ...draft, logos: [] })}>{t("Remove logos")}</button> : null}
          <label className="jc-field"><span>{t("Voice")}</span><textarea rows={2} maxLength={1000} value={draft.voice ?? ""} placeholder={t("How the brand speaks")} onChange={(event) => setDraft({ ...draft, voice: event.target.value || null })} /></label>
          <div className="jc-actions">
            <button type="submit" className="jc-button primary" disabled={busy || !draft.name.trim()}>{t("Save brand kit")}</button>
            <button type="button" className="jc-button ghost" onClick={() => setEditing(null)}>{t("Cancel")}</button>
          </div>
        </form>
      ) : <button type="button" className="jc-button" onClick={() => start()}><Plus aria-hidden="true" /> {t("Add brand kit")}</button>}
      {message ? <p className="jc-message" role="status">{message}</p> : null}
    </div>
  );
}
