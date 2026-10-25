import { useState } from "react";
import { SPACEAPP_BRAND_KIT, type DesignBrandKit, type DesignBrandKitInput, type Pane } from "@space/contracts";
import { api } from "../../api.js";
import { Plus, Trash2 } from "../ui-theme/app-icons.js";

const COLOR_ROLES = ["background", "surface", "text", "primary", "accent"] as const;
const COLOR_LABELS: Record<(typeof COLOR_ROLES)[number], string> = { background: "Background", surface: "Surface", text: "Text", primary: "Primary", accent: "Accent" };
const draftOf = (kit?: DesignBrandKit): DesignBrandKitInput => ({
  name: kit?.name ?? "", colors: { ...(kit?.colors ?? SPACEAPP_BRAND_KIT.colors) }, fonts: { ...(kit?.fonts ?? SPACEAPP_BRAND_KIT.fonts) }, logos: kit?.builtIn ? [] : [...(kit?.logos ?? [])], voice: kit?.voice ?? null
});

/** Brand kits: the built-in SpaceApp kit, and the operator's own (colours, fonts, logos uploaded to this room's Media, voice). */
export function BrandKitsTab({ pane, brandKits, onChanged }: { pane: Pane; brandKits: DesignBrandKit[]; onChanged(): void }) {
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
      setMessage("Brand kit saved.");
      onChanged();
    } catch (error) { setMessage(error instanceof Error ? error.message : "The brand kit could not be saved."); }
    finally { setBusy(false); }
  }
  async function uploadLogo(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    try {
      const { artifacts } = await api.uploadImages({ roomId: pane.roomId, paneId: pane.id, source: "USER_UPLOAD", files: [...files].slice(0, 1) });
      setDraft((current) => ({ ...current, logos: [...current.logos, ...artifacts.map((artifact) => artifact.id)].slice(0, 4) }));
    } catch (error) { setMessage(error instanceof Error ? error.message : "The logo could not be uploaded."); }
    finally { setBusy(false); }
  }
  async function remove(kit: DesignBrandKit) {
    try { await api.deleteDesignBrandKit(kit.id); setMessage(`${kit.name} deleted.`); onChanged(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "The brand kit could not be deleted."); }
  }
  return (
    <div className="dz-brand-kits" role="tabpanel" id="jc-panel-brand-kits" aria-labelledby="jc-tab-brand-kits">
      <ul className="jc-list" aria-label="Brand kits">
        {brandKits.map((kit) => (
          <li key={kit.id} className="jc-card dz-kit">
            <div className="jc-row">
              <strong>{kit.name}</strong>
              {kit.builtIn ? <span className="jc-pill">Built in</span> : (
                <span className="dz-library-actions">
                  <button type="button" className="jc-button ghost" onClick={() => start(kit)}>Edit</button>
                  <button type="button" className="jc-icon-button" aria-label={`Delete ${kit.name}`} title="Delete" onClick={() => void remove(kit)}><Trash2 aria-hidden="true" /></button>
                </span>
              )}
            </div>
            <div className="dz-swatches" aria-label={`${kit.name} colours`}>
              {COLOR_ROLES.map((role) => <span key={role} className="dz-swatch" style={{ background: kit.colors[role] }} title={`${COLOR_LABELS[role]} ${kit.colors[role]}`} />)}
              <span className="jc-row-meta">{kit.fonts.heading} / {kit.fonts.body} · {kit.logos.length} logo{kit.logos.length === 1 ? "" : "s"}</span>
            </div>
          </li>
        ))}
      </ul>
      {editing ? (
        <form className="jc-form dz-kit-form" onSubmit={(event) => { event.preventDefault(); void save(); }} aria-label={editing === "new" ? "New brand kit" : "Edit brand kit"}>
          <label className="jc-field"><span>Name</span><input value={draft.name} maxLength={80} required onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
          <div className="dz-row">
            {COLOR_ROLES.map((role) => (
              <label key={role} className="jc-field"><span>{COLOR_LABELS[role]}</span>
                <input type="color" value={draft.colors[role]} aria-label={`${COLOR_LABELS[role]} colour`} onChange={(event) => setDraft({ ...draft, colors: { ...draft.colors, [role]: event.target.value.toUpperCase() } })} /></label>
            ))}
          </div>
          <div className="dz-row">
            <label className="jc-field"><span>Heading font</span><input value={draft.fonts.heading} maxLength={60} pattern="[A-Za-z0-9 \-]+" onChange={(event) => setDraft({ ...draft, fonts: { ...draft.fonts, heading: event.target.value } })} /></label>
            <label className="jc-field"><span>Body font</span><input value={draft.fonts.body} maxLength={60} pattern="[A-Za-z0-9 \-]+" onChange={(event) => setDraft({ ...draft, fonts: { ...draft.fonts, body: event.target.value } })} /></label>
          </div>
          <label className="jc-field"><span>Logo (PNG, JPEG or WebP, {draft.logos.length}/4)</span>
            <input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy || draft.logos.length >= 4} onChange={(event) => void uploadLogo(event.target.files)} /></label>
          {draft.logos.length ? <button type="button" className="jc-button ghost" onClick={() => setDraft({ ...draft, logos: [] })}>Remove logos</button> : null}
          <label className="jc-field"><span>Voice</span><textarea rows={2} maxLength={1000} value={draft.voice ?? ""} placeholder="How the brand speaks" onChange={(event) => setDraft({ ...draft, voice: event.target.value || null })} /></label>
          <div className="jc-actions">
            <button type="submit" className="jc-button primary" disabled={busy || !draft.name.trim()}>Save brand kit</button>
            <button type="button" className="jc-button ghost" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </form>
      ) : <button type="button" className="jc-button" onClick={() => start()}><Plus aria-hidden="true" /> Add brand kit</button>}
      {message ? <p className="jc-message" role="status">{message}</p> : null}
    </div>
  );
}
