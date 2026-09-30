import { useState, type KeyboardEvent } from "react";
import { X, FolderPlus, FileInput, Edit3, Trash2, AlertTriangle } from "lucide-react";
import type { FileItem } from "@space/contracts";

export interface CreateModalProps {
  type: "file" | "directory";
  currentPath: string;
  onClose: () => void;
  onSubmit: (name: string) => void;
}

export function CreateModal({ type, currentPath, onClose, onSubmit }: CreateModalProps) {
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
            <span>Create New {type === "directory" ? "Folder" : "File"}</span>
          </div>
          <button className="fm-action-btn" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="fm-modal-body">
          <div style={{ fontSize: "0.82rem", color: "var(--modern-muted)" }}>
            In: <code>{currentPath}</code>
          </div>
          <input
            autoFocus
            className="fm-path-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={type === "directory" ? "e.g. components" : "e.g. index.ts"}
          />
        </div>

        <div className="fm-modal-footer">
          <button className="fm-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="fm-btn primary" onClick={handleSubmit} disabled={!name.trim()}>
            Create
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
            <Edit3 size={16} />
            <span>Rename {entry.isDirectory ? "Folder" : "File"}</span>
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
            Cancel
          </button>
          <button className="fm-btn primary" onClick={handleSubmit} disabled={!name.trim() || name === entry.name}>
            Rename
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
  return (
    <div className="fm-modal-backdrop" onClick={onClose}>
      <div className="fm-modal-card" style={{ maxWidth: "440px" }} onClick={(e) => e.stopPropagation()}>
        <div className="fm-modal-header">
          <div className="fm-modal-title" style={{ color: "var(--modern-danger)" }}>
            <AlertTriangle size={18} />
            <span>Confirm Deletion</span>
          </div>
          <button className="fm-action-btn" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="fm-modal-body">
          <p style={{ margin: 0, fontSize: "0.88rem", color: "var(--modern-text)" }}>
            Are you sure you want to permanently delete{" "}
            <strong>{entry.name}</strong>?
          </p>
          <p style={{ margin: 0, fontSize: "0.78rem", color: "var(--modern-muted)" }}>
            Path: <code>{entry.path}</code>
          </p>
          {entry.isDirectory && (
            <div style={{ padding: "8px 12px", background: "var(--modern-danger-soft)", color: "var(--modern-danger)", borderRadius: 4, fontSize: "0.8rem" }}>
              Warning: All files and subdirectories inside this folder will be deleted recursively!
            </div>
          )}
        </div>

        <div className="fm-modal-footer">
          <button className="fm-btn" onClick={onClose}>
            Cancel
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
            <span>Delete</span>
          </button>
        </div>
      </div>
    </div>
  );
}
