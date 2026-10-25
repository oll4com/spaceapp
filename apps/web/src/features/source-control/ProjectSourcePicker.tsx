import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, FolderOpen, FolderPlus, Link2, Lock, Search, X } from "../ui-theme/app-icons.js";
import type { GitRemoteRepository, OpenProjectInput, OpenProjectResult, RepositoryProviderId, RepositoryProviderState } from "@space/contracts";
import { SOURCE_CONTROL_CONNECTION_EVENT, sourceControlClient, type SourceControlClient } from "./client.js";
import { ProviderConnectForm } from "./ProviderConnectForm.js";
import { ProviderIcon, availabilityLabel, enabledProviders, providerAvailability, providerLabel } from "./ProviderIcon.js";
import { ServerFolderBrowser } from "./ServerFolderBrowser.js";
import "./repository-providers.css";
import "./project-source-picker.css";

export type ProjectPickerContext = { kind: "room"; roomId: string; roomName: string } | { kind: "dock" };
type View = "home" | "new" | "local" | "git-url" | RepositoryProviderId;
type Item = { id: View; label: string; detail: string; icon: React.ReactNode; state?: RepositoryProviderState };
const folderPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const joinPath = (parent: string, name: string) => `${parent.replace(/\/+$/, "") || ""}/${name}`;
function folderFromUrl(value: string): string {
  try { const last = new URL(value).pathname.split("/").filter(Boolean).pop() ?? ""; return last.replace(/\.git$/, "").replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 100); } catch { return ""; }
}
const isEditable = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

export interface ProjectSourcePickerProps {
  context: ProjectPickerContext;
  defaultParent: string;
  isAdmin: boolean;
  client?: SourceControlClient;
  /** Applies the prepared project to the context that opened the picker. Throwing keeps the result for Retry attachment. */
  onOpened: (result: OpenProjectResult) => Promise<void> | void;
  onClose: () => void;
}

/**
 * One picker for the Source Control dock and a room's Project Directory:
 * New project → Local folder → Git URL → enabled repository providers (alphabetical).
 */
export function ProjectSourcePicker({ context, defaultParent, isAdmin, client = sourceControlClient, onOpened, onClose }: ProjectSourcePickerProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<View>("home");
  const [search, setSearch] = useState("");
  const [active, setActive] = useState(0);
  const [states, setStates] = useState<RepositoryProviderState[] | null>(null);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [parent, setParent] = useState(defaultParent);
  const [newName, setNewName] = useState("");
  const [localPath, setLocalPath] = useState(defaultParent);
  const [gitUrl, setGitUrl] = useState("");
  const [gitFolder, setGitFolder] = useState("");
  const [gitFolderEdited, setGitFolderEdited] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [repoQuery, setRepoQuery] = useState<Partial<Record<RepositoryProviderId, string>>>({});
  const [repoPages, setRepoPages] = useState<Partial<Record<RepositoryProviderId, { data: GitRemoteRepository[]; nextCursor: string | null; nextPage: number | null; query: string }>>>({});
  const [repoLoading, setRepoLoading] = useState(false);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [selectedRepo, setSelectedRepo] = useState<Partial<Record<RepositoryProviderId, GitRemoteRepository>>>({});
  const [repoFolder, setRepoFolder] = useState<Partial<Record<RepositoryProviderId, string>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<OpenProjectResult | null>(null);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  useEffect(() => {
    const previous = document.activeElement;
    const node = dialog.current;
    if (node && typeof node.showModal === "function" && !node.open) node.showModal(); else node?.setAttribute("open", "");
    searchRef.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);

  const loadProviders = useCallback(async (signal?: AbortSignal) => {
    try { const next = await client.providers(signal); if (!signal?.aborted) { setStates(next); setProvidersError(null); } }
    catch (cause) { if (!signal?.aborted) setProvidersError(cause instanceof Error ? cause.message : "Repository providers could not load."); }
  }, [client]);
  useEffect(() => {
    const controller = new AbortController(); void loadProviders(controller.signal);
    const refresh = () => void loadProviders();
    window.addEventListener(SOURCE_CONTROL_CONNECTION_EVENT, refresh);
    return () => { controller.abort(); window.removeEventListener(SOURCE_CONTROL_CONNECTION_EVENT, refresh); };
  }, [loadProviders]);

  const providerItems = useMemo(() => enabledProviders(states ?? []), [states]);
  const items = useMemo<Item[]>(() => {
    const base: Item[] = [
      { id: "new", label: "New project", detail: "Create an empty folder with a Git repository", icon: <FolderPlus size={16} aria-hidden="true" /> },
      { id: "local", label: "Local folder", detail: "Open a folder that already exists on the Space host", icon: <FolderOpen size={16} aria-hidden="true" /> },
      { id: "git-url", label: "Git URL", detail: "Clone an HTTPS repository URL", icon: <Link2 size={16} aria-hidden="true" /> },
      ...providerItems.map(state => ({ id: state.id as View, label: state.label, detail: providerAvailability(state) === "connected" ? `Clone from ${state.connection.accountLogin ?? "your account"}` : providerAvailability(state) === "error" ? state.connection.error || "Saved credentials need attention" : "Connect your account to browse repositories", icon: <ProviderIcon provider={state.id} />, state }))
    ];
    const needle = search.trim().toLowerCase();
    return needle ? base.filter(item => `${item.label} ${item.detail}`.toLowerCase().includes(needle)) : base;
  }, [providerItems, search]);
  useEffect(() => { setActive(index => Math.min(index, Math.max(0, items.length - 1))); }, [items.length]);

  const go = (next: View) => { setView(next); setError(null); setBrowsing(false); setRepoError(null); };
  const back = () => { if (busyRef.current) return; go("home"); requestAnimationFrame(() => searchRef.current?.focus()); };
  const close = () => { if (busyRef.current) return; dialog.current?.close?.(); onClose(); };

  const run = async (label: string, input: OpenProjectInput) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(label); setError(null);
    let result: OpenProjectResult | null = null;
    try {
      result = await client.openProject(input);
      if (mounted.current) setPrepared(result);
      await onOpened(result);
      if (mounted.current) { busyRef.current = false; close(); }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "The project could not be opened.");
    } finally { busyRef.current = false; if (mounted.current) setBusy(null); }
  };
  const retryAttachment = async () => {
    if (!prepared || busyRef.current) return;
    busyRef.current = true; setBusy("Attaching project…"); setError(null);
    try { await onOpened(prepared); busyRef.current = false; close(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The project could not be attached."); }
    finally { busyRef.current = false; if (mounted.current) setBusy(null); }
  };

  const providerState = view !== "home" && view !== "new" && view !== "local" && view !== "git-url" ? (states ?? []).find(state => state.id === view) ?? null : null;
  const provider = providerState?.id ?? null;
  const connected = providerState ? providerAvailability(providerState) === "connected" : false;
  const requestSeq = useRef(0);
  const loadRepositories = useCallback(async (id: RepositoryProviderId, query: string, more: boolean) => {
    const seq = ++requestSeq.current;
    setRepoLoading(true); setRepoError(null);
    try {
      const current = more ? repoPages[id] : undefined;
      const page = await client.listRepositories({ provider: id, query: query || undefined, ...(current?.nextCursor ? { cursor: current.nextCursor } : current?.nextPage ? { page: current.nextPage } : { page: 1 }) });
      // A newer search or provider switch wins; never show a stale page.
      if (!mounted.current || seq !== requestSeq.current) return;
      setRepoPages(pages => {
        const previous = pages[id];
        const data = more && previous ? [...previous.data, ...page.data.filter(repo => !previous.data.some(item => item.id === repo.id))] : page.data;
        return { ...pages, [id]: { data, nextCursor: page.nextCursor, nextPage: page.nextCursor ? null : page.nextPage, query } };
      });
    } catch (cause) { if (mounted.current && seq === requestSeq.current) setRepoError(cause instanceof Error ? cause.message : "Repositories could not load."); }
    finally { if (mounted.current && seq === requestSeq.current) setRepoLoading(false); }
  }, [client, repoPages]);
  const query = provider ? repoQuery[provider] ?? "" : "";
  useEffect(() => {
    if (!provider || !connected) return;
    if (repoPages[provider]?.query === query) return;
    const timer = setTimeout(() => void loadRepositories(provider, query, false), query ? 300 : 0);
    return () => clearTimeout(timer);
  }, [provider, connected, query, repoPages, loadRepositories]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDialogElement>) => {
    if (event.key === "Escape") { event.preventDefault(); close(); return; }
    if (event.key === "Backspace" && view !== "home" && !isEditable(event.target)) { event.preventDefault(); back(); return; }
    if (view !== "home") return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive(index => items.length ? (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length : 0);
    } else if (event.key === "Enter" && items[active] && (event.target === searchRef.current || !isEditable(event.target))) {
      event.preventDefault(); go(items[active]!.id);
    }
  };

  const title = context.kind === "room" ? `Choose project for ${context.roomName}` : "Open project";
  const parentField = (
    <div className="project-picker-location">
      <label>Location<input value={parent} spellCheck={false} onChange={event => setParent(event.target.value)} disabled={!!busy} /></label>
      <button type="button" onClick={() => setBrowsing(value => !value)} aria-expanded={browsing} disabled={!!busy}>{browsing ? "Done" : "Browse…"}</button>
      {browsing ? <ServerFolderBrowser path={parent} admin={isAdmin} onNavigate={setParent} label="Choose a location on the Space host" /> : null}
    </div>
  );
  const status = busy ? <p role="status" className="project-picker-status"><span className="project-picker-spinner" aria-hidden="true" />{busy}</p> : null;
  const failure = error ? <div role="alert" className="project-picker-error">
    <p>{error}</p>
    {prepared ? <><p>The project is ready at <code>{prepared.projectPath}</code>. Nothing will be created or cloned again.</p>
      <button type="button" className="is-primary" onClick={() => void retryAttachment()} disabled={!!busy}>Retry attachment</button></> : null}
  </div> : null;

  return (
    <dialog ref={dialog} className="project-source-picker" aria-label={title} aria-busy={!!busy} onCancel={event => { event.preventDefault(); close(); }} onKeyDown={onKeyDown}>
      <header className="project-picker-header">
        {view !== "home" ? <button type="button" className="project-picker-icon-button" aria-label="Back to project sources" onClick={back} disabled={!!busy}><ArrowLeft size={16} aria-hidden="true" /></button> : null}
        <div><strong>{title}</strong>{context.kind === "dock" ? <small>Adds the project to your Source Control presets. Rooms are not changed.</small> : <small>Running CLI sessions keep their current folder; new tools open in the chosen project.</small>}</div>
        <button type="button" className="project-picker-icon-button" aria-label="Close project picker" onClick={close} disabled={!!busy}><X size={16} aria-hidden="true" /></button>
      </header>

      {view === "home" ? <div className="project-picker-home">
        <label className="project-picker-search"><Search size={14} aria-hidden="true" />
          <input ref={searchRef} aria-label="Search project sources" placeholder="Search sources" value={search} role="combobox" aria-expanded="true" aria-controls="project-source-list"
            aria-activedescendant={items[active] ? `project-source-${items[active]!.id}` : undefined} onChange={event => { setSearch(event.target.value); setActive(0); }} />
        </label>
        <ul id="project-source-list" role="listbox" aria-label="Project sources" className="project-source-list">
          {items.map((item, index) => (
            <li key={item.id} id={`project-source-${item.id}`} role="option" aria-selected={index === active} className={index === active ? "is-active" : undefined}
              data-source-id={item.id} onMouseEnter={() => setActive(index)} onClick={() => go(item.id)}>
              <span className="project-source-icon">{item.icon}</span>
              <span className="project-source-copy"><strong>{item.label}</strong><small>{item.detail}</small></span>
              {item.state ? <span className={`repository-provider-status is-${providerAvailability(item.state)}`}>{availabilityLabel[providerAvailability(item.state)]}</span> : null}
            </li>
          ))}
          {!items.length ? <li className="project-picker-muted" role="presentation">No sources match “{search}”.</li> : null}
        </ul>
        {providersError ? <p role="alert" className="project-picker-error">{providersError}</p> : null}
        {states && !providerItems.length ? <p className="project-picker-muted">Enable GitHub, GitLab, Bitbucket and other repository providers in Settings → Plugins.</p> : null}
        <p className="project-picker-hint"><kbd>↑</kbd><kbd>↓</kbd> choose · <kbd>Enter</kbd> open · <kbd>Esc</kbd> close</p>
      </div> : null}

      {view === "new" ? <form className="project-picker-body" onSubmit={event => { event.preventDefault(); if (folderPattern.test(newName) && parent.trim()) void run("Creating project…", { source: { kind: "new", name: newName }, destination: joinPath(parent.trim(), newName) }); }}>
        <h3>New project</h3>
        <label>Project name<input autoFocus value={newName} spellCheck={false} placeholder="my-project" onChange={event => setNewName(event.target.value)} disabled={!!busy} aria-invalid={!!newName && !folderPattern.test(newName)} /></label>
        {newName && !folderPattern.test(newName) ? <small className="project-picker-error">Use letters, numbers, dots, underscores or hyphens.</small> : null}
        {parentField}
        <small className="project-picker-muted">Creates <code>{newName ? joinPath(parent.trim(), newName) : "…"}</code> and runs <code>git init</code>. Existing folders are never overwritten.</small>
        {status}{failure}
        <div className="project-picker-actions"><button type="submit" className="is-primary" disabled={!!busy || !folderPattern.test(newName) || !parent.trim()}>Create project</button></div>
      </form> : null}

      {view === "local" ? <div className="project-picker-body">
        <h3>Local folder</h3>
        <p className="project-picker-muted">Folders on the machine that runs Space, not on this device. The folder is opened as it is: nothing is initialized or changed.</p>
        <ServerFolderBrowser path={localPath} admin={isAdmin} onNavigate={setLocalPath} />
        {status}{failure}
        <div className="project-picker-actions"><button type="button" className="is-primary" disabled={!!busy || !localPath.trim()} onClick={() => void run("Opening folder…", { source: { kind: "local", path: localPath.trim() } })}>Open this folder</button></div>
      </div> : null}

      {view === "git-url" ? <form className="project-picker-body" onSubmit={event => { event.preventDefault(); if (gitUrl.trim() && folderPattern.test(gitFolder) && parent.trim()) void run("Cloning repository…", { source: { kind: "git-url", url: gitUrl.trim() }, destination: joinPath(parent.trim(), gitFolder) }); }}>
        <h3>Git URL</h3>
        <label>Repository URL<input autoFocus type="url" inputMode="url" value={gitUrl} spellCheck={false} placeholder="https://example.com/team/project.git" disabled={!!busy}
          onChange={event => { setGitUrl(event.target.value); if (!gitFolderEdited) setGitFolder(folderFromUrl(event.target.value)); }} /></label>
        {(() => {
          let match: RepositoryProviderState | undefined;
          try { const origin = new URL(gitUrl.trim()).origin; match = providerItems.find(state => providerAvailability(state) === "connected" && new URL(state.connection.serverUrl).origin === origin); } catch { match = undefined; }
          return <small className="project-picker-muted">{match ? `Uses your connected ${match.label} account for this host only.` : "Public repositories clone without credentials. For a private repository, connect its provider first."}</small>;
        })()}
        <label>Folder name<input value={gitFolder} spellCheck={false} onChange={event => { setGitFolder(event.target.value); setGitFolderEdited(true); }} disabled={!!busy} aria-invalid={!!gitFolder && !folderPattern.test(gitFolder)} /></label>
        {parentField}
        {status}{failure}
        <div className="project-picker-actions"><button type="submit" className="is-primary" disabled={!!busy || !/^https:\/\//i.test(gitUrl.trim()) || !folderPattern.test(gitFolder) || !parent.trim()}>Clone and open</button></div>
      </form> : null}

      {providerState ? <div className="project-picker-body">
        <h3 className="project-picker-provider-title"><ProviderIcon provider={providerState.id} />{providerState.label}</h3>
        {!connected ? <>
          <p className="project-picker-muted">{providerAvailability(providerState) === "error" ? `${providerState.label} needs to be reconnected.` : `Set up ${providerState.label} to browse its repositories.`} Other fields in this picker are kept.</p>
          <ProviderConnectForm key={providerState.id} state={providerState} reconnect={providerAvailability(providerState) === "error"} onConnected={() => loadProviders()} />
        </> : <>
          <label className="project-picker-search"><Search size={14} aria-hidden="true" />
            <input autoFocus aria-label={`Search ${providerState.label} repositories`} placeholder="Search repositories" value={query} spellCheck={false}
              onChange={event => setRepoQuery(current => ({ ...current, [providerState.id]: event.target.value }))} disabled={!!busy} /></label>
          <ul className="project-repository-list" role="listbox" aria-label={`${providerState.label} repositories`} aria-busy={repoLoading}>
            {(repoPages[providerState.id]?.data ?? []).map(repo => {
              const selected = selectedRepo[providerState.id]?.id === repo.id;
              return <li key={repo.id} role="option" aria-selected={selected} className={selected ? "is-active" : undefined} tabIndex={0}
                onClick={() => { setSelectedRepo(current => ({ ...current, [providerState.id]: repo })); setRepoFolder(current => ({ ...current, [providerState.id]: folderFromUrl(repo.cloneUrl) || repo.fullName.split("/").pop() || "" })); }}
                onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); (event.currentTarget as HTMLElement).click(); } }}>
                <span className="project-repository-name">{repo.fullName}</span>
                <span className="project-repository-meta">{repo.private ? <><Lock size={11} aria-hidden="true" />Private</> : "Public"}{repo.permissions.push ? "" : " · Read only"}</span>
              </li>;
            })}
            {repoLoading ? <li className="project-picker-muted" role="presentation">Loading repositories…</li> : null}
            {!repoLoading && repoPages[providerState.id] && !repoPages[providerState.id]!.data.length ? <li className="project-picker-muted" role="presentation">No repositories match.</li> : null}
          </ul>
          {repoError ? <p role="alert" className="project-picker-error">{repoError}</p> : null}
          {repoPages[providerState.id]?.nextCursor || repoPages[providerState.id]?.nextPage ? <button type="button" disabled={repoLoading} onClick={() => void loadRepositories(providerState.id, query, true)}>Load more repositories</button> : null}
          {selectedRepo[providerState.id] ? <form className="project-picker-clone" onSubmit={event => {
            event.preventDefault(); const repo = selectedRepo[providerState.id]!, folder = repoFolder[providerState.id] ?? "";
            if (folderPattern.test(folder) && parent.trim()) void run("Cloning repository…", { source: { kind: "provider", provider: providerState.id, repositoryId: repo.id }, destination: joinPath(parent.trim(), folder) });
          }}>
            <label>Folder name<input value={repoFolder[providerState.id] ?? ""} spellCheck={false} onChange={event => setRepoFolder(current => ({ ...current, [providerState.id]: event.target.value }))} disabled={!!busy} /></label>
            {parentField}
            {status}{failure}
            <div className="project-picker-actions"><button type="submit" className="is-primary" disabled={!!busy || !folderPattern.test(repoFolder[providerState.id] ?? "") || !parent.trim()}>Clone {selectedRepo[providerState.id]!.fullName}</button></div>
          </form> : <>{status}{failure}</>}
        </>}
      </div> : null}
      {view !== "home" && view !== "new" && view !== "local" && view !== "git-url" && !providerState ? <div className="project-picker-body"><p className="project-picker-muted">{providerLabel(view as RepositoryProviderId)} is not enabled.</p></div> : null}
    </dialog>
  );
}
