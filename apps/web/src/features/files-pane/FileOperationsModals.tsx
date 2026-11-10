import { useState, type KeyboardEvent } from "react";
import { X, FolderPlus, FileInput, TextCursorInput, Trash2, AlertTriangle } from "../ui-theme/app-icons.js";
import type { FileItem } from "@space/contracts";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";

export interface CreateModalProps {
  type: "file" | "directory";
  currentPath: string;
  onClose: () => void;
  onSubmit: (name: string) => void;
}

export function CreateModal({ type, currentPath, onClose, onSubmit }: CreateModalProps) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [name, setName] = useState("");

  function handleSubmit() {
    const trimmed = name.trim();
    if (trimmed) {
      onSubmit(trimmed);
      onClose();
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") handleSubmit();
    if (e.key === "Escape") onClose();
  }

  return (
    <div className="fm-modal-backdrop" onClick={onClose}>
      <div className="fm-modal-card" style={{ maxWidth: "420px" }} onClick={(e) => e.stopPropagation()}>
        <div className="fm-modal-header">
          <div className="fm-modal-title">
            {type === "directory" ? <FolderPlus size={16} /> : <FileInput size={16} />}
            <span>{type === "directory" ? t("Create New Folder") : t("Create New File")}</span>
          </div>
          <button className="fm-action-btn" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="fm-modal-body">
          <div style={{ fontSize: "0.82rem", color: "var(--modern-muted)" }}>
            {t("In:")} <code>{currentPath}</code>
          </div>
          <input
            autoFocus
            className="fm-path-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={type === "directory" ? t("e.g. components") : t("e.g. index.ts")}
          />
        </div>

        <div className="fm-modal-footer">
          <button className="fm-btn" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button className="fm-btn primary" onClick={handleSubmit} disabled={!name.trim()}>
            {t("Create")}
          </button>
        </div>
      </div>
    </div>
  );
}

export interface RenameModalProps {
  entry: FileItem;
  onClose: () => void;
  onSubmit: (newName: string) => void;
}

export function RenameModal({ entry, onClose, onSubmit }: RenameModalProps) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [name, setName] = useState(entry.name);

  function handleSubmit() {
    const trimmed = name.trim();
    if (trimmed && trimmed !== entry.name) {
      onSubmit(trimmed);
      onClose();
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") handleSubmit();
    if (e.key === "Escape") onClose();
  }

  return (
    <div className="fm-modal-backdrop" onClick={onClose}>
      <div className="fm-modal-card" style={{ maxWidth: "420px" }} onClick={(e) => e.stopPropagation()}>
        <div className="fm-modal-header">
          <div className="fm-modal-title">
            <TextCursorInput size={16} />
            <span>{entry.isDirectory ? t("Rename Folder") : t("Rename File")}</span>
          </div>
          <button className="fm-action-btn" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="fm-modal-body">
          <input
            autoFocus
            className="fm-path-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>

        <div className="fm-modal-footer">
          <button className="fm-btn" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button className="fm-btn primary" onClick={handleSubmit} disabled={!name.trim() || name === entry.name}>
            {t("Rename")}
          </button>
        </div>
      </div>
    </div>
  );
}

export interface DeleteModalProps {
  entry: FileItem;
  onClose: () => void;
  onConfirm: () => void;
}

export function DeleteModal({ entry, onClose, onConfirm }: DeleteModalProps) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  return (
    <div className="fm-modal-backdrop" onClick={onClose}>
      <div className="fm-modal-card" style={{ maxWidth: "440px" }} onClick={(e) => e.stopPropagation()}>
        <div className="fm-modal-header">
          <div className="fm-modal-title" style={{ color: "var(--modern-danger)" }}>
            <AlertTriangle size={18} />
            <span>{t("Confirm Deletion")}</span>
          </div>
          <button className="fm-action-btn" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="fm-modal-body">
          <p style={{ margin: 0, fontSize: "0.88rem", color: "var(--modern-text)" }}>
            {t("Are you sure you want to permanently delete")}{" "}
            <strong>{entry.name}</strong>?
          </p>
          <p style={{ margin: 0, fontSize: "0.78rem", color: "var(--modern-muted)" }}>
            {t("Path:")} <code>{entry.path}</code>
          </p>
          {entry.isDirectory && (
            <div style={{ padding: "8px 12px", background: "var(--modern-danger-soft)", color: "var(--modern-danger)", borderRadius: 4, fontSize: "0.8rem" }}>
              {t("Warning: All files and subdirectories inside this folder will be deleted recursively!")}
            </div>
          )}
        </div>

        <div className="fm-modal-footer">
          <button className="fm-btn" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button
            className="fm-btn"
            style={{ background: "var(--modern-danger)", color: "#fff", borderColor: "transparent" }}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            <Trash2 size={14} />
            <span>{t("Delete")}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
