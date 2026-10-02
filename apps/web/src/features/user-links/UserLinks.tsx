import { ExternalLink, Link as LinkIcon, Music2, Pencil, Plus, Search, Star, Trash2, X } from "../ui-theme/app-icons.js";
import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import type { UserLink, UserLinkCategory, UserLinkOpenMode } from "@space/contracts";
import { api } from "../../api.js";
import { resolveExternalResource } from "../../runtime/SpaceRuntime.js";
import { useAutoDismiss } from "../../use-auto-dismiss.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { useRailPopover } from "../rail-popover.js";
import { useWorkspaceSurface } from "../ui-theme/WorkspaceSurface.js";

export const USER_LINKS_UPDATED_EVENT = "space:user-links-updated";
const STORAGE_KEY_SELECTED_CATEGORY = "space:user-links-selected-category";
const pageSize = 10;

const categoryLabels: Record<UserLinkCategory, string> = {
  GENERAL: "General",
  MUSIC_LIBRARY: "Music library"
};

function getSavedCategory(): UserLinkCategory | "ALL" {
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

export function LinkFavicon({ link }: { link: UserLink }) {
  const embedded = useWorkspaceSurface();
  const [failed, setFailed] = useState(false);
  const source = resolveExternalResource(`${new URL(link.url).origin}/favicon.ico`);
  useEffect(() => setFailed(false), [link.url]);
  // Workspace navigation uses local icons and does not contact bookmarked sites.
  if (embedded) return link.category === "MUSIC_LIBRARY" ? <Music2 aria-hidden="true" /> : <LinkIcon aria-hidden="true" />;
  if (!source || failed) return <LinkIcon aria-hidden="true" />;
  return <img src={source} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

type LinkDraft = { title: string; url: string; description: string; openMode: UserLinkOpenMode; category: UserLinkCategory; isQuick: boolean };
const emptyDraft: LinkDraft = { title: "", url: "", description: "", openMode: "EMBEDDED", category: "GENERAL", isQuick: false };

export function LinksPanel({ onOpen }: { onOpen: (link: UserLink) => void }) {
  const [links, setLinks] = useState<UserLink[]>([]);
  const [query, setQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<UserLinkCategory | "ALL">(getSavedCategory);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<UserLink | "new" | null>(null);
  const [draft, setDraft] = useState<LinkDraft>(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);
  const inspectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastInspectedUrlRef = useRef<string>("");

  useAutoDismiss(error, setError);

  useEffect(() => {
    if (!editing) return;
    const panel = panelRef.current;
    if (!panel) return;
    if (typeof panel.scrollTo === "function") {
      panel.scrollTo({ top: 0, behavior: "smooth" });
    } else {
      panel.scrollTop = 0;
    }
  }, [editing]);

  async function load(nextPage = 1, append = false, category = selectedCategory) {
    setLoading(true);
    setError(null);
    try {
      const result = await api.links({
        q: query || undefined,
        category: category === "ALL" ? undefined : category,
        page: nextPage,
        pageSize
      });
      setLinks((current) => append ? [...current, ...result.data] : result.data);
      setPage(nextPage);
      setTotal(result.pagination.totalItems);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Links could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(1, false, selectedCategory);
  }, []);

  function handleCategoryChange(category: UserLinkCategory | "ALL") {
    setSelectedCategory(category);
    try {
      localStorage.setItem(STORAGE_KEY_SELECTED_CATEGORY, category);
    } catch {}
    void load(1, false, category);
  }

  async function inspectUrl(targetUrl: string, currentCategory: UserLinkCategory) {
    let normalized = targetUrl.trim();
    if (!normalized) return;
    if (!/^https?:\/\//i.test(normalized) && !normalized.includes(".")) return;
    if (!/^https?:\/\//i.test(normalized)) {
      normalized = `https://${normalized}`;
    }
    if (normalized === lastInspectedUrlRef.current) return;
    lastInspectedUrlRef.current = normalized;

    setInspecting(true);
    try {
      const info = await api.inspectLink(normalized);
      let detectedTitle = info.title?.trim() || "";
      if (detectedTitle === "- YouTube" || detectedTitle.toLowerCase() === "youtube" || detectedTitle === "-") {
        detectedTitle = "";
      }
      if (!detectedTitle && (normalized.includes("youtube.com") || normalized.includes("youtu.be"))) {
        try {
          const ytRes = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(normalized)}&format=json`);
          if (ytRes.ok) {
            const ytData = (await ytRes.json()) as { title?: string };
            if (ytData?.title) detectedTitle = ytData.title.trim();
          }
        } catch {}
      }
      if (detectedTitle.endsWith(" - YouTube")) {
        detectedTitle = detectedTitle.slice(0, -" - YouTube".length).trim();
      }

      setDraft((current) => {
        const isGenericTitle =
          !current.title.trim() ||
          current.title === current.url ||
          current.title === "- YouTube" ||
          current.title.toLowerCase() === "youtube" ||
          current.title === "Link";
        const newTitle = isGenericTitle ? (detectedTitle || info.title) : current.title;
        const newOpenMode = currentCategory === "GENERAL" ? info.openMode : (currentCategory === "MUSIC_LIBRARY" ? "EMBEDDED" : current.openMode);
        return {
          ...current,
          url: normalized,
          title: newTitle,
          openMode: newOpenMode
        };
      });
    } catch {
      let clientTitle = "";
      if (normalized.includes("youtube.com") || normalized.includes("youtu.be")) {
        try {
          const ytRes = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(normalized)}&format=json`);
          if (ytRes.ok) {
            const ytData = (await ytRes.json()) as { title?: string };
            if (ytData?.title) clientTitle = ytData.title.trim();
          }
        } catch {}
      }
      if (clientTitle.endsWith(" - YouTube")) {
        clientTitle = clientTitle.slice(0, -" - YouTube".length).trim();
      }
      setDraft((current) => {
        const isGenericTitle =
          !current.title.trim() ||
          current.title === current.url ||
          current.title === "- YouTube" ||
          current.title.toLowerCase() === "youtube" ||
          current.title === "Link";
        if (isGenericTitle) {
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
      openMode: /^http:\/\//i.test(rawUrl) ? "NEW_TAB" : current.openMode
    }));

    if (inspectTimeoutRef.current) clearTimeout(inspectTimeoutRef.current);
    inspectTimeoutRef.current = setTimeout(() => {
      void inspectUrl(rawUrl, draft.category);
    }, 400);
  }

  function handleUrlBlur() {
    if (inspectTimeoutRef.current) clearTimeout(inspectTimeoutRef.current);
    if (draft.url) {
      void inspectUrl(draft.url, draft.category);
    }
  }

  function startAdd() {
    lastInspectedUrlRef.current = "";
    const category: UserLinkCategory = selectedCategory === "MUSIC_LIBRARY" ? "MUSIC_LIBRARY" : "GENERAL";
    setDraft({ ...emptyDraft, category });
    setEditing("new");
  }

  function startEdit(link: UserLink) {
    lastInspectedUrlRef.current = link.url;
    setDraft({
      title: link.title,
      url: link.url,
      description: link.description || "",
      openMode: link.openMode,
      category: link.category,
      isQuick: link.isQuick
    });
    setEditing(link);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      let finalTitle = draft.title.trim();
      let finalUrl = draft.url.trim();
      if (!/^https?:\/\//i.test(finalUrl)) {
        finalUrl = `https://${finalUrl}`;
      }
      let finalOpenMode = draft.category === "MUSIC_LIBRARY" ? "EMBEDDED" : draft.openMode;

      const isGeneric = !finalTitle || finalTitle === "- YouTube" || finalTitle.toLowerCase() === "youtube" || finalTitle === "Link";
      if (isGeneric || (draft.category === "GENERAL" && editing === "new")) {
        try {
          const info = await api.inspectLink(finalUrl);
          if (isGeneric && info.title && info.title !== "- YouTube" && info.title.toLowerCase() !== "youtube") {
            finalTitle = info.title;
          }
          if (draft.category === "GENERAL") finalOpenMode = info.openMode;
        } catch {
          if (isGeneric) {
            try { finalTitle = new URL(finalUrl).hostname; } catch { finalTitle = "Link"; }
          }
        }
      }

      const payload = {
        title: finalTitle || "Link",
        url: finalUrl,
        description: "",
        openMode: finalOpenMode,
        category: draft.category,
        isQuick: draft.isQuick
      };

      if (editing === "new") await api.createLink(payload);
      else if (editing) await api.updateLink(editing.id, payload);
      setEditing(null);
      notifyLinksUpdated();
      await load(1, false, selectedCategory);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Link could not be saved.");
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
      setError(reason instanceof Error ? reason.message : "Quick Link could not be updated.");
    }
  }

  async function remove(link: UserLink) {
    if (!window.confirm(`Delete ${link.title}?`)) return;
    try {
      await api.deleteLink(link.id);
      notifyLinksUpdated();
      await load(1, false, selectedCategory);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Link could not be deleted.");
    }
  }

  return <section ref={panelRef} className="links-panel side-surface-panel" aria-label="Links library">
    <form className="links-search" onSubmit={(event) => { event.preventDefault(); void load(1, false, selectedCategory); }}>
      <Search aria-hidden="true" />
      <input aria-label="Search links" placeholder="Search links" value={query} onChange={(event) => setQuery(event.target.value)} />
      <button type="submit">Search</button>
    </form>

    <div className="links-category-tabs" role="tablist" aria-label="Link type filter">
      <button
        type="button"
        role="tab"
        aria-selected={selectedCategory === "ALL"}
        className={`links-category-tab ${selectedCategory === "ALL" ? "is-active" : ""}`}
        onClick={() => handleCategoryChange("ALL")}
      >
        All
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={selectedCategory === "GENERAL"}
        className={`links-category-tab ${selectedCategory === "GENERAL" ? "is-active" : ""}`}
        onClick={() => handleCategoryChange("GENERAL")}
      >
        General
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={selectedCategory === "MUSIC_LIBRARY"}
        className={`links-category-tab ${selectedCategory === "MUSIC_LIBRARY" ? "is-active" : ""}`}
        onClick={() => handleCategoryChange("MUSIC_LIBRARY")}
      >
        <Music2 aria-hidden="true" /> Music library
      </button>
    </div>

    <button className="links-add" type="button" onClick={startAdd}><Plus aria-hidden="true" /> Add link</button>
    {error ? (
      <p className="links-error" role="alert"><span>{error}</span><button type="button" className="notice-close" aria-label="Dismiss message" onClick={() => setError(null)}><X aria-hidden="true" /></button></p>
    ) : null}
    {editing ? <form className="link-form" aria-label={editing === "new" ? "Add link" : "Edit link"} onSubmit={submit}>
      <header><strong>{editing === "new" ? "Add link" : "Edit link"}</strong><button type="button" aria-label="Close link form" onClick={() => setEditing(null)}><X aria-hidden="true" /></button></header>
      <label>URL
        <input
          required
          type="text"
          maxLength={2048}
          placeholder="https://example.com"
          value={draft.url}
          onChange={(event) => handleUrlChange(event.target.value)}
          onBlur={handleUrlBlur}
          autoFocus
        />
      </label>
      <label className="link-title-label">
        <span>Title {inspecting ? <small className="link-inspecting-hint">(Detecting site…)</small> : null}</span>
        <input
          maxLength={160}
          placeholder={inspecting ? "Reading title from site…" : "Auto-detected from site"}
          value={draft.title}
          onChange={(event) => setDraft({ ...draft, title: event.target.value })}
        />
      </label>
      {editing !== "new" ? (
        <label>Link type
          <select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value as UserLinkCategory })}>
            {(Object.keys(categoryLabels) as UserLinkCategory[]).map((category) => (
              <option key={category} value={category}>{categoryLabels[category]}</option>
            ))}
          </select>
        </label>
      ) : null}
      {draft.category !== "MUSIC_LIBRARY" ? (
        <fieldset><legend>Open link</legend>
          <label><input type="radio" name="open-mode" checked={draft.openMode === "EMBEDDED"} disabled={/^http:\/\//i.test(draft.url)} onChange={() => setDraft({ ...draft, openMode: "EMBEDDED" })} /> Open in Space modal</label>
          <label><input type="radio" name="open-mode" checked={draft.openMode === "NEW_TAB"} onChange={() => setDraft({ ...draft, openMode: "NEW_TAB" })} /> Open in new tab</label>
        </fieldset>
      ) : null}
      <SpaceToggle className="link-check" label="Add to Quick Links" checked={draft.isQuick} onChange={(isQuick) => setDraft({ ...draft, isQuick })} />
      <button type="submit" disabled={saving || inspecting}>{saving ? "Saving…" : inspecting ? "Reading site…" : "Save link"}</button>
    </form> : null}
    {(() => {
      const filteredLinks = selectedCategory === "ALL"
        ? links
        : links.filter((link) => (link.category || "GENERAL") === selectedCategory);
      return <>
        {!loading && filteredLinks.length === 0 ? (
          <p className="links-empty">No {selectedCategory === "ALL" ? "" : `${categoryLabels[selectedCategory].toLowerCase()} `}links found. Add a link or change your filter.</p>
        ) : null}
        <div className="links-list">
          {filteredLinks.map((link) => <article className="link-card" key={link.id}>
            <button className="link-main" type="button" onClick={() => onOpen(link)} aria-label={`Open ${link.title}`}>
              <span className="link-favicon"><LinkFavicon link={link} /></span>
              <strong className="link-title" title={link.title}>{link.title}</strong>
            </button>
            <div className="link-actions">
              <button
                type="button"
                className={`link-quick-toggle ${link.isQuick ? "selected is-quick" : ""}`}
                aria-label={`${link.isQuick ? "Remove" : "Add"} ${link.title} ${link.isQuick ? "from" : "to"} Quick Links`}
                title={link.isQuick ? "Remove from Quick Links" : "Add to Quick Links"}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void toggleQuick(link);
                }}
              >
                <Star aria-hidden="true" fill={link.isQuick ? "currentColor" : "none"} />
              </button>
              <button type="button" aria-label={`Edit ${link.title}`} onClick={() => startEdit(link)}><Pencil aria-hidden="true" /></button>
              <button type="button" aria-label={`Delete ${link.title}`} onClick={() => void remove(link)}><Trash2 aria-hidden="true" /></button>
            </div>
          </article>)}
        </div>
      </>;
    })()}
    {loading ? <p role="status">Loading links…</p> : null}
    {!loading && links.length < total ? <button type="button" onClick={() => void load(page + 1, true, selectedCategory)}>Load more</button> : null}
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
      className="quick-links-popover toolbar-floating-menu"
      role="dialog"
      aria-label="Quick Links"
    >
      <header>
        <strong>Quick Links</strong>
        <button type="button" aria-label="Close Quick Links" onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </header>
      {error ? (
        <p role="alert">
          <span>{error}</span>
          <button type="button" className="notice-close" aria-label="Dismiss message" onClick={() => setError(null)}>
            <X aria-hidden="true" />
          </button>
        </p>
      ) : null}
      {!loading && links.length === 0 ? (
        <p className="links-empty">No Quick Links yet. Star links in Manage Links to add them here.</p>
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
        <button type="button" onClick={() => void load(page + 1, true, true)}>Load more</button>
      ) : null}
      <button
        type="button"
        className="quick-links-manage"
        onClick={() => {
          onManage();
          onClose();
        }}
      >
        Manage Links
      </button>
    </section>
  );
}
