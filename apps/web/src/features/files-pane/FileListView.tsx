import { useState, useMemo, useEffect, type DragEvent } from "react";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import {
  Folder,
  File,
  FileCode,
  FileText,
  FileVideo,
  FileAudio,
  Image as ImageIcon,
  Archive,
  Edit,
  Eye,
  Trash2,
  Download,
  Lock,
  CornerLeftUp,
  ArrowUp,
  ArrowDown,
  Copy,
  Check,
  Edit2
} from "lucide-react";
import type { FileItem } from "@space/contracts";
import { useTouchContextMenu } from "../ui-theme/use-touch-context-menu.js";

export interface FileListViewProps {
  entries: FileItem[];
  currentPath: string;
  parentPath: string | null;
  canGoUp: boolean;
  viewMode: "table" | "grid";
  mode: "user" | "admin";
  onOpenEntry: (entry: FileItem) => void;
  onEditEntry: (entry: FileItem) => void;
  onPreviewEntry: (entry: FileItem) => void;
  onRenameEntry: (entry: FileItem) => void;
  onChmodEntry: (entry: FileItem) => void;
  onDeleteEntry: (entry: FileItem) => void;
  onDownloadEntry: (entry: FileItem) => void;
  onFilesDropped: (files: FileList) => void;
  onNavigateUp: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDate(iso?: string): string {
  if (!iso) return "-";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "-";
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return iso || "-";
  }
}

function getFileIcon(entry: FileItem) {
  if (entry.isDirectory) {
    return <Folder size={18} color="#ffd43b" />;
  }
  const mime = entry.mimeType || "";
  const ext = entry.extension?.toLowerCase() || "";

  if (mime.startsWith("image/")) return <ImageIcon size={18} color="#69db7c" />;
  if (mime.startsWith("video/")) return <FileVideo size={18} color="#da77f2" />;
  if (mime.startsWith("audio/")) return <FileAudio size={18} color="#f06595" />;
  if (mime === "application/zip" || ext === ".tar" || ext === ".gz") return <Archive size={18} color="#ffa94d" />;
  if (
    mime.includes("javascript") ||
    mime.includes("typescript") ||
    mime.includes("json") ||
    [".ts", ".tsx", ".js", ".jsx", ".py", ".sh", ".rs", ".go", ".c", ".cpp", ".html", ".css", ".yaml", ".yml"].includes(ext)
  ) {
    return <FileCode size={18} color="var(--modern-accent, #61d2c3)" />;
  }
  if (ext === ".md" || mime.startsWith("text/")) return <FileText size={18} color="#74c0fc" />;
  return <File size={18} color="var(--modern-muted, #95a4b1)" />;
}

export function FileListView({
  entries,
  currentPath,
  parentPath,
  canGoUp,
  viewMode,
  mode,
  onOpenEntry,
  onEditEntry,
  onPreviewEntry,
  onRenameEntry,
  onChmodEntry,
  onDeleteEntry,
  onDownloadEntry,
  onFilesDropped,
  onNavigateUp
}: FileListViewProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [sortField, setSortField] = useState<"name" | "size" | "permissions" | "mtime" | "birthtime">("name");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [tableBodyRef] = useAutoAnimate();
  const [gridRef] = useAutoAnimate();
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    entry: FileItem;
  } | null>(null);
  const [copiedNotice, setCopiedNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!contextMenu) return;
    const handleClose = () => setContextMenu(null);
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setContextMenu(null);
    };

    window.addEventListener("click", handleClose);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", handleClose, true);
    return () => {
      window.removeEventListener("click", handleClose);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleClose, true);
    };
  }, [contextMenu]);

  function openContextMenu(entry: FileItem, clientX: number, clientY: number) {
    setSelectedPath(entry.path);
    const menuWidth = 200;
    const menuHeight = 280;
    const x = Math.max(8, Math.min(clientX, window.innerWidth - menuWidth - 8));
    const y = Math.max(8, Math.min(clientY, window.innerHeight - menuHeight - 8));
    setContextMenu({ x, y, entry });
  }

  function handleContextMenu(e: React.MouseEvent, entry: FileItem) {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(entry, e.clientX, e.clientY);
  }

  const touchContext = useTouchContextMenu(
    (source) => {
      if (!(source instanceof Element) || source.closest("button")) return null;
      return source.closest<HTMLElement>("[data-file-entry-path]");
    },
    ({ target, x, y }) => {
      const entry = entries.find((item) => item.path === target.dataset.fileEntryPath);
      if (entry) openContextMenu(entry, x, y);
    }
  );

  async function handleCopyPath(entry: FileItem) {
    setContextMenu(null);
    try {
      await navigator.clipboard.writeText(entry.path);
      setCopiedNotice(`Copied: ${entry.path}`);
      setTimeout(() => setCopiedNotice(null), 2500);
    } catch {
      try {
        const input = document.createElement("textarea");
        input.value = entry.path;
        document.body.appendChild(input);
        input.select();
        document.execCommand("copy");
        document.body.removeChild(input);
        setCopiedNotice(`Copied: ${entry.path}`);
        setTimeout(() => setCopiedNotice(null), 2500);
      } catch {
        // ignore
      }
    }
  }

  function handleSort(field: "name" | "size" | "permissions" | "mtime" | "birthtime") {
    if (sortField === field) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDirection("asc");
    }
  }

  const sortedEntries = useMemo(() => {
    if (!Array.isArray(entries)) return [];
    const list = [...entries];
    list.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }
      let cmp = 0;
      if (sortField === "name") {
        cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
      } else if (sortField === "size") {
        cmp = a.size - b.size;
      } else if (sortField === "permissions") {
        cmp = a.permissions.localeCompare(b.permissions);
      } else if (sortField === "mtime") {
        cmp = new Date(a.mtime).getTime() - new Date(b.mtime).getTime();
      } else if (sortField === "birthtime") {
        const aTime = a.birthtime ? new Date(a.birthtime).getTime() : new Date(a.mtime).getTime();
        const bTime = b.birthtime ? new Date(b.birthtime).getTime() : new Date(b.mtime).getTime();
        cmp = aTime - bTime;
      }
      return sortDirection === "asc" ? cmp : -cmp;
    });
    return list;
  }, [entries, sortField, sortDirection]);

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    setIsDragOver(true);
  }

  function handleDragLeave(e: DragEvent) {
    e.preventDefault();
    setIsDragOver(false);
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    setIsDragOver(false);
    if (mode !== "admin") return;
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      onFilesDropped(e.dataTransfer.files);
    }
  }

  return (
    <div
      className="fm-content"
      {...touchContext}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div className="fm-drag-overlay">
          Drop files here to upload to {currentPath}
        </div>
      )}

      {viewMode === "table" ? (
        <div className="fm-table-container">
          <table className="fm-table">
            <thead>
              <tr>
                <th style={{ width: "30%", cursor: "pointer" }} onClick={() => handleSort("name")}>
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <span>Name</span>
                    {sortField === "name" && (sortDirection === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                  </div>
                </th>
                <th style={{ width: "12%", cursor: "pointer" }} onClick={() => handleSort("size")}>
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <span>Size</span>
                    {sortField === "size" && (sortDirection === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                  </div>
                </th>
                <th style={{ width: "12%", cursor: "pointer" }} onClick={() => handleSort("permissions")}>
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <span>Permissions</span>
                    {sortField === "permissions" && (sortDirection === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                  </div>
                </th>
                <th style={{ width: "16%", cursor: "pointer" }} onClick={() => handleSort("mtime")}>
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <span>Modified</span>
                    {sortField === "mtime" && (sortDirection === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                  </div>
                </th>
                <th style={{ width: "16%", cursor: "pointer" }} onClick={() => handleSort("birthtime")}>
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <span>Created</span>
                    {sortField === "birthtime" && (sortDirection === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                  </div>
                </th>
                <th style={{ width: "14%", textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody ref={tableBodyRef}>
              {canGoUp && (
                <tr className="fm-row" onDoubleClick={onNavigateUp}>
                  <td colSpan={6} style={{ color: "var(--modern-accent, #61d2c3)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }} onClick={onNavigateUp}>
                      <CornerLeftUp size={16} />
                      <span style={{ fontWeight: 600 }}>.. (Parent Directory)</span>
                    </div>
                  </td>
                </tr>
              )}

              {sortedEntries.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ textAlign: "center", padding: "32px", color: "var(--modern-muted)" }}>
                    This folder is empty
                  </td>
                </tr>
              )}

              {sortedEntries.map((entry) => {
                const isSelected = selectedPath === entry.path;
                return (
                  <tr
                    key={entry.path}
                    data-file-entry-path={entry.path}
                    className={`fm-row ${isSelected ? "selected" : ""}`}
                    onClick={() => setSelectedPath(entry.path)}
                    onDoubleClick={() => onOpenEntry(entry)}
                    onContextMenu={(e) => handleContextMenu(e, entry)}
                  >
                    <td>
                      <div className={`fm-item-name ${entry.isDirectory ? "directory" : ""}`}>
                        <span className="fm-item-icon">{getFileIcon(entry)}</span>
                        <span title={entry.path}>{entry.name}</span>
                      </div>
                    </td>
                    <td className="fm-item-size">
                      {entry.isDirectory
                        ? "-"
                        : formatBytes(entry.size ?? 0)}
                    </td>
                    <td className="fm-item-permissions" title={`Octal: ${entry.octalPermissions}`}>
                      {entry.permissions}
                    </td>
                    <td className="fm-item-mtime">{formatDate(entry.mtime)}</td>
                    <td className="fm-item-mtime">{formatDate(entry.birthtime || entry.mtime)}</td>
                    <td className="fm-actions-cell">
                      {mode === "admin" && !entry.isDirectory && (
                        <button
                          type="button"
                          className="fm-action-btn"
                          title="Edit file"
                          onClick={(e) => {
                            e.stopPropagation();
                            onEditEntry(entry);
                          }}
                        >
                          <Edit size={14} />
                        </button>
                      )}

                      {!entry.isDirectory && (
                        <button
                          type="button"
                          className="fm-action-btn"
                          title="Preview file"
                          onClick={(e) => {
                            e.stopPropagation();
                            onPreviewEntry(entry);
                          }}
                        >
                          <Eye size={14} />
                        </button>
                      )}

                      {mode === "admin" && (
                        <button
                          type="button"
                          className="fm-action-btn"
                          title="Rename"
                          onClick={(e) => {
                            e.stopPropagation();
                            onRenameEntry(entry);
                          }}
                        >
                          <Edit size={13} style={{ opacity: 0.8 }} />
                        </button>
                      )}

                      {mode === "admin" && (
                        <button
                          type="button"
                          className="fm-action-btn"
                          title="Change permissions (chmod)"
                          onClick={(e) => {
                            e.stopPropagation();
                            onChmodEntry(entry);
                          }}
                        >
                          <Lock size={13} color="var(--modern-warning)" />
                        </button>
                      )}

                      {!entry.isDirectory && (
                        <button
                          type="button"
                          className="fm-action-btn"
                          title="Download file"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDownloadEntry(entry);
                          }}
                        >
                          <Download size={14} />
                        </button>
                      )}

                      {mode === "admin" && (
                        <button
                          type="button"
                          className="fm-action-btn delete"
                          title="Delete"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteEntry(entry);
                          }}
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={gridRef} className="fm-grid">
          {canGoUp && (
            <div className="fm-grid-card" onClick={onNavigateUp}>
              <CornerLeftUp size={32} color="var(--modern-accent)" />
              <div className="fm-grid-name">..</div>
              <div className="fm-grid-meta">Parent</div>
            </div>
          )}

          {sortedEntries.map((entry) => (
            <div
              key={entry.path}
              className="fm-grid-card"
              data-file-entry-path={entry.path}
              onClick={() => setSelectedPath(entry.path)}
              onDoubleClick={() => onOpenEntry(entry)}
              onContextMenu={(e) => handleContextMenu(e, entry)}
            >
              <div style={{ transform: "scale(1.5)", marginBottom: 6 }}>
                {getFileIcon(entry)}
              </div>
              <div className="fm-grid-name" title={entry.name}>
                {entry.name}
              </div>
              <div className="fm-grid-meta">
                {entry.isDirectory
                  ? "Folder"
                  : formatBytes(entry.size ?? 0)}
              </div>
            </div>
          ))}

          {sortedEntries.length === 0 && (
            <div style={{ gridColumn: "1 / -1", textAlign: "center", padding: "32px", color: "var(--modern-muted)" }}>
              This folder is empty
            </div>
          )}
        </div>
      )}

      {/* Right-click Context Menu */}
      {contextMenu && (
        <div
          className="fm-context-menu"
          style={{
            position: "fixed",
            left: contextMenu.x,
            top: contextMenu.y,
            zIndex: 1000
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header with filename / path */}
          <div className="fm-context-menu-header">
            <span className="fm-context-menu-filename" title={contextMenu.entry.path}>
              {contextMenu.entry.name}
            </span>
          </div>
          <div className="fm-context-menu-separator" />

          {/* Primary action: Copy Path */}
          <button
            type="button"
            className="fm-context-menu-item primary"
            onClick={() => void handleCopyPath(contextMenu.entry)}
          >
            <Copy size={14} color="var(--modern-accent, #61d2c3)" />
            <span>Copy Path</span>
          </button>

          <div className="fm-context-menu-separator" />

          {/* Open / Preview */}
          <button
            type="button"
            className="fm-context-menu-item"
            onClick={() => {
              setContextMenu(null);
              onOpenEntry(contextMenu.entry);
            }}
          >
            {contextMenu.entry.isDirectory ? <Folder size={14} color="#ffd43b" /> : <Eye size={14} />}
            <span>{contextMenu.entry.isDirectory ? "Open Folder" : "Preview"}</span>
          </button>

          {/* Download (if file) */}
          {!contextMenu.entry.isDirectory && (
            <button
              type="button"
              className="fm-context-menu-item"
              onClick={() => {
                setContextMenu(null);
                onDownloadEntry(contextMenu.entry);
              }}
            >
              <Download size={14} />
              <span>Download</span>
            </button>
          )}

          {/* Admin actions */}
          {mode === "admin" && (
            <>
              <div className="fm-context-menu-separator" />

              {!contextMenu.entry.isDirectory && (
                <button
                  type="button"
                  className="fm-context-menu-item"
                  onClick={() => {
                    setContextMenu(null);
                    onEditEntry(contextMenu.entry);
                  }}
                >
                  <Edit size={14} />
                  <span>Edit</span>
                </button>
              )}

              <button
                type="button"
                className="fm-context-menu-item"
                onClick={() => {
                  setContextMenu(null);
                  onRenameEntry(contextMenu.entry);
                }}
              >
                <Edit2 size={14} />
                <span>Rename</span>
              </button>

              <button
                type="button"
                className="fm-context-menu-item"
                onClick={() => {
                  setContextMenu(null);
                  onChmodEntry(contextMenu.entry);
                }}
              >
                <Lock size={14} color="var(--modern-warning, #efc56c)" />
                <span>Permissions</span>
              </button>

              <div className="fm-context-menu-separator" />

              <button
                type="button"
                className="fm-context-menu-item danger"
                onClick={() => {
                  setContextMenu(null);
                  onDeleteEntry(contextMenu.entry);
                }}
              >
                <Trash2 size={14} color="var(--modern-danger, #e05252)" />
                <span>Delete</span>
              </button>
            </>
          )}
        </div>
      )}

      {/* Copied Path Toast Notice */}
      {copiedNotice && (
        <div className="fm-toast-notice">
          <Check size={14} color="#65d8a3" />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {copiedNotice}
          </span>
        </div>
      )}
    </div>
  );
}
