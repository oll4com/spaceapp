import { useState } from "react";
import { X, Lock, Check } from "lucide-react";
import { api } from "../../api.js";
import type { FileItem } from "@space/contracts";

export interface FilePermissionsModalProps {
  entry: FileItem;
  mode: "user" | "admin";
  onClose: () => void;
  onSuccess: () => void;
}

export function FilePermissionsModal({ entry, mode, onClose, onSuccess }: FilePermissionsModalProps) {
  // Parse initial mode bits (e.g. 0755)
  const initialOctal = entry.octalPermissions.slice(-3);
  const initialMode = parseInt(initialOctal, 8);

  const [ownerR, setOwnerR] = useState(Boolean((initialMode >> 6) & 4));
  const [ownerW, setOwnerW] = useState(Boolean((initialMode >> 6) & 2));
  const [ownerX, setOwnerX] = useState(Boolean((initialMode >> 6) & 1));

  const [groupR, setGroupR] = useState(Boolean((initialMode >> 3) & 4));
  const [groupW, setGroupW] = useState(Boolean((initialMode >> 3) & 2));
  const [groupX, setGroupX] = useState(Boolean((initialMode >> 3) & 1));

  const [otherR, setOtherR] = useState(Boolean(initialMode & 4));
  const [otherW, setOtherW] = useState(Boolean(initialMode & 2));
  const [otherX, setOtherX] = useState(Boolean(initialMode & 1));

  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Calculate octal string from states
  const uVal = (ownerR ? 4 : 0) + (ownerW ? 2 : 0) + (ownerX ? 1 : 0);
  const gVal = (groupR ? 4 : 0) + (groupW ? 2 : 0) + (groupX ? 1 : 0);
  const oVal = (otherR ? 4 : 0) + (otherW ? 2 : 0) + (otherX ? 1 : 0);
  const calculatedOctal = `0${uVal}${gVal}${oVal}`;

  function applyPreset(preset: string) {
    const val = parseInt(preset, 8);
    setOwnerR(Boolean((val >> 6) & 4));
    setOwnerW(Boolean((val >> 6) & 2));
    setOwnerX(Boolean((val >> 6) & 1));

    setGroupR(Boolean((val >> 3) & 4));
    setGroupW(Boolean((val >> 3) & 2));
    setGroupX(Boolean((val >> 3) & 1));

    setOtherR(Boolean(val & 4));
    setOtherW(Boolean(val & 2));
    setOtherX(Boolean(val & 1));
  }

  async function handleSave() {
    setIsSaving(true);
    setError(null);
    try {
      await api.filesChmod({
        path: entry.path,
        octalPermissions: calculatedOctal,
        mode: "admin"
      });
      onSuccess();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to change permissions");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="fm-modal-backdrop" onClick={onClose}>
      <div className="fm-modal-card" style={{ maxWidth: "460px" }} onClick={(e) => e.stopPropagation()}>
        <div className="fm-modal-header">
          <div className="fm-modal-title">
            <Lock size={16} color="var(--modern-warning)" />
            <span>File Permissions (chmod)</span>
          </div>
          <button className="fm-action-btn" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="fm-modal-body">
          <div style={{ fontSize: "0.85rem", color: "var(--modern-muted)" }}>
            Target: <strong style={{ color: "var(--modern-text)" }}>{entry.name}</strong>
          </div>

          {error && (
            <div style={{ padding: "8px 12px", background: "var(--modern-danger-soft)", color: "var(--modern-danger)", borderRadius: 4, fontSize: "0.82rem" }}>
              {error}
            </div>
          )}

          {/* Permissions Matrix */}
          <table style={{ width: "100%", textAlign: "center", borderCollapse: "collapse", fontSize: "0.85rem" }}>
            <thead>
              <tr style={{ color: "var(--modern-muted)" }}>
                <th style={{ textAlign: "left", padding: "6px" }}>Scope</th>
                <th>Read (r)</th>
                <th>Write (w)</th>
                <th>Execute (x)</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={{ textAlign: "left", padding: "6px", fontWeight: 600 }}>Owner (User)</td>
                <td><input type="checkbox" checked={ownerR} onChange={(e) => setOwnerR(e.target.checked)} /></td>
                <td><input type="checkbox" checked={ownerW} onChange={(e) => setOwnerW(e.target.checked)} /></td>
                <td><input type="checkbox" checked={ownerX} onChange={(e) => setOwnerX(e.target.checked)} /></td>
              </tr>
              <tr>
                <td style={{ textAlign: "left", padding: "6px", fontWeight: 600 }}>Group</td>
                <td><input type="checkbox" checked={groupR} onChange={(e) => setGroupR(e.target.checked)} /></td>
                <td><input type="checkbox" checked={groupW} onChange={(e) => setGroupW(e.target.checked)} /></td>
                <td><input type="checkbox" checked={groupX} onChange={(e) => setGroupX(e.target.checked)} /></td>
              </tr>
              <tr>
                <td style={{ textAlign: "left", padding: "6px", fontWeight: 600 }}>Others</td>
                <td><input type="checkbox" checked={otherR} onChange={(e) => setOtherR(e.target.checked)} /></td>
                <td><input type="checkbox" checked={otherW} onChange={(e) => setOtherW(e.target.checked)} /></td>
                <td><input type="checkbox" checked={otherX} onChange={(e) => setOtherX(e.target.checked)} /></td>
              </tr>
            </tbody>
          </table>

          {/* Octal & Presets */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: "0.82rem", color: "var(--modern-muted)" }}>Octal:</span>
              <span style={{ fontFamily: "monospace", fontWeight: 700, fontSize: "1.1rem", color: "var(--modern-accent)" }}>
                {calculatedOctal}
              </span>
            </div>

            <div style={{ display: "flex", gap: 4 }}>
              <button className="fm-btn" onClick={() => applyPreset("644")} style={{ fontSize: "0.72rem", padding: "3px 6px" }}>
                644
              </button>
              <button className="fm-btn" onClick={() => applyPreset("755")} style={{ fontSize: "0.72rem", padding: "3px 6px" }}>
                755
              </button>
              <button className="fm-btn" onClick={() => applyPreset("600")} style={{ fontSize: "0.72rem", padding: "3px 6px" }}>
                600
              </button>
              <button className="fm-btn" onClick={() => applyPreset("777")} style={{ fontSize: "0.72rem", padding: "3px 6px" }}>
                777
              </button>
            </div>
          </div>
        </div>

        <div className="fm-modal-footer">
          <button className="fm-btn" onClick={onClose} disabled={isSaving}>
            Cancel
          </button>
          <button className="fm-btn primary" onClick={handleSave} disabled={isSaving}>
            <Check size={14} />
            <span>{isSaving ? "Applying..." : "Apply Permissions"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
