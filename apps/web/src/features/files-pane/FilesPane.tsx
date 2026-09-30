import { useState, useEffect, useRef, useMemo } from "react";
import type { Pane, FileItem } from "@space/contracts";
import { api } from "../../api.js";
import { FileManagerToolbar } from "./FileManagerToolbar.js";
import { FileFolderTree } from "./FileFolderTree.js";
import { FileListView } from "./FileListView.js";
import { FileEditorModal } from "./FileEditorModal.js";
import { FilePreviewModal } from "./FilePreviewModal.js";
import { FilePermissionsModal } from "./FilePermissionsModal.js";
import { CreateModal, RenameModal, DeleteModal } from "./FileOperationsModals.js";
import "./files-pane.css";

export interface FilesPaneProps {
  pane?: Pane;
  uiTheme?: string;
  mobile?: boolean;
  projectPath?: string | null;
}

const STORAGE_PATH_KEY = "space.fileManager.lastPath";
const STORAGE_MODE_KEY = "space.fileManager.mode";
const DEFAULT_WORKSPACE = "/opt/spaceapp";

export function FilesPane({ pane, mobile = false, projectPath }: FilesPaneProps) {
  const effectiveProjectPath = useMemo(() => {
    return pane?.cwd?.trim() || projectPath?.trim() || null;
  }, [pane?.cwd, projectPath]);

  const isOutsideDefaultWorkspace = Boolean(
    effectiveProjectPath && !effectiveProjectPath.startsWith(DEFAULT_WORKSPACE)
  );

  const [mode, setMode] = useState<"user" | "admin">(() => {
    if (isOutsideDefaultWorkspace) return "admin";
    const saved = localStorage.getItem(STORAGE_MODE_KEY);
    return saved === "admin" ? "admin" : "user";
  });
  const [currentPath, setCurrentPath] = useState<string>(() => {
    if (effectiveProjectPath) return effectiveProjectPath;
    return localStorage.getItem(STORAGE_PATH_KEY) || DEFAULT_WORKSPACE;
  });
  const [isAdminCapable, setIsAdminCapable] = useState<boolean>(isOutsideDefaultWorkspace);
  const [showHidden, setShowHidden] = useState<boolean>(false);
  const [viewMode, setViewMode] = useState<"table" | "grid">("table");
  const [searchQuery, setSearchQuery] = useState<string>("");

  const [entries, setEntries] = useState<FileItem[]>([]);
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [canGoUp, setCanGoUp] = useState<boolean>(false);
  const [workspaceRoot, setWorkspaceRoot] = useState<string>(DEFAULT_WORKSPACE);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);

  // Modals & Panels
  const [editorFilePath, setEditorFilePath] = useState<string | null>(null);
  const [previewEntry, setPreviewEntry] = useState<FileItem | null>(null);
  const [chmodEntry, setChmodEntry] = useState<FileItem | null>(null);
  const [createType, setCreateType] = useState<"file" | "directory" | null>(null);
  const [renameTarget, setRenameTarget] = useState<FileItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FileItem | null>(null);
  const [sidebarVisible, setSidebarVisible] = useState<boolean>(() => {
    if (mobile) return false;
    try {
      const saved = localStorage.getItem("space_fm_sidebar");
      return saved === null ? true : saved === "true";
    } catch {
      return true;
    }
  });

  useEffect(() => {
    if (mobile) {
      setSidebarVisible(false);
      return;
    }
    try { setSidebarVisible(localStorage.getItem("space_fm_sidebar") !== "false"); } catch { setSidebarVisible(true); }
  }, [mobile]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Check admin privileges on mount
  useEffect(() => {
    api.me()
      .then((res) => {
        const role = res.user?.role;
        const isAdmin = role === "ADMIN" || role === "OPERATOR";
        setIsAdminCapable(isAdmin);
        if (!isAdmin && mode === "admin") {
          setMode("user");
        } else if (isAdmin && effectiveProjectPath && !effectiveProjectPath.startsWith(DEFAULT_WORKSPACE)) {
          setMode("admin");
          void loadDirectory(effectiveProjectPath, "admin", showHidden);
        }
      })
      .catch(() => {
        setIsAdminCapable(false);
      });
  }, [effectiveProjectPath]);

  // Load directory contents
  async function loadDirectory(
    targetPath: string,
    targetMode = mode,
    targetHidden = showHidden
  ) {
    setIsLoading(true);
    setErrorNotice(null);
    let effectiveMode = targetMode;
    if (effectiveMode === "user" && !targetPath.startsWith(DEFAULT_WORKSPACE)) {
      effectiveMode = "admin";
      setMode("admin");
    }
    try {
      const res = await api.filesList({
        path: targetPath,
        mode: effectiveMode,
        showHidden: targetHidden
      });
      setCurrentPath(res.currentPath);
      setParentPath(res.parentPath);
      setCanGoUp(res.canGoUp);
      setWorkspaceRoot(res.workspaceRoot);
      setEntries(res.entries);
      localStorage.setItem(STORAGE_PATH_KEY, res.currentPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load directory";
      if (effectiveMode === "user") {
        try {
          const res = await api.filesList({
            path: targetPath,
            mode: "admin",
            showHidden: targetHidden
          });
          setMode("admin");
          setCurrentPath(res.currentPath);
          setParentPath(res.parentPath);
          setCanGoUp(res.canGoUp);
          setWorkspaceRoot(res.workspaceRoot);
          setEntries(res.entries);
          localStorage.setItem(STORAGE_PATH_KEY, res.currentPath);
          return;
        } catch {
          // ignore fallback failure
        }
      }
      setErrorNotice(msg);
      // If user mode rejected path, fallback to workspace root
      if (effectiveMode === "user" && targetPath !== DEFAULT_WORKSPACE) {
        void loadDirectory(DEFAULT_WORKSPACE, "user", targetHidden);
      }
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    if (effectiveProjectPath) {
      const needsAdmin = !effectiveProjectPath.startsWith(DEFAULT_WORKSPACE);
      if (needsAdmin && mode !== "admin") {
        setMode("admin");
      }
      void loadDirectory(effectiveProjectPath, needsAdmin ? "admin" : mode, showHidden);
    }
  }, [effectiveProjectPath]);

  useEffect(() => {
    void loadDirectory(currentPath, mode, showHidden);
  }, [mode, showHidden]);

  useEffect(() => {
    function handleExternalNavigate(event: Event) {
      const customEvent = event as CustomEvent<{ path: string }>;
      if (customEvent.detail?.path) {
        const target = customEvent.detail.path.trim();
        const needsAdmin = !target.startsWith(DEFAULT_WORKSPACE);
        if (needsAdmin && mode !== "admin") {
          setMode("admin");
        }
        void loadDirectory(target, needsAdmin ? "admin" : mode, showHidden);
      }
    }
    window.addEventListener("space:files:navigate", handleExternalNavigate);
    return () => window.removeEventListener("space:files:navigate", handleExternalNavigate);
  }, [mode, showHidden]);

  function handleNavigate(newPath: string) {
    void loadDirectory(newPath, mode, showHidden);
  }

  function handleNavigateUp() {
    if (parentPath) {
      handleNavigate(parentPath);
    }
  }

  function handleModeToggle() {
    if (mode === "user") {
      if (!isAdminCapable) {
        alert("Admin Mode requires Administrator or Operator privileges.");
        return;
      }
      setMode("admin");
      localStorage.setItem(STORAGE_MODE_KEY, "admin");
    } else {
      setMode("user");
      localStorage.setItem(STORAGE_MODE_KEY, "user");
      // If current path is outside workspace, reset to workspace root
      if (!currentPath.startsWith(workspaceRoot)) {
        handleNavigate(workspaceRoot);
      }
    }
  }

  function handleOpenEntry(entry: FileItem) {
    if (entry.isDirectory) {
      handleNavigate(entry.path);
    } else {
      if (mode === "user") {
        setPreviewEntry(entry);
      } else {
        const mime = entry.mimeType || "";
        if (mime.startsWith("image/") || mime.startsWith("video/") || mime.startsWith("audio/") || mime === "application/pdf") {
          setPreviewEntry(entry);
        } else {
          setEditorFilePath(entry.path);
        }
      }
    }
  }

  async function handleCreate(name: string) {
    if (mode !== "admin" || !createType) return;
    const target = `${currentPath}/${name}`.replace(/\/+/g, "/");
    try {
      await api.filesCreate({ path: target, type: createType, mode });
      void loadDirectory(currentPath);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to create entry");
    }
  }

  async function handleRename(newName: string) {
    if (mode !== "admin" || !renameTarget) return;
    const parent = renameTarget.path.substring(0, renameTarget.path.lastIndexOf("/"));
    const newPath = `${parent}/${newName}`.replace(/\/+/g, "/");
    try {
      await api.filesRename({ oldPath: renameTarget.path, newPath, mode });
      void loadDirectory(currentPath);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to rename entry");
    }
  }

  async function handleDelete() {
    if (mode !== "admin" || !deleteTarget) return;
    try {
      await api.filesDelete({
        path: deleteTarget.path,
        recursive: deleteTarget.isDirectory,
        mode
      });
      void loadDirectory(currentPath);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete entry");
    }
  }

  function handleDownload(entry: FileItem) {
    const downloadUrl = `/api/files/raw?path=${encodeURIComponent(entry.path)}&raw=true${mode === "admin" ? "&mode=admin" : ""}`;
    const spaceNative = (window as unknown as { SpaceNative?: { downloadUrl?: (url: string, name: string, mime: string) => boolean } }).SpaceNative;
    if (typeof spaceNative?.downloadUrl === "function") {
      spaceNative.downloadUrl(downloadUrl, entry.name, "application/octet-stream");
      return;
    }
    const a = document.createElement("a");
    a.href = downloadUrl;
    a.download = entry.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  async function handleFilesDropped(files: FileList) {
    if (mode !== "admin" || files.length === 0) return;
    const formData = new FormData();
    formData.append("targetDir", currentPath);
    formData.append("mode", mode);
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file) formData.append("files", file);
    }
    try {
      await api.filesUpload(formData);
      void loadDirectory(currentPath);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Upload failed");
    }
  }

  const filteredEntries = useMemo(() => {
    if (!searchQuery.trim()) return entries;
    const q = searchQuery.toLowerCase();
    return entries.filter((e) => e.name.toLowerCase().includes(q));
  }, [entries, searchQuery]);

  return (
    <div className="files-pane-root" data-space-pane-id={pane?.id}>
      {/* Hidden File Picker */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          if (e.target.files) void handleFilesDropped(e.target.files);
        }}
      />

      {/* Toolbar */}
      <FileManagerToolbar
        currentPath={currentPath}
        workspaceRoot={workspaceRoot}
        mode={mode}
        isAdminCapable={isAdminCapable}
        onModeToggle={handleModeToggle}
        onNavigate={handleNavigate}
        onRefresh={() => void loadDirectory(currentPath)}
        onNewFile={() => setCreateType("file")}
        onNewFolder={() => setCreateType("directory")}
        onUploadClick={() => fileInputRef.current?.click()}
        showHidden={showHidden}
        onToggleHidden={() => setShowHidden((s) => !s)}
        viewMode={viewMode}
        onToggleViewMode={() => setViewMode((m) => (m === "table" ? "grid" : "table"))}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        sidebarVisible={sidebarVisible}
        onToggleSidebar={() => {
          const next = !sidebarVisible;
          setSidebarVisible(next);
          if (!mobile) try { localStorage.setItem("space_fm_sidebar", String(next)); } catch { /* ignore */ }
        }}
      />

      {errorNotice && (
        <div style={{ padding: "6px 14px", background: "var(--modern-danger-soft)", color: "var(--modern-danger)", fontSize: "0.82rem" }}>
          {errorNotice}
        </div>
      )}

      {/* Main Body */}
      <div className="fm-body">
        {/* Sidebar Folder Tree & Bookmarks */}
        <FileFolderTree
          currentPath={currentPath}
          workspaceRoot={workspaceRoot}
          mode={mode}
          onNavigate={handleNavigate}
          collapsed={!sidebarVisible}
        />

        {/* File List / Grid View */}
        <FileListView
          entries={filteredEntries}
          currentPath={currentPath}
          parentPath={parentPath}
          canGoUp={canGoUp}
          viewMode={viewMode}
          mode={mode}
          onOpenEntry={handleOpenEntry}
          onEditEntry={(entry) => setEditorFilePath(entry.path)}
          onPreviewEntry={(entry) => setPreviewEntry(entry)}
          onRenameEntry={(entry) => setRenameTarget(entry)}
          onChmodEntry={(entry) => setChmodEntry(entry)}
          onDeleteEntry={(entry) => setDeleteTarget(entry)}
          onDownloadEntry={handleDownload}
          onFilesDropped={handleFilesDropped}
          onNavigateUp={handleNavigateUp}
        />
      </div>

      {/* Code Editor Modal */}
      {editorFilePath && (
        <FileEditorModal
          filePath={editorFilePath}
          mode={mode}
          onClose={() => setEditorFilePath(null)}
          onSaved={() => void loadDirectory(currentPath)}
        />
      )}

      {/* Media Preview Modal */}
      {previewEntry && (
        <FilePreviewModal
          entry={previewEntry}
          mode={mode}
          onClose={() => setPreviewEntry(null)}
          onDownload={() => handleDownload(previewEntry)}
          onEdit={
            mode === "admin"
              ? (entry) => {
                  setPreviewEntry(null);
                  setEditorFilePath(entry.path);
                }
              : undefined
          }
        />
      )}

      {/* Permissions Chmod Modal */}
      {mode === "admin" && chmodEntry && (
        <FilePermissionsModal
          entry={chmodEntry}
          mode={mode}
          onClose={() => setChmodEntry(null)}
          onSuccess={() => void loadDirectory(currentPath)}
        />
      )}

      {/* Create Modal */}
      {mode === "admin" && createType && (
        <CreateModal
          type={createType}
          currentPath={currentPath}
          onClose={() => setCreateType(null)}
          onSubmit={handleCreate}
        />
      )}

      {/* Rename Modal */}
      {mode === "admin" && renameTarget && (
        <RenameModal
          entry={renameTarget}
          onClose={() => setRenameTarget(null)}
          onSubmit={handleRename}
        />
      )}

      {/* Delete Modal */}
      {mode === "admin" && deleteTarget && (
        <DeleteModal
          entry={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onConfirm={handleDelete}
        />
      )}
    </div>
  );
}

export default FilesPane;
