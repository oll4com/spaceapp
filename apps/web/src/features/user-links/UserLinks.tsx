import { ExternalLink, Link as LinkIcon, Music2, Pencil, Plus, Search, Star, Trash2, X } from "../ui-theme/app-icons.js";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { UserLink, UserLinkCategory, UserLinkOpenMode } from "@space/contracts";
import { api } from "../../api.js";
import { resolveExternalResource } from "../../runtime/SpaceRuntime.js";
import { useAutoDismiss } from "../../use-auto-dismiss.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";

export const USER_LINKS_UPDATED_EVENT = "space:user-links-updated";
const pageSize = 10;

const categoryLabels: Record<UserLinkCategory, string> = {
  GENERAL: "General",
  MUSIC_LIBRARY: "Music library"
};

function notifyLinksUpdated() {
  window.dispatchEvent(new Event(USER_LINKS_UPDATED_EVENT));
}

export function LinkFavicon({ link }: { link: UserLink }) {
  const [failed, setFailed] = useState(false);
  const source = resolveExternalResource(`${new URL(link.url).origin}/favicon.ico`);
  useEffect(() => setFailed(false), [link.url]);
  if (!source || failed) return <LinkIcon aria-hidden="true" />;
  return <img src={source} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

type LinkDraft = { title: string; url: string; description: string; openMode: UserLinkOpenMode; category: UserLinkCategory; isQuick: boolean };
const emptyDraft: LinkDraft = { title: "", url: "", description: "", openMode: "EMBEDDED", category: "GENERAL", isQuick: false };

export function LinksPanel({ onOpen }: { onOpen: (link: UserLink) => void }) {
  const [links, setLinks] = useState<UserLink[]>([]);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<UserLink | "new" | null>(null);
  const [draft, setDraft] = useState<LinkDraft>(emptyDraft);
  const [saving, setSaving] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);

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

  async function load(nextPage = 1, append = false) {
    setLoading(true);
    setError(null);
    try {
      const result = await api.links({ q: query || undefined, page: nextPage, pageSize });
      setLinks((current) => append ? [...current, ...result.data] : result.data);
      setPage(nextPage);
      setTotal(result.pagination.totalItems);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Links could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  function startAdd() {
    setDraft(emptyDraft);
    setEditing("new");
  }

  function startEdit(link: UserLink) {
    setDraft({ title: link.title, url: link.url, description: link.description, openMode: link.openMode, category: link.category, isQuick: link.isQuick });
    setEditing(link);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (editing === "new") await api.createLink(draft);
      else if (editing) await api.updateLink(editing.id, draft);
      setEditing(null);
      notifyLinksUpdated();
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Link could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleQuick(link: UserLink) {
    try {
      await api.updateLink(link.id, { isQuick: !link.isQuick });
      setLinks((current) => current.map((item) => item.id === link.id ? { ...item, isQuick: !item.isQuick } : item));
      notifyLinksUpdated();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Quick Link could not be updated.");
    }
  }

  async function remove(link: UserLink) {
    if (!window.confirm(`Delete ${link.title}?`)) return;
    try {
      await api.deleteLink(link.id);
      notifyLinksUpdated();
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Link could not be deleted.");
    }
  }

  return <section ref={panelRef} className="links-panel side-surface-panel" aria-label="Links library">
    <form className="links-search" onSubmit={(event) => { event.preventDefault(); void load(); }}>
      <Search aria-hidden="true" />
      <input aria-label="Search links" placeholder="Search links" value={query} onChange={(event) => setQuery(event.target.value)} />
      <button type="submit">Search</button>
    </form>
    <button className="links-add" type="button" onClick={startAdd}><Plus aria-hidden="true" /> Add link</button>
    {error ? (
      <p className="links-error" role="alert"><span>{error}</span><button type="button" className="notice-close" aria-label="Dismiss message" onClick={() => setError(null)}><X aria-hidden="true" /></button></p>
    ) : null}
    {editing ? <form className="link-form" aria-label={editing === "new" ? "Add link" : "Edit link"} onSubmit={submit}>
      <header><strong>{editing === "new" ? "Add link" : "Edit link"}</strong><button type="button" aria-label="Close link form" onClick={() => setEditing(null)}><X aria-hidden="true" /></button></header>
      <label>Title<input required maxLength={160} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
      <label>URL<input required type="url" maxLength={2048} value={draft.url} onChange={(event) => {
        const url = event.target.value;
        setDraft({ ...draft, url, openMode: /^http:\/\//i.test(url) ? "NEW_TAB" : draft.openMode });
      }} /></label>
      <label>Description<textarea maxLength={1000} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
      <label>Link type<select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value as UserLinkCategory })}>
        {(Object.keys(categoryLabels) as UserLinkCategory[]).map((category) => <option key={category} value={category}>{categoryLabels[category]}</option>)}
      </select></label>
      <fieldset><legend>Open link</legend>
        <label><input type="radio" name="open-mode" checked={draft.openMode === "EMBEDDED"} disabled={/^http:\/\//i.test(draft.url)} onChange={() => setDraft({ ...draft, openMode: "EMBEDDED" })} /> Open in Space modal</label>
        <label><input type="radio" name="open-mode" checked={draft.openMode === "NEW_TAB"} onChange={() => setDraft({ ...draft, openMode: "NEW_TAB" })} /> Open in new tab</label>
      </fieldset>
      <SpaceToggle className="link-check" label="Add to Quick Links" checked={draft.isQuick} onChange={(isQuick) => setDraft({ ...draft, isQuick })} />
      <button type="submit" disabled={saving}>{saving ? "Saving…" : "Save link"}</button>
    </form> : null}
    {!loading && links.length === 0 ? <p className="links-empty">No links found. Add a link or change your search.</p> : null}
    <div className="links-list">
      {links.map((link) => <article className="link-card" key={link.id}>
        <button className="link-main" type="button" onClick={() => onOpen(link)} aria-label={`Open ${link.title}`}>
          <span className="link-favicon"><LinkFavicon link={link} /></span><span><strong>{link.title}</strong>{link.description ? <small>{link.description}</small> : null}<em>{new URL(link.url).hostname}</em>{link.category === "MUSIC_LIBRARY" ? <small className="link-category-badge"><Music2 aria-hidden="true" />{categoryLabels.MUSIC_LIBRARY}</small> : null}</span>
        </button>
        <div className="link-actions">
          <button type="button" className={link.isQuick ? "selected" : ""} aria-label={`${link.isQuick ? "Remove" : "Add"} ${link.title} ${link.isQuick ? "from" : "to"} Quick Links`} title="Toggle Quick Link" onClick={() => void toggleQuick(link)}><Star aria-hidden="true" /></button>
          <button type="button" aria-label={`Edit ${link.title}`} onClick={() => startEdit(link)}><Pencil aria-hidden="true" /></button>
          <button type="button" aria-label={`Delete ${link.title}`} onClick={() => void remove(link)}><Trash2 aria-hidden="true" /></button>
        </div>
      </article>)}
    </div>
    {loading ? <p role="status">Loading links…</p> : null}
    {!loading && links.length < total ? <button type="button" onClick={() => void load(page + 1, true)}>Load more</button> : null}
  </section>;
}

export function QuickLinksPopover({ open, onClose, onOpen, onManage }: { open: boolean; onClose: () => void; onOpen: (link: UserLink) => void; onManage: () => void }) {
  const ref = useRef<HTMLElement | null>(null);
  const [links, setLinks] = useState<UserLink[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useAutoDismiss(error, setError);

  async function load(nextPage = 1, append = false) {
    setLoading(true); setError(null);
    try {
      const result = await api.links({ isQuick: true, page: nextPage, pageSize });
      setLinks((current) => append ? [...current, ...result.data] : result.data);
      setPage(nextPage); setTotal(result.pagination.totalItems);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Quick Links could not be loaded."); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    if (!open) return;
    void load();
    const refresh = () => { void load(); };
    const dismiss = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener(USER_LINKS_UPDATED_EVENT, refresh);
    window.addEventListener("keydown", dismiss);
    return () => { window.removeEventListener(USER_LINKS_UPDATED_EVENT, refresh); window.removeEventListener("keydown", dismiss); };
  }, [open]);
  if (!open) return null;
  return <section ref={ref} className="quick-links-popover" role="dialog" aria-label="Quick Links">
    <header><strong>Quick Links</strong><button type="button" aria-label="Close Quick Links" onClick={onClose}><X aria-hidden="true" /></button></header>
    {error ? (
      <p role="alert"><span>{error}</span><button type="button" className="notice-close" aria-label="Dismiss message" onClick={() => setError(null)}><X aria-hidden="true" /></button></p>
    ) : null}
    {!loading && links.length === 0 ? <p className="links-empty">No Quick Links yet. Star links in Manage Links to add them here.</p> : null}
    <div className="quick-links-list">{links.map((link) => <button type="button" key={link.id} onClick={() => onOpen(link)}>
      <span className="link-favicon"><LinkFavicon link={link} /></span><span><strong>{link.title}</strong>{link.description ? <small>{link.description}</small> : null}</span><ExternalLink aria-hidden="true" />
    </button>)}</div>
    {loading ? <p role="status">Loading Quick Links…</p> : null}
    {links.length < total ? <button type="button" onClick={() => void load(page + 1, true)}>Load more</button> : null}
    <button type="button" className="quick-links-manage" onClick={onManage}>Manage Links</button>
  </section>;
}
