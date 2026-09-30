import { useEffect, useMemo, useRef, useState } from "react";
import { isAgentFileArtifact, type Artifact, type Room } from "@space/contracts";
import {
  Download,
  Eye,
  File,
  FileVideo,
  FolderOpen,
  Images,
  Loader2,
  Maximize2,
  Minimize2,
  Music2,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X
} from "../ui-theme/app-icons.js";
import { api } from "../../api.js";
import { ARTIFACTS_UPDATED_EVENT, dispatchArtifactsUpdated, isArtifactsUpdatedDetail } from "../../artifact-events.js";
import { setArtifactDragData } from "../artifacts/artifact-drag.js";
import { formatAppDateTime } from "../date-time-settings/date-time-settings.js";

interface AgentFilesDockProps {
  activeRoom: Room | null;
  refreshKey?: string | null;
}

type AgentFilePreviewKind = "IMAGE" | "VIDEO" | "AUDIO" | "PDF" | "TEXT" | "DOCX" | "NONE";

interface AgentFileEntry {
  artifact: Artifact;
  filename: string;
  previewKind: AgentFilePreviewKind;
  runtimeLabel: string;
  paneLabel: string;
  timestamp: string;
  size: string;
}

interface AgentFileWritable {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
}

interface AgentFileHandle {
  createWritable(): Promise<AgentFileWritable>;
}

type AgentFileSavePicker = (options: {
  suggestedName: string;
  types: Array<{
    description: string;
    accept: Record<string, string[]>;
  }>;
}) => Promise<AgentFileHandle>;

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(",")[1] ?? "";
      resolve(base64);
    };
    reader.onerror = () => reject(new Error("Failed to encode file for download"));
    reader.readAsDataURL(blob);
  });
}

function windowsAgentFileSavePicker(entry: AgentFileEntry): AgentFileSavePicker | null {
  if (entry.previewKind !== "DOCX") return null;
  const platform = `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`;
  if (!/\bWin(?:32|64|dows)?\b/i.test(platform)) return null;
  const picker = (window as typeof window & { showSaveFilePicker?: AgentFileSavePicker }).showSaveFilePicker;
  return typeof picker === "function" ? picker.bind(window) : null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / 1024 / 102.4) / 10} MB`;
  return `${Math.round(bytes / 1024 / 1024 / 102.4) / 10} GB`;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return formatAppDateTime(date);
}

function metadataString(artifact: Artifact, key: string): string | null {
  const value = artifact.metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function artifactFilename(artifact: Artifact): string {
  return (
    metadataString(artifact, "originalFilename") ??
    metadataString(artifact, "storedFilename") ??
    `agent-file-${artifact.id}`
  );
}

function previewKindFor(artifact: Artifact): AgentFilePreviewKind {
  const storedKind = metadataString(artifact, "previewKind");
  if (storedKind && ["IMAGE", "VIDEO", "AUDIO", "PDF", "TEXT", "DOCX", "NONE"].includes(storedKind)) {
    return storedKind as AgentFilePreviewKind;
  }
  const mimeType = artifact.mimeType.toLowerCase();
  const filename = artifactFilename(artifact).toLowerCase();
  if (mimeType.startsWith("image/") && mimeType !== "image/svg+xml") return "IMAGE";
  if (mimeType.startsWith("video/")) return "VIDEO";
  if (mimeType.startsWith("audio/")) return "AUDIO";
  if (mimeType === "application/pdf") return "PDF";
  if (
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    filename.endsWith(".docx")
  ) {
    return "DOCX";
  }
  if (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/xml"
  ) {
    return "TEXT";
  }
  return "NONE";
}

function runtimeLabel(artifact: Artifact): string {
  if (isUserUpload(artifact)) return "You";
  const runtimeId = metadataString(artifact, "runtimeId");
  if (!runtimeId) return "Agent";
  return runtimeId.replace(/^cli:/, "").replaceAll("-", " ");
}

function isUserUpload(artifact: Artifact): boolean {
  return metadataString(artifact, "source") === "USER_UPLOAD";
}

function paneLabel(artifact: Artifact): string {
  if (isUserUpload(artifact)) return "User upload";
  return artifact.paneId ? `Pane ${artifact.paneId}` : "Room deliverable";
}

function sortAgentFiles(artifacts: Artifact[]): Artifact[] {
  return [...artifacts].sort((left, right) => {
    const createdOrder = right.createdAt.localeCompare(left.createdAt);
    return createdOrder || right.id.localeCompare(left.id);
  });
}

function mergeAgentFiles(current: Artifact[], incoming: Artifact[]): Artifact[] {
  const byId = new Map<string, Artifact>();
  for (const artifact of [...incoming, ...current]) {
    if (!isAgentFileArtifact(artifact) || artifact.deletedAt || byId.has(artifact.id)) continue;
    byId.set(artifact.id, artifact);
  }
  return sortAgentFiles(Array.from(byId.values()));
}

function agentFileEntries(artifacts: Artifact[]): AgentFileEntry[] {
  return sortAgentFiles(artifacts).filter(isAgentFileArtifact).map((artifact) => ({
    artifact,
    filename: artifactFilename(artifact),
    previewKind: previewKindFor(artifact),
    runtimeLabel: runtimeLabel(artifact),
    paneLabel: paneLabel(artifact),
    timestamp: formatTimestamp(artifact.createdAt),
    size: formatBytes(artifact.byteSize)
  }));
}

export function AgentFilesDock({ activeRoom, refreshKey = null }: AgentFilesDockProps) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [clearingAll, setClearingAll] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [selected, setSelected] = useState<AgentFileEntry | null>(null);
  const [textPreview, setTextPreview] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("ALL");
  const loadSequence = useRef(0);
  const previewSequence = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const activeRoomId = useRef<string | null>(activeRoom?.id ?? null);
  activeRoomId.current = activeRoom?.id ?? null;
  const entries = useMemo(() => agentFileEntries(artifacts), [artifacts]);
  const filteredEntries = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return entries.filter((entry) =>
      (!search || entry.filename.toLocaleLowerCase().includes(search)) &&
      (typeFilter === "ALL" || entry.previewKind === typeFilter)
    );
  }, [entries, query, typeFilter]);

  async function loadAgentFiles(roomId: string) {
    if (activeRoomId.current !== roomId) return;
    const sequence = ++loadSequence.current;
    setLoading(true);
    setLoadFailed(false);
    setError(null);
    try {
      const firstPage = await api.artifacts({
        roomId,
        collection: "AGENT_FILES",
        pageSize: 100,
        sortOrder: "desc"
      });
      const loaded = [...firstPage.data];
      for (let page = 2; page <= firstPage.pagination.totalPages; page += 1) {
        if (sequence !== loadSequence.current || activeRoomId.current !== roomId) return;
        const payload = await api.artifacts({
          roomId,
          collection: "AGENT_FILES",
          page,
          pageSize: 100,
          sortOrder: "desc"
        });
        loaded.push(...payload.data);
      }
      if (sequence !== loadSequence.current || activeRoomId.current !== roomId) return;
      setArtifacts(mergeAgentFiles([], loaded));
    } catch (loadError) {
      if (sequence !== loadSequence.current || activeRoomId.current !== roomId) return;
      setError(loadError instanceof Error ? loadError.message : "Agent Files load failed");
      setLoadFailed(true);
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }

  useEffect(() => {
    setArtifacts([]);
    setSelected(null);
    setTextPreview(null);
    setPreviewError(null);
    setPreviewLoading(false);
    setLoading(false);
    setLoadFailed(false);
    setError(null);
    setQuery("");
    setTypeFilter("ALL");
    setDragOver(false);
    if (!activeRoom) setIsFullscreen(false);
    return () => {
      loadSequence.current += 1;
      previewSequence.current += 1;
    };
  }, [activeRoom?.id]);

  useEffect(() => {
    if (!activeRoom) return;
    void loadAgentFiles(activeRoom.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRoom?.id, refreshKey]);

  useEffect(() => {
    function handleArtifactsUpdated(event: Event) {
      if (!(event instanceof CustomEvent) || !isArtifactsUpdatedDetail(event.detail)) return;
      if (event.detail.roomId !== activeRoom?.id) return;
      setArtifacts((current) => mergeAgentFiles(current, event.detail.artifacts));
      setError(null);
    }
    window.addEventListener(ARTIFACTS_UPDATED_EVENT, handleArtifactsUpdated);
    return () => window.removeEventListener(ARTIFACTS_UPDATED_EVENT, handleArtifactsUpdated);
  }, [activeRoom?.id]);

  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (selected) {
        closePreview();
        return;
      }
      if (isFullscreen) setIsFullscreen(false);
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [isFullscreen, selected]);

  function closePreview() {
    previewSequence.current += 1;
    setSelected(null);
    setTextPreview(null);
    setPreviewLoading(false);
    setPreviewError(null);
  }

  async function openPreview(entry: AgentFileEntry) {
    const sequence = ++previewSequence.current;
    setSelected(entry);
    setTextPreview(null);
    setPreviewError(null);
    setPreviewLoading(entry.previewKind === "TEXT");
    if (entry.previewKind !== "TEXT") return;
    try {
      const response = await fetch(api.agentFilePreviewUrl(entry.artifact.id), {
        credentials: "same-origin",
        headers: { accept: "text/plain" }
      });
      if (!response.ok) throw new Error(`Preview failed (${response.status})`);
      const content = await response.text();
      if (sequence !== previewSequence.current) return;
      setTextPreview(content);
    } catch (previewLoadError) {
      if (sequence !== previewSequence.current) return;
      setPreviewError(previewLoadError instanceof Error ? previewLoadError.message : "Preview failed");
    } finally {
      if (sequence === previewSequence.current) setPreviewLoading(false);
    }
  }

  async function deleteAgentFile(entry: AgentFileEntry) {
    if (!window.confirm(`Permanently delete ${entry.filename}? This cannot be undone.`)) return;
    setDeletingId(entry.artifact.id);
    setError(null);
    try {
      await api.deleteArtifact(entry.artifact.id);
      setArtifacts((current) => current.filter((artifact) => artifact.id !== entry.artifact.id));
      if (selected?.artifact.id === entry.artifact.id) closePreview();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Agent File delete failed");
    } finally {
      setDeletingId(null);
    }
  }

  async function downloadAgentFile(entry: AgentFileEntry) {
    setDownloadingId(entry.artifact.id);
    setError(null);
    try {
      const savePicker = windowsAgentFileSavePicker(entry);
      let fileHandle: AgentFileHandle | null = null;
      if (savePicker) {
        try {
          fileHandle = await savePicker({
            suggestedName: entry.filename,
            types: [{
              description: "Microsoft Word document",
              accept: { [entry.artifact.mimeType]: [".docx"] }
            }]
          });
        } catch (pickerError) {
          if (pickerError instanceof DOMException && pickerError.name === "AbortError") return;
          throw pickerError;
        }
      }

      const response = await fetch(api.agentFileDownloadUrl(entry.artifact.id), {
        credentials: "same-origin",
        headers: { accept: entry.artifact.mimeType }
      });
      if (!response.ok) throw new Error(`Download failed (${response.status})`);
      const contentLengthHeader = response.headers.get("content-length");
      const contentEncoding = response.headers.get("content-encoding");
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (
        contentLengthHeader !== null
        && !contentEncoding
        && Number(contentLengthHeader) !== entry.artifact.byteSize
      ) {
        throw new Error("Download size verification failed.");
      }
      if (contentType !== entry.artifact.mimeType.toLowerCase()) {
        throw new Error("Download type verification failed.");
      }
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength !== entry.artifact.byteSize) {
        throw new Error("Downloaded file is incomplete.");
      }
      const digest = bytesToHex(await crypto.subtle.digest("SHA-256", buffer));
      if (digest !== entry.artifact.sha256.toLowerCase()) {
        throw new Error("Download integrity verification failed.");
      }

      const blob = new Blob([buffer], { type: entry.artifact.mimeType });
      if (fileHandle) {
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        return;
      }

      // If native Space App bridge is available, save directly to device Downloads
      const spaceNative = (window as unknown as { SpaceNative?: { saveFile?: (b64: string, name: string, mime: string) => boolean } }).SpaceNative;
      if (typeof spaceNative?.saveFile === "function") {
        const base64 = await blobToBase64(blob);
        const saved = spaceNative.saveFile(base64, entry.filename, entry.artifact.mimeType);
        if (saved) return;
      }

      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = entry.filename;
      anchor.rel = "noopener";
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : "Agent File download failed");
    } finally {
      setDownloadingId(null);
    }
  }

  async function clearAllAgentFiles() {
    if (!activeRoom || !entries.length) return;
    if (!window.confirm(`Permanently delete all Agent Files from ${activeRoom.name}? This cannot be undone.`)) {
      return;
    }
    setClearingAll(true);
    setError(null);
    const roomId = activeRoom.id;
    try {
      const result = await api.deleteRoomAgentFiles(roomId);
      if (activeRoomId.current !== roomId) return;
      closePreview();
      await loadAgentFiles(roomId);
      if (activeRoomId.current === roomId && result.failedCount > 0) {
        setError(`${result.failedCount} Agent File${result.failedCount === 1 ? "" : "s"} could not be deleted.`);
      }
    } catch (clearError) {
      if (activeRoomId.current === roomId) setError(clearError instanceof Error ? clearError.message : "Agent Files clear failed");
    } finally {
      setClearingAll(false);
    }
  }

  async function uploadFiles(files: File[]) {
    if (!activeRoom || !files.length || uploading) return;
    const roomId = activeRoom.id;
    setUploading(true);
    setError(null);
    try {
      const uploaded = await api.uploadAgentFiles({ roomId, files });
      if (activeRoomId.current === roomId) setArtifacts((current) => mergeAgentFiles(current, uploaded.artifacts));
      dispatchArtifactsUpdated(roomId, uploaded.artifacts);
    } catch (uploadError) {
      if (activeRoomId.current === roomId) setError(uploadError instanceof Error ? uploadError.message : "Agent Files upload failed");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function handleDragOver(event: React.DragEvent<HTMLDivElement>) {
    if (!activeRoom) return;
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    setDragOver(true);
  }

  function handleDragLeave(event: React.DragEvent<HTMLDivElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragOver(false);
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    if (!activeRoom) return;
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    setDragOver(false);
    void uploadFiles(Array.from(event.dataTransfer.files));
  }

  function previewBody(entry: AgentFileEntry) {
    const previewUrl = api.agentFilePreviewUrl(entry.artifact.id);
    if (entry.previewKind === "IMAGE") {
      return <img src={previewUrl} alt={`Preview of ${entry.filename}`} />;
    }
    if (entry.previewKind === "VIDEO") {
      return <video src={previewUrl} controls playsInline preload="metadata" aria-label={`Preview of ${entry.filename}`} />;
    }
    if (entry.previewKind === "AUDIO") {
      return <audio src={previewUrl} controls preload="metadata" aria-label={`Preview of ${entry.filename}`} />;
    }
    if (entry.previewKind === "PDF") {
      return <iframe src={previewUrl} title={`Preview of ${entry.filename}`} />;
    }
    if (entry.previewKind === "DOCX") {
      return <iframe src={previewUrl} title={`Preview of ${entry.filename}`} sandbox="" />;
    }
    if (entry.previewKind === "TEXT") {
      if (previewLoading) return <div className="agent-file-preview-status">Loading preview…</div>;
      if (previewError) return <div className="agent-file-preview-fallback bad">{previewError}</div>;
      return <pre className="agent-file-text-preview">{textPreview ?? ""}</pre>;
    }
    return (
      <div className="agent-file-preview-fallback">
        <File aria-hidden="true" />
        <strong>Preview is not available for this file type.</strong>
        <small>You can still download the original file.</small>
      </div>
    );
  }

  return (
    <div className={["agent-files-dock-shell", isFullscreen ? "is-fullscreen" : ""].filter(Boolean).join(" ")}>
      <div
        className={["dock-panel", "agent-files-dock", dragOver ? "is-dragover" : ""].filter(Boolean).join(" ")}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="agent-files-dock-head">
          <h2>Agent Files</h2>
          <div className="agent-files-dock-actions">
            <button
              className="icon-action"
              onClick={() => fileInputRef.current?.click()}
              disabled={!activeRoom || uploading || clearingAll}
              aria-label="Upload files to Agent Files"
              title="Upload files to Agent Files"
            >
              <Upload aria-hidden="true" />
            </button>
            <button
              className={`icon-action dock-fullscreen-toggle${isFullscreen ? " is-active" : ""}`}
              onClick={() => setIsFullscreen((current) => !current)}
              aria-label={isFullscreen ? "Exit Agent Files fullscreen" : "Maximize Agent Files"}
              title={isFullscreen ? "Exit Agent Files fullscreen" : "Maximize Agent Files"}
              aria-pressed={isFullscreen}
            >
              {isFullscreen ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
            </button>
            <button
              className="icon-action"
              onClick={() => void clearAllAgentFiles()}
              disabled={!activeRoom || !entries.length || clearingAll || Boolean(deletingId) || Boolean(downloadingId)}
              aria-label="Clear all Agent Files"
              title="Clear all Agent Files"
            >
              <Trash2 aria-hidden="true" />
            </button>
            <button
              className="icon-action"
              onClick={() => activeRoom && void loadAgentFiles(activeRoom.id)}
              disabled={!activeRoom || loading || clearingAll}
              aria-label="Refresh Agent Files"
              title="Refresh Agent Files"
            >
              <RefreshCw className={loading ? "agent-files-spinner" : undefined} aria-hidden="true" />
            </button>
          </div>
        </div>

        <section className="agent-files-summary" aria-label="Room Agent Files summary">
          <FolderOpen aria-hidden="true" />
          <span>
            <strong>{activeRoom ? loading && !entries.length ? "Loading files…" : loadFailed && !entries.length ? "Files unavailable" : `${entries.length} file${entries.length === 1 ? "" : "s"} in this room` : "No room selected"}</strong>
            <small>Agent deliverables and your uploads, together. Preview, download or drag a file into a pane.</small>
          </span>
        </section>

        {activeRoom ? (
          <div className="agent-files-filters" role="search" aria-label="Find Agent Files">
            <label className="agent-files-search">
              <Search aria-hidden="true" />
              <input type="search" aria-label="Search Agent Files" placeholder="Search files…" value={query} onChange={(event) => setQuery(event.target.value)} />
            </label>
            <select aria-label="Filter Agent Files by type" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
              <option value="ALL">All types</option>
              <option value="IMAGE">Images</option>
              <option value="PDF">PDFs</option>
              <option value="DOCX">Documents</option>
              <option value="TEXT">Text & code</option>
              <option value="VIDEO">Videos</option>
              <option value="AUDIO">Audio</option>
              <option value="NONE">Other files</option>
            </select>
            {query || typeFilter !== "ALL" ? <small className="agent-files-result-count" role="status">{filteredEntries.length} of {entries.length} files</small> : null}
          </div>
        ) : null}

        {error ? <div className="banner bad" role="alert">{error}</div> : null}
        {uploading ? <div className="banner" role="status">Uploading files…</div> : null}

        {!activeRoom ? (
          <div className="empty-state" role="status">
            <FolderOpen aria-hidden="true" />
            <span>Select a room to view its Agent Files.</span>
          </div>
        ) : loading && !entries.length ? (
          <div className="empty-state" role="status"><Loader2 className="agent-files-spinner" aria-hidden="true" /><span>Loading Agent Files…</span></div>
        ) : filteredEntries.length ? (
          <div className={["agent-files-list", isFullscreen ? "is-gallery" : ""].filter(Boolean).join(" ")} role="list" aria-label="Room Agent Files" aria-busy={loading}>
            {filteredEntries.map((entry) => (
              <article
                className="agent-file-card"
                role="listitem"
                key={entry.artifact.id}
                draggable
                onDragStart={(event) => setArtifactDragData(event, entry.artifact)}
                aria-label={`Drag ${entry.filename}`}
              >
                <button
                  className="agent-file-preview-button"
                  onClick={() => void openPreview(entry)}
                  disabled={clearingAll || Boolean(deletingId)}
                  aria-label={`Preview ${entry.filename}`}
                  title={`Preview ${entry.filename}`}
                >
                  {entry.previewKind === "IMAGE" ? <Images aria-hidden="true" /> : entry.previewKind === "VIDEO" ? <FileVideo aria-hidden="true" /> : entry.previewKind === "AUDIO" ? <Music2 aria-hidden="true" /> : <File aria-hidden="true" />}
                  <span className="agent-file-preview-chip"><Eye aria-hidden="true" /></span>
                </button>
                <div className="agent-file-card-body">
                  <strong title={entry.filename}>{entry.filename}</strong>
                  <small>{entry.runtimeLabel} · {entry.paneLabel}</small>
                  <small>{entry.timestamp} · {entry.size}</small>
                </div>
                <div className="agent-file-card-actions">
                  <button
                    className="agent-file-action"
                    type="button"
                    onClick={() => void downloadAgentFile(entry)}
                    disabled={Boolean(downloadingId) || clearingAll}
                    aria-label={`Download ${entry.filename}`}
                    title={`Download and verify ${entry.filename}`}
                  >
                    {downloadingId === entry.artifact.id ? <Loader2 className="agent-files-spinner" aria-hidden="true" /> : <Download aria-hidden="true" />}
                  </button>
                  <button
                    className="agent-file-action"
                    onClick={() => void deleteAgentFile(entry)}
                    disabled={deletingId === entry.artifact.id || clearingAll || Boolean(downloadingId)}
                    aria-label={`Delete ${entry.filename}`}
                    title={`Permanently delete ${entry.filename}`}
                  >
                    <Trash2 aria-hidden="true" />
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : query || typeFilter !== "ALL" ? (
          <div className="empty-state" role="status">
            <Search aria-hidden="true" />
            <span>No files match your search.</span>
            <button type="button" onClick={() => { setQuery(""); setTypeFilter("ALL"); }}>Clear filters</button>
          </div>
        ) : loadFailed ? (
          <div className="empty-state"><span>Files could not be loaded.</span><button type="button" onClick={() => void loadAgentFiles(activeRoom.id)}>Try again</button></div>
        ) : (
          <div className={["empty-state", dragOver ? "is-dragover" : ""].filter(Boolean).join(" ")} role="status">
            <Upload aria-hidden="true" />
            <span>Drop files here or use the upload button to add files to this room.</span>
            <button type="button" disabled={uploading || clearingAll} onClick={() => fileInputRef.current?.click()}>Upload files</button>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          aria-hidden="true"
          tabIndex={-1}
          onChange={(event) => void uploadFiles(Array.from(event.target.files ?? []))}
        />

        {selected ? (
          <div
            className="attachment-modal agent-file-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`Preview ${selected.filename}`}
            onClick={closePreview}
          >
            <div className="attachment-modal-body agent-file-modal-body" onClick={(event) => event.stopPropagation()}>
              <div className="agent-file-modal-head">
                <span>
                  <strong>{selected.filename}</strong>
                  <small>{selected.runtimeLabel} · {selected.timestamp} · {selected.size}</small>
                </span>
                <div>
                  <button
                    className="icon-button"
                    type="button"
                    onClick={() => void downloadAgentFile(selected)}
                    disabled={downloadingId === selected.artifact.id}
                    aria-label={`Download ${selected.filename}`}
                    title={`Download and verify ${selected.filename}`}
                  >
                    <Download aria-hidden="true" />
                  </button>
                  <button className="icon-button" onClick={closePreview} aria-label="Close Agent File preview">
                    <X aria-hidden="true" />
                  </button>
                </div>
              </div>
              <div className="agent-file-modal-preview">{previewBody(selected)}</div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
