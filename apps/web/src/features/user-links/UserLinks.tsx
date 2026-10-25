import { ExternalLink, Link as LinkIcon, Music2, Pencil, Plus, Star, Trash2, X } from "../ui-theme/app-icons.js";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type RefObject } from "react";
import type { UserLink, UserLinkCategory, UserLinkOpenMode } from "@space/contracts";
import { api } from "../../api.js";
import { resolveExternalResource } from "../../runtime/SpaceRuntime.js";
import { useAutoDismiss } from "../../use-auto-dismiss.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { useRailPopover } from "../rail-popover.js";
import { useWorkspaceSurface } from "../ui-theme/WorkspaceSurface.js";
import { shouldPreserveForSnipTool } from "../snip-tool/snip-guard.js";
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
  useDockFullscreen
} from "../dock-kit/DockKit.js";
import "./user-links.css";

export const USER_LINKS_UPDATED_EVENT = "space:user-links-updated";
const STORAGE_KEY_SELECTED_CATEGORY = "space:user-links-selected-category";
const pageSize = 10;
const SEARCH_DEBOUNCE_MS = 300;

type CategoryFilter = UserLinkCategory | "ALL";

const categoryLabels: Record<UserLinkCategory, string> = {
  GENERAL: "General",
  MUSIC_LIBRARY: "Music library"
};

const categoryFilters: Array<{ id: CategoryFilter; label: string }> = [
  { id: "ALL", label: "All" },
  { id: "GENERAL", label: "General" },
  { id: "MUSIC_LIBRARY", label: "Music library" }
];

function getSavedCategory(): CategoryFilter {
  try {
    const saved = localStorage.getItem(STORAGE_KEY_SELECTED_CATEGORY);
    if (saved === "GENERAL" || saved === "MUSIC_LIBRARY" || saved === "ALL") {
      return saved;
    }
  } catch {}
  return "ALL";
}

function notifyLinksUpdated() {
  window.dispatchEvent(new Event(USER_LINKS_UPDATED_EVENT));
}

function withScheme(url: string): string {
  const trimmed = url.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function isPlainHttp(url: string): boolean {
  return /^http:\/\//i.test(url.trim());
}

function isYouTubeLink(url: string): boolean {
  try {
    const host = new URL(withScheme(url)).hostname.replace(/^www\./, "");
    return host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be";
  } catch {
    return false;
  }
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function isGenericTitle(title: string, url: string): boolean {
  const trimmed = title.trim();
  return !trimmed || trimmed === url || trimmed === "- YouTube" || trimmed.toLowerCase() === "youtube" || trimmed === "Link";
}

function withoutYouTubeSuffix(title: string): string {
  return title.endsWith(" - YouTube") ? title.slice(0, -" - YouTube".length).trim() : title;
}

/** YouTube pages often hide their real title from the server; oEmbed still has it. */
async function readYouTubeTitle(url: string): Promise<string> {
  if (!url.includes("youtube.com") && !url.includes("youtu.be")) return "";
  try {
    const response = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
    if (!response.ok) return "";
    const data = (await response.json()) as { title?: string };
    return data?.title?.trim() ?? "";
  } catch {
    return "";
  }
}

function ExternalLinkFavicon({ source }: { source: string | null }) {
  const [failed, setFailed] = useState(false);
  if (!source || failed) return <LinkIcon aria-hidden="true" />;
  return <img src={source} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

export function LinkFavicon({ link }: { link: UserLink }) {
  const embedded = useWorkspaceSurface();
  // Workspace navigation uses local icons and does not contact bookmarked sites.
  if (embedded) return link.category === "MUSIC_LIBRARY" ? <Music2 aria-hidden="true" /> : <LinkIcon aria-hidden="true" />;
  const source = resolveExternalResource(`${new URL(link.url).origin}/favicon.ico`);
  // A new URL gets a fresh attempt; no mount effect can erase an early load error.
  return <ExternalLinkFavicon key={link.url} source={source} />;
}

type LinkDraft = { title: string; url: string; openMode: UserLinkOpenMode; category: UserLinkCategory; isQuick: boolean };
const emptyDraft: LinkDraft = { title: "", url: "", openMode: "EMBEDDED", category: "GENERAL", isQuick: false };

export function LinksPanel({ onOpen }: { onOpen: (link: UserLink) => void }) {
  const { confirm, confirmDialog } = useDockConfirm();
  const [isFullscreen, setIsFullscreen] = useDockFullscreen();
  const [links, setLinks] = useState<UserLink[]>([]);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<CategoryFilter>(getSavedCategory);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<UserLink | "new" | null>(null);
  const [draft, setDraft] = useState<LinkDraft>(emptyDraft);
  const [embedBlockedUrl, setEmbedBlockedUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const editorRef = useRef<HTMLFormElement | null>(null);
  const inspectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastInspectedUrlRef = useRef<string>("");
  const loadRequestRef = useRef(0);
  // Until the user picks how a link opens, the site check suggests it.
  const openModeChosenRef = useRef(false);
  const openModeLabelId = useId();

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => () => {
    if (inspectTimeoutRef.current) clearTimeout(inspectTimeoutRef.current);
  }, []);

  useEffect(() => {
    if (!editing) return;
    editorRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [editing]);

  const load = useCallback(async (nextPage = 1, append = false) => {
    const requestId = ++loadRequestRef.current;
    if (append) setLoadingMore(true);
    try {
      // The server filters by search and link type; the list shows its result as is.
      const result = await api.links({
        q: debouncedQuery.trim() || undefined,
        category: selectedCategory === "ALL" ? undefined : selectedCategory,
        page: nextPage,
        pageSize
      });
      if (requestId !== loadRequestRef.current) return;
      setLinks((current) => append ? [...current, ...result.data] : result.data);
      setPage(nextPage);
      setTotal(result.pagination.totalItems);
      setLoadError(null);
    } catch (reason) {
      if (requestId !== loadRequestRef.current) return;
      setLoadError(reason instanceof Error && reason.message ? reason.message : "Links could not be loaded.");
    } finally {
      if (requestId === loadRequestRef.current) {
        setHasLoaded(true);
        setLoadingMore(false);
      }
    }
  }, [debouncedQuery, selectedCategory]);

  useEffect(() => {
    void load(1, false);
  }, [load]);

  function handleCategoryChange(category: CategoryFilter) {
    setSelectedCategory(category);
    try {
      localStorage.setItem(STORAGE_KEY_SELECTED_CATEGORY, category);
    } catch {}
  }

  async function inspectUrl(targetUrl: string, currentCategory: UserLinkCategory) {
    const trimmed = targetUrl.trim();
    if (!trimmed) return;
    if (!/^https?:\/\//i.test(trimmed) && !trimmed.includes(".")) return;
    const normalized = withScheme(trimmed);
    if (normalized === lastInspectedUrlRef.current) return;
    lastInspectedUrlRef.current = normalized;

    setInspecting(true);
    try {
      const info = await api.inspectLink(normalized);
      let detectedTitle = info.title?.trim() || "";
      if (detectedTitle === "- YouTube" || detectedTitle.toLowerCase() === "youtube" || detectedTitle === "-") {
        detectedTitle = "";
      }
      if (!detectedTitle) detectedTitle = await readYouTubeTitle(normalized);
      detectedTitle = withoutYouTubeSuffix(detectedTitle);
      const blocked = currentCategory === "GENERAL" && info.openMode === "NEW_TAB";
      setEmbedBlockedUrl(blocked ? normalized : null);

      setDraft((current) => {
        // The user kept typing; the next check handles the new address.
        if (current.url.trim() !== trimmed && current.url.trim() !== normalized) return current;
        const title = isGenericTitle(current.title, current.url) ? (detectedTitle || info.title) : current.title;
        const openMode = currentCategory === "MUSIC_LIBRARY"
          ? "EMBEDDED"
          : blocked ? "NEW_TAB" : openModeChosenRef.current ? current.openMode : info.openMode;
        return { ...current, url: normalized, title, openMode };
      });
    } catch {
      const clientTitle = withoutYouTubeSuffix(await readYouTubeTitle(normalized));
      setDraft((current) => {
        if (current.url.trim() !== trimmed && current.url.trim() !== normalized) return current;
        if (isGenericTitle(current.title, current.url)) {
          try {
            return { ...current, url: normalized, title: clientTitle || new URL(normalized).hostname };
          } catch {}
        }
        return { ...current, url: normalized };
      });
    } finally {
      setInspecting(false);
    }
  }

  function handleUrlChange(rawUrl: string) {
    setDraft((current) => ({
      ...current,
      url: rawUrl,
      openMode: isPlainHttp(rawUrl) ? "NEW_TAB" : current.openMode
    }));

    if (inspectTimeoutRef.current) clearTimeout(inspectTimeoutRef.current);
    const category = draft.category;
    inspectTimeoutRef.current = setTimeout(() => {
      void inspectUrl(rawUrl, category);
    }, 400);
  }

  function handleUrlBlur() {
    if (inspectTimeoutRef.current) clearTimeout(inspectTimeoutRef.current);
    if (draft.url) {
      void inspectUrl(draft.url, draft.category);
    }
  }

  function closeEditor() {
    if (inspectTimeoutRef.current) clearTimeout(inspectTimeoutRef.current);
    setEditing(null);
    setInspecting(false);
  }

  function startAdd() {
    lastInspectedUrlRef.current = "";
    const category: UserLinkCategory = selectedCategory === "MUSIC_LIBRARY" ? "MUSIC_LIBRARY" : "GENERAL";
    setDraft({ ...emptyDraft, category });
    openModeChosenRef.current = false;
    setEmbedBlockedUrl(null);
    setNotice(null);
    setEditing("new");
  }

  function startEdit(link: UserLink) {
    lastInspectedUrlRef.current = link.url;
    setDraft({
      title: link.title,
      url: link.url,
      openMode: link.openMode,
      category: link.category,
      isQuick: link.isQuick
    });
    openModeChosenRef.current = true;
    setEmbedBlockedUrl(null);
    setNotice(null);
    setEditing(link);
  }

  const draftUrl = draft.url.trim() ? withScheme(draft.url) : "";
  const draftIsHttp = isPlainHttp(draft.url);
  const draftIsYouTube = Boolean(draftUrl) && isYouTubeLink(draftUrl);
  const draftEmbedBlocked = Boolean(draftUrl) && embedBlockedUrl === draftUrl;
  const forcedNewTab = draft.category === "GENERAL" && (draftIsHttp || draftEmbedBlocked);
  const effectiveOpenMode: UserLinkOpenMode = draft.category === "MUSIC_LIBRARY" ? "EMBEDDED" : forcedNewTab ? "NEW_TAB" : draft.openMode;

  function chooseOpenMode(openMode: UserLinkOpenMode) {
    openModeChosenRef.current = true;
    setDraft((current) => ({ ...current, openMode }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!editing || !draft.url.trim()) return;
    if (inspectTimeoutRef.current) clearTimeout(inspectTimeoutRef.current);
    setSaving(true);
    setError(null);
    try {
      let finalTitle = draft.title.trim();
      const finalUrl = withScheme(draft.url);
      let finalOpenMode: UserLinkOpenMode = draft.category === "MUSIC_LIBRARY" ? "EMBEDDED" : isPlainHttp(finalUrl) ? "NEW_TAB" : effectiveOpenMode;

      const isGeneric = isGenericTitle(finalTitle, finalUrl);
      if (isGeneric || (draft.category === "GENERAL" && editing === "new")) {
        try {
          const info = await api.inspectLink(finalUrl);
          if (isGeneric && info.title && info.title !== "- YouTube" && info.title.toLowerCase() !== "youtube") {
            finalTitle = info.title;
          }
          // A site that refuses to be shown inside Space always opens in a new tab;
          // otherwise the user's choice wins over the suggestion.
          if (draft.category === "GENERAL" && (info.openMode === "NEW_TAB" || !openModeChosenRef.current)) finalOpenMode = info.openMode;
        } catch {
          if (isGeneric) {
            try { finalTitle = new URL(finalUrl).hostname; } catch { finalTitle = "Link"; }
          }
        }
      }

      // The API accepts plain HTTP links only when they open in a new tab.
      if (isPlainHttp(finalUrl)) finalOpenMode = "NEW_TAB";

      const payload = {
        title: finalTitle || "Link",
        url: finalUrl,
        openMode: finalOpenMode,
        category: draft.category,
        isQuick: draft.isQuick
      };

      // The form does not edit descriptions, so an edit leaves the saved one untouched.
      if (editing === "new") await api.createLink({ ...payload, description: "" });
      else await api.updateLink(editing.id, payload);
      closeEditor();
      if (selectedCategory !== "ALL" && selectedCategory !== draft.category) {
        setNotice(`Saved to ${categoryLabels[draft.category]}. Choose All or ${categoryLabels[draft.category]} to see it.`);
      }
      notifyLinksUpdated();
      await load(1, false);
    } catch (reason) {
      setError(reason instanceof Error && reason.message ? reason.message : "The link could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleQuick(link: UserLink) {
    const nextQuick = !link.isQuick;
    setLinks((current) => current.map((item) => item.id === link.id ? { ...item, isQuick: nextQuick } : item));
    try {
      await api.updateLink(link.id, { isQuick: nextQuick });
      notifyLinksUpdated();
    } catch (reason) {
      setLinks((current) => current.map((item) => item.id === link.id ? { ...item, isQuick: link.isQuick } : item));
      setError(reason instanceof Error && reason.message ? reason.message : "Quick Links could not be updated.");
    }
  }

  async function remove(link: UserLink) {
    if (!await confirm({ title: "Delete this link?", message: `"${link.title}" will be removed from your links.`, confirmLabel: "Delete" })) return;
    try {
      await api.deleteLink(link.id);
      if (editing !== "new" && editing?.id === link.id) closeEditor();
      notifyLinksUpdated();
      await load(1, false);
    } catch (reason) {
      setError(reason instanceof Error && reason.message ? reason.message : "The link could not be deleted.");
    }
  }

  const isSearching = Boolean(debouncedQuery.trim());
  const formLabel = editing === "new" ? "Add link" : "Edit link";

  function emptyState() {
    if (!hasLoaded) return <DockState kind="loading" title="Loading links…" />;
    if (loadError) {
      return <DockState kind="error" title="Links could not be loaded" detail={loadError} action={{ label: "Try again", onClick: () => void load(1, false) }} />;
    }
    if (isSearching) {
      return <DockState kind="empty" icon={LinkIcon} title="No links match this search." detail="Try other words, or choose All to search every link." />;
    }
    if (selectedCategory !== "ALL") {
      return <DockState kind="empty" icon={selectedCategory === "MUSIC_LIBRARY" ? Music2 : LinkIcon}
        title={`No ${categoryLabels[selectedCategory].toLowerCase()} links yet`}
        detail="Add one, or choose All to see every link." />;
    }
    return <DockState kind="empty" icon={LinkIcon} title="No links yet"
      detail="Save the sites you use often. Star a link to show it in Quick Links."
      action={{ label: "Add your first link", icon: Plus, onClick: startAdd }} />;
  }

  return <section className="links-panel side-surface-panel" aria-label="Links library">
    <div className={`links-dock-shell dock-kit-shell${isFullscreen ? " is-fullscreen" : ""}`}>
      <div className="links-dock dock-kit-dock">
        <DockToolbar
          title={isFullscreen ? "Links" : undefined}
          summary={hasLoaded ? <><strong>{total.toLocaleString()}</strong> {isSearching ? "matching " : ""}link{total === 1 ? "" : "s"}{selectedCategory !== "ALL" ? ` · ${categoryLabels[selectedCategory]}` : ""}</> : null}
        >
          <DockIconButton label="Add link" icon={Plus} tone="primary" aria-expanded={editing === "new"} onClick={startAdd} />
          <DockFullscreenButton name="links" active={isFullscreen} onToggle={() => setIsFullscreen((value) => !value)} />
        </DockToolbar>

        <div className="dock-kit-controls">
          <DockSearch name="links-search" label="Search links" value={query} onChange={setQuery} />
          <DockChips label="Filter by link type" options={categoryFilters} value={selectedCategory} onChange={handleCategoryChange} />
        </div>

        {editing ? (
          <form ref={editorRef} className="links-editor dock-kit-editor" aria-label={formLabel} onSubmit={submit}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.stopPropagation();
              closeEditor();
            }}>
            <strong className="dock-kit-section-title">{formLabel}</strong>
            <label className="links-field">
              <span className="links-field-label">URL</span>
              <input
                className="dock-kit-field"
                required
                type="text"
                inputMode="url"
                maxLength={2048}
                placeholder="https://example.com"
                value={draft.url}
                onChange={(event) => handleUrlChange(event.target.value)}
                onBlur={handleUrlBlur}
                autoFocus
              />
            </label>
            <label className="links-field">
              <span className="links-field-label">Title</span>
              <input
                className="dock-kit-field"
                maxLength={160}
                placeholder={inspecting ? "Reading title from site…" : "Auto-detected from site"}
                value={draft.title}
                onChange={(event) => {
                  const title = event.target.value;
                  setDraft((current) => ({ ...current, title }));
                }}
              />
            </label>
            {inspecting ? <small className="links-field-hint" role="status">Reading the page title…</small> : null}
            <label className="links-field">
              <span className="links-field-label">Link type</span>
              <select className="dock-kit-select" value={draft.category}
                onChange={(event) => {
                  const category = event.target.value as UserLinkCategory;
                  setDraft((current) => ({ ...current, category }));
                }}>
                {(Object.keys(categoryLabels) as UserLinkCategory[]).map((category) => (
                  <option key={category} value={category}>{categoryLabels[category]}</option>
                ))}
              </select>
            </label>
            {draft.category === "MUSIC_LIBRARY" ? (
              <small className="links-field-hint">Music links always play inside Space.</small>
            ) : draftIsYouTube ? (
              <small className="links-field-hint">YouTube links play in a YouTube pane inside Space.</small>
            ) : (
              <div className="links-field">
                <span className="links-field-label" id={openModeLabelId}>Opens in</span>
                <div className="dock-kit-chips" role="group" aria-labelledby={openModeLabelId}>
                  <button type="button" className="dock-kit-chip" aria-pressed={effectiveOpenMode === "EMBEDDED"} disabled={forcedNewTab}
                    onClick={() => chooseOpenMode("EMBEDDED")}>Inside Space</button>
                  <button type="button" className="dock-kit-chip" aria-pressed={effectiveOpenMode === "NEW_TAB"}
                    onClick={() => chooseOpenMode("NEW_TAB")}>New browser tab</button>
                </div>
                {draftIsHttp ? (
                  <small className="links-field-hint">Plain HTTP pages cannot be shown inside Space, so this link opens in a new browser tab.</small>
                ) : draftEmbedBlocked ? (
                  <small className="links-field-hint">This site does not allow being shown inside Space, so it opens in a new browser tab.</small>
                ) : null}
              </div>
            )}
            <SpaceToggle className="links-quick-switch" label="Add to Quick Links" checked={draft.isQuick} onChange={(isQuick) => setDraft((current) => ({ ...current, isQuick }))} />
            <div className="dock-kit-editor-footer">
              <DockButton tone="ghost" onClick={closeEditor}>Cancel</DockButton>
              <DockButton type="submit" tone="primary" busy={saving} disabled={saving || inspecting || !draft.url.trim()}>Save link</DockButton>
            </div>
          </form>
        ) : null}

        {error ? <DockNotice onDismiss={() => setError(null)}>{error}</DockNotice> : null}
        {notice ? <DockNotice tone="success" onDismiss={() => setNotice(null)}>{notice}</DockNotice> : null}
        {loadError && links.length ? <DockNotice onDismiss={() => setLoadError(null)}>{loadError}</DockNotice> : null}

        {!links.length ? emptyState() : null}

        <div className="links-list dock-kit-list" role="list" aria-label="Saved links" hidden={!links.length}>
          {links.map((link) => {
            const youTube = isYouTubeLink(link.url);
            return <article className="links-item dock-kit-card" role="listitem" key={link.id}>
              <button className="links-item-open" type="button" onClick={() => onOpen(link)} aria-label={`Open ${link.title}`} title={link.url}>
                <span className="link-favicon"><LinkFavicon link={link} /></span>
                <span className="links-item-text">
                  <span className="dock-kit-card-title" data-sensitive-masked="manual">{link.title}</span>
                  <span className="dock-kit-meta">
                    <span className="dock-kit-meta-text">{hostnameOf(link.url)}</span>
                    {link.category === "MUSIC_LIBRARY" ? <span className="dock-kit-badge is-accent">Music</span> : null}
                    {youTube && link.category !== "MUSIC_LIBRARY" ? <span className="dock-kit-badge">YouTube</span> : null}
                    {!youTube && link.openMode === "NEW_TAB" ? <span className="dock-kit-badge">New tab</span> : null}
                  </span>
                </span>
              </button>
              <div className="dock-kit-card-actions">
                <DockIconButton
                  className="links-star"
                  icon={Star}
                  aria-pressed={link.isQuick}
                  label={`${link.isQuick ? "Remove" : "Add"} ${link.title} ${link.isQuick ? "from" : "to"} Quick Links`}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void toggleQuick(link);
                  }}
                />
                <DockIconButton label={`Edit ${link.title}`} icon={Pencil} onClick={() => startEdit(link)} />
                <DockIconButton label={`Delete ${link.title}`} icon={Trash2} tone="danger" onClick={() => void remove(link)} />
              </div>
            </article>;
          })}
        </div>

        {links.length < total && links.length ? (
          <DockButton className="links-load-more" busy={loadingMore} disabled={loadingMore} onClick={() => void load(page + 1, true)}>
            Load more
          </DockButton>
        ) : null}
      </div>
    </div>
    {confirmDialog}
  </section>;
}

export interface QuickLinksCache {
  data: UserLink[];
  total: number;
  timestamp: number;
}

const STORAGE_KEY_QUICK_LINKS_CACHE = "space:quick-links-cache";
let memoryQuickLinksCache: QuickLinksCache | null = null;
let activePreloadPromise: Promise<QuickLinksCache | null> | null = null;

export function resetQuickLinksCache(): void {
  memoryQuickLinksCache = null;
  activePreloadPromise = null;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(STORAGE_KEY_QUICK_LINKS_CACHE);
    }
  } catch {}
}

export function readQuickLinksCache(): QuickLinksCache | null {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY_QUICK_LINKS_CACHE) : null;
    if (!raw) {
      memoryQuickLinksCache = null;
      return null;
    }
    if (memoryQuickLinksCache) return memoryQuickLinksCache;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.data)) {
      memoryQuickLinksCache = parsed;
      return parsed;
    }
  } catch {
    memoryQuickLinksCache = null;
  }
  return null;
}

export function writeQuickLinksCache(data: UserLink[], total: number): QuickLinksCache {
  const cache: QuickLinksCache = { data, total, timestamp: Date.now() };
  memoryQuickLinksCache = cache;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY_QUICK_LINKS_CACHE, JSON.stringify(cache));
    }
  } catch {}
  return cache;
}

export async function preloadQuickLinks(force = false): Promise<QuickLinksCache | null> {
  if (activePreloadPromise && !force) return activePreloadPromise;
  activePreloadPromise = (async () => {
    try {
      const result = await api.links({ isQuick: true, page: 1, pageSize });
      return writeQuickLinksCache(result.data, result.pagination.totalItems);
    } catch {
      return memoryQuickLinksCache;
    } finally {
      activePreloadPromise = null;
    }
  })();
  return activePreloadPromise;
}

export function QuickLinksPopover({
  open,
  triggerRef,
  onClose,
  onOpen,
  onManage
}: {
  open: boolean;
  triggerRef?: RefObject<HTMLButtonElement | null> | null;
  onClose: () => void;
  onOpen: (link: UserLink) => void;
  onManage: () => void;
}) {
  const ref = useRef<HTMLElement | null>(null);
  useRailPopover(ref, triggerRef ?? { current: null });

  const initialCache = readQuickLinksCache();
  const [links, setLinks] = useState<UserLink[]>(() => initialCache?.data ?? []);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(() => initialCache?.total ?? initialCache?.data.length ?? 0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useAutoDismiss(error, setError);

  const applyCache = (cache: QuickLinksCache | null) => {
    if (cache) {
      setLinks(cache.data);
      setTotal(cache.total);
    }
  };

  async function load(nextPage = 1, append = false, showLoading = true) {
    if (showLoading) setLoading(true);
    setError(null);
    try {
      const result = await api.links({ isQuick: true, page: nextPage, pageSize });
      setLinks((current) => {
        const next = append ? [...current, ...result.data] : result.data;
        if (!append) writeQuickLinksCache(next, result.pagination.totalItems);
        return next;
      });
      setPage(nextPage);
      setTotal(result.pagination.totalItems);
    } catch (reason) {
      if (showLoading || links.length === 0) {
        setError(reason instanceof Error ? reason.message : "Quick Links could not be loaded.");
      }
    } finally {
      if (showLoading) setLoading(false);
    }
  }

  useEffect(() => {
    if (!open && !readQuickLinksCache()) {
      void preloadQuickLinks().then(applyCache);
    }
    const onLinksUpdated = () => {
      void preloadQuickLinks(true).then(applyCache);
    };
    window.addEventListener(USER_LINKS_UPDATED_EVENT, onLinksUpdated);
    return () => {
      window.removeEventListener(USER_LINKS_UPDATED_EVENT, onLinksUpdated);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const cache = readQuickLinksCache();
    if (cache) {
      applyCache(cache);
      void load(1, false, false);
    } else {
      void load(1, false, true);
    }

    const dismiss = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    const handleOutside = (event: PointerEvent) => {
      if (shouldPreserveForSnipTool(event)) return;
      const target = event.target as Node;
      if (ref.current?.contains(target)) return;
      if (triggerRef?.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener("keydown", dismiss);
    document.addEventListener("pointerdown", handleOutside, true);
    return () => {
      window.removeEventListener("keydown", dismiss);
      document.removeEventListener("pointerdown", handleOutside, true);
    };
  }, [open]);

  if (!open) return null;

  return (
    <section
      ref={ref}
      id="quick-links-popover"
      className="quick-links-popover toolbar-floating-menu dock-kit-scope"
      role="dialog"
      aria-label="Quick Links"
    >
      <header>
        <strong>Quick Links</strong>
        <button type="button" aria-label="Close Quick Links" onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </header>
      {error ? <DockNotice onDismiss={() => setError(null)}>{error}</DockNotice> : null}
      {!loading && links.length === 0 ? (
        <DockState kind="empty" icon={Star} className="quick-links-empty" title="No Quick Links yet"
          detail="Star links in Manage Links to add them here." />
      ) : null}
      <div className="quick-links-list">
        {links.map((link) => (
          <button
            type="button"
            key={link.id}
            onClick={() => {
              onOpen(link);
              onClose();
            }}
          >
            <span className="link-favicon"><LinkFavicon link={link} /></span>
            <span><strong>{link.title}</strong></span>
            <ExternalLink aria-hidden="true" />
          </button>
        ))}
      </div>
      {links.length < total ? (
        <DockButton busy={loading} disabled={loading} onClick={() => void load(page + 1, true, true)}>Load more</DockButton>
      ) : null}
      <DockButton
        className="quick-links-manage"
        onClick={() => {
          onManage();
          onClose();
        }}
      >
        Manage Links
      </DockButton>
    </section>
  );
}
