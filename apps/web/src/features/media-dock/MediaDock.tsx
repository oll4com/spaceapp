import { File, Film, Images, Maximize2, Minimize2, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { isRoomMediaArtifact, type Artifact, type Room } from "@space/contracts";
import { api } from "../../api.js";
import { ARTIFACTS_UPDATED_EVENT, isArtifactsUpdatedDetail } from "../../artifact-events.js";
import { DEMO_LOCAL_REPLY, getSpaceRuntime } from "../../runtime/SpaceRuntime.js";

interface MediaDockProps {
  activeRoom: Room | null;
  refreshKey?: string | null;
}

interface MediaEntry {
  artifact: Artifact;
  mediaType: "image" | "video" | "file";
  label: string;
  title: string;
  meta: string;
}

function isImageArtifact(artifact: Artifact): boolean {
  return artifact.mimeType.startsWith("image/") || artifact.kind === "IMAGE" || artifact.kind === "SCREENSHOT";
}

function isVideoArtifact(artifact: Artifact): boolean {
  return artifact.mimeType.startsWith("video/") || artifact.kind === "VIDEO";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / 1024 / 102.4) / 10} MB`;
}

function sortMediaArtifacts(artifacts: Artifact[]): Artifact[] {
  return [...artifacts].sort((left, right) => {
    const leftTime = Date.parse(left.createdAt);
    const rightTime = Date.parse(right.createdAt);
    if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) return right.id.localeCompare(left.id);
    if (rightTime === leftTime) return right.id.localeCompare(left.id);
    return rightTime - leftTime;
  });
}

function formatMediaTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${day}/${month}/${year} ${hours}:${minutes}`;
}

function mediaEntries(artifacts: Artifact[]): MediaEntry[] {
  let photoIndex = 0;
  let videoIndex = 0;
  let fileIndex = 0;
  return sortMediaArtifacts(artifacts).filter(isRoomMediaArtifact).map((artifact) => {
    const mediaType = isImageArtifact(artifact) ? "image" : isVideoArtifact(artifact) ? "video" : "file";
    const index = mediaType === "image" ? (photoIndex += 1) : mediaType === "video" ? (videoIndex += 1) : (fileIndex += 1);
    const label = `${mediaType === "image" ? "Photo" : mediaType === "video" ? "Video" : "File"} ${index}`;
    return {
      artifact,
      mediaType,
      label,
      title: formatMediaTimestamp(artifact.createdAt),
      meta: `${label} · ${artifact.kind} · ${formatBytes(artifact.byteSize)}`
    };
  });
}

function mergeMediaArtifacts(current: Artifact[], incoming: Artifact[]): Artifact[] {
  const byId = new Map<string, Artifact>();
  for (const artifact of [...incoming, ...current]) {
    if (!isRoomMediaArtifact(artifact) || byId.has(artifact.id)) continue;
    byId.set(artifact.id, artifact);
  }
  return sortMediaArtifacts(Array.from(byId.values()));
}

export function MediaDock({ activeRoom, refreshKey = null }: MediaDockProps) {
  const runtime = getSpaceRuntime();
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [clearingAll, setClearingAll] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [selected, setSelected] = useState<MediaEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const loadSequence = useRef(0);
  const activeRoomId = useRef<string | null>(activeRoom?.id ?? null);
  activeRoomId.current = activeRoom?.id ?? null;
  const entries = useMemo(() => mediaEntries(artifacts), [artifacts]);
  const mediaLayout = isFullscreen ? "gallery" : "list";

  async function loadMedia(roomId: string) {
    if (activeRoomId.current !== roomId) return;
    const sequence = ++loadSequence.current;
    setLoading(true);
    setError(null);
    try {
      const firstPage = await api.artifacts({ roomId, pageSize: 100, sortOrder: "desc" });
      const loaded = [...firstPage.data];
      for (let page = 2; page <= firstPage.pagination.totalPages; page += 1) {
        const payload = await api.artifacts({ roomId, page, pageSize: 100, sortOrder: "desc" });
        loaded.push(...payload.data);
      }
      if (sequence !== loadSequence.current || activeRoomId.current !== roomId) return;
      setArtifacts(mergeMediaArtifacts([], loaded));
    } catch (err) {
      if (sequence !== loadSequence.current || activeRoomId.current !== roomId) return;
      setError(err instanceof Error ? err.message : "Media load failed");
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }

  useEffect(() => {
    if (!activeRoom) {
      loadSequence.current += 1;
      setArtifacts([]);
      setSelected(null);
      setIsFullscreen(false);
      setError(null);
      return;
    }
    void loadMedia(activeRoom.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRoom?.id, refreshKey]);

  useEffect(() => {
    function handleArtifactsUpdated(event: Event) {
      if (!(event instanceof CustomEvent) || !isArtifactsUpdatedDetail(event.detail)) return;
      if (event.detail.roomId !== activeRoom?.id) return;
      setArtifacts((current) => mergeMediaArtifacts(current, event.detail.artifacts));
      setError(null);
    }
    window.addEventListener(ARTIFACTS_UPDATED_EVENT, handleArtifactsUpdated);
    return () => window.removeEventListener(ARTIFACTS_UPDATED_EVENT, handleArtifactsUpdated);
  }, [activeRoom?.id]);

  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (selected) {
        setSelected(null);
        return;
      }
      if (isFullscreen) {
        setIsFullscreen(false);
      }
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [isFullscreen, selected]);

  async function deleteMedia(entry: MediaEntry) {
    if (!window.confirm(`Permanently delete ${entry.label}? This cannot be undone.`)) {
      return;
    }
    setDeletingId(entry.artifact.id);
    setError(null);
    try {
      await api.deleteArtifact(entry.artifact.id);
      setArtifacts((current) => current.filter((artifact) => artifact.id !== entry.artifact.id));
      setSelected((current) => (current?.artifact.id === entry.artifact.id ? null : current));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Media delete failed");
    } finally {
      setDeletingId(null);
    }
  }

  function openMedia(entry: MediaEntry) {
    setNotice(null);
    if (entry.mediaType === "image" || entry.mediaType === "video") {
      setSelected(entry);
      return;
    }
    const opened = runtime.platform.openLink(api.artifactFileUrl(entry.artifact.id), "_blank", "noopener,noreferrer");
    if (!opened && runtime.kind === "demo") setNotice(DEMO_LOCAL_REPLY);
  }

  async function clearAllMedia() {
    if (!activeRoom || !entries.length) return;
    if (!window.confirm(`Permanently delete all media from ${activeRoom.name}, including older media? This cannot be undone.`)) {
      return;
    }
    setClearingAll(true);
    setError(null);
    try {
      const result = await api.deleteRoomMedia(activeRoom.id);
      setSelected(null);
      await loadMedia(activeRoom.id);
      if (result.failedCount > 0) {
        setError(`${result.failedCount} media item${result.failedCount === 1 ? "" : "s"} could not be deleted.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Media clear failed");
    } finally {
      setClearingAll(false);
    }
  }

  return (
    <div className={["media-dock-shell", isFullscreen ? "is-fullscreen" : ""].filter(Boolean).join(" ")}>
      <div className="dock-panel media-dock">
        <div className="media-dock-head">
          <h2>Media</h2>
          <div className="media-dock-actions">
            <button
              className="icon-action"
              onClick={() => setIsFullscreen((current) => !current)}
              aria-label={isFullscreen ? "Exit media fullscreen" : "Maximize media"}
              title={isFullscreen ? "Exit media fullscreen" : "Maximize media"}
              aria-pressed={isFullscreen}
            >
              {isFullscreen ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
            </button>
            <button
              className="icon-action"
              onClick={() => void clearAllMedia()}
              disabled={!activeRoom || !entries.length || clearingAll || Boolean(deletingId)}
              aria-label="Clear all media"
              title="Clear all media"
            >
              <Trash2 aria-hidden="true" />
            </button>
            <button
              className="icon-action"
              onClick={() => activeRoom && void loadMedia(activeRoom.id)}
              disabled={!activeRoom || loading || clearingAll}
              aria-label="Refresh media"
              title="Refresh media"
            >
              <RefreshCw aria-hidden="true" />
            </button>
          </div>
        </div>
      <section className="media-summary" aria-label="Room media summary">
        <Images aria-hidden="true" />
        <span>
          <strong>{activeRoom ? `${entries.length} room media items` : "No room selected"}</strong>
          <small>Uploads sent to agents and terminal panes are collected here automatically.</small>
        </span>
      </section>
      {error ? <div className="banner bad">{error}</div> : null}
      {notice ? <div className="banner warn" role="status">{notice}</div> : null}
      {!activeRoom ? (
        <div className="empty-state" role="status">
          <Images aria-hidden="true" />
          <span>Select a room to view its media.</span>
        </div>
      ) : entries.length ? (
        <div className={`media-grid ${isFullscreen ? "is-gallery" : "is-list"}`} role="list" aria-label="Room media" data-layout={mediaLayout}>
          {entries.map((entry) => (
            <article className="media-card" role="listitem" key={entry.artifact.id}>
              <button
                className="media-preview-button"
                onClick={() => openMedia(entry)}
                aria-label={`Open ${entry.label}`}
                disabled={clearingAll || Boolean(deletingId)}
              >
                {entry.mediaType === "image" ? (
                  <img src={api.artifactFileUrl(entry.artifact.id)} alt={entry.label} loading="lazy" />
                ) : entry.mediaType === "video" ? (
                  <video src={api.artifactFileUrl(entry.artifact.id)} aria-label={entry.label} preload="metadata" muted playsInline />
                ) : (
                  <span className="media-file-icon">
                    <File aria-hidden="true" />
                  </span>
                )}
                {entry.mediaType === "video" ? (
                  <span className="media-video-chip" aria-hidden="true">
                    <Film />
                  </span>
                ) : null}
                <span className="media-open-chip">
                  <Maximize2 aria-hidden="true" />
                </span>
              </button>
              <div className="media-card-body">
                <span>
                  <strong>{entry.title}</strong>
                  <small>{entry.meta}</small>
                </span>
                <button
                  className="media-delete"
                  onClick={() => void deleteMedia(entry)}
                  disabled={deletingId === entry.artifact.id || clearingAll}
                  aria-label={`Delete ${entry.label}`}
                  title={`Permanently delete ${entry.label}`}
                >
                  <Trash2 aria-hidden="true" />
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty-state" role="status">
          <Images aria-hidden="true" />
          <span>No media has been sent in this room yet.</span>
        </div>
      )}
      {selected ? (
        <div className="attachment-modal media-modal" role="dialog" aria-modal="true" aria-label={`${selected.label} full resolution`} onClick={() => setSelected(null)}>
          <div className="attachment-modal-body media-modal-body" onClick={(event) => event.stopPropagation()}>
            <button className="icon-button" onClick={() => setSelected(null)} aria-label="Close media viewer">
              <X aria-hidden="true" />
            </button>
            {selected.mediaType === "video" ? (
              <video src={api.artifactFileUrl(selected.artifact.id)} controls playsInline preload="metadata" aria-label={`${selected.label} full resolution`} />
            ) : (
              <img src={api.artifactFileUrl(selected.artifact.id)} alt={`${selected.label} full resolution`} />
            )}
            <div className="media-modal-caption">
              <strong>{selected.title}</strong>
              <small>{selected.meta}</small>
            </div>
          </div>
        </div>
      ) : null}
      </div>
    </div>
  );
}
