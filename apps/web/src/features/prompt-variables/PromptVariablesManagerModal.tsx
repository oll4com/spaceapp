import { useMemo, useState } from "react";
import type { PromptVariable } from "@space/contracts";
import { Download, Hash, Pencil, Plus, Search, Trash2, Upload, X } from "../ui-theme/app-icons.js";
import { usePromptVariables } from "./prompt-variables-store.js";
import "./prompt-variables-manager.css";

export interface PromptVariablesManagerModalProps {
  open: boolean;
  onClose: () => void;
  initialName?: string;
  onInsertToActivePane?: (variable: PromptVariable) => void;
}

export function PromptVariablesManagerModal({
  open,
  onClose,
  initialName = "",
  onInsertToActivePane
}: PromptVariablesManagerModalProps) {
  const { variables, addVariable, updateVariable, deleteVariable } = usePromptVariables();
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(Boolean(initialName));

  // Form states
  const [formName, setFormName] = useState(initialName.replace(/^#+/, ""));
  const [formLabel, setFormLabel] = useState("");
  const [formValue, setFormValue] = useState("");
  const [formCategory, setFormCategory] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return variables;
    return variables.filter(
      (v) =>
        v.name.toLowerCase().includes(q) ||
        (v.label ?? "").toLowerCase().includes(q) ||
        (v.category ?? "").toLowerCase().includes(q) ||
        v.value.toLowerCase().includes(q)
    );
  }, [variables, search]);

  if (!open) return null;

  function resetForm() {
    setEditingId(null);
    setIsCreating(false);
    setFormName("");
    setFormLabel("");
    setFormValue("");
    setFormCategory("");
    setFormDescription("");
    setFormError(null);
  }

  function handleStartCreate() {
    resetForm();
    setIsCreating(true);
  }

  function handleStartEdit(variable: PromptVariable) {
    setEditingId(variable.id);
    setIsCreating(false);
    setFormName(variable.name);
    setFormLabel(variable.label ?? "");
    setFormValue(variable.value);
    setFormCategory(variable.category ?? "");
    setFormDescription(variable.description ?? "");
    setFormError(null);
  }

  function handleSaveForm(e: React.FormEvent) {
    e.preventDefault();
    const cleanName = formName.trim().replace(/^#+/, "");
    if (!cleanName) {
      setFormError("Variable name is required.");
      return;
    }
    if (!/^[a-zA-Z0-9_\-\u0370-\u03ff]+$/.test(cleanName)) {
      setFormError("Variable name can only contain letters, numbers, underscores, and hyphens.");
      return;
    }
    if (!formValue.trim()) {
      setFormError("Definition / value is required.");
      return;
    }

    if (editingId) {
      updateVariable(editingId, {
        name: cleanName,
        label: formLabel.trim() || undefined,
        value: formValue.trim(),
        category: formCategory.trim() || undefined,
        description: formDescription.trim() || undefined
      });
    } else {
      addVariable({
        name: cleanName,
        label: formLabel.trim() || undefined,
        value: formValue.trim(),
        category: formCategory.trim() || undefined,
        description: formDescription.trim() || undefined
      });
    }

    resetForm();
  }

  function handleExportJson() {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(variables, null, 2));
    const downloadAnchor = document.createElement("a");
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `space-prompt-variables-${new Date().toISOString().slice(0, 10)}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  }

  function handleImportJson(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const parsed = JSON.parse(event.target?.result as string);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item.name && item.value) {
              addVariable({
                name: String(item.name),
                label: item.label ? String(item.label) : undefined,
                value: String(item.value),
                category: item.category ? String(item.category) : undefined,
                description: item.description ? String(item.description) : undefined
              });
            }
          }
        }
      } catch (err) {
        console.error("Failed to parse prompt variables JSON import:", err);
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  return (
    <div className="prompt-variables-modal-backdrop" onClick={onClose}>
      <div
        className="prompt-variables-modal-dialog"
        role="dialog"
        aria-labelledby="prompt-vars-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="prompt-variables-modal-header">
          <div className="prompt-variables-modal-title">
            <Hash aria-hidden="true" />
            <h2 id="prompt-vars-dialog-title">Prompt Variables</h2>
          </div>
          <button
            type="button"
            className="prompt-variables-modal-close-btn"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <X aria-hidden="true" />
          </button>
        </div>

        <div className="prompt-variables-modal-body">
          {/* Top toolbar */}
          <div className="prompt-variables-modal-toolbar">
            <div className="prompt-variables-search-box">
              <Search aria-hidden="true" />
              <input
                type="text"
                placeholder="Search variables"
                aria-label="Search variables"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search ? (
                <button
                  type="button"
                  className="prompt-variables-search-clear"
                  onClick={() => setSearch("")}
                  aria-label="Clear search"
                >
                  <X aria-hidden="true" />
                </button>
              ) : null}
            </div>

            <div className="prompt-variables-toolbar-actions">
              <button
                type="button"
                className="prompt-variables-btn primary"
                onClick={handleStartCreate}
                disabled={isCreating}
              >
                <Plus aria-hidden="true" />
                <span>New Variable</span>
              </button>

              <label className="prompt-variables-btn secondary" title="Import variables from JSON">
                <Upload aria-hidden="true" />
                <span>Import</span>
                <input type="file" accept=".json" hidden onChange={handleImportJson} />
              </label>

              <button
                type="button"
                className="prompt-variables-btn secondary"
                onClick={handleExportJson}
                title="Export variables as JSON"
                disabled={variables.length === 0}
              >
                <Download aria-hidden="true" />
                <span>Export</span>
              </button>
            </div>
          </div>

          {/* Form when creating or editing */}
          {isCreating || editingId ? (
            <form className="prompt-variables-editor-form" onSubmit={handleSaveForm}>
              <div className="prompt-variables-editor-header">
                <h3>{editingId ? "Edit Variable" : "New Prompt Variable"}</h3>
                <button type="button" className="prompt-variables-form-cancel" onClick={resetForm}>
                  Cancel
                </button>
              </div>

              {formError ? <div className="prompt-variables-form-error">{formError}</div> : null}

              <div className="prompt-variables-form-grid">
                <div className="prompt-variables-form-field">
                  <label htmlFor="pv-form-name">Trigger Name (without #)</label>
                  <div className="prompt-variables-input-with-prefix">
                    <span className="prompt-variables-prefix">#</span>
                    <input
                      id="pv-form-name"
                      type="text"
                      placeholder="pc_thai"
                      value={formName}
                      onChange={(e) => setFormName(e.target.value)}
                      required
                      autoFocus
                    />
                  </div>
                </div>

                <div className="prompt-variables-form-field">
                  <label htmlFor="pv-form-label">Friendly Label (optional)</label>
                  <input
                    id="pv-form-label"
                    type="text"
                    placeholder="Thai Remote Workstation"
                    value={formLabel}
                    onChange={(e) => setFormLabel(e.target.value)}
                  />
                </div>

                <div className="prompt-variables-form-field">
                  <label htmlFor="pv-form-cat">Category (optional)</label>
                  <input
                    id="pv-form-cat"
                    type="text"
                    placeholder="Infrastructure, Database, Network..."
                    value={formCategory}
                    onChange={(e) => setFormCategory(e.target.value)}
                  />
                </div>
              </div>

              <div className="prompt-variables-form-field">
                <label htmlFor="pv-form-val">
                  Prompt Value / Expansion Definition
                  <small>Text that will be passed into the prompt when #{formName || "variable"} is selected</small>
                </label>
                <textarea
                  id="pv-form-val"
                  rows={3}
                  placeholder="Computer at 192.168.10.50 accessible via wireguard tunnel on router RT-BKK-01"
                  value={formValue}
                  onChange={(e) => setFormValue(e.target.value)}
                  required
                />
              </div>

              <div className="prompt-variables-form-actions">
                <button type="button" className="prompt-variables-btn secondary" onClick={resetForm}>
                  Cancel
                </button>
                <button type="submit" className="prompt-variables-btn primary">
                  {editingId ? "Save Changes" : "Create Variable"}
                </button>
              </div>
            </form>
          ) : null}

          {/* Variables list */}
          <div className="prompt-variables-cards-container">
            {filtered.length > 0 ? (
              filtered.map((item) => (
                <div className="prompt-variable-card" key={item.id}>
                  <div className="prompt-variable-card-head">
                    <div className="prompt-variable-card-identity">
                      <span className="prompt-variable-card-name">#{item.name}</span>
                      {item.label ? <span className="prompt-variable-card-label">{item.label}</span> : null}
                    </div>
                    {item.category ? (
                      <span className="prompt-variable-card-category">{item.category}</span>
                    ) : null}
                  </div>

                  <div className="prompt-variable-card-value" data-sensitive-masked="manual">{item.value}</div>

                  <div className="prompt-variable-card-actions">
                    {onInsertToActivePane ? (
                      <button
                        type="button"
                        className="prompt-variable-card-action-btn insert"
                        onClick={() => {
                          onInsertToActivePane(item);
                          onClose();
                        }}
                        title="Insert into current prompt"
                      >
                        Insert
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="prompt-variable-card-action-btn"
                      onClick={() => handleStartEdit(item)}
                      title="Edit variable"
                      aria-label={`Edit #${item.name}`}
                    >
                      <Pencil aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="prompt-variable-card-action-btn danger"
                      onClick={() => {
                        if (window.confirm(`Delete variable #${item.name}?`)) {
                          deleteVariable(item.id);
                        }
                      }}
                      title="Delete variable"
                      aria-label={`Delete #${item.name}`}
                    >
                      <Trash2 aria-hidden="true" />
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <div className="prompt-variables-empty-state">
                <Hash aria-hidden="true" />
                <p>
                  {search
                    ? `No prompt variables matched "${search}".`
                    : "No variables yet. Save text you reuse under a short #name, then type #name in any prompt to insert it."}
                </p>
                {!isCreating ? (
                  <button type="button" className="prompt-variables-btn primary" onClick={handleStartCreate}>
                    <Plus aria-hidden="true" />
                    <span>Create Variable</span>
                  </button>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
