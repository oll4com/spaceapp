import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronRight, Download, FolderPlus, GitBranch, GitMerge, Minus, Plus, RefreshCw, Settings, Star, Trash2, Undo2, Upload, X } from "../ui-theme/app-icons.js";
import type { AnyProjectBinding, GitFileChange, GitFileDiff, GitOperation, GitOperationInput, GitRemoteRepository, GitStatusSnapshot, OpenProjectResult, ProjectDefaultRepositories, RepositoryProviderId, RepositoryProviderState, SpaceWorktree } from "@space/contracts";
import { normalizeProjectBinding } from "@space/contracts";
import { SOURCE_CONTROL_CONNECTION_EVENT, SourceControlRequestError, repositoryProviderSettings, sourceControlClient, type SourceControlClient } from "./client.js";
import { ProjectSourcePicker } from "./ProjectSourcePicker.js";
import { ProviderConnectForm } from "./ProviderConnectForm.js";
import { PublishRepositoryPanel } from "./PublishRepositoryPanel.js";
import { enabledProviders, providerAvailability, providerLabel } from "./ProviderIcon.js";
import { listWorktrees, mergeWorktree, removeWorktree } from "../worktrees/worktree-client.js";
import { useIsDockActive } from "../docks/dock-active-context.js";
import { DeployActivityPanel } from "../deploy-queue/DeployActivityPanel.js";
import type { DeployQueueClient } from "../deploy-queue/deploy-queue-format.js";
import {
  DockButton,
  DockChips,
  DockFullscreenButton,
  DockIconButton,
  DockNotice,
  DockSearch,
  DockState,
  DockToolbar,
  useDockConfirm,
  useDockFullscreen,
  type DockChipOption
} from "../dock-kit/DockKit.js";
import "./source-control.css";
import { SourceControlDiffModal } from "./SourceControlDiffModal.js";

interface Project { label: string; path: string }
type DockProvider = "local" | RepositoryProviderId;
type StatusFilter = "all" | "M" | "A" | "D" | "R";
type WorktreeFilter = "all" | "dirty" | "ahead";
/** Above this many worktrees the open list gets a branch filter. */
const WORKTREE_FILTER_MIN = 6;
interface Props {
  userId: string; projects: Project[]; currentProjectPath?: string | null; client?: SourceControlClient;
  isAdmin?: boolean; defaultProjectParent?: string;
  /** ADMIN only: shows the live merge-queue deploy above the repository. */
  canViewDeploys?: boolean; deployClient?: DeployQueueClient;
  /** Adds a project opened from the dock to the personal presets. Never changes or creates a room. */
  onProjectOpened?: (project: Project) => void;
}
const baseName = (path: string) => path.split("/").filter(Boolean).pop() || path;
const tabVisible = () => document.visibilityState !== "hidden";
const REMOTE_FETCH_INTERVAL_MS = 30_000;
const REFRESHED_NOTICE = "Repository and remote status refreshed.";
function Dialog({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    if (typeof ref.current?.showModal === "function") ref.current.showModal(); else ref.current?.setAttribute("open", "");
    ref.current?.querySelector<HTMLElement>("button")?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={ref} className="source-control-dialog" aria-label={title} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><strong>{title}</strong><DockIconButton label={`Close ${title}`} icon={X} onClick={onClose} /></header>{children}
  </dialog>;
}
/** Version tooltip from the repository's own version.json, without assuming any product layout. */
function versionTitle(kind: string, version: string, pillars?: Record<string, string | undefined> | null): string {
  const parts = Object.entries(pillars ?? {}).filter(([, value]) => Boolean(value)).map(([name, value]) => `${name}: v${value}`);
  return [`${kind} version v${version}`, ...parts].join("\n");
}
function fileStatus(status: string, remote = false): { type: "added" | "deleted" | "renamed" | "modified"; title: string } {
  const value = status.toUpperCase();
  if (value === "A") return { type: "added", title: remote ? "Added (New file on remote)" : "Added (New file)" };
  if (value === "U" || value === "?") return { type: "added", title: "Untracked (New file)" };
  if (value === "D") return { type: "deleted", title: "Deleted file" };
  if (value === "R") return { type: "renamed", title: "Renamed file" };
  return { type: "modified", title: "Modified file" };
}
function matchesStatus(filter: StatusFilter, status: string): boolean {
  const value = status.toUpperCase();
  if (filter === "all") return true;
  if (filter === "A") return value === "A" || value === "U" || value === "?";
  return value === filter;
}
const extensionOf = (path: string) => {
  const lastDot = path.lastIndexOf(".");
  return lastDot !== -1 ? path.slice(lastDot).toLowerCase() : "(no ext)";
};
function formatCommitDate(iso?: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return `${d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  } catch {
    return iso;
  }
}

export function SourceControlDock({ userId, projects, currentProjectPath, client = sourceControlClient, isAdmin = false, defaultProjectParent = "/opt/spaceapp/projects", onProjectOpened, canViewDeploys = false, deployClient }: Props) {
  // A hidden dock stays mounted; it must not poll git status or fetch remotes in the background.
  const isDockActive = useIsDockActive();
  const { confirm, confirmDialog } = useDockConfirm();
  const [openedProjects, setOpenedProjects] = useState<Project[]>([]);
  const projectOptions = useMemo(() => [...new Map([...projects, ...openedProjects].filter(p => p.path).map(p => [p.path, p])).values()], [projects, openedProjects]);
  const [project, setProject] = useState(currentProjectPath || projectOptions[0]?.path || "");
  const [providerStates, setProviderStates] = useState<RepositoryProviderState[]>([]);
  // The first binding waits for provider states so a connected provider is not preceded by a throwaway local bind.
  const [providersReady, setProvidersReady] = useState(false);
  const [provider, setProvider] = useState<DockProvider>("local");
  const providerChosen = useRef(false);
  const providerChoiceKey = `space:source-control-provider:${userId}`;
  const [repos, setRepos] = useState<GitRemoteRepository[]>([]);
  const [repository, setRepositoryState] = useState("");
  // Binding requests read the selection from a ref; only explicit choices request a new binding.
  const repositoryRef = useRef("");
  const [bindRequest, setBindRequest] = useState(0);
  const setRepository = (id: string, rebind = false) => { repositoryRef.current = id; setRepositoryState(id); if (rebind) setBindRequest(value => value + 1); };
  const [search, setSearch] = useState("");
  const [nextCursor, setNextCursor] = useState<{ cursor: string | null; page: number | null } | null>(null);
  const [binding, setBinding] = useState<AnyProjectBinding | null>(null);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  // While a publish runs the project and provider cannot change underneath it.
  const [publishBusy, setPublishBusy] = useState(false);
  const projectRef = useRef(project);
  projectRef.current = project;
  const [snapshot, setSnapshot] = useState<GitStatusSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [diff, setDiff] = useState<GitFileDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ path: string; staged: boolean; remote?: boolean; status?: string } | null>(null);
  const [isFullscreen, setIsFullscreen] = useDockFullscreen();
  const [pushOperation, setPushOperation] = useState<"push" | "commit-push" | null>(null);
  const [remoteFileLimit, setRemoteFileLimit] = useState(100);
  const [remoteChecked, setRemoteChecked] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [extFilter, setExtFilter] = useState<string>("all");
  const [searchFilter, setSearchFilter] = useState<string>("");
  const [projectDefaults, setProjectDefaults] = useState<ProjectDefaultRepositories | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [defaultsLoading, setDefaultsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [allProviderRepos, setAllProviderRepos] = useState<Partial<Record<RepositoryProviderId, GitRemoteRepository[]>>>({});
  const [worktrees, setWorktrees] = useState<SpaceWorktree[]>([]);
  const [worktreeBusy, setWorktreeBusy] = useState<string | null>(null);
  // Worktrees stay folded until the user opens them; a repository can have more than a hundred.
  const [worktreesOpen, setWorktreesOpen] = useState(false);
  const [worktreeQuery, setWorktreeQuery] = useState("");
  const [worktreeFilter, setWorktreeFilter] = useState<WorktreeFilter>("all");
  const [deployRefresh, setDeployRefresh] = useState(0);
  const worktreePanelId = useId();
  const visibleProviders = useMemo(() => enabledProviders(providerStates), [providerStates]);
  const connected = useMemo(() => visibleProviders.filter(state => providerAvailability(state) === "connected"), [visibleProviders]);
  const activeState = provider === "local" ? null : providerStates.find(state => state.id === provider) ?? null;
  // "enabled" keeps its historical meaning: the selected provider can be used for repository requests.
  const enabled = !!activeState && providerAvailability(activeState) === "connected";
  const activeConnection = activeState?.connection;
  const connectionKey = JSON.stringify([provider, activeConnection?.serverUrl, activeConnection?.accountLogin, activeConnection?.connectedAt]);
  const providerName = provider === "local" ? (binding?.kind === "git-url" ? "origin" : "Local") : providerLabel(provider);
  const hasRemote = binding?.kind === "git-url" || (binding?.kind === "provider" && !!binding.repository);
  const remoteRepository = binding?.kind === "provider" ? binding.repository : null;
  const canPush = binding?.kind === "provider" ? !!binding.repository && binding.repository.permissions.push !== false : binding?.kind === "git-url" && !!binding.provider;

  // Worktrees exist only in a Git repository; a plain folder is never asked (the API answers 400 for it).
  const repositoryReady = snapshot?.initialized === true;
  const refreshWorktrees = useCallback(async () => {
    if (!project || !repositoryReady) { setWorktrees([]); return; }
    try {
      const list = await listWorktrees(project);
      if (projectRef.current === project) setWorktrees(list);
    } catch {
      if (projectRef.current === project) setWorktrees([]);
    }
  }, [project, repositoryReady]);

  // Worktrees load when the dock is shown, the project changes or its repository becomes known; Refresh reloads them too.
  useEffect(() => {
    if (isDockActive) void refreshWorktrees();
  }, [isDockActive, refreshWorktrees]);

  useEffect(() => {
    if (!project) { setProjectDefaults(null); return; }
    const controller = new AbortController();
    void client.defaults(project, controller.signal).then(defs => {
      if (!controller.signal.aborted) setProjectDefaults(defs);
    }).catch(() => {});
    return () => controller.abort();
  }, [client, project, enabled, connectionKey]);

  useEffect(() => {
    if (!isSettingsOpen) return;
    const controller = new AbortController();
    for (const state of connected) {
      void client.listRepositories({ provider: state.id, page: 1 }, controller.signal).then(result => {
        if (!controller.signal.aborted) setAllProviderRepos(prev => ({ ...prev, [state.id]: result.data }));
      }).catch(() => {});
    }
    return () => controller.abort();
  }, [isSettingsOpen, client, connected]);

  // repository holds the stable repository ID for every provider.
  const isCurrentRepoDefault = Boolean(repository && provider !== "local" && projectDefaults?.defaults?.[provider]?.repository?.id === repository);
  const repositoryName = repos.find(r => r.id === repository)?.fullName ?? remoteRepository?.fullName ?? repository;

  const handleToggleDefault = async (makeDefault: boolean) => {
    if (!project || !enabled || provider === "local") return;
    setDefaultsLoading(true);
    try {
      await client.setDefaultRepository(project, provider, makeDefault ? repository : null);
      const defs = await client.defaults(project);
      setProjectDefaults(defs);
      setNotice(makeDefault ? `Set ${repositoryName} as default for ${providerLabel(provider)}.` : "Default repository cleared (manual mode).");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update default repository.");
    } finally {
      setDefaultsLoading(false);
    }
  };

  const handleSetProviderDefault = async (targetProvider: RepositoryProviderId, repositoryId: string | null) => {
    if (!project) return;
    setDefaultsLoading(true);
    try {
      const result = await client.setDefaultRepository(project, targetProvider, repositoryId);
      const defs = await client.defaults(project);
      setProjectDefaults(defs);
      if (targetProvider === provider) {
        setRepository(repositoryId || "", true);
      }
      setNotice(result.repository ? `Set default ${providerLabel(targetProvider)} repository to ${result.repository.fullName}.` : `Cleared default repository for ${providerLabel(targetProvider)}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to set default repository.");
    } finally {
      setDefaultsLoading(false);
    }
  };

  const comparisonFiles = useMemo(() => snapshot?.comparison?.changes ?? [], [snapshot?.comparison?.changes]);
  const allChangesFiles = useMemo(() => {
    if (!snapshot) return [];
    return [
      ...(snapshot.conflicts ?? []),
      ...(snapshot.staged ?? []),
      ...(snapshot.changes ?? []),
      ...(snapshot.comparison?.changes ?? [])
    ];
  }, [snapshot]);

  const filterStats = useMemo(() => {
    let m = 0, a = 0, d = 0, r = 0;
    const extCounts = new Map<string, number>();

    for (const file of allChangesFiles) {
      if (matchesStatus("M", file.status)) m++;
      else if (matchesStatus("A", file.status)) a++;
      else if (matchesStatus("D", file.status)) d++;
      else if (matchesStatus("R", file.status)) r++;
      const ext = extensionOf(file.path);
      extCounts.set(ext, (extCounts.get(ext) || 0) + 1);
    }

    const sortedExts = [...extCounts.entries()].sort((a, b) => b[1] - a[1]);
    return { m, a, d, r, total: allChangesFiles.length, exts: sortedExts };
  }, [allChangesFiles]);

  // Readable change-type chips; a type appears once it has files (or while it is the active filter).
  const statusChips = useMemo<DockChipOption<StatusFilter>[]>(() => [
    { id: "all", label: "All", count: filterStats.total },
    ...([["M", "Modified", filterStats.m], ["A", "Added", filterStats.a], ["D", "Deleted", filterStats.d], ["R", "Renamed", filterStats.r]] as const)
      .filter(([id, , count]) => count > 0 || statusFilter === id)
      .map(([id, label, count]) => ({ id, label, count }))
  ], [filterStats, statusFilter]);
  const isFiltered = statusFilter !== "all" || extFilter !== "all" || searchFilter.trim() !== "";
  const resetFilters = () => { setStatusFilter("all"); setExtFilter("all"); setSearchFilter(""); };

  const filterFileList = useCallback((files: GitFileChange[]) => {
    const query = searchFilter.trim().toLowerCase();
    return files.filter(file => matchesStatus(statusFilter, file.status)
      && (extFilter === "all" || extensionOf(file.path) === extFilter.toLowerCase())
      && (!query || file.path.toLowerCase().includes(query)));
  }, [statusFilter, extFilter, searchFilter]);

  const filteredConflicts = useMemo(() => filterFileList(snapshot?.conflicts ?? []), [filterFileList, snapshot?.conflicts]);
  const filteredStaged = useMemo(() => filterFileList(snapshot?.staged ?? []), [filterFileList, snapshot?.staged]);
  const filteredChanges = useMemo(() => filterFileList(snapshot?.changes ?? []), [filterFileList, snapshot?.changes]);
  const filteredComparisonFiles = useMemo(() => filterFileList(comparisonFiles), [filterFileList, comparisonFiles]);

  const worktreeStats = useMemo(() => ({
    dirty: worktrees.filter(wt => wt.isDirty).length,
    ahead: worktrees.filter(wt => wt.aheadCount > 0).length
  }), [worktrees]);
  const worktreeChips = useMemo<DockChipOption<WorktreeFilter>[]>(() => [
    { id: "all", label: "All", count: worktrees.length },
    { id: "dirty", label: "Uncommitted", count: worktreeStats.dirty },
    { id: "ahead", label: "Ahead", count: worktreeStats.ahead }
  ], [worktrees.length, worktreeStats]);
  const visibleWorktrees = useMemo(() => {
    const query = worktreeQuery.trim().toLowerCase();
    return worktrees.filter(wt => (worktreeFilter === "all" || (worktreeFilter === "dirty" ? wt.isDirty : wt.aheadCount > 0))
      && (!query || wt.branch.toLowerCase().includes(query)));
  }, [worktrees, worktreeFilter, worktreeQuery]);
  const context = useRef(0);
  const staleRemoteDiff = useRef<string | null>(null);
  const staleRemoteMessage = "The remote branch changed while this file was being opened. The comparison list was refreshed.";
  const statusEpoch = useRef(0);
  const latest = useRef(snapshot); latest.current = snapshot;
  const busyRef = useRef(busy); busyRef.current = busy;
  const refreshingRef = useRef(false);
  // The 30 s remote fetch cadence survives hiding and showing the dock.
  const lastRemoteFetch = useRef<{ bindingId: string; at: number } | null>(null);
  const draftKey = `space:git-draft:${JSON.stringify([userId, project])}`;
  useEffect(() => { try { setMessage(localStorage.getItem(draftKey) || ""); } catch { setMessage(""); } }, [draftKey]);
  const editMessage = (value: string) => { setMessage(value); try { localStorage.setItem(draftKey, value); } catch {} };
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const data = await client.providers(controller.signal); if (controller.signal.aborted) return;
        setProviderStates(data); setProvidersReady(true);
        // Registry order (GitHub first) for the automatic choice; menus stay alphabetical.
        const usable = data.filter(state => state.enabled && state.available && providerAvailability(state) === "connected");
        let remembered: string | null = null;
        try { remembered = localStorage.getItem(providerChoiceKey); } catch {}
        setProvider(current => {
          if (current !== "local" && enabledProviders(data).some(state => state.id === current)) return current;
          if (!providerChosen.current && remembered === "local") return "local";
          const preferred = usable.find(state => state.id === remembered) ?? usable[0];
          // A disabled provider falls back without losing local work.
          return !providerChosen.current || current !== "local" ? preferred?.id ?? "local" : current;
        });
      } catch (error) { if (!controller.signal.aborted) { setProvidersReady(true); setError(error instanceof Error ? error.message : "Repository providers could not load."); } }
    };
    void load(); window.addEventListener(SOURCE_CONTROL_CONNECTION_EVENT, load);
    return () => { controller.abort(); window.removeEventListener(SOURCE_CONTROL_CONNECTION_EVENT, load); };
  }, [client, userId]);
  const chooseProvider = (next: DockProvider) => { providerChosen.current = true; setProvider(next); try { localStorage.setItem(providerChoiceKey, next); } catch {} };
  // A project opened from the picker selects its cloned repository after the provider switch resets the list.
  const pendingRepository = useRef<GitRemoteRepository | null>(null);
  // Confirmation for an action that also switches the binding; shown once the new binding is ready.
  const noticeAfterBind = useRef<string | null>(null);
  useEffect(() => {
    const pending = pendingRepository.current;
    setRepos(pending ? [pending] : []); setSearch(""); setNextCursor(null);
  }, [provider, userId, connectionKey]);
  // A repository selection belongs to one project and provider; never carry it to another project.
  useEffect(() => {
    const pending = pendingRepository.current; pendingRepository.current = null;
    setRepository(pending?.id ?? "");
    if (pending) setRepos(old => old.some(r => r.id === pending.id) ? old : [pending, ...old]);
  }, [provider, userId, connectionKey, project]);
  useEffect(() => {
    if (!enabled || provider === "local") return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void client.listRepositories({ provider, query: search.trim() || undefined, page: 1 }, controller.signal).then(result => {
        if (controller.signal.aborted) return;
        setRepos(old => { const selected = old.find(r => r.id === repositoryRef.current); return selected && !result.data.some(r => r.id === selected.id) ? [selected, ...result.data] : result.data; });
        setNextCursor(result.nextCursor || result.nextPage ? { cursor: result.nextCursor, page: result.nextCursor ? null : result.nextPage } : null);
      }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    }, search.trim() ? 300 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
    // The selected repository is kept visible but must not refetch the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, provider, enabled, userId, connectionKey, search]);
  useEffect(() => {
    const controller = new AbortController(); const current = ++context.current;
    busyRef.current = false; setBusy(false);
    setBinding(null); setSnapshot(null); setSelection(null); setDiff(null); setPushOperation(null); setError(null); setNotice(null); setRemoteChecked(null); setRemoteFileLimit(100);
    const selected = repositoryRef.current;
    const request = !project || !providersReady ? null : provider === "local" ? client.bindLocal(project, controller.signal) : enabled ? client.bindRepository(project, provider, selected || undefined, controller.signal) : null;
    if (request) void request.then(raw => {
      if (!controller.signal.aborted && current === context.current) {
        const result = normalizeProjectBinding(raw);
        setBinding(result);
        if (noticeAfterBind.current) { setNotice(noticeAfterBind.current); noticeAfterBind.current = null; }
        if (result.kind === "provider" && result.repository && !selected) {
          setRepos(old => old.some(r => r.id === result.repository!.id) ? old : [...old, result.repository!]);
          setRepository(result.repository.id);
        }
      }
    }).catch(error => { if (!controller.signal.aborted && current === context.current) setError(error.message); });
    return () => { controller.abort(); if (current === context.current) ++context.current; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, project, provider, enabled, userId, connectionKey, bindRequest, providersReady]);
  useEffect(() => {
    if (!binding || !isDockActive) return;
    const controller = new AbortController(); const current = context.current;
    let timer: ReturnType<typeof setTimeout> | undefined; let running = false;
    const fetchDue = () => {
      const last = lastRemoteFetch.current;
      return !last || last.bindingId !== binding.id || Date.now() - last.at >= REMOTE_FETCH_INTERVAL_MS;
    };
    const poll = async () => {
      if (running || controller.signal.aborted || !tabVisible()) return;
      // A manual refresh owns the status epoch until it finishes; polling resumes afterwards.
      if (busyRef.current || refreshingRef.current) { timer = setTimeout(() => void poll(), 1000); return; }
      running = true;
      const epoch = ++statusEpoch.current;
      try {
        let result = await client.status(binding.id, controller.signal);
        if (!controller.signal.aborted && current === context.current && epoch === statusEpoch.current && !busyRef.current) {
          setSnapshot(result);
          if ((binding.kind === "git-url" || binding.kind === "provider" && binding.repository) && fetchDue() && !busyRef.current) {
            lastRemoteFetch.current = { bindingId: binding.id, at: Date.now() };
            const fetched = await client.operate("fetch", { bindingId: binding.id, expectedVersion: result.version, paths: [], confirmed: false, private: true });
            result = fetched.snapshot;
            if (!controller.signal.aborted && current === context.current && epoch === statusEpoch.current && !busyRef.current) { setSnapshot(result); setRemoteChecked(new Date().toLocaleTimeString()); }
          }
        }
      } catch (error) { if (!controller.signal.aborted && current === context.current && epoch === statusEpoch.current) setError(error instanceof Error ? error.message : "Repository status could not refresh."); }
      finally { running = false; if (!controller.signal.aborted && tabVisible()) timer = setTimeout(() => void poll(), 1000); }
    };
    const visibility = () => { if (timer) clearTimeout(timer); if (tabVisible()) void poll(); };
    void poll(); document.addEventListener("visibilitychange", visibility);
    return () => { controller.abort(); if (timer) clearTimeout(timer); document.removeEventListener("visibilitychange", visibility); };
  }, [binding, client, isDockActive]);
  useEffect(() => {
    if (!binding || !selection) { staleRemoteDiff.current = null; return; }
    if (staleRemoteDiff.current !== selection.path) staleRemoteDiff.current = null;
    const controller = new AbortController(); const current = context.current; setDiff(null); setDiffError(null);
    const request = selection.remote ? client.diff(binding.id, selection.path, false, controller.signal, true) : client.diff(binding.id, selection.path, selection.staged, controller.signal);
    void request.then(result => {
      if (!controller.signal.aborted && current === context.current) setDiff(result);
    }).catch(error => {
      if (controller.signal.aborted || current !== context.current) return;
      // The remote comparison refs are shared, so the remote branch can move between listing and opening a
      // file. Refresh the list once instead of leaving a stale entry that can no longer be compared.
      const stale = selection.remote && error instanceof SourceControlRequestError && error.code === "INVALID_PATH";
      if (stale && staleRemoteDiff.current === selection.path) { setDiffError(staleRemoteMessage); return; }
      setDiffError(error instanceof Error ? error.message : "Diff could not load. Close it and refresh the repository.");
      if (stale) {
        staleRemoteDiff.current = selection.path;
        void client.status(binding.id).then(next => { if (current === context.current) { setSnapshot(next); setDiffError(staleRemoteMessage); } }).catch(() => undefined);
      }
    });
    return () => controller.abort();
  }, [binding, selection, client, snapshot?.version]);
  const action = async (operation: GitOperation, extra: Partial<GitOperationInput> = {}) => {
    if (!binding || !latest.current || busyRef.current) return;
    const current = context.current; const id = binding.id;
    ++statusEpoch.current;
    busyRef.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      const result = await client.operate(operation, { bindingId: id, expectedVersion: latest.current.version, paths: [], confirmed: false, private: true, message: message.trim() || undefined, ...extra });
      if (current !== context.current) return;
      if (result?.snapshot) setSnapshot(result.snapshot);
      const resultBinding = result?.binding ? normalizeProjectBinding(result.binding) : null;
      if (resultBinding?.kind === "provider" && resultBinding.repository) {
        const remote = resultBinding.repository;
        setRepos(old => old.some(r => r.id === remote.id) ? old : [...old, remote]);
        setRepository(remote.id);
      }
      if (result?.committed) editMessage("");
      setNotice(result?.message ?? "Operation completed.");
      if (result && !result.ok) setError(result.message);
      if (operation === "fetch") { setRemoteChecked(new Date().toLocaleTimeString()); lastRemoteFetch.current = { bindingId: id, at: Date.now() }; }
      setPushOperation(null);
    } catch (error) { if (current === context.current) setError(error instanceof Error ? error.message : "Git operation failed."); }
    finally {
      if (current === context.current) {
        const epoch = ++statusEpoch.current;
        busyRef.current = false; setBusy(false);
        try { const status = await client.status(id); if (current === context.current && epoch === statusEpoch.current) setSnapshot(status); } catch {}
      }
    }
  };

  const handleRefresh = async () => {
    if (busyRef.current || refreshingRef.current) return;
    refreshingRef.current = true; setIsRefreshing(true);
    setError(null);
    setDeployRefresh(value => value + 1);
    const epoch = ++statusEpoch.current;
    try {
      // 1. Provider states (enabled/connected) may have changed in Plugins.
      let states = providerStates;
      try { states = await client.providers(); setProviderStates(states); } catch {}
      const selected = provider === "local" ? null : states.find(state => state.id === provider) ?? null;
      const usable = !!selected && selected.enabled && providerAvailability(selected) === "connected";

      // 2. Repository list for the selected provider.
      if (usable && provider !== "local") {
        try {
          const page = await client.listRepositories({ provider, query: search.trim() || undefined, page: 1 });
          setRepos(page.data);
          setNextCursor(page.nextCursor || page.nextPage ? { cursor: page.nextCursor, page: page.nextCursor ? null : page.nextPage } : null);
        } catch {}
      }

      // 3. Project defaults and worktrees.
      if (project) {
        try { setProjectDefaults(await client.defaults(project)); } catch {}
        await refreshWorktrees();
      }

      // 4. Ensure a binding exists (local mode never needs a provider).
      let activeBinding = binding;
      if (!activeBinding && project && (provider === "local" || usable)) {
        activeBinding = normalizeProjectBinding(provider === "local" ? await client.bindLocal(project) : await client.bindRepository(project, provider, repository || undefined));
        setBinding(activeBinding);
        if (activeBinding.kind === "provider" && activeBinding.repository && !repository) {
          const remote = activeBinding.repository;
          setRepos(old => old.some(r => r.id === remote.id) ? old : [...old, remote]);
          setRepository(remote.id);
        }
      }

      // 5. Status and remote comparison.
      if (activeBinding) {
        let status = await client.status(activeBinding.id);
        if (activeBinding.kind === "git-url" || activeBinding.kind === "provider" && activeBinding.repository) {
          try {
            const fetched = await client.operate("fetch", { bindingId: activeBinding.id, expectedVersion: status.version, paths: [], confirmed: false, private: true });
            if (fetched?.snapshot) status = fetched.snapshot;
            lastRemoteFetch.current = { bindingId: activeBinding.id, at: Date.now() };
            if (epoch === statusEpoch.current) setRemoteChecked(new Date().toLocaleTimeString());
          } catch (fetchErr) {
            console.warn("Source control remote fetch failed during refresh:", fetchErr);
          }
        }
        if (epoch === statusEpoch.current) setSnapshot(status);

        // 6. Refresh an open diff.
        if (selection) {
          try {
            setDiff(selection.remote
              ? await client.diff(activeBinding.id, selection.path, false, undefined, true)
              : await client.diff(activeBinding.id, selection.path, selection.staged, undefined));
          } catch {}
        }
        if (epoch === statusEpoch.current) {
          setNotice(REFRESHED_NOTICE);
          setTimeout(() => setNotice(prev => prev === REFRESHED_NOTICE ? null : prev), 4000);
        }
      }
    } catch (err) {
      if (epoch === statusEpoch.current) setError(err instanceof Error ? err.message : "Failed to refresh repository.");
    } finally {
      refreshingRef.current = false; setIsRefreshing(false);
    }
  };

  const openPickerResult = (result: OpenProjectResult) => {
    const opened = { label: baseName(result.projectPath), path: result.projectPath };
    setOpenedProjects(current => current.some(p => p.path === opened.path) ? current : [...current, opened]);
    onProjectOpened?.(opened);
    setProject(result.projectPath);
    if (result.binding?.kind === "provider") {
      providerChosen.current = true;
      // Consumed by the selection reset that follows the project/provider change.
      if (result.projectPath === project && result.binding.provider === provider) setRepository(result.binding.repository?.id ?? "", true);
      else { pendingRepository.current = result.binding.repository; setProvider(result.binding.provider); }
    } else if (result.binding) { providerChosen.current = true; setProvider("local"); }
    noticeAfterBind.current = `${result.source.label}${result.source.detail ? ` · ${result.source.detail}` : ""} opened at ${result.projectPath}.`;
  };

  // Discarding asks first; a project switch while the question is open cancels the discard.
  const discardFile = async (path: string) => {
    const current = context.current;
    const accepted = await confirm({ title: "Discard changes?", message: `All unstaged changes in ${path} will be lost. This cannot be undone.`, confirmLabel: "Discard changes" });
    if (!accepted || current !== context.current) return;
    await action("discard", { paths: [path], confirmed: true });
  };

  const mergeIntoBase = async (worktree: SpaceWorktree) => {
    const target = worktree.baseBranch || "main";
    const accepted = await confirm({ title: `Merge ${worktree.branch} into ${target}?`, message: `The branch is merged into ${target}, then the worktree and its branch are removed.`, confirmLabel: "Merge", tone: "primary" });
    if (!accepted) return;
    setWorktreeBusy(worktree.worktreePath); setError(null); setNotice(null);
    try {
      await mergeWorktree(worktree.worktreePath, { strategy: "merge", deleteBranchAfter: true });
      setNotice(`Merged ${worktree.branch} into ${target}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Merge failed.");
    } finally {
      setWorktreeBusy(null);
      await refreshWorktrees();
    }
  };

  const discardWorktree = async (worktree: SpaceWorktree) => {
    const accepted = await confirm({ title: `Discard worktree ${worktree.branch}?`,
      message: worktree.isDirty ? "It has uncommitted changes. They will be lost and the worktree is removed. This cannot be undone." : "The worktree is removed. This cannot be undone.",
      confirmLabel: "Discard" });
    if (!accepted) return;
    setWorktreeBusy(worktree.worktreePath); setError(null); setNotice(null);
    try {
      await removeWorktree(worktree.worktreePath, true);
      setNotice(`Discarded ${worktree.branch}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Discard failed.");
    } finally {
      setWorktreeBusy(null);
      await refreshWorktrees();
    }
  };

  const fileName = (file: GitFileChange, label: string, onOpen: () => void) => {
    const segments = file.path.split("/");
    const basename = segments.pop() || file.path;
    const dirname = segments.join("/");
    return (
      <button type="button" className={`source-control-file-name${file.status.toUpperCase() === "D" ? " is-deleted" : ""}`} aria-label={label} title={file.path} onClick={onOpen}>
        {file.originalPath ? <span className="source-control-file-rename">{file.originalPath} → </span> : null}
        <span className="source-control-file-basename">{basename}</span>
        {dirname ? <span className="source-control-file-dir">{dirname}</span> : null}
      </button>
    );
  };

  const statusBadge = (file: GitFileChange, remote = false) => {
    const { type, title } = fileStatus(file.status, remote);
    return <span className={`source-control-file-status status-${type}`} title={title} aria-label={title}>{file.status}</span>;
  };

  const rows = (files: GitFileChange[], staged: boolean, conflicts = false) => files.map(file => (
    <div className={`source-control-file status-${fileStatus(file.status).type}`} key={file.path}>
      {statusBadge(file)}
      {fileName(file, `Open ${staged ? "staged " : ""}diff for ${file.path}`, () => setSelection({ path: file.path, staged, status: file.status }))}
      <DockIconButton label={`${staged ? "Unstage" : "Stage"} ${file.path}`} icon={staged ? Minus : Plus} disabled={busy}
        onClick={() => void action(staged ? "unstage" : "stage", { paths: [file.path] })} />
      {!staged && !conflicts ? (
        <DockIconButton label={`Discard ${file.path}`} icon={Undo2} tone="danger" disabled={busy} onClick={() => void discardFile(file.path)} />
      ) : null}
    </div>
  ));

  const projectLabel = projectOptions.find(p => p.path === project)?.label || project;
  const changedCount = snapshot?.initialized ? snapshot.conflicts.length + snapshot.staged.length + snapshot.changes.length : 0;
  // A status load is only expected once a project is chosen and its provider (or Local only) can bind.
  const expectsStatus = !!project && (!providersReady || provider === "local" || enabled);
  const firstLoadFailed = expectsStatus && !snapshot && !!error;
  const comparisonBlocked = !!snapshot?.comparison && (!snapshot.comparison.ready || snapshot.comparison.related === false);
  const remoteName = remoteRepository?.fullName ?? (binding?.kind === "git-url" ? binding.url : "");
  const remoteTitle = canPush ? undefined : "Connect the provider that hosts this repository to push.";

  return <div className={`source-control-dock-shell dock-kit-shell${isFullscreen ? " is-fullscreen" : ""}`}>
    <section className="source-control-dock dock-panel dock-kit-dock" aria-label="Source Control" aria-busy={busy}
      onKeyDown={event => {
        // A dialog inside the dock handles its own Escape; it must not also leave fullscreen.
        if (event.key === "Escape" && event.target instanceof Element && event.target.closest("dialog, .source-control-modal-backdrop")) event.stopPropagation();
      }}>
      <DockToolbar
        title={isFullscreen ? "Source Control" : undefined}
        summary={snapshot?.initialized
          ? <><strong>{changedCount}</strong> changed file{changedCount === 1 ? "" : "s"} · {snapshot.staged.length} staged</>
          : project ? projectLabel : "No project selected"}
      >
        <DockButton icon={FolderPlus} tone="primary" className="source-control-open-project" aria-label="Open project"
          title="Open project: new, local folder, Git URL or a repository provider" disabled={busy || publishBusy}
          onClick={() => setIsPickerOpen(true)}><span>Open project</span></DockButton>
        <DockIconButton label="Repository defaults" icon={Settings} disabled={busy || !project} onClick={() => setIsSettingsOpen(true)} />
        <DockIconButton label="Refresh repository" icon={RefreshCw} busy={isRefreshing} disabled={busy || isRefreshing}
          title="Refresh status, worktrees and the remote comparison" onClick={() => void handleRefresh()} />
        <DockFullscreenButton name="source control" active={isFullscreen} onToggle={() => setIsFullscreen(value => !value)} />
      </DockToolbar>

      {error && !firstLoadFailed ? <DockNotice onDismiss={() => setError(null)}>{error}</DockNotice> : null}
      {notice ? <DockNotice tone="success" onDismiss={() => setNotice(null)}>{notice}</DockNotice> : null}

      <div className="source-control-body">
        {canViewDeploys ? <DeployActivityPanel client={deployClient} active={isDockActive} refreshKey={deployRefresh} /> : null}
        <div className="source-control-selectors">
          <label>Project<select aria-label="Project" value={project} disabled={busy || publishBusy} onChange={event => setProject(event.target.value)}>
            {!projectOptions.length ? <option value="">No projects</option> : null}{projectOptions.map(p => <option key={p.path} value={p.path}>{p.label}</option>)}
          </select></label>
          <label>Provider<select aria-label="Provider" value={provider} disabled={busy || publishBusy} onChange={event => chooseProvider(event.target.value as DockProvider)}>
            <option value="local">Local only</option>
            {visibleProviders.map(state => <option key={state.id} value={state.id}>{state.label}{providerAvailability(state) === "connected" ? ` · ${state.connection.accountLogin}` : providerAvailability(state) === "error" ? " (reconnect required)" : " (setup required)"}</option>)}
          </select></label>
        </div>

        {activeState && !enabled ? <section className="source-control-setup dock-kit-card" aria-label={`${activeState.label} setup`}>
          <p>{providerAvailability(activeState) === "error" ? `${activeState.label} needs to be reconnected. ${activeState.connection.error ?? ""}` : `Set up ${activeState.label} to choose its repositories. Local changes stay available in Local only.`}</p>
          {providerAvailability(activeState) === "error" ? <DockButton icon={RefreshCw} disabled={isRefreshing} onClick={() => void (async () => {
            try { const result = await repositoryProviderSettings.test(activeState.id); if (result.ok) setNotice(result.message); else setError(result.message); }
            catch (cause) { setError(cause instanceof Error ? cause.message : "The provider could not be checked."); }
            finally { repositoryProviderSettings.changed(); }
          })()}>Retry connection</DockButton> : null}
          <ProviderConnectForm key={activeState.id} state={activeState} reconnect={providerAvailability(activeState) === "error"} onConnected={() => undefined} />
        </section> : null}

        {provider === "local" && binding?.kind === "git-url" ? <p className="source-control-muted">Origin: {binding.url}{binding.provider ? ` · uses your ${providerLabel(binding.provider)} account` : " · public, Push needs a connected provider"}</p> : null}
        {provider === "local" && binding?.kind === "local" && !snapshot?.remoteUrl ? <p className="source-control-muted">Local only. Choose a provider to fetch, pull or push.</p> : null}

        {enabled && provider !== "local" ? <div className="source-control-repositories">
          <DockSearch label="Search repositories" placeholder="Search repositories…" value={search} onChange={setSearch} name="source-control-repository-search" />
          <label>Repository<select aria-label="Repository" disabled={busy} value={repository} onChange={e => setRepository(e.target.value, true)}>
            <option value="">Local repository</option>{repos.map(r => <option key={r.id} value={r.id}>{r.fullName}{r.permissions.push ? "" : " (read only)"}</option>)}
          </select></label>
          <div className="source-control-default-repo-row">
            {isCurrentRepoDefault ? (
              <span className="source-control-default-badge dock-kit-badge is-accent">
                <Star className="source-control-star-icon" size={12} fill="currentColor" aria-hidden="true" />
                <span>Default ({providerName})</span>
              </span>
            ) : !repository ? (
              <span className="source-control-manual-mode-hint">No default repository; choose one each time.</span>
            ) : null}
            {isCurrentRepoDefault ? (
              <DockButton tone="ghost" icon={X} className="source-control-clear-default-btn" disabled={busy || defaultsLoading}
                title="Clear the default and choose the repository manually" onClick={() => void handleToggleDefault(false)}>Clear</DockButton>
            ) : repository ? (
              <DockButton tone="ghost" icon={Star} className="source-control-set-default-btn" disabled={busy || defaultsLoading}
                title={`Set ${repositoryName} as default for this project when using ${providerName}`}
                onClick={() => void handleToggleDefault(true)}>Set as default for this project</DockButton>
            ) : null}
          </div>
          {nextCursor ? <DockButton tone="ghost" disabled={busy} onClick={async () => {
            const current = context.current;
            try {
              const result = await client.listRepositories({ provider, query: search.trim() || undefined, ...(nextCursor.cursor ? { cursor: nextCursor.cursor } : { page: nextCursor.page ?? 2 }) });
              if (current === context.current) { setRepos(old => [...old, ...result.data.filter(r => !old.some(item => item.id === r.id))]); setNextCursor(result.nextCursor || result.nextPage ? { cursor: result.nextCursor, page: result.nextCursor ? null : result.nextPage } : null); }
            } catch (error) { if (current === context.current) setError((error as Error).message); }
          }}>Load more repositories</DockButton> : null}
        </div> : null}

        {!project ? (
          <DockState kind="empty" icon={FolderPlus} title="No project selected" detail="Open a project to see its changes, commit and sync."
            action={{ label: "Open project", icon: FolderPlus, onClick: () => setIsPickerOpen(true) }} />
        ) : firstLoadFailed ? (
          <DockState kind="error" title="Repository could not load" detail={error}
            action={{ label: "Try again", icon: RefreshCw, onClick: () => { setError(null); void handleRefresh(); } }} />
        ) : !snapshot && expectsStatus ? (
          <DockState kind="loading" title="Loading repository…" />
        ) : null}

        {snapshot ? <>
          <div className="source-control-branch">
            <GitBranch size={14} aria-hidden="true" />
            {snapshot.branch
              ? <span>{snapshot.branch}</span>
              : <span title={snapshot.initialized ? "No branch is checked out (detached HEAD). Commits made here belong to no branch." : undefined}>{snapshot.initialized ? "Detached (no branch)" : "No repository"}</span>}
            {snapshot.comparison && !snapshot.comparison.ready
              ? <span>Remote not checked</span>
              : <span className="source-control-sync" title={`${snapshot.ahead} to push, ${snapshot.behind} to pull`} aria-label={`${snapshot.ahead} to push, ${snapshot.behind} to pull`}>
                <span className={snapshot.ahead ? "is-ahead" : undefined}>↑ {snapshot.ahead}</span>
                <span className={snapshot.behind ? "is-behind" : undefined}>↓ {snapshot.behind}</span>
              </span>}
          </div>
          {snapshot.initialized ? (
            <div className="source-control-meta-card" aria-label="Project and repository details">
              <div className="source-control-meta-row">
                <span className="source-control-meta-label">Project</span>
                <span className="source-control-meta-val">
                  <strong>{projectLabel}</strong>
                  {snapshot.projectVersion ? (
                    <span className="source-control-meta-badge" title={versionTitle("Project", snapshot.projectVersion, snapshot.projectPillars)}>v{snapshot.projectVersion}</span>
                  ) : null}
                  {snapshot.headShort ? (
                    <span className="source-control-meta-commit" title={snapshot.headMessage || undefined}>commit {snapshot.headShort}</span>
                  ) : null}
                  {snapshot.headDate ? (
                    <span className="source-control-meta-date" title={`Commit date: ${snapshot.headDate}`}>· {formatCommitDate(snapshot.headDate)}</span>
                  ) : null}
                </span>
              </div>
              {hasRemote ? (
                <div className="source-control-meta-row">
                  <span className="source-control-meta-label">Remote</span>
                  <span className="source-control-meta-val">
                    <strong>{remoteName}</strong>
                    {snapshot.comparison?.repoVersion ? (
                      <span className="source-control-meta-badge" title={versionTitle("Remote", snapshot.comparison.repoVersion, snapshot.comparison.repoPillars)}>v{snapshot.comparison.repoVersion}</span>
                    ) : null}
                    {snapshot.comparison?.headShort ? (
                      <span className="source-control-meta-commit" title={snapshot.comparison.headMessage || undefined}>commit {snapshot.comparison.headShort}</span>
                    ) : null}
                    {snapshot.comparison?.headDate ? (
                      <span className="source-control-meta-date" title={`Remote commit date: ${snapshot.comparison.headDate}`}>· {formatCommitDate(snapshot.comparison.headDate)}</span>
                    ) : snapshot.comparison?.checkedAt ? (
                      <span className="source-control-meta-date" title={`Checked at: ${snapshot.comparison.checkedAt}`}>· Checked {formatCommitDate(snapshot.comparison.checkedAt)}</span>
                    ) : null}
                  </span>
                </div>
              ) : null}
            </div>
          ) : null}

          {snapshot.initialized && worktrees.length > 0 ? (
            <section className={`source-control-worktrees${worktreesOpen ? " is-open" : ""}`} aria-label="Worktrees">
              <button type="button" className="source-control-section-toggle" aria-expanded={worktreesOpen} aria-controls={worktreePanelId}
                onClick={() => setWorktreesOpen(open => !open)}>
                <ChevronRight className="source-control-section-chevron" size={14} aria-hidden="true" />
                <span className="source-control-section-title">Worktrees</span>
                <span className="source-control-count">{worktrees.length}</span>
                {worktreeStats.dirty ? <span className="dock-kit-badge is-warning">{worktreeStats.dirty} uncommitted</span> : null}
                <span className="source-control-section-hint" aria-hidden="true">{worktreesOpen ? "Hide" : "Show"}</span>
              </button>
              {worktreesOpen ? (
                <div className="source-control-worktree-panel" id={worktreePanelId}>
                  {worktrees.length > WORKTREE_FILTER_MIN ? (
                    <div className="source-control-worktree-tools">
                      <DockSearch label="Filter worktrees by branch" placeholder="Filter branches…" value={worktreeQuery} onChange={setWorktreeQuery} name="source-control-worktree-filter" />
                      <DockChips label="Worktree filter" options={worktreeChips} value={worktreeFilter}
                        onChange={id => setWorktreeFilter(current => current === id && id !== "all" ? "all" : id)} />
                    </div>
                  ) : null}
                  <div className="source-control-worktree-list">
                    {visibleWorktrees.map(wt => {
                      const target = wt.baseBranch || "main";
                      const pending = worktreeBusy === wt.worktreePath;
                      // The repository's own checkout cannot be merged into itself or removed.
                      const primary = wt.worktreePath === wt.repoPath;
                      return (
                        <div key={wt.worktreePath} className={`source-control-worktree-item${wt.isDirty ? " is-dirty" : ""}${primary ? " is-primary" : ""}`}>
                          <div className="source-control-worktree-info">
                            <span className="source-control-worktree-branch" title={`${wt.branch}\n${wt.worktreePath}`}>
                              <GitBranch size={13} aria-hidden="true" />
                              <strong>{wt.branch}</strong>
                            </span>
                            <span className="source-control-worktree-meta">
                              {wt.isDirty ? <span className="source-control-worktree-dirty">Uncommitted changes</span> : <span>Clean</span>}
                              {wt.aheadCount ? <span className="source-control-worktree-ahead" title={`${wt.aheadCount} commit${wt.aheadCount === 1 ? "" : "s"} ahead of ${target}`}>↑ {wt.aheadCount} ahead</span> : null}
                              {wt.behindCount ? <span title={`${wt.behindCount} commit${wt.behindCount === 1 ? "" : "s"} behind ${target}`}>↓ {wt.behindCount} behind</span> : null}
                            </span>
                          </div>
                          {primary ? <span className="dock-kit-badge">Main checkout</span> : (
                            <div className="source-control-worktree-actions">
                              {wt.branch !== target ? (
                                <DockButton icon={GitMerge} busy={pending} disabled={!!worktreeBusy} title={`Merge ${wt.branch} into ${target}`}
                                  onClick={() => void mergeIntoBase(wt)}>Merge into {target}</DockButton>
                              ) : null}
                              <DockIconButton label={`Discard worktree ${wt.branch}`} icon={Trash2} tone="danger" disabled={!!worktreeBusy}
                                onClick={() => void discardWorktree(wt)} />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {!visibleWorktrees.length ? <p className="source-control-muted">No worktrees match the filter.</p> : null}
                </div>
              ) : null}
            </section>
          ) : null}

          {!snapshot.initialized ? (
            <div className="dock-kit-state is-empty source-control-empty" role="status">
              <span className="dock-kit-state-icon" aria-hidden="true"><GitBranch /></span>
              <strong className="dock-kit-state-title">This project has no Git repository</strong>
              <p className="dock-kit-state-detail">Initialize a new repository here{remoteRepository ? ", or clone the selected repository" : ""}.</p>
              <div className="dock-kit-card-actions">
                <DockButton tone="primary" disabled={busy} onClick={() => void action("initialize")}>Initialize repository</DockButton>
                {remoteRepository ? <DockButton disabled={busy} onClick={() => void action("clone")}>Clone repository</DockButton> : null}
              </div>
            </div>
          ) : <>
            {allChangesFiles.length > 0 ? (
              <div className="dock-kit-controls source-control-filters" role="group" aria-label="Filter changes">
                <DockChips label="Change types" options={statusChips} value={statusFilter}
                  onChange={id => setStatusFilter(current => current === id && id !== "all" ? "all" : id)} />
                <div className="source-control-filter-controls">
                  <DockSearch label="Filter files by name" placeholder="Filter files…" value={searchFilter} onChange={setSearchFilter} name="source-control-file-filter" />
                  <select className="source-control-ext-select" aria-label="Filter by file type" value={extFilter} onChange={e => setExtFilter(e.target.value)}>
                    <option value="all">All file types</option>
                    {filterStats.exts.map(([ext, count]) => (
                      <option key={ext} value={ext}>{ext === "(no ext)" ? "No extension" : ext} ({count})</option>
                    ))}
                  </select>
                </div>
                {isFiltered ? <DockButton tone="ghost" className="source-control-filter-reset" onClick={resetFilters}>Reset filters</DockButton> : null}
              </div>
            ) : null}

            {snapshot.conflicts.length ? (
              <section className="source-control-changes source-control-conflicts" aria-label="Conflicts">
                <h3>Conflicts <span>{filteredConflicts.length}{filteredConflicts.length !== snapshot.conflicts.length ? ` of ${snapshot.conflicts.length}` : ""}</span></h3>
                {rows(filteredConflicts, false, true)}
              </section>
            ) : null}
            <section className="source-control-changes">
              <h3>
                Staged Changes <span>{filteredStaged.length}{filteredStaged.length !== snapshot.staged.length ? ` of ${snapshot.staged.length}` : ""}</span>
                {snapshot.staged.length ? (
                  <DockButton tone="ghost" disabled={busy}
                    onClick={() => void action("unstage", { paths: (filteredStaged.length !== snapshot.staged.length ? filteredStaged : snapshot.staged).map(f => f.path) })}>
                    {filteredStaged.length !== snapshot.staged.length ? "Unstage filtered" : "Unstage all"}
                  </DockButton>
                ) : null}
              </h3>
              {rows(filteredStaged, true)}
            </section>
            <section className="source-control-changes">
              <h3>
                Changes <span>{filteredChanges.length}{filteredChanges.length !== snapshot.changes.length ? ` of ${snapshot.changes.length}` : ""}</span>
                {snapshot.changes.length ? (
                  <DockButton tone="ghost" disabled={busy}
                    onClick={() => void action("stage", { paths: (filteredChanges.length !== snapshot.changes.length ? filteredChanges : snapshot.changes).map(f => f.path) })}>
                    {filteredChanges.length !== snapshot.changes.length ? "Stage filtered" : "Stage all"}
                  </DockButton>
                ) : null}
              </h3>
              {rows(filteredChanges, false)}
              {!snapshot.changes.length && !snapshot.staged.length && !snapshot.conflicts.length ? (
                <p className="source-control-muted">Working tree is clean.</p>
              ) : snapshot.changes.length > 0 && !filteredChanges.length ? (
                <p className="source-control-muted">No working tree changes match the selected filter.</p>
              ) : null}
            </section>

            <div className="source-control-commit dock-kit-editor">
              <label>Commit message<textarea className="dock-kit-field" aria-label="Commit message" placeholder="Describe the staged changes" rows={3} value={message} onChange={e => editMessage(e.target.value)} /></label>
              <div className="dock-kit-editor-footer">
                <span className="dock-kit-counter">{snapshot.staged.length} staged file{snapshot.staged.length === 1 ? "" : "s"}</span>
                <DockButton tone="primary" disabled={busy || !message.trim() || !snapshot.staged.length || !!snapshot.conflicts.length} onClick={() => void action("commit")}>Commit</DockButton>
                <DockButton icon={Upload} disabled={busy || !message.trim() || !snapshot.staged.length || !!snapshot.conflicts.length || !canPush || comparisonBlocked}
                  title={remoteTitle} onClick={() => setPushOperation("commit-push")}>Commit &amp; Push</DockButton>
              </div>
            </div>
            {hasRemote ? <div className="source-control-actions" role="group" aria-label="Sync with remote">
              <DockButton icon={Upload} disabled={busy || !canPush || comparisonBlocked} title={remoteTitle} onClick={() => setPushOperation("push")}>Push</DockButton>
              <DockButton icon={RefreshCw} disabled={busy} title="Download remote changes without changing your files" onClick={() => void action("fetch")}>Fetch</DockButton>
              <DockButton icon={Download} disabled={busy || !!snapshot.conflicts.length || snapshot.comparison?.related === false} title="Fast-forward to the remote branch" onClick={() => void action("pull")}>Pull</DockButton>
            </div> : null}
            <small className="source-control-footnote">Remote checked: {snapshot.comparison?.checkedAt ? new Date(snapshot.comparison.checkedAt).toLocaleTimeString() : remoteChecked || "Not checked yet"} · Pull is fast-forward only.</small>
            {hasRemote ? <section className="source-control-changes source-control-comparison" aria-label={`Changes vs ${providerName}`}>
              <h3>
                Changes vs {providerName}{" "}
                <span>
                  {snapshot.comparison?.ready
                    ? `${filteredComparisonFiles.length}${filteredComparisonFiles.length !== comparisonFiles.length ? ` of ${comparisonFiles.length}` : ""}`
                    : "—"}
                </span>
              </h3>
              {!snapshot.comparison?.ready ? <p className="source-control-muted" role="status">Checking the selected repository… Use Fetch to retry.</p> : <>
                <small>{remoteName} {snapshot.comparison.repoVersion ? `(v${snapshot.comparison.repoVersion})` : ""} · {snapshot.comparison.branch} → local {snapshot.projectVersion ? `(v${snapshot.projectVersion})` : "commit"}</small>
                {snapshot.comparison.related === false ? <DockNotice>This repository has unrelated history. Check your repository selection before synchronizing.</DockNotice> : null}
                {filteredComparisonFiles.slice(0, remoteFileLimit).map(file => (
                  <div className={`source-control-file status-${fileStatus(file.status, true).type}`} key={file.path}>
                    {statusBadge(file, true)}
                    {fileName({ ...file, originalPath: null }, `Compare ${file.path} with ${providerName}`, () => setSelection({ path: file.path, staged: false, remote: true, status: file.status }))}
                  </div>
                ))}
                {comparisonFiles.length > 0 && filteredComparisonFiles.length === 0 ? (
                  <p className="source-control-muted">No remote comparison files match the selected filter.</p>
                ) : null}
                {filteredComparisonFiles.length > remoteFileLimit ? <DockButton tone="ghost" onClick={() => setRemoteFileLimit(limit => limit + 100)}>Show more files ({filteredComparisonFiles.length - remoteFileLimit} remaining)</DockButton> : null}
                {!comparisonFiles.length ? <p className="source-control-muted">Files in the local commit match the selected remote branch.</p> : null}
              </>}
            </section> : null}

            {allChangesFiles.length > 0 && isFiltered &&
              filteredConflicts.length === 0 &&
              filteredStaged.length === 0 &&
              filteredChanges.length === 0 &&
              filteredComparisonFiles.length === 0 ? (
                <DockState kind="empty" title="No files match the selected filter." action={{ label: "Clear filters", onClick: resetFilters }} />
            ) : null}
          </>}

          {!snapshot.remoteUrl && !hasRemote && project ? <PublishRepositoryPanel key={project} client={client} projectPath={project} providers={visibleProviders} preferred={provider === "local" ? null : provider}
            defaultName={baseName(project)} disabled={busy} onBusyChange={setPublishBusy} onPublished={(publishedPath, published, result, hasCommits) => {
              // A late result for another project must never select that project's new repository here.
              if (publishedPath !== projectRef.current) return;
              if (result.binding?.kind === "provider" && result.binding.repository) {
                providerChosen.current = true;
                const remote = result.binding.repository;
                if (published !== provider) { pendingRepository.current = remote; setProvider(published); }
                else { setRepos(old => old.some(r => r.id === remote.id) ? old : [...old, remote]); setRepository(remote.id, true); }
              }
              if (result.remoteCreated) noticeAfterBind.current = hasCommits ? "Remote created and connected. Existing commits stay local until you choose Push." : "Remote created and connected. Nothing was committed or pushed.";
            }} /> : null}
        </> : null}
      </div>

      {selection ? (
        <SourceControlDiffModal
          title={`${selection.remote ? "Compare" : "Diff"} · ${selection.path}`}
          path={selection.path}
          staged={selection.staged}
          isRemote={selection.remote}
          status={selection.status}
          diff={diff}
          diffError={diffError}
          busy={busy}
          provider={providerName}
          snapshotVersion={snapshot?.version}
          onClose={() => { setSelection(null); setDiff(null); }}
          onStageHunk={(hunkId) => void action(selection.staged ? "unstage" : "stage", { paths: [selection.path], hunkId, expectedVersion: diff?.version })}
          onStageFile={() => void action("stage", { paths: [selection.path] })}
          onUnstageFile={() => void action("unstage", { paths: [selection.path] })}
          onDiscardFile={() => void discardFile(selection.path)}
        />
      ) : null}
      {pushOperation && snapshot ? <Dialog title="Outgoing commits" onClose={() => setPushOperation(null)}>
        <p>{pushOperation === "commit-push" ? `Commit ${snapshot.staged.length} staged file${snapshot.staged.length === 1 ? "" : "s"}, then push these outgoing commits and the new commit.` : `Push all ${snapshot.outgoing.length} outgoing commit${snapshot.outgoing.length === 1 ? "" : "s"}.`}</p>
        <ol>{snapshot.outgoing.map(commit => <li key={commit.id}><code>{commit.id.slice(0, 7)}</code> {commit.message}</li>)}</ol>
        <div className="source-control-dialog-actions">
          <DockButton tone="ghost" onClick={() => setPushOperation(null)}>Cancel</DockButton>
          <DockButton tone="primary" icon={Upload} disabled={busy || !canPush} onClick={() => void action(pushOperation)}>Confirm {pushOperation === "push" ? "Push" : "Commit & Push"}</DockButton>
        </div>
      </Dialog> : null}
      {isSettingsOpen ? (
        <Dialog title="Repository defaults" onClose={() => setIsSettingsOpen(false)}>
          <div className="source-control-defaults-dialog">
            <p className="source-control-defaults-desc">
              Optional default repositories for <strong>{projectLabel}</strong>. A default is selected automatically for its provider; without one you choose the repository each time.
            </p>
            {!visibleProviders.length ? <p className="source-control-muted">Enable a repository provider in Settings → Plugins to configure defaults.</p> : null}
            {visibleProviders.map(state => {
              const ready = providerAvailability(state) === "connected";
              const current = projectDefaults?.defaults?.[state.id];
              const options = [...new Map([...(provider === state.id ? repos : []), ...(allProviderRepos[state.id] ?? []), ...(current?.repository ? [current.repository] : [])].map(r => [r.id, r])).values()];
              return (
                <div className="source-control-defaults-card dock-kit-card" key={state.id}>
                  <div className="source-control-defaults-provider-header">
                    <strong>{state.label}</strong>
                    {ready ? <span className="dock-kit-badge is-success">Connected</span> : <span className="dock-kit-badge is-warning">{providerAvailability(state) === "error" ? "Reconnect required" : "Setup required"}</span>}
                  </div>
                  {ready ? (
                    <div className="source-control-defaults-select-row">
                      <label htmlFor={`workspace-default-${state.id}`}>Default Repository</label>
                      <select id={`workspace-default-${state.id}`} disabled={defaultsLoading} value={current?.repository?.id || ""}
                        onChange={e => void handleSetProviderDefault(state.id, e.target.value || null)}>
                        <option value="">None (choose each time)</option>
                        {options.map(r => <option key={r.id} value={r.id}>{r.fullName}</option>)}
                      </select>
                    </div>
                  ) : (
                    <p className="source-control-muted">Connect {state.label} in Plugins to choose a default repository.</p>
                  )}
                </div>
              );
            })}
          </div>
        </Dialog>
      ) : null}
      {isPickerOpen ? <ProjectSourcePicker context={{ kind: "dock" }} client={client} isAdmin={isAdmin} defaultParent={defaultProjectParent}
        onOpened={openPickerResult} onClose={() => setIsPickerOpen(false)} /> : null}
      {confirmDialog}
    </section>
  </div>;
}
