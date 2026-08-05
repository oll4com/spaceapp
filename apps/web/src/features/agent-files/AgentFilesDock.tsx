import { useEffect, useMemo, useRef, useState } from "react";
import { isAgentFileArtifact, type Artifact, type Room } from "@space/contracts";
import {
  Download,
  Eye,
  File,
  FolderOpen,
  Maximize2,
  Minimize2,
  RefreshCw,
  Trash2,
  X
} from "../ui-theme/app-icons.js";
import { api } from "../../api.js";
import { ARTIFACTS_UPDATED_EVENT, isArtifactsUpdatedDetail } from "../../artifact-events.js";
import { setArtifactDragData } from "../artifacts/artifact-drag.js";

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
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
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
  const runtimeId = metadataString(artifact, "runtimeId");
  if (!runtimeId) return "Agent";
  return runtimeId.replace(/^cli:/, "").replaceAll("-", " ");
}

function paneLabel(artifact: Artifact): string {
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
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [clearingAll, setClearingAll] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [selected, setSelected] = useState<AgentFileEntry | null>(null);
  const [textPreview, setTextPreview] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadSequence = useRef(0);
  const previewSequence = useRef(0);
  const activeRoomId = useRef<string | null>(activeRoom?.id ?? null);
  activeRoomId.current = activeRoom?.id ?? null;
  const entries = useMemo(() => agentFileEntries(artifacts), [artifacts]);

  async function loadAgentFiles(roomId: string) {
    if (activeRoomId.current !== roomId) return;
    const sequence = ++loadSequence.current;
    setLoading(true);
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
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }

  useEffect(() => {
    if (!activeRoom) {
      loadSequence.current += 1;
      previewSequence.current += 1;
      setArtifacts([]);
      setSelected(null);
      setTextPreview(null);
      setPreviewError(null);
      setIsFullscreen(false);
      setError(null);
      return;
    }
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
    try {
      const result = await api.deleteRoomAgentFiles(activeRoom.id);
      closePreview();
      await loadAgentFiles(activeRoom.id);
      if (result.failedCount > 0) {
        setError(`${result.failedCount} Agent File${result.failedCount === 1 ? "" : "s"} could not be deleted.`);
      }
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : "Agent Files clear failed");
    } finally {
      setClearingAll(false);
    }
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
      <div className="dock-panel agent-files-dock">
        <div className="agent-files-dock-head">
          <h2>Agent Files</h2>
          <div className="agent-files-dock-actions">
            <button
              className="icon-action"
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
              <RefreshCw aria-hidden="true" />
            </button>
          </div>
        </div>

        <section className="agent-files-summary" aria-label="Room Agent Files summary">
          <FolderOpen aria-hidden="true" />
          <span>
            <strong>{activeRoom ? `${entries.length} agent-created file${entries.length === 1 ? "" : "s"}` : "No room selected"}</strong>
            <small>Final deliverables published by agents stay here until you delete them.</small>
          </span>
        </section>

        {error ? <div className="banner bad">{error}</div> : null}

        {!activeRoom ? (
          <div className="empty-state" role="status">
            <FolderOpen aria-hidden="true" />
            <span>Select a room to view its Agent Files.</span>
          </div>
        ) : entries.length ? (
          <div className={["agent-files-list", isFullscreen ? "is-gallery" : ""].filter(Boolean).join(" ")} role="list" aria-label="Room Agent Files">
            {entries.map((entry) => (
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
                  <File aria-hidden="true" />
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
                    disabled={downloadingId === entry.artifact.id || clearingAll}
                    aria-label={`Download ${entry.filename}`}
                    title={`Download and verify ${entry.filename}`}
                  >
                    <Download aria-hidden="true" />
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
        ) : (
          <div className="empty-state" role="status">
            <FolderOpen aria-hidden="true" />
            <span>No agent-created files have been published in this room yet.</span>
          </div>
        )}

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
