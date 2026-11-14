import { useCallback, useEffect, useState } from "react";
import type { SavedSignature } from "@space/contracts";
import { api } from "../../api.js";
import { DockButton, DockNotice } from "../dock-kit/DockKit.js";
import { PenLine, Star, Trash2 } from "../ui-theme/app-icons.js";
import { InfoTip } from "../ui-controls/InfoTip.js";
import { useUiText } from "../ui-language/ui-language.js";
import { SignaturePad } from "./SignaturePad.js";

/** Every saved signature (operator 6/11 01:15 BKK, nous_msg:781819c5ba0440fbbee8682c): name, default, delete, and a new one drawn here.
 * Each one also has a PNG copy in Agent Files › Signatures. */
export function SignatureLibrary() {
  const t = useUiText();
  const [items, setItems] = useState<SavedSignature[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [drawn, setDrawn] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const load = useCallback(() => api.signatures().then(({ signatures }) => setItems(signatures)), []);
  useEffect(() => { load().catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "The signatures could not be loaded.")); }, [load]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try { await action(); await load(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "That did not work."); }
    finally { setBusy(false); }
  }

  return (
    <div className="sign-library">
      {error ? <DockNotice onDismiss={() => setError(null)}>{error}</DockNotice> : null}
      {items === null ? <div className="empty-mini" role="status">Loading signatures…</div>
        : !items.length ? <p className="dock-kit-meta-text">No signature is saved yet. Draw one below, or when you sign a document.</p> : (
          <ul className="sign-library-list" aria-label="Saved signatures">
            {items.map((item) => (
              <li key={item.id} className="sign-library-item">
                <img className="sign-saved" src={api.savedSignatureImageUrl(item.id)} alt={`Signature ${item.label}`} />
                <label className="sign-field">
                  <span>Name<InfoTip text={t("The name you pick this signature by when you sign a document; the default one comes first.")} label={t("About {label}", { label: t("Name") })} />{item.isDefault ? <small> · default</small> : null}</span>
                  <input defaultValue={item.label} maxLength={80} onBlur={(event) => {
                    const next = event.target.value.trim();
                    if (next && next !== item.label) void run(() => api.updateSignature(item.id, { label: next }));
                  }} />
                </label>
                <div className="sign-library-actions">
                  {item.isDefault ? null : <DockButton icon={Star} disabled={busy} onClick={() => void run(() => api.updateSignature(item.id, { isDefault: true }))}>Make default</DockButton>}
                  <DockButton tone="danger" icon={Trash2} disabled={busy} onClick={() => {
                    if (window.confirm(`Delete the signature "${item.label}"? Its copy in Agent Files › Signatures is deleted too.`)) void run(() => api.deleteSavedSignature(item.id));
                  }}>Delete</DockButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      {adding ? (
        <div className="sign-library-new">
          <SignaturePad onChange={(png) => setDrawn(png)} />
          <label className="sign-field"><span>Name<InfoTip text={t("The name you pick this signature by when you sign a document; the default one comes first.")} label={t("About {label}", { label: t("Name") })} /></span>
            <input value={label} maxLength={80} placeholder={`Signature ${(items?.length ?? 0) + 1}`} onChange={(event) => setLabel(event.target.value)} /></label>
          <div className="sign-library-actions">
            <DockButton tone="primary" icon={PenLine} disabled={!drawn || busy} busy={busy} onClick={() => void run(async () => {
              await api.saveSignature({ png: drawn!, ...(label.trim() ? { label: label.trim() } : {}) });
              setAdding(false); setDrawn(null); setLabel("");
            })}>Save signature</DockButton>
            <DockButton onClick={() => { setAdding(false); setDrawn(null); }}>Cancel</DockButton>
          </div>
        </div>
      ) : <DockButton icon={PenLine} onClick={() => setAdding(true)}>New signature</DockButton>}
    </div>
  );
}
