import { useCallback, useEffect, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import type { MarketingBookmark } from "@space/contracts";
import { api } from "../../api.js";
import { dispatchBrowserPaneActionEvent, MARKETING_BOOKMARKS_CHANGED_EVENT } from "../browser-pane/events.js";
import { avatarHue } from "../browser-pane/GoogleAccountMenuItems.js";
import { accountMenuEntries, effectiveAccountId, type YouTubeAccounts } from "../browser-pane/youtube-accounts.js";
import { BookmarkPlus, Plus, Trash2, Users } from "../ui-theme/app-icons.js";
import "../copilot-kit/copilot-pane.css";
import "./marketing-copilot-pane.css";

function withScheme(url: string): string {
  const trimmed = url.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}
function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}
/** Page titles carry the site's unread counter ("(1) Home / X"); the list shows the title without it. */
export function bookmarkTitle(title: string): string {
  return title.replace(/^\(\d+\+?\)\s*/, "") || title;
}

function BookmarkRow({ bookmark, busy, disabled, onOpen, onDelete }: { bookmark: MarketingBookmark; busy: boolean; disabled: boolean; onOpen(): void; onDelete(): void }) {
  const host = hostOf(bookmark.url);
  const title = bookmarkTitle(bookmark.title);
  const account = bookmark.accountLabel;
  return (
    <li className="mk-bookmark" data-busy={busy ? "true" : undefined}>
      <button type="button" className="mk-bookmark-open" title={`${bookmark.url}\nOpens with ${account ?? "the pane's account"}`} aria-busy={busy || undefined}
        aria-label={`Open ${title}${account ? ` with ${account}` : ""}`} disabled={disabled} onClick={onOpen}>
        <span className="mk-bookmark-site" aria-hidden="true">{host.charAt(0)}</span>
        <span className="mk-bookmark-copy" aria-hidden="true">
          <span className="mk-bookmark-title">{title}</span>
          <span className="mk-bookmark-meta">
            <span className="mk-bookmark-host">{host}</span>
            <span className="mk-bookmark-account">
              {account
                ? <span className="account-menu-avatar" style={{ "--account-hue": avatarHue(account) } as CSSProperties}>{account.charAt(0).toUpperCase()}</span>
                : <span className="account-menu-avatar private"><Users /></span>}
              <span>{account ?? "Pane's account"}</span>
            </span>
          </span>
        </span>
      </button>
      <button type="button" className="jc-icon-button mk-bookmark-delete" title="Delete" aria-label={`Delete bookmark ${title}`} disabled={disabled} onClick={onDelete}><Trash2 aria-hidden="true" /></button>
    </li>
  );
}

/**
 * The Bookmarks rail tab (operator request 2026-10-16): pages the pane browser opens in a new tab with the Google
 * account saved for them; a browser tab's context menu saves one too. The copilot lists and opens the same bookmarks.
 * `popover`: the browser toolbar's Bookmarks menu, so every browser pane shares the list (operator request 2026-10-21).
 */
export function BookmarksTab({ paneId, onOpened, popover = false }: { paneId: string; onOpened(): void; popover?: boolean }) {
  const [bookmarks, setBookmarks] = useState<MarketingBookmark[]>([]);
  const [accounts, setAccounts] = useState<YouTubeAccounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<{ url: string; title: string; profileId: string | null }>({ url: "", title: "", profileId: null });
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setBookmarks((await api.marketingBookmarks()).bookmarks); } catch { setBookmarks([]); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const onChanged = () => void load();
    window.addEventListener(MARKETING_BOOKMARKS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(MARKETING_BOOKMARKS_CHANGED_EVENT, onChanged);
  }, [load]);
  // The account list is the browser's own menu (ADMIN only); without it a bookmark opens in the pane's account.
  useEffect(() => {
    let cancelled = false;
    api.browserAccounts(paneId).then((next) => {
      if (cancelled) return;
      setAccounts(next);
      // New bookmarks start with the account the pane opens with (the option of its row).
      const effective = effectiveAccountId(next);
      const entry = accountMenuEntries(next).find((candidate) => candidate.group === "shared" && candidate.profiles.some((profile) => profile.profileId === effective));
      setForm((current) => current.profileId === null && entry ? { ...current, profileId: entry.profiles[0]!.profileId } : current);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [paneId]);
  const shared = useMemo(() => accounts ? accountMenuEntries(accounts).filter((entry) => entry.group === "shared") : [], [accounts]);
  const empty = !loading && bookmarks.length === 0;
  const formOpen = adding || empty;

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (busy || !form.url.trim()) return;
    const entry = shared.find((candidate) => candidate.profiles.some((profile) => profile.profileId === form.profileId));
    setBusy("save");
    setMessage(null);
    api.createMarketingBookmark({ url: withScheme(form.url), ...(form.title.trim() ? { title: form.title.trim() } : {}), profileId: entry ? form.profileId : null, accountLabel: entry?.title ?? null })
      .then(({ bookmark }) => { setBookmarks((current) => [...current, bookmark]); setForm((current) => ({ ...current, url: "", title: "" })); setAdding(false); })
      .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "The bookmark could not be saved."))
      .finally(() => setBusy(null));
  };
  const open = (bookmark: MarketingBookmark) => {
    if (busy) return;
    setBusy(bookmark.id);
    setMessage(null);
    api.openMarketingBookmark(paneId, bookmark.id)
      .then(() => { dispatchBrowserPaneActionEvent({ paneId, action: "tabs" }); onOpened(); })
      .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "The browser could not open the bookmark."))
      .finally(() => setBusy(null));
  };
  const remove = (bookmark: MarketingBookmark) => {
    if (busy) return;
    setBusy(bookmark.id);
    api.deleteMarketingBookmark(bookmark.id)
      .then(() => setBookmarks((current) => current.filter((entry) => entry.id !== bookmark.id)))
      .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "The bookmark could not be deleted."))
      .finally(() => setBusy(null));
  };

  return (
    <div className="mk-bookmarks" {...popover ? { role: "group", "aria-label": "Bookmarks" } : { role: "tabpanel", id: "jc-panel-bookmarks", "aria-labelledby": "jc-tab-bookmarks" }}>
      <div className="mk-bookmarks-head">
        <span className="jc-muted">
          {bookmarks.length ? <>{bookmarks.length} {bookmarks.length === 1 ? "bookmark" : "bookmarks"}<span className="mk-bookmarks-hint"> · right-click a browser tab to save it</span></> : "Right-click a browser tab to save it here"}
        </span>
        {!empty ? <button type="button" className="jc-button primary" aria-expanded={formOpen} onClick={() => setAdding((current) => !current)}><Plus aria-hidden="true" /> Add bookmark</button> : null}
      </div>
      {formOpen ? (
        <form className="jc-teach mk-bookmark-form" onSubmit={save}>
          <label className="jc-field mk-span"><span>Address</span>
            <input value={form.url} placeholder="x.com" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoFocus={adding} onChange={(event) => setForm({ ...form, url: event.target.value })} required />
          </label>
          <label className="jc-field"><span>Name (optional)</span><input value={form.title} placeholder="The site's name" onChange={(event) => setForm({ ...form, title: event.target.value })} /></label>
          <label className="jc-field"><span>Google account</span>
            <select value={form.profileId ?? ""} onChange={(event) => setForm({ ...form, profileId: event.target.value || null })}>
              <option value="">The pane's account</option>
              {shared.map((entry) => <option key={entry.key} value={entry.profiles[0]!.profileId}>{entry.title}</option>)}
            </select>
          </label>
          <div className="jc-actions mk-span">
            <button type="submit" className="jc-button primary" disabled={busy !== null || !form.url.trim()}><BookmarkPlus aria-hidden="true" /> Save bookmark</button>
            {!empty ? <button type="button" className="jc-button ghost" onClick={() => setAdding(false)}>Cancel</button> : null}
          </div>
        </form>
      ) : null}
      {message ? <p className="jc-message" role="status">{message}</p> : null}
      {loading && bookmarks.length === 0 ? <p className="jc-muted jc-panel-loading" role="status">Loading bookmarks…</p> : null}
      {empty ? <div className="jc-empty"><strong>No bookmarks yet</strong><span>Save a site with the Google account it opens with. One click opens it in the pane browser, signed in, and the copilot can open it too.</span></div> : null}
      <ul className="mk-bookmark-list" aria-label="Bookmarks">
        {bookmarks.map((bookmark) => (
          <BookmarkRow key={bookmark.id} bookmark={bookmark} busy={busy === bookmark.id} disabled={busy !== null} onOpen={() => open(bookmark)} onDelete={() => remove(bookmark)} />
        ))}
      </ul>
    </div>
  );
}
