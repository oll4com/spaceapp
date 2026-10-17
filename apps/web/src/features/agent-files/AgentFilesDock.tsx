import { useEffect, useId, useMemo, useRef, useState } from "react";
import { isAgentFileArtifact, type Artifact, type Room } from "@space/contracts";
import {
  CornerLeftUp,
  Download,
  Eye,
  File,
  FileText,
  FileVideo,
  Filter,
  Folder,
  FolderOpen,
  FolderPlus,
  Grid2X2,
  Images,
  List,
  Music2,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
  AgentFiles
} from "../ui-theme/app-icons.js";
import { api } from "../../api.js";
import { ARTIFACTS_UPDATED_EVENT, dispatchArtifactsUpdated, isArtifactsUpdatedDetail } from "../../artifact-events.js";
import { setArtifactDragData } from "../artifacts/artifact-drag.js";
import {
  DATE_TIME_SETTINGS_UPDATED_EVENT,
  formatAppDateTime
} from "../date-time-settings/date-time-settings.js";
import { useIsDockActive } from "../docks/dock-active-context.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import {
  DockButton,
  DockFullscreenButton,
  DockIconButton,
  DockNotice,
  DockSearch,
  DockState,
  DockToolbar,
  useDockConfirm,
  useDockFullscreen
} from "../dock-kit/DockKit.js";
import "./agent-files-dock.css";

interface AgentFilesDockProps {
  activeRoom: Room | null;
  refreshKey?: string | null;
  /** Readable pane titles by pane id, used to say which pane produced a file. */
  paneTitles?: Readonly<Record<string, string>>;
}

type AgentFilePreviewKind = "IMAGE" | "VIDEO" | "AUDIO" | "PDF" | "TEXT" | "DOCX" | "NONE";
type AgentFileTypeFilter = "ALL" | AgentFilePreviewKind;

interface AgentFileEntry {
  artifact: Artifact;
  filename: string;
  previewKind: AgentFilePreviewKind;
  /** Who produced the file, e.g. "Codex · Main pane" or "Uploaded by you". */
  provenance: string;
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

interface FolderDef {
  id: string;
  name: string;
}

const SMART_FOLDERS: FolderDef[] = [
  { id: "ALL", name: "All files" },
  { id: "GRAPHICS", name: "Graphics" },
  { id: "DOCUMENTS", name: "Documents" },
  { id: "CODE", name: "Code" },
  { id: "MEDIA", name: "Media" },
  { id: "UPLOADS", name: "Uploads" }
];

export const TYPE_FILTER_OPTIONS: Array<{ id: AgentFileTypeFilter; label: string }> = [
  { id: "ALL", label: "All types" },
  { id: "IMAGE", label: "Images" },
  { id: "PDF", label: "PDFs" },
  { id: "DOCX", label: "Documents" },
  { id: "TEXT", label: "Text & code" },
  { id: "VIDEO", label: "Videos" },
  { id: "AUDIO", label: "Audio" },
  { id: "NONE", label: "Other files" }
];

const PAGE_STEP = 40;

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

function isUserUpload(artifact: Artifact): boolean {
  return metadataString(artifact, "source") === "USER_UPLOAD";
}

function runtimeLabel(artifact: Artifact): string {
  const runtimeId = metadataString(artifact, "runtimeId");
  const name = runtimeId?.replace(/^cli:/, "").replaceAll("-", " ").trim();
  if (!name) return "Agent";
  return name.charAt(0).toLocaleUpperCase() + name.slice(1);
}

/** Readable origin of a file. Pane ids are never shown; a pane title is used when one is known. */
export function agentFileProvenance(artifact: Artifact, paneTitles?: Readonly<Record<string, string>>): string {
  if (isUserUpload(artifact)) return "Uploaded by you";
  const knownTitle = artifact.paneId ? paneTitles?.[artifact.paneId]?.trim() : undefined;
  const paneTitle = knownTitle || metadataString(artifact, "paneTitle");
  const where = paneTitle ?? (artifact.paneId ? null : "Room deliverable");
  return [runtimeLabel(artifact), where].filter(Boolean).join(" · ");
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

function agentFileEntries(artifacts: Artifact[], paneTitles?: Readonly<Record<string, string>>): AgentFileEntry[] {
  return sortAgentFiles(artifacts).filter(isAgentFileArtifact).map((artifact) => ({
    artifact,
    filename: artifactFilename(artifact),
    previewKind: previewKindFor(artifact),
    provenance: agentFileProvenance(artifact, paneTitles),
    timestamp: formatTimestamp(artifact.createdAt),
    size: formatBytes(artifact.byteSize)
  }));
}

function smartFolder(id: string): FolderDef | undefined {
  return SMART_FOLDERS.find((folder) => folder.id === id);
}

export function normalizeFolderPath(path: string): string {
  return path
    .split("/")
    .map((seg) => seg.trim())
    .filter(Boolean)
    .join("/");
}

export function splitFolderPath(path: string): string[] {
  return normalizeFolderPath(path).split("/").filter(Boolean);
}

export function getParentFolderPath(folderPath: string): string | null {
  const parts = splitFolderPath(folderPath);
  if (parts.length <= 1) return null;
  return parts.slice(0, -1).join("/");
}

export function getFolderLeafName(folderPath: string): string {
  const smart = smartFolder(folderPath);
  if (smart) return smart.name;
  const parts = splitFolderPath(folderPath);
  return parts[parts.length - 1] || folderPath;
}

/** Readable path such as "Graphics / Logos" for "GRAPHICS/Logos". */
export function getFolderDisplayPath(folderPath: string): string {
  return splitFolderPath(folderPath)
    .map((part, index) => (index === 0 ? smartFolder(part)?.name ?? part : part))
    .join(" / ");
}

export function getFolderBreadcrumbs(folderPath: string): Array<{ id: string; name: string }> {
  if (folderPath === "ALL" || !folderPath) return [];
  const parts = splitFolderPath(folderPath);
  const breadcrumbs: Array<{ id: string; name: string }> = [];
  let current = "";
  for (const [index, part] of parts.entries()) {
    current = current ? `${current}/${part}` : part;
    // Subfolders of a smart folder keep the smart folder's label, never its id.
    breadcrumbs.push({ id: current, name: index === 0 ? smartFolder(part)?.name ?? part : part });
  }
  return breadcrumbs;
}

export function getAssignedFolder(artifact: Artifact, folderMap: Record<string, string>): string | null {
  const mapped = folderMap[artifact.id];
  if (typeof mapped === "string" && mapped.trim()) {
    return normalizeFolderPath(mapped.trim());
  }
  const metaFolder = artifact.metadata?.folder;
  if (typeof metaFolder === "string" && metaFolder.trim()) {
    return normalizeFolderPath(metaFolder.trim());
  }
  return null;
}

function getStoredCustomFolders(roomId: string): string[] {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(`space_agent_files_custom_folders_${roomId}`) : null;
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function setStoredCustomFolders(roomId: string, folders: string[]) {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(`space_agent_files_custom_folders_${roomId}`, JSON.stringify(folders));
    }
  } catch {}
}

function getStoredFolderMap(roomId: string): Record<string, string> {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(`space_agent_files_folder_map_${roomId}`) : null;
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function setStoredFolderMap(roomId: string, map: Record<string, string>) {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(`space_agent_files_folder_map_${roomId}`, JSON.stringify(map));
    }
  } catch {}
}

function matchesFolder(entry: AgentFileEntry, folderId: string, folderMap: Record<string, string>): boolean {
  if (folderId === "ALL") return true;
  const assigned = getAssignedFolder(entry.artifact, folderMap);
  if (assigned) {
    return assigned === folderId || assigned.startsWith(`${folderId}/`);
  }
  if (folderId === "GRAPHICS") return entry.previewKind === "IMAGE";
  if (folderId === "DOCUMENTS") return entry.previewKind === "PDF" || entry.previewKind === "DOCX";
  if (folderId === "CODE") return entry.previewKind === "TEXT";
  if (folderId === "MEDIA") return entry.previewKind === "VIDEO" || entry.previewKind === "AUDIO";
  if (folderId === "UPLOADS") return isUserUpload(entry.artifact);
  return false;
}

export type AgentFileDateFilter =
  | "ALL"
  | "PAST_1H"
  | "PAST_6H"
  | "TODAY"
  | "PAST_24H"
  | "PAST_3D"
  | "PAST_7D"
  | "PAST_30D"
  | "CUSTOM";

export const DATE_FILTER_OPTIONS: Array<{ id: AgentFileDateFilter; label: string }> = [
  { id: "ALL", label: "All dates" },
  { id: "PAST_1H", label: "Past 1 hour" },
  { id: "PAST_6H", label: "Past 6 hours" },
  { id: "TODAY", label: "Today" },
  { id: "PAST_24H", label: "Past 24 hours" },
  { id: "PAST_3D", label: "Past 3 days" },
  { id: "PAST_7D", label: "Past 7 days" },
  { id: "PAST_30D", label: "Past 30 days" },
  { id: "CUSTOM", label: "Custom date range…" }
];

export function matchesDateFilter(
  entry: AgentFileEntry,
  filter: AgentFileDateFilter,
  customStart?: string,
  customEnd?: string,
  now = Date.now()
): boolean {
  if (filter === "ALL") return true;

  const createdAt = entry.artifact.createdAt;
  if (!createdAt) return false;
  const time = new Date(createdAt).getTime();
  if (Number.isNaN(time)) return false;

  if (filter === "PAST_1H") {
    return time >= now - 60 * 60 * 1000;
  }

  if (filter === "PAST_6H") {
    return time >= now - 6 * 60 * 60 * 1000;
  }

  if (filter === "TODAY") {
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    return time >= today.getTime();
  }

  if (filter === "PAST_24H") {
    return time >= now - 24 * 60 * 60 * 1000;
  }

  if (filter === "PAST_3D") {
    return time >= now - 3 * 24 * 60 * 60 * 1000;
  }

  if (filter === "PAST_7D") {
    return time >= now - 7 * 24 * 60 * 60 * 1000;
  }

  if (filter === "PAST_30D") {
    return time >= now - 30 * 24 * 60 * 60 * 1000;
  }

  if (filter === "CUSTOM") {
    if (customStart) {
      const start = new Date(`${customStart}T00:00:00`).getTime();
      if (!Number.isNaN(start) && time < start) return false;
    }
    if (customEnd) {
      const end = new Date(`${customEnd}T23:59:59.999`).getTime();
      if (!Number.isNaN(end) && time > end) return false;
    }
    return true;
  }

  return true;
}

export function getDateFilterBadgeLabel(
  filter: AgentFileDateFilter,
  startDate?: string,
  endDate?: string
): string {
  switch (filter) {
    case "PAST_1H":
      return "Past 1h";
    case "PAST_6H":
      return "Past 6h";
    case "TODAY":
      return "Today";
    case "PAST_24H":
      return "Past 24h";
    case "PAST_3D":
      return "Past 3d";
    case "PAST_7D":
      return "Past 7d";
    case "PAST_30D":
      return "Past 30d";
    case "CUSTOM":
      if (startDate && endDate) return `${startDate} – ${endDate}`;
      if (startDate) return `From ${startDate}`;
      if (endDate) return `Until ${endDate}`;
      return "Custom range";
    default:
      return "Date filter";
  }
}

/** Readable labels of the active type and date filters, e.g. ["Images", "Past 1 hour"]. */
export function activeFilterLabels(
  typeFilter: AgentFileTypeFilter,
  dateFilter: AgentFileDateFilter,
  startDate?: string,
  endDate?: string
): string[] {
  const labels: string[] = [];
  if (typeFilter !== "ALL") labels.push(TYPE_FILTER_OPTIONS.find((option) => option.id === typeFilter)?.label ?? "Other files");
  if (dateFilter === "CUSTOM") labels.push(getDateFilterBadgeLabel(dateFilter, startDate, endDate));
  else if (dateFilter !== "ALL") labels.push(DATE_FILTER_OPTIONS.find((option) => option.id === dateFilter)?.label ?? "Date filter");
  return labels;
}

const agentFilesRoomCache = new Map<string, Artifact[]>();
const agentFilesLastFetched = new Map<string, { timestamp: number; refreshKey: string | number | null }>();
const AGENT_FILES_CACHE_TTL_MS = 60_000;

export function getStoredAgentFilesCache(roomId: string): Artifact[] {
  const inMem = agentFilesRoomCache.get(roomId);
  if (inMem && inMem.length > 0) return inMem;
  try {
    if (typeof sessionStorage !== "undefined") {
      const raw = sessionStorage.getItem(`space_agent_files_cache_${roomId}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          agentFilesRoomCache.set(roomId, parsed);
          return parsed;
        }
      }
    }
  } catch {}
  return inMem ?? [];
}

export function persistAgentFilesCache(roomId: string, items: Artifact[]): void {
  agentFilesRoomCache.set(roomId, items);
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(`space_agent_files_cache_${roomId}`, JSON.stringify(items.slice(0, 500)));
    }
  } catch {}
}

export function clearStoredAgentFilesCache(roomId?: string): void {
  if (roomId) {
    agentFilesRoomCache.delete(roomId);
    agentFilesLastFetched.delete(roomId);
    try {
      if (typeof sessionStorage !== "undefined") {
        sessionStorage.removeItem(`space_agent_files_cache_${roomId}`);
      }
    } catch {}
  } else {
    agentFilesRoomCache.clear();
    agentFilesLastFetched.clear();
    try {
      if (typeof sessionStorage !== "undefined") {
        const toRemove: string[] = [];
        for (let i = 0; i < sessionStorage.length; i++) {
          const key = sessionStorage.key(i);
          if (key?.startsWith("space_agent_files_cache_")) toRemove.push(key);
        }
        toRemove.forEach((k) => sessionStorage.removeItem(k));
      }
    } catch {}
  }
}

function roomHasLoaded(roomId: string | undefined): boolean {
  if (!roomId) return false;
  return agentFilesLastFetched.has(roomId) || getStoredAgentFilesCache(roomId).length > 0;
}

function kindIcon(kind: AgentFilePreviewKind) {
  if (kind === "IMAGE") return Images;
  if (kind === "VIDEO") return FileVideo;
  if (kind === "AUDIO") return Music2;
  if (kind === "PDF" || kind === "DOCX" || kind === "TEXT") return FileText;
  return File;
}

export function AgentFilesDock({ activeRoom, refreshKey = null, paneTitles }: AgentFilesDockProps) {
  const isDockActive = useIsDockActive();
  const { confirm, confirmDialog } = useDockConfirm();
  const filterPanelId = useId();
  const [artifacts, setArtifacts] = useState<Artifact[]>(() =>
    activeRoom?.id ? getStoredAgentFilesCache(activeRoom.id) : []
  );
  const [hasLoaded, setHasLoaded] = useState(() => roomHasLoaded(activeRoom?.id));
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [clearingAll, setClearingAll] = useState(false);
  const [isFullscreen, setIsFullscreen] = useDockFullscreen();
  const [selected, setSelected] = useState<AgentFileEntry | null>(null);
  const [textPreview, setTextPreview] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<AgentFileTypeFilter>("ALL");
  const [dateFilter, setDateFilter] = useState<AgentFileDateFilter>("ALL");
  const [customStartDate, setCustomStartDate] = useState("");
  const [customEndDate, setCustomEndDate] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [activeFolder, setActiveFolder] = useState<string>("ALL");
  const [customFolders, setCustomFolders] = useState<string[]>([]);
  const [fileFolderMap, setFileFolderMap] = useState<Record<string, string>>({});
  const [movingEntry, setMovingEntry] = useState<AgentFileEntry | null>(null);
  const [showNewFolderModal, setShowNewFolderModal] = useState(false);
  const [newFolderParent, setNewFolderParent] = useState<string>("");
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderDraft, setNewFolderDraft] = useState("");
  const [inlineParentDraft, setInlineParentDraft] = useState<string>("");
  const [visibleCount, setVisibleCount] = useState(PAGE_STEP);
  const [brokenThumbs, setBrokenThumbs] = useState<ReadonlySet<string>>(() => new Set());
  const [dateTimeTick, setDateTimeTick] = useState(0);

  const [viewMode, setViewMode] = useState<"list" | "grid">(() => {
    try {
      return typeof localStorage !== "undefined" && localStorage.getItem("space_agent_files_view_mode") === "list" ? "list" : "grid";
    } catch {
      return "grid";
    }
  });

  const [showPreviews, setShowPreviews] = useState<boolean>(() => {
    try {
      return typeof localStorage !== "undefined" ? localStorage.getItem("space_agent_files_thumbnails") !== "false" : true;
    } catch {
      return true;
    }
  });

  const loadSequence = useRef(0);
  const previewSequence = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const activeRoomId = useRef<string | null>(activeRoom?.id ?? null);
  activeRoomId.current = activeRoom?.id ?? null;

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const entries = useMemo(() => agentFileEntries(artifacts, paneTitles), [artifacts, paneTitles, dateTimeTick]);

  const allKnownFolders = useMemo(() => {
    const folderSet = new Set<string>();
    for (const f of customFolders) {
      const norm = normalizeFolderPath(f);
      if (norm) {
        folderSet.add(norm);
        let parent = getParentFolderPath(norm);
        while (parent) {
          folderSet.add(parent);
          parent = getParentFolderPath(parent);
        }
      }
    }
    for (const entry of entries) {
      const assigned = getAssignedFolder(entry.artifact, fileFolderMap);
      if (assigned) {
        folderSet.add(assigned);
        let parent = getParentFolderPath(assigned);
        while (parent) {
          folderSet.add(parent);
          parent = getParentFolderPath(parent);
        }
      }
    }
    return Array.from(folderSet).sort((a, b) => a.localeCompare(b));
  }, [customFolders, entries, fileFolderMap]);

  // Folders that are not smart folders themselves (a smart folder can still hold custom subfolders).
  const customFolderPaths = useMemo(() => allKnownFolders.filter((f) => !smartFolder(f)), [allKnownFolders]);

  const topLevelCustomFolders = useMemo(() => {
    return customFolderPaths.filter((f) => !f.includes("/"));
  }, [customFolderPaths]);

  const activeRootFolder = useMemo(() => {
    if (activeFolder === "ALL") return "ALL";
    if (smartFolder(activeFolder)) return activeFolder;
    const parts = splitFolderPath(activeFolder);
    return parts[0] || activeFolder;
  }, [activeFolder]);

  const subfoldersForActiveRoot = useMemo(() => {
    if (activeRootFolder === "ALL") return [];
    const prefix = `${activeRootFolder}/`;
    const subs: Array<{ path: string; name: string }> = [];
    const seen = new Set<string>();

    for (const f of allKnownFolders) {
      if (f.startsWith(prefix)) {
        const rel = f.slice(prefix.length);
        const childName = rel.split("/")[0] ?? "";
        const childPath = `${activeRootFolder}/${childName}`;
        if (!seen.has(childPath)) {
          seen.add(childPath);
          subs.push({ path: childPath, name: childName });
        }
      }
    }
    return subs;
  }, [activeRootFolder, allKnownFolders]);

  const activeFolderDepth = activeFolder === "ALL" ? 0 : splitFolderPath(activeFolder).length;

  // Deeper subfolders are reachable from shortcut cards; first-level ones are already in the subfolder bar.
  const nestedSubfolders = useMemo(() => {
    if (activeFolder === "ALL" || activeFolderDepth < 2) return [];
    const prefix = `${activeFolder}/`;
    const subs: Array<{ path: string; name: string }> = [];
    const seen = new Set<string>();

    for (const f of allKnownFolders) {
      if (f.startsWith(prefix)) {
        const rel = f.slice(prefix.length);
        const childName = rel.split("/")[0] ?? "";
        const childPath = `${activeFolder}/${childName}`;
        if (!seen.has(childPath)) {
          seen.add(childPath);
          subs.push({ path: childPath, name: childName });
        }
      }
    }
    return subs;
  }, [activeFolder, activeFolderDepth, allKnownFolders]);

  const breadcrumbs = useMemo(() => getFolderBreadcrumbs(activeFolder), [activeFolder]);
  const parentFolder = useMemo(() => getParentFolderPath(activeFolder), [activeFolder]);

  const activeFilterCount = (typeFilter !== "ALL" ? 1 : 0) + (dateFilter !== "ALL" ? 1 : 0);
  const filterLabels = activeFilterLabels(typeFilter, dateFilter, customStartDate, customEndDate);
  const isFiltered = query.trim() !== "" || activeFilterCount > 0;

  const folderCounts = useMemo(() => {
    const counts: Record<string, number> = {
      ALL: 0,
      GRAPHICS: 0,
      DOCUMENTS: 0,
      CODE: 0,
      MEDIA: 0,
      UPLOADS: 0
    };
    for (const folder of allKnownFolders) {
      counts[folder] = 0;
    }
    const search = query.trim().toLocaleLowerCase();
    const matchingEntries = entries.filter((entry) => {
      if (typeFilter !== "ALL" && entry.previewKind !== typeFilter) return false;
      if (!matchesDateFilter(entry, dateFilter, customStartDate, customEndDate)) return false;
      if (search && !entry.filename.toLocaleLowerCase().includes(search)) return false;
      return true;
    });

    counts.ALL = matchingEntries.length;

    for (const entry of matchingEntries) {
      const assigned = getAssignedFolder(entry.artifact, fileFolderMap);
      if (assigned) {
        let current: string | null = assigned;
        while (current) {
          counts[current] = (counts[current] ?? 0) + 1;
          current = getParentFolderPath(current);
        }
      } else {
        if (entry.previewKind === "IMAGE") counts.GRAPHICS = (counts.GRAPHICS ?? 0) + 1;
        else if (entry.previewKind === "PDF" || entry.previewKind === "DOCX") counts.DOCUMENTS = (counts.DOCUMENTS ?? 0) + 1;
        else if (entry.previewKind === "TEXT") counts.CODE = (counts.CODE ?? 0) + 1;
        else if (entry.previewKind === "VIDEO" || entry.previewKind === "AUDIO") counts.MEDIA = (counts.MEDIA ?? 0) + 1;
        if (isUserUpload(entry.artifact)) counts.UPLOADS = (counts.UPLOADS ?? 0) + 1;
      }
    }
    return counts;
  }, [entries, allKnownFolders, fileFolderMap, typeFilter, dateFilter, customStartDate, customEndDate, query]);

  const filteredEntries = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return entries.filter((entry) => {
      if (!matchesFolder(entry, activeFolder, fileFolderMap)) return false;
      if (typeFilter !== "ALL" && entry.previewKind !== typeFilter) return false;
      if (!matchesDateFilter(entry, dateFilter, customStartDate, customEndDate)) return false;
      if (search && !entry.filename.toLocaleLowerCase().includes(search)) return false;
      return true;
    });
  }, [entries, activeFolder, fileFolderMap, typeFilter, dateFilter, customStartDate, customEndDate, query]);

  const displayedEntries = useMemo(() => {
    return filteredEntries.slice(0, visibleCount);
  }, [filteredEntries, visibleCount]);

  const showList = Boolean(activeRoom) && (displayedEntries.length > 0 || nestedSubfolders.length > 0);

  useEffect(() => {
    setVisibleCount(PAGE_STEP);
  }, [activeRoom?.id, activeFolder, query, typeFilter, dateFilter, customStartDate, customEndDate]);

  // Infinite scroll; the "Load more" button at the end of the list is the fallback.
  useEffect(() => {
    if (!sentinelRef.current || displayedEntries.length >= filteredEntries.length) return;
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (observed) => {
        if (observed[0]?.isIntersecting) {
          setVisibleCount((prev) => Math.min(prev + PAGE_STEP, filteredEntries.length));
        }
      },
      { rootMargin: "250px" }
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [displayedEntries.length, filteredEntries.length]);

  async function loadAgentFiles(roomId: string, force = false) {
    if (activeRoomId.current !== roomId) return;
    const last = agentFilesLastFetched.get(roomId);
    const cached = getStoredAgentFilesCache(roomId);
    if (
      !force &&
      cached.length > 0 &&
      last &&
      Date.now() - last.timestamp < AGENT_FILES_CACHE_TTL_MS &&
      last.refreshKey === refreshKey
    ) {
      setHasLoaded(true);
      return;
    }
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
      if (firstPage.pagination.totalPages > 1) {
        const remainingPages = await Promise.all(
          Array.from({ length: firstPage.pagination.totalPages - 1 }, (_, i) =>
            api.artifacts({
              roomId,
              collection: "AGENT_FILES",
              page: i + 2,
              pageSize: 100,
              sortOrder: "desc"
            })
          )
        );
        for (const payload of remainingPages) {
          loaded.push(...payload.data);
        }
      }
      if (sequence !== loadSequence.current || activeRoomId.current !== roomId) return;
      const merged = mergeAgentFiles([], loaded);
      persistAgentFilesCache(roomId, merged);
      agentFilesLastFetched.set(roomId, { timestamp: Date.now(), refreshKey });
      setArtifacts(merged);
      setLoadError(null);
      setHasLoaded(true);
    } catch (loadFailure) {
      if (sequence !== loadSequence.current || activeRoomId.current !== roomId) return;
      setLoadError(loadFailure instanceof Error ? loadFailure.message : "Agent Files could not be loaded.");
      setHasLoaded(true);
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }

  useEffect(() => {
    const cached = activeRoom?.id ? getStoredAgentFilesCache(activeRoom.id) : null;
    setArtifacts(cached && cached.length > 0 ? cached : []);
    setHasLoaded(roomHasLoaded(activeRoom?.id));
    setSelected(null);
    setTextPreview(null);
    setPreviewError(null);
    setPreviewLoading(false);
    setLoading(false);
    setLoadError(null);
    setError(null);
    setQuery("");
    setTypeFilter("ALL");
    setDateFilter("ALL");
    setCustomStartDate("");
    setCustomEndDate("");
    setFiltersOpen(false);
    setActiveFolder("ALL");
    setVisibleCount(PAGE_STEP);
    setMovingEntry(null);
    setShowNewFolderModal(false);
    setDragOver(false);
    setBrokenThumbs(new Set());
    if (activeRoom?.id) {
      setCustomFolders(getStoredCustomFolders(activeRoom.id));
      setFileFolderMap(getStoredFolderMap(activeRoom.id));
    } else {
      setCustomFolders([]);
      setFileFolderMap({});
    }
    if (!activeRoom) setIsFullscreen(false);
    return () => {
      loadSequence.current += 1;
      previewSequence.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      setArtifacts((current) => {
        const merged = mergeAgentFiles(current, event.detail.artifacts);
        if (activeRoom?.id) persistAgentFilesCache(activeRoom.id, merged);
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

  // Keep the selected folder chip visible in the scrolling folder rows.
  const foldersRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const selectedTabs = foldersRef.current?.querySelectorAll<HTMLElement>('[role="tab"][aria-selected="true"]');
    selectedTabs?.forEach((tab) => {
      if (typeof tab.scrollIntoView === "function") tab.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  }, [activeFolder]);

  // A hidden dock leaves fullscreen so no Escape listener stays behind.
  useEffect(() => {
    if (!isDockActive) setIsFullscreen(false);
  }, [isDockActive, setIsFullscreen]);

  // Escape closes the top dialog first; fullscreen waits for the next Escape.
  const hasOpenDialog = Boolean(selected || movingEntry || showNewFolderModal);
  useEffect(() => {
    if (!hasOpenDialog || !isDockActive) return;
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (event.target instanceof Element && event.target.closest(".dock-kit-confirm")) return;
      event.stopPropagation();
      if (movingEntry) {
        setMovingEntry(null);
        return;
      }
      if (showNewFolderModal) {
        closeNewFolderModal();
        return;
      }
      closePreview();
    }
    document.addEventListener("keydown", handleEscape, true);
    return () => document.removeEventListener("keydown", handleEscape, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasOpenDialog, isDockActive, movingEntry, showNewFolderModal]);

  function handleSetViewMode(mode: "list" | "grid") {
    setViewMode(mode);
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("space_agent_files_view_mode", mode);
      }
    } catch {}
  }

  function handleSetShowPreviews(enabled: boolean) {
    setShowPreviews(enabled);
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("space_agent_files_thumbnails", enabled ? "true" : "false");
      }
    } catch {}
  }

  function clearFilters() {
    setTypeFilter("ALL");
    setDateFilter("ALL");
    setCustomStartDate("");
    setCustomEndDate("");
  }

  function showAllFiles() {
    setQuery("");
    clearFilters();
    setActiveFolder("ALL");
  }

  function openNewFolderModal() {
    setNewFolderParent(activeFolder === "ALL" ? "" : activeFolder);
    setNewFolderName("");
    setShowNewFolderModal(true);
  }

  function closeNewFolderModal() {
    setShowNewFolderModal(false);
    setNewFolderName("");
    setNewFolderParent("");
  }

  function createFolderFromModal() {
    if (!newFolderName.trim()) return;
    const full = handleAddCustomFolder(newFolderName.trim(), newFolderParent);
    if (full) setActiveFolder(full);
    closeNewFolderModal();
  }

  function createFolderAndMove(entry: AgentFileEntry) {
    if (!newFolderDraft.trim()) return;
    const full = handleAddCustomFolder(newFolderDraft.trim(), inlineParentDraft);
    if (full) handleMoveFile(entry.artifact.id, full);
    setNewFolderDraft("");
    setInlineParentDraft("");
    setMovingEntry(null);
  }

  function handleAddCustomFolder(name: string, parentFolderCandidate?: string | null): string | undefined {
    const trimmed = name.trim();
    if (!trimmed || !activeRoom?.id) return undefined;
    let fullPath: string;
    if (trimmed.includes("/")) {
      fullPath = normalizeFolderPath(trimmed);
    } else if (parentFolderCandidate && parentFolderCandidate !== "ALL") {
      fullPath = `${normalizeFolderPath(parentFolderCandidate)}/${trimmed}`;
    } else {
      fullPath = trimmed;
    }
    if (!fullPath) return undefined;

    const nextSet = new Set(customFolders);
    nextSet.add(fullPath);
    let p = getParentFolderPath(fullPath);
    while (p) {
      nextSet.add(p);
      p = getParentFolderPath(p);
    }
    const next = Array.from(nextSet).sort((a, b) => a.localeCompare(b));
    setCustomFolders(next);
    setStoredCustomFolders(activeRoom.id, next);
    return fullPath;
  }

  async function handleDeleteCustomFolder(name: string) {
    if (!activeRoom?.id) return;
    const roomId = activeRoom.id;
    const isParent = allKnownFolders.some((f) => f.startsWith(`${name}/`));
    const accepted = await confirm({
      title: isParent ? "Delete this folder and its subfolders?" : "Delete this folder?",
      message: `"${getFolderDisplayPath(name)}" will be removed. The files inside stay in this room.`,
      confirmLabel: "Delete folder"
    });
    if (!accepted || activeRoomId.current !== roomId) return;

    setCustomFolders((current) => {
      const nextFolders = current.filter((f) => f !== name && !f.startsWith(`${name}/`));
      setStoredCustomFolders(roomId, nextFolders);
      return nextFolders;
    });

    const parent = getParentFolderPath(name);
    setFileFolderMap((current) => {
      const nextMap = { ...current };
      let changed = false;
      for (const [artId, fName] of Object.entries(nextMap)) {
        if (fName === name || fName.startsWith(`${name}/`)) {
          if (parent) {
            nextMap[artId] = parent;
          } else {
            delete nextMap[artId];
          }
          changed = true;
        }
      }
      if (!changed) return current;
      setStoredFolderMap(roomId, nextMap);
      return nextMap;
    });
    setActiveFolder((current) => (current === name || current.startsWith(`${name}/`) ? parent || "ALL" : current));
  }

  function handleMoveFile(artifactId: string, folderId: string) {
    if (!activeRoom?.id) return;
    const nextMap = { ...fileFolderMap };
    if (!folderId) {
      delete nextMap[artifactId];
    } else {
      nextMap[artifactId] = normalizeFolderPath(folderId);
    }
    setFileFolderMap(nextMap);
    setStoredFolderMap(activeRoom.id, nextMap);
  }

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
    const accepted = await confirm({
      title: "Delete this file?",
      message: `"${entry.filename}" will be permanently deleted. This cannot be undone.`,
      confirmLabel: "Delete"
    });
    if (!accepted) return;
    const roomId = activeRoom?.id ?? null;
    setDeletingId(entry.artifact.id);
    setError(null);
    try {
      await api.deleteArtifact(entry.artifact.id);
      // Update the cache of the room the file was deleted from, even after a room switch.
      if (roomId) {
        persistAgentFilesCache(roomId, getStoredAgentFilesCache(roomId).filter((artifact) => artifact.id !== entry.artifact.id));
      }
      setArtifacts((current) => current.filter((artifact) => artifact.id !== entry.artifact.id));
      if (selected?.artifact.id === entry.artifact.id) closePreview();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "The file could not be deleted.");
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
      setError(downloadError instanceof Error ? downloadError.message : "The file could not be downloaded.");
    } finally {
      setDownloadingId(null);
    }
  }

  async function clearAllAgentFiles() {
    if (!activeRoom || !entries.length) return;
    const room = activeRoom;
    const accepted = await confirm({
      title: "Clear all Agent Files?",
      message: `Permanently delete all Agent Files from ${room.name}? This cannot be undone.`,
      confirmLabel: "Clear all"
    });
    if (!accepted) return;
    setClearingAll(true);
    setError(null);
    const roomId = room.id;
    try {
      const result = await api.deleteRoomAgentFiles(roomId);
      if (activeRoomId.current !== roomId) return;
      closePreview();
      clearStoredAgentFilesCache(roomId);
      await loadAgentFiles(roomId, true);
      if (activeRoomId.current === roomId && result.failedCount > 0) {
        setError(`${result.failedCount} Agent File${result.failedCount === 1 ? "" : "s"} could not be deleted.`);
      }
    } catch (clearError) {
      if (activeRoomId.current === roomId) setError(clearError instanceof Error ? clearError.message : "Agent Files could not be cleared.");
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
      if (activeRoomId.current === roomId) {
        setArtifacts((current) => {
          const merged = mergeAgentFiles(current, uploaded.artifacts);
          persistAgentFilesCache(roomId, merged);
          return merged;
        });
      }
      dispatchArtifactsUpdated(roomId, uploaded.artifacts);
    } catch (uploadError) {
      if (activeRoomId.current === roomId) setError(uploadError instanceof Error ? uploadError.message : "The upload failed.");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function openFilePicker() {
    fileInputRef.current?.click();
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
      if (previewLoading) return <div className="agent-files-preview-note" role="status">Loading preview…</div>;
      if (previewError) return <div className="agent-files-preview-note is-error" role="alert">{previewError}</div>;
      return <pre className="agent-files-text-preview">{textPreview ?? ""}</pre>;
    }
    return (
      <div className="agent-files-preview-note">
        <File aria-hidden="true" />
        <strong>Preview is not available for this file type.</strong>
        <small>You can still download the original file.</small>
      </div>
    );
  }

  function folderOptionGroups() {
    return (
      <>
        <optgroup label="Smart folders">
          {SMART_FOLDERS.filter((f) => f.id !== "ALL").map((f) => (
            <option key={f.id} value={f.id}>{f.name}</option>
          ))}
        </optgroup>
        {customFolderPaths.length ? (
          <optgroup label="Folders and subfolders">
            {customFolderPaths.map((f) => (
              <option key={f} value={f}>{getFolderDisplayPath(f)}</option>
            ))}
          </optgroup>
        ) : null}
      </>
    );
  }

  const summary = !activeRoom
    ? "No room selected"
    : !entries.length && (!hasLoaded || loadError)
      ? undefined
      : isFiltered || activeFolder !== "ALL"
        ? <><strong>{filteredEntries.length}</strong> of {entries.length} file{entries.length === 1 ? "" : "s"}{filterLabels.length ? ` · ${filterLabels.join(" · ")}` : ""}</>
        : <><strong>{entries.length}</strong> file{entries.length === 1 ? "" : "s"} in this room</>;

  const movingAssignedFolder = movingEntry ? getAssignedFolder(movingEntry.artifact, fileFolderMap) : null;

  return (
    <div className={`agent-files-dock-shell dock-kit-shell${isFullscreen ? " is-fullscreen" : ""}`}>
      <div
        className={`agent-files-dock dock-kit-dock${dragOver ? " is-dragover" : ""}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <DockToolbar title={isFullscreen ? "Agent Files" : undefined} summary={summary}>
          <DockIconButton
            label="Upload files to Agent Files"
            icon={Upload}
            tone="primary"
            busy={uploading}
            disabled={!activeRoom || uploading || clearingAll}
            onClick={openFilePicker}
          />
          <DockIconButton
            label={viewMode === "grid" ? "Switch to list view" : "Switch to grid view"}
            icon={viewMode === "grid" ? List : Grid2X2}
            disabled={!activeRoom}
            onClick={() => handleSetViewMode(viewMode === "grid" ? "list" : "grid")}
          />
          <DockIconButton
            label="Refresh Agent Files"
            icon={RefreshCw}
            busy={loading && hasLoaded}
            disabled={!activeRoom || loading || clearingAll}
            onClick={() => activeRoom && void loadAgentFiles(activeRoom.id, true)}
          />
          <DockIconButton
            label="Clear all Agent Files"
            icon={Trash2}
            tone="danger"
            busy={clearingAll}
            disabled={!activeRoom || !entries.length || clearingAll || Boolean(deletingId) || Boolean(downloadingId)}
            onClick={() => void clearAllAgentFiles()}
          />
          <DockFullscreenButton name="Agent Files" active={isFullscreen} onToggle={() => setIsFullscreen((current) => !current)} />
        </DockToolbar>

        {activeRoom ? (
          <div ref={foldersRef} className="dock-kit-controls agent-files-controls">
            <div className="agent-files-folders">
              <div className="agent-files-folder-tabs" role="tablist" aria-label="Agent Files Folders">
                {SMART_FOLDERS.map((folder) => {
                  const isSelected = activeFolder === folder.id || activeRootFolder === folder.id;
                  const Icon = folder.id === "GRAPHICS" ? Images : folder.id === "DOCUMENTS" ? FileText : folder.id === "ALL" ? FolderOpen : Folder;
                  return (
                    <button
                      key={folder.id}
                      type="button"
                      role="tab"
                      aria-selected={isSelected}
                      className="agent-files-folder-chip dock-kit-chip"
                      onClick={() => setActiveFolder(folder.id)}
                    >
                      <Icon aria-hidden="true" />
                      <span>{folder.name}</span>
                      <span className="dock-kit-chip-count">{folderCounts[folder.id] ?? 0}</span>
                    </button>
                  );
                })}
                {topLevelCustomFolders.map((folderName) => {
                  const isSelected = activeFolder === folderName || activeRootFolder === folderName;
                  return (
                    <span key={folderName} className="agent-files-folder-chip-group">
                      <button
                        type="button"
                        role="tab"
                        aria-selected={isSelected}
                        className="agent-files-folder-chip dock-kit-chip"
                        onClick={() => setActiveFolder(folderName)}
                      >
                        <Folder aria-hidden="true" />
                        <span>{folderName}</span>
                        <span className="dock-kit-chip-count">{folderCounts[folderName] ?? 0}</span>
                      </button>
                      {isSelected ? (
                        <DockIconButton
                          label={`Delete ${folderName} folder`}
                          icon={X}
                          className="agent-files-folder-remove"
                          onClick={() => void handleDeleteCustomFolder(folderName)}
                        />
                      ) : null}
                    </span>
                  );
                })}
              </div>
              <DockButton
                tone="ghost"
                icon={FolderPlus}
                className="agent-files-new-folder"
                aria-label="Create new folder"
                title={activeFolder === "ALL" ? "Create a new folder" : `Create a folder inside ${getFolderDisplayPath(activeFolder)}`}
                onClick={openNewFolderModal}
              >
                New folder
              </DockButton>
            </div>

            {activeRootFolder !== "ALL" && subfoldersForActiveRoot.length > 0 ? (
              <div className="agent-files-folder-tabs is-sub" role="tablist" aria-label="Agent Files Subfolders">
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeFolder === activeRootFolder}
                  className="agent-files-folder-chip dock-kit-chip"
                  onClick={() => setActiveFolder(activeRootFolder)}
                >
                  <Folder aria-hidden="true" />
                  <span>All in {getFolderLeafName(activeRootFolder)}</span>
                  <span className="dock-kit-chip-count">{folderCounts[activeRootFolder] ?? 0}</span>
                </button>
                {subfoldersForActiveRoot.map((sub) => {
                  const isSelected = activeFolder === sub.path || activeFolder.startsWith(`${sub.path}/`);
                  return (
                    <span key={sub.path} className="agent-files-folder-chip-group">
                      <button
                        type="button"
                        role="tab"
                        aria-selected={isSelected}
                        className="agent-files-folder-chip dock-kit-chip"
                        onClick={() => setActiveFolder(sub.path)}
                      >
                        <Folder aria-hidden="true" />
                        <span>{sub.name}</span>
                        <span className="dock-kit-chip-count">{folderCounts[sub.path] ?? 0}</span>
                      </button>
                      {activeFolder === sub.path ? (
                        <DockIconButton
                          label={`Delete ${sub.name} subfolder`}
                          icon={X}
                          className="agent-files-folder-remove"
                          onClick={() => void handleDeleteCustomFolder(sub.path)}
                        />
                      ) : null}
                    </span>
                  );
                })}
              </div>
            ) : null}

            {activeFolderDepth >= 2 ? (
              <nav className="agent-files-path" aria-label="Folder navigation">
                {parentFolder ? (
                  <DockIconButton
                    label={`Up to ${getFolderLeafName(parentFolder)}`}
                    icon={CornerLeftUp}
                    className="agent-files-path-up"
                    onClick={() => setActiveFolder(parentFolder)}
                  />
                ) : null}
                <DockButton tone="ghost" icon={FolderOpen} className="agent-files-path-crumb" onClick={() => setActiveFolder("ALL")}>
                  All files
                </DockButton>
                {breadcrumbs.map((crumb, idx) => {
                  const isLast = idx === breadcrumbs.length - 1;
                  return (
                    <span key={crumb.id} className="agent-files-path-item">
                      <span className="agent-files-path-separator" aria-hidden="true">/</span>
                      <DockButton
                        tone="ghost"
                        className={`agent-files-path-crumb${isLast ? " is-current" : ""}`}
                        aria-current={isLast ? "page" : undefined}
                        onClick={() => setActiveFolder(crumb.id)}
                      >
                        {crumb.name}
                      </DockButton>
                    </span>
                  );
                })}
              </nav>
            ) : null}

            <div className="agent-files-search-row">
              <DockSearch
                name="agent-files-search"
                label="Search Agent Files"
                placeholder="Search files…"
                value={query}
                onChange={setQuery}
              />
              <span className="agent-files-filter-toggle">
                <DockIconButton
                  label={activeFilterCount ? `Filters (${activeFilterCount} active)` : "Filters"}
                  icon={Filter}
                  aria-expanded={filtersOpen}
                  aria-controls={filterPanelId}
                  onClick={() => setFiltersOpen((open) => !open)}
                />
                {activeFilterCount ? <span className="dock-kit-chip-count agent-files-filter-count" aria-hidden="true">{activeFilterCount}</span> : null}
              </span>
              <SpaceToggle
                className="agent-files-previews"
                label="Previews"
                checked={showPreviews}
                onChange={handleSetShowPreviews}
                title="Show image thumbnails"
              />
            </div>

            {filtersOpen ? (
              <div id={filterPanelId} className="agent-files-filter-panel dock-kit-editor" role="group" aria-label="Agent Files filters">
                <label className="agent-files-filter-field">
                  <span className="dock-kit-section-title">Type</span>
                  <select
                    className="dock-kit-select"
                    aria-label="Filter Agent Files by type"
                    value={typeFilter}
                    onChange={(event) => setTypeFilter(event.target.value as AgentFileTypeFilter)}
                  >
                    {TYPE_FILTER_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <label className="agent-files-filter-field">
                  <span className="dock-kit-section-title">Date</span>
                  <select
                    className="dock-kit-select"
                    aria-label="Filter Agent Files by date"
                    value={dateFilter}
                    onChange={(event) => setDateFilter(event.target.value as AgentFileDateFilter)}
                  >
                    {DATE_FILTER_OPTIONS.map((opt) => (
                      <option key={opt.id} value={opt.id}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </label>
                {dateFilter === "CUSTOM" ? (
                  <div className="agent-files-date-range" role="group" aria-label="Custom date range">
                    <label className="agent-files-filter-field">
                      <span className="dock-kit-section-title">From</span>
                      <input
                        className="dock-kit-field"
                        type="date"
                        aria-label="Filter from date"
                        value={customStartDate}
                        onChange={(event) => setCustomStartDate(event.target.value)}
                      />
                    </label>
                    <label className="agent-files-filter-field">
                      <span className="dock-kit-section-title">To</span>
                      <input
                        className="dock-kit-field"
                        type="date"
                        aria-label="Filter to date"
                        value={customEndDate}
                        onChange={(event) => setCustomEndDate(event.target.value)}
                      />
                    </label>
                    {customStartDate || customEndDate ? (
                      <DockIconButton
                        label="Clear date range"
                        icon={X}
                        onClick={() => {
                          setCustomStartDate("");
                          setCustomEndDate("");
                        }}
                      />
                    ) : null}
                  </div>
                ) : null}
                {activeFilterCount ? (
                  <div className="dock-kit-editor-footer">
                    <DockButton tone="ghost" onClick={clearFilters}>Clear filters</DockButton>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {error ? <DockNotice onDismiss={() => setError(null)}>{error}</DockNotice> : null}
        {loadError && entries.length ? <DockNotice onDismiss={() => setLoadError(null)}>{loadError}</DockNotice> : null}
        {uploading ? <DockNotice tone="info">Uploading files…</DockNotice> : null}

        {!activeRoom ? (
          <DockState kind="empty" icon={AgentFiles} title="Select a room to view its Agent Files." />
        ) : showList ? null : !entries.length && !hasLoaded ? (
          <DockState kind="loading" title="Loading Agent Files…" />
        ) : !entries.length && loadError ? (
          <DockState
            kind="error"
            title="Files could not be loaded"
            detail={loadError}
            action={{ label: "Try again", onClick: () => void loadAgentFiles(activeRoom.id, true) }}
          />
        ) : isFiltered || activeFolder !== "ALL" ? (
          <DockState
            kind="empty"
            icon={Search}
            title={isFiltered ? "No files match your search." : "This folder is empty."}
            detail={isFiltered ? "Change the search, the filters or the folder." : "Move files here with the folder button on a file."}
            action={{ label: "Show all files", onClick: showAllFiles }}
          />
        ) : (
          <DockState
            kind="empty"
            icon={Upload}
            className={dragOver ? "is-dragover" : undefined}
            title="No files in this room yet"
            detail="Drop files here or use the upload button to add files to this room."
            action={{ label: "Upload files", icon: Upload, onClick: openFilePicker }}
          />
        )}

        <div
          className={`agent-files-items dock-kit-list ${viewMode === "grid" ? "is-grid" : "is-list"}`}
          role="list"
          aria-label="Room Agent Files"
          aria-busy={loading}
          hidden={!showList}
        >
          {nestedSubfolders.length ? (
            <div className="agent-files-folder-shortcuts" role="group" aria-label="Subfolder shortcuts">
              {nestedSubfolders.map((sub) => (
                <DockButton
                  key={sub.path}
                  icon={Folder}
                  className="agent-files-folder-shortcut"
                  title={`Open ${sub.name}`}
                  onClick={() => setActiveFolder(sub.path)}
                >
                  <span className="agent-files-folder-shortcut-name">{sub.name}</span>
                  <span className="dock-kit-chip-count">{folderCounts[sub.path] ?? 0}</span>
                </DockButton>
              ))}
            </div>
          ) : null}
          {displayedEntries.map((entry) => {
            const KindIcon = kindIcon(entry.previewKind);
            const showThumbnail = entry.previewKind === "IMAGE" && showPreviews && !brokenThumbs.has(entry.artifact.id);
            return (
              <article
                className={`agent-files-item dock-kit-card ${viewMode === "grid" ? "is-grid" : "is-list"}`}
                role="listitem"
                key={entry.artifact.id}
                draggable
                onDragStart={(event) => setArtifactDragData(event, entry.artifact)}
                aria-label={`Drag ${entry.filename}`}
              >
                <button
                  type="button"
                  className="agent-files-item-thumb"
                  onClick={() => void openPreview(entry)}
                  disabled={clearingAll || Boolean(deletingId)}
                  aria-label={`Preview ${entry.filename}`}
                  title={`Preview ${entry.filename}`}
                >
                  {showThumbnail ? (
                    <img
                      src={api.agentFilePreviewUrl(entry.artifact.id)}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      className="agent-files-item-thumb-img"
                      onError={() => setBrokenThumbs((current) => new Set(current).add(entry.artifact.id))}
                    />
                  ) : (
                    <KindIcon className="agent-files-item-kind" aria-hidden="true" />
                  )}
                  <span className="agent-files-item-thumb-chip" aria-hidden="true">
                    <Eye />
                  </span>
                </button>

                <div className="agent-files-item-body">
                  <div className="dock-kit-card-title" title={entry.filename}>{entry.filename}</div>
                  <div className="dock-kit-meta">
                    <span className="dock-kit-meta-text" title={entry.provenance}>{entry.provenance}</span>
                  </div>
                  <div className="dock-kit-meta">
                    <span className="dock-kit-meta-text">{entry.timestamp} · {entry.size}</span>
                  </div>
                </div>

                <div className="dock-kit-card-actions agent-files-item-actions">
                  <DockIconButton
                    label={`Move ${entry.filename} to folder`}
                    icon={FolderPlus}
                    disabled={clearingAll || Boolean(deletingId)}
                    onClick={() => setMovingEntry(entry)}
                  />
                  <DockIconButton
                    label={`Download ${entry.filename}`}
                    title={`Download and verify ${entry.filename}`}
                    icon={Download}
                    busy={downloadingId === entry.artifact.id}
                    disabled={Boolean(downloadingId) || clearingAll}
                    onClick={() => void downloadAgentFile(entry)}
                  />
                  <DockIconButton
                    label={`Delete ${entry.filename}`}
                    title={`Permanently delete ${entry.filename}`}
                    icon={Trash2}
                    tone="danger"
                    busy={deletingId === entry.artifact.id}
                    disabled={deletingId === entry.artifact.id || clearingAll || Boolean(downloadingId)}
                    onClick={() => void deleteAgentFile(entry)}
                  />
                </div>
              </article>
            );
          })}

          {displayedEntries.length < filteredEntries.length ? (
            <>
              <DockButton
                tone="ghost"
                className="agent-files-more"
                onClick={() => setVisibleCount((prev) => prev + PAGE_STEP)}
              >
                Load more files ({filteredEntries.length - displayedEntries.length} remaining)
              </DockButton>
              <div ref={sentinelRef} className="agent-files-sentinel" aria-hidden="true" />
            </>
          ) : null}
        </div>

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
            className="attachment-modal agent-files-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`Preview ${selected.filename}`}
            onClick={closePreview}
          >
            <div className="attachment-modal-body agent-files-modal-body is-preview" onClick={(event) => event.stopPropagation()}>
              <div className="agent-files-modal-head">
                <div className="agent-files-modal-heading">
                  <span className="dock-kit-card-title" title={selected.filename}>{selected.filename}</span>
                  <span className="dock-kit-meta-text">{selected.provenance} · {selected.timestamp} · {selected.size}</span>
                </div>
                <div className="agent-files-modal-actions">
                  <DockIconButton
                    label={`Download ${selected.filename}`}
                    title={`Download and verify ${selected.filename}`}
                    icon={Download}
                    busy={downloadingId === selected.artifact.id}
                    disabled={downloadingId === selected.artifact.id}
                    onClick={() => void downloadAgentFile(selected)}
                  />
                  <DockIconButton label="Close Agent File preview" icon={X} autoFocus onClick={closePreview} />
                </div>
              </div>
              <div className="agent-files-modal-preview">{previewBody(selected)}</div>
            </div>
          </div>
        ) : null}

        {movingEntry ? (
          <div
            className="attachment-modal agent-files-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`Move ${movingEntry.filename} to folder`}
            onClick={() => setMovingEntry(null)}
          >
            <div className="attachment-modal-body agent-files-modal-body is-form" onClick={(e) => e.stopPropagation()}>
              <div className="agent-files-modal-head">
                <div className="agent-files-modal-heading">
                  <span className="dock-kit-card-title">Move to folder</span>
                  <span className="dock-kit-meta-text" title={movingEntry.filename}>{movingEntry.filename}</span>
                </div>
                <DockIconButton label="Close move to folder dialog" icon={X} onClick={() => setMovingEntry(null)} />
              </div>
              <div className="agent-files-folder-options">
                <button
                  type="button"
                  className={`agent-files-folder-option${!movingAssignedFolder ? " is-selected" : ""}`}
                  aria-current={!movingAssignedFolder ? "true" : undefined}
                  onClick={() => {
                    handleMoveFile(movingEntry.artifact.id, "");
                    setMovingEntry(null);
                  }}
                >
                  <FolderOpen aria-hidden="true" />
                  <span>Automatic (by file type)</span>
                  {!movingAssignedFolder ? <span className="dock-kit-badge is-accent">Current</span> : null}
                </button>
                <div className="dock-kit-section-title agent-files-folder-group">Smart folders</div>
                {SMART_FOLDERS.filter((f) => f.id !== "ALL").map((folder) => {
                  const isSelected = movingAssignedFolder === folder.id;
                  return (
                    <button
                      key={folder.id}
                      type="button"
                      className={`agent-files-folder-option${isSelected ? " is-selected" : ""}`}
                      aria-current={isSelected ? "true" : undefined}
                      onClick={() => {
                        handleMoveFile(movingEntry.artifact.id, folder.id);
                        setMovingEntry(null);
                      }}
                    >
                      <Folder aria-hidden="true" />
                      <span>{folder.name}</span>
                      {isSelected ? <span className="dock-kit-badge is-accent">Current</span> : null}
                    </button>
                  );
                })}
                {customFolderPaths.length ? <div className="dock-kit-section-title agent-files-folder-group">Folders and subfolders</div> : null}
                {customFolderPaths.map((folderPath) => {
                  const depth = splitFolderPath(folderPath).length - 1;
                  const isSelected = movingAssignedFolder === folderPath;
                  return (
                    <button
                      key={folderPath}
                      type="button"
                      style={{ paddingLeft: `${0.75 + depth * 1.1}rem` }}
                      className={`agent-files-folder-option${isSelected ? " is-selected" : ""}`}
                      aria-current={isSelected ? "true" : undefined}
                      onClick={() => {
                        handleMoveFile(movingEntry.artifact.id, folderPath);
                        setMovingEntry(null);
                      }}
                    >
                      <Folder aria-hidden="true" />
                      <span>{getFolderLeafName(folderPath)}</span>
                      {depth > 0 ? <small className="agent-files-folder-option-path">{getFolderDisplayPath(folderPath)}</small> : null}
                      {isSelected ? <span className="dock-kit-badge is-accent">Current</span> : null}
                    </button>
                  );
                })}
              </div>
              <div className="agent-files-inline-create">
                <span className="dock-kit-section-title">New folder</span>
                <div className="agent-files-inline-create-row">
                  <select
                    className="dock-kit-select"
                    aria-label="Parent folder for new destination"
                    value={inlineParentDraft}
                    onChange={(e) => setInlineParentDraft(e.target.value)}
                  >
                    <option value="">Top level</option>
                    {folderOptionGroups()}
                  </select>
                  <input
                    className="dock-kit-field"
                    type="text"
                    aria-label="New folder name"
                    placeholder="New folder / subfolder name…"
                    value={newFolderDraft}
                    onChange={(e) => setNewFolderDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") createFolderAndMove(movingEntry);
                    }}
                  />
                  <DockButton tone="primary" disabled={!newFolderDraft.trim()} onClick={() => createFolderAndMove(movingEntry)}>
                    Create &amp; move
                  </DockButton>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {showNewFolderModal ? (
          <div
            className="attachment-modal agent-files-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Create new folder"
            onClick={closeNewFolderModal}
          >
            <div className="attachment-modal-body agent-files-modal-body is-form" onClick={(e) => e.stopPropagation()}>
              <div className="agent-files-modal-head">
                <div className="agent-files-modal-heading">
                  <span className="dock-kit-card-title">New folder</span>
                  <span className="dock-kit-meta-text">Group your files by topic, feature, or asset type</span>
                </div>
                <DockIconButton label="Close new folder dialog" icon={X} onClick={closeNewFolderModal} />
              </div>
              <div className="agent-files-new-folder-form">
                <label className="agent-files-filter-field">
                  <span className="dock-kit-section-title">Inside</span>
                  <select
                    className="dock-kit-select"
                    aria-label="Parent folder"
                    value={newFolderParent}
                    onChange={(e) => setNewFolderParent(e.target.value)}
                  >
                    <option value="">None (top-level folder)</option>
                    {folderOptionGroups()}
                  </select>
                </label>
                <input
                  className="dock-kit-field"
                  type="text"
                  aria-label="Folder name"
                  placeholder={newFolderParent ? `Subfolder name inside ${getFolderLeafName(newFolderParent)}…` : "Folder name (e.g. Graphics, Dev Logos, Exports)…"}
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") createFolderFromModal();
                  }}
                />
                <div className="dock-kit-editor-footer">
                  <DockButton tone="ghost" onClick={closeNewFolderModal}>Cancel</DockButton>
                  <DockButton tone="primary" disabled={!newFolderName.trim()} onClick={createFolderFromModal}>
                    {newFolderParent ? "Create subfolder" : "Create folder"}
                  </DockButton>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>
      {confirmDialog}
    </div>
  );
}
