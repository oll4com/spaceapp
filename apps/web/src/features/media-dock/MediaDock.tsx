import { ExternalLink, File, Film, Images, RefreshCw, Trash2, X, ZoomIn } from "../ui-theme/app-icons.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { isRoomMediaArtifact, type Artifact, type Room } from "@space/contracts";
import { api } from "../../api.js";
import { ARTIFACTS_UPDATED_EVENT, isArtifactsUpdatedDetail } from "../../artifact-events.js";
import { DEMO_LOCAL_REPLY, getSpaceRuntime } from "../../runtime/SpaceRuntime.js";
import { setArtifactDragData } from "../artifacts/artifact-drag.js";
import { useAutoDismiss } from "../../use-auto-dismiss.js";
import {
  DATE_TIME_SETTINGS_UPDATED_EVENT,
  formatAppDateTime
} from "../date-time-settings/date-time-settings.js";
import { useIsDockActive } from "../docks/dock-active-context.js";
import {
  DockFullscreenButton,
  DockIconButton,
  DockNotice,
  DockSearch,
  DockState,
  DockToolbar,
  useDockConfirm,
  useDockFullscreen
} from "../dock-kit/DockKit.js";
import "./media-dock.css";

interface MediaDockProps {
  activeRoom: Room | null;
  refreshKey?: string | null;
}

type MediaType = "image" | "video" | "file";

export interface MediaEntry {
  artifact: Artifact;
  mediaType: MediaType;
  /** Readable kind, e.g. "Screenshot" or "Pasted image". */
  kindLabel: string;
  /** Stable title: the file name, or the kind and time when there is no useful name. */
  title: string;
  /** True when the title is a real file name (so the time is shown separately). */
  hasFilename: boolean;
  time: string;
  size: string;
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
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / 1024 / 102.4) / 10} MB`;
  return `${Math.round(bytes / 1024 / 1024 / 102.4) / 10} GB`;
}

function metadataString(artifact: Artifact, key: string): string | null {
  const value = artifact.metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
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

function mediaKindLabel(artifact: Artifact, mediaType: MediaType): string {
  if (artifact.kind === "SCREENSHOT") return "Screenshot";
  if (mediaType === "image") return metadataString(artifact, "source") === "CLIPBOARD" ? "Pasted image" : "Image";
  if (mediaType === "video") return "Video";
  return "File";
}

/** Clipboard pastes carry generic browser names such as "image.png", so they are titled by kind and time. */
function mediaFilename(artifact: Artifact): string | null {
  if (metadataString(artifact, "source") === "CLIPBOARD") return null;
  return metadataString(artifact, "originalFilename");
}

function mediaTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return formatAppDateTime(date);
}

export function mediaEntries(artifacts: Artifact[]): MediaEntry[] {
  return sortMediaArtifacts(artifacts).filter(isRoomMediaArtifact).map((artifact) => {
    const mediaType: MediaType = isImageArtifact(artifact) ? "image" : isVideoArtifact(artifact) ? "video" : "file";
    const kindLabel = mediaKindLabel(artifact, mediaType);
    const time = mediaTime(artifact.createdAt);
    const filename = mediaFilename(artifact);
    return {
      artifact,
      mediaType,
      kindLabel,
      title: filename ?? `${kindLabel} · ${time}`,
      hasFilename: Boolean(filename),
      time,
      size: formatBytes(artifact.byteSize)
    };
  });
}

function matchesMediaSearch(entry: MediaEntry, search: string): boolean {
  if (!search) return true;
  return [entry.title, entry.kindLabel, entry.artifact.mimeType]
    .join(" ")
    .toLocaleLowerCase()
    .includes(search);
}

function mergeMediaArtifacts(current: Artifact[], incoming: Artifact[]): Artifact[] {
  const byId = new Map<string, Artifact>();
  for (const artifact of [...incoming, ...current]) {
    if (!isRoomMediaArtifact(artifact) || byId.has(artifact.id)) continue;
    byId.set(artifact.id, artifact);
  }
  return sortMediaArtifacts(Array.from(byId.values()));
}

const mediaRoomCache = new Map<string, Artifact[]>();

/** Test hook: forget every cached room. */
export function clearMediaRoomCache(): void {
  mediaRoomCache.clear();
}

export function MediaDock({ activeRoom, refreshKey = null }: MediaDockProps) {
  const runtime = getSpaceRuntime();
  const isDockActive = useIsDockActive();
  const { confirm, confirmDialog } = useDockConfirm();
  const [artifacts, setArtifacts] = useState<Artifact[]>(() =>
    activeRoom?.id ? mediaRoomCache.get(activeRoom.id) ?? [] : []
  );
  const [hasLoaded, setHasLoaded] = useState(() => Boolean(activeRoom?.id && mediaRoomCache.has(activeRoom.id)));
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [clearingAll, setClearingAll] = useState(false);
  const [isFullscreen, setIsFullscreen] = useDockFullscreen();
  const [selected, setSelected] = useState<MediaEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [dateTimeTick, setDateTimeTick] = useState(0);
  const loadSequence = useRef(0);
  const activeRoomId = useRef<string | null>(activeRoom?.id ?? null);
  activeRoomId.current = activeRoom?.id ?? null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const entries = useMemo(() => mediaEntries(artifacts), [artifacts, dateTimeTick]);
  const search = query.trim().toLocaleLowerCase();
  const visibleEntries = useMemo(() => entries.filter((entry) => matchesMediaSearch(entry, search)), [entries, search]);
  const mediaLayout = isFullscreen ? "gallery" : "list";

  useAutoDismiss(error, setError);
  useAutoDismiss(notice, setNotice);

  async function loadMedia(roomId: string) {
    if (activeRoomId.current !== roomId) return;
    const sequence = ++loadSequence.current;
    setLoading(true);
    try {
      const firstPage = await api.artifacts({ roomId, collection: "ROOM_MEDIA", pageSize: 100, sortOrder: "desc" });
      const loaded = [...firstPage.data];
      for (let page = 2; page <= firstPage.pagination.totalPages; page += 1) {
        const payload = await api.artifacts({ roomId, collection: "ROOM_MEDIA", page, pageSize: 100, sortOrder: "desc" });
        loaded.push(...payload.data);
      }
      if (sequence !== loadSequence.current || activeRoomId.current !== roomId) return;
      const merged = mergeMediaArtifacts([], loaded);
      mediaRoomCache.set(roomId, merged);
      setArtifacts(merged);
      setLoadError(null);
      setHasLoaded(true);
    } catch (err) {
      if (sequence !== loadSequence.current || activeRoomId.current !== roomId) return;
      setLoadError(err instanceof Error ? err.message : "Media could not be loaded.");
      setHasLoaded(true);
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }

  // A room switch never shows the previous room's media while the next room loads.
  useEffect(() => {
    setSelected(null);
    setQuery("");
    setError(null);
    setLoadError(null);
    if (!activeRoom) {
      loadSequence.current += 1;
      setArtifacts([]);
      setIsFullscreen(false);
      setLoading(false);
      return;
    }
    const cached = mediaRoomCache.get(activeRoom.id);
    setArtifacts(cached ?? []);
    setHasLoaded(Boolean(cached));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRoom?.id]);

  useEffect(() => {
    if (!activeRoom) return;
    void loadMedia(activeRoom.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRoom?.id, refreshKey]);

  useEffect(() => {
    function handleArtifactsUpdated(event: Event) {
      if (!(event instanceof CustomEvent) || !isArtifactsUpdatedDetail(event.detail)) return;
      if (event.detail.roomId !== activeRoom?.id) return;
      setArtifacts((current) => {
        const merged = mergeMediaArtifacts(current, event.detail.artifacts);
        if (activeRoom?.id) mediaRoomCache.set(activeRoom.id, merged);
        return merged;
      });
      setError(null);
    }
    window.addEventListener(ARTIFACTS_UPDATED_EVENT, handleArtifactsUpdated);
    return () => window.removeEventListener(ARTIFACTS_UPDATED_EVENT, handleArtifactsUpdated);
  }, [activeRoom?.id]);

  useEffect(() => {
    const handleSettingsUpdate = () => setDateTimeTick((count) => count + 1);
    window.addEventListener(DATE_TIME_SETTINGS_UPDATED_EVENT, handleSettingsUpdate);
    return () => window.removeEventListener(DATE_TIME_SETTINGS_UPDATED_EVENT, handleSettingsUpdate);
  }, []);

  // A hidden dock leaves fullscreen so no Escape listener stays behind.
  useEffect(() => {
    if (!isDockActive) setIsFullscreen(false);
  }, [isDockActive, setIsFullscreen]);

  // The viewer closes first on Escape; fullscreen stays until the next Escape.
  useEffect(() => {
    if (!selected || !isDockActive) return;
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setSelected(null);
    }
    document.addEventListener("keydown", handleEscape, true);
    return () => document.removeEventListener("keydown", handleEscape, true);
  }, [selected, isDockActive]);

  async function deleteMedia(entry: MediaEntry) {
    const accepted = await confirm({
      title: "Delete this media item?",
      message: `"${entry.title}" will be permanently deleted. This cannot be undone.`,
      confirmLabel: "Delete"
    });
    if (!accepted) return;
    const roomId = activeRoom?.id ?? null;
    setDeletingId(entry.artifact.id);
    setError(null);
    try {
      await api.deleteArtifact(entry.artifact.id);
      setArtifacts((current) => current.filter((artifact) => artifact.id !== entry.artifact.id));
      // Keep the room cache in step so a remount does not bring the deleted item back.
      const cached = roomId ? mediaRoomCache.get(roomId) : undefined;
      if (roomId && cached) mediaRoomCache.set(roomId, cached.filter((artifact) => artifact.id !== entry.artifact.id));
      setSelected((current) => (current?.artifact.id === entry.artifact.id ? null : current));
    } catch (err) {
      setError(err instanceof Error ? err.message : "The media item could not be deleted.");
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
    const room = activeRoom;
    const accepted = await confirm({
      title: "Clear all media?",
      message: `Permanently delete all media from ${room.name}, including older media? This cannot be undone.`,
      confirmLabel: "Clear all"
    });
    if (!accepted) return;
    setClearingAll(true);
    setError(null);
    try {
      const result = await api.deleteRoomMedia(room.id);
      setSelected(null);
      await loadMedia(room.id);
      if (result.failedCount > 0) {
        setError(`${result.failedCount} media item${result.failedCount === 1 ? "" : "s"} could not be deleted.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Media could not be cleared.");
    } finally {
      setClearingAll(false);
    }
  }

  const summary = !activeRoom
    ? "No room selected"
    : !hasLoaded && !entries.length
      ? undefined
      : search
        ? <><strong>{visibleEntries.length}</strong> of {entries.length} media item{entries.length === 1 ? "" : "s"}</>
        : <><strong>{entries.length}</strong> media item{entries.length === 1 ? "" : "s"} in this room</>;

  return (
    <div className={`media-dock-shell dock-kit-shell${isFullscreen ? " is-fullscreen" : ""}`}>
      <div className="media-dock dock-kit-dock">
        <DockToolbar title={isFullscreen ? "Media" : undefined} summary={summary}>
          <DockIconButton
            label="Refresh media"
            icon={RefreshCw}
            busy={loading && hasLoaded}
            disabled={!activeRoom || loading || clearingAll}
            onClick={() => activeRoom && void loadMedia(activeRoom.id)}
          />
          <DockIconButton
            label="Clear all media"
            icon={Trash2}
            tone="danger"
            disabled={!activeRoom || !entries.length || clearingAll || Boolean(deletingId)}
            onClick={() => void clearAllMedia()}
          />
          <DockFullscreenButton name="media" active={isFullscreen} onToggle={() => setIsFullscreen((current) => !current)} />
        </DockToolbar>

        {activeRoom && (entries.length > 0 || query) ? (
          <div className="dock-kit-controls">
            <DockSearch name="media-search" label="Search media" placeholder="Search by name or type…" value={query} onChange={setQuery} />
          </div>
        ) : null}

        {error ? <DockNotice onDismiss={() => setError(null)}>{error}</DockNotice> : null}
        {loadError && entries.length ? <DockNotice onDismiss={() => setLoadError(null)}>{loadError}</DockNotice> : null}
        {notice ? <DockNotice tone="info" onDismiss={() => setNotice(null)}>{notice}</DockNotice> : null}

        {!activeRoom ? (
          <DockState kind="empty" icon={Images} title="Select a room to view its media." />
        ) : !visibleEntries.length ? (
          !hasLoaded && !entries.length ? (
            <DockState kind="loading" title="Loading media…" />
          ) : loadError && !entries.length ? (
            <DockState kind="error" title="Media could not be loaded" detail={loadError}
              action={{ label: "Try again", onClick: () => void loadMedia(activeRoom.id) }} />
          ) : entries.length ? (
            <DockState kind="empty" icon={Images} title="No media matches your search." detail="Try another file name or type." />
          ) : (
            <DockState kind="empty" icon={Images} title="No media has been sent in this room yet."
              detail="Uploads sent to agents and terminal panes are collected here automatically." />
          )
        ) : null}

        <div
          className={`media-dock-list dock-kit-list ${isFullscreen ? "is-gallery" : "is-list"}`}
          role="list"
          aria-label="Room media"
          data-layout={mediaLayout}
          hidden={!activeRoom || !visibleEntries.length}
        >
          {visibleEntries.map((entry) => (
            <article
              className="media-dock-card dock-kit-card"
              role="listitem"
              key={entry.artifact.id}
              draggable
              onDragStart={(event) => setArtifactDragData(event, entry.artifact)}
              aria-label={`Drag ${entry.title}`}
            >
              <button
                type="button"
                className="media-dock-preview"
                onClick={() => openMedia(entry)}
                aria-label={`Open ${entry.title}`}
                title={entry.mediaType === "file" ? `Open ${entry.title} in a new tab` : `Open ${entry.title}`}
                disabled={clearingAll || Boolean(deletingId)}
              >
                {entry.mediaType === "image" ? (
                  <img src={api.artifactFileUrl(entry.artifact.id)} alt={entry.title} loading="lazy" />
                ) : entry.mediaType === "video" ? (
                  <video src={api.artifactFileUrl(entry.artifact.id)} aria-label={entry.title} preload="metadata" muted playsInline />
                ) : (
                  <span className="media-dock-file-icon">
                    <File aria-hidden="true" />
                  </span>
                )}
                {entry.mediaType === "video" ? (
                  <span className="media-dock-chip is-start" aria-hidden="true">
                    <Film />
                  </span>
                ) : null}
                <span className="media-dock-chip is-end" aria-hidden="true">
                  {entry.mediaType === "file" ? <ExternalLink /> : <ZoomIn />}
                </span>
              </button>
              <div className="media-dock-card-footer">
                <div className="media-dock-card-body">
                  <div className="dock-kit-meta">
                    <span className={`dock-kit-badge${entry.mediaType === "file" ? "" : " is-accent"}`}>{entry.kindLabel}</span>
                    <span className="dock-kit-meta-text">{entry.hasFilename ? `${entry.time} · ${entry.size}` : entry.size}</span>
                  </div>
                  <div className="dock-kit-card-title" title={entry.title}>{entry.title}</div>
                </div>
                <DockIconButton
                  label={`Delete ${entry.title}`}
                  title={`Permanently delete ${entry.title}`}
                  icon={Trash2}
                  tone="danger"
                  busy={deletingId === entry.artifact.id}
                  disabled={deletingId === entry.artifact.id || clearingAll}
                  onClick={() => void deleteMedia(entry)}
                />
              </div>
            </article>
          ))}
        </div>

        {selected ? (
          <div
            className="attachment-modal media-dock-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`${selected.title} full resolution`}
            onClick={() => setSelected(null)}
          >
            <div className="attachment-modal-body media-dock-viewer" onClick={(event) => event.stopPropagation()}>
              <DockIconButton label="Close media viewer" icon={X} className="media-dock-viewer-close" autoFocus onClick={() => setSelected(null)} />
              {selected.mediaType === "video" ? (
                <video src={api.artifactFileUrl(selected.artifact.id)} controls playsInline preload="metadata" aria-label={`${selected.title} full resolution`} />
              ) : (
                <img src={api.artifactFileUrl(selected.artifact.id)} alt={`${selected.title} full resolution`} />
              )}
              <div className="media-dock-viewer-caption">
                <span className="dock-kit-card-title">{selected.title}</span>
                <span className="dock-kit-meta-text">{selected.kindLabel} · {selected.time} · {selected.size}</span>
              </div>
            </div>
          </div>
        ) : null}
      </div>
      {confirmDialog}
    </div>
  );
}
