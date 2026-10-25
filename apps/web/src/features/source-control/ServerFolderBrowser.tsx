import React, { useEffect, useState } from "react";
import { ArrowUp, Folder } from "../ui-theme/app-icons.js";
import { listServerDirectories, type ServerDirectoryListing } from "./client.js";

/** Folders on the Space runtime host only; listing uses the existing Files authorization. */
export function ServerFolderBrowser({ path, admin, onNavigate, label = "Folders on the Space host" }: {
  path: string; admin: boolean; onNavigate: (path: string) => void; label?: string;
}) {
  const [listing, setListing] = useState<ServerDirectoryListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState(path);
  useEffect(() => { setDraft(path); }, [path]);
  useEffect(() => {
    const controller = new AbortController(); setError(null);
    void listServerDirectories(path || undefined, admin, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setListing(result);
      if (result.currentPath !== path) onNavigate(result.currentPath);
    }).catch(cause => { if (!controller.signal.aborted) { setListing(null); setError(cause instanceof Error ? cause.message : "Folder could not be listed."); } });
    return () => controller.abort();
    // onNavigate is intentionally excluded: callers pass inline setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, admin]);
  return (
    <div className="project-folder-browser" aria-label={label} role="group">
      <div className="project-folder-path">
        <button type="button" aria-label="Parent folder" title="Parent folder" disabled={!listing?.parentPath} onClick={() => listing?.parentPath && onNavigate(listing.parentPath)}><ArrowUp size={14} aria-hidden="true" /></button>
        <input aria-label="Folder path" value={draft} spellCheck={false} onChange={event => setDraft(event.target.value)}
          onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); if (draft.trim()) onNavigate(draft.trim()); } }} />
        <button type="button" onClick={() => draft.trim() && onNavigate(draft.trim())}>Go</button>
      </div>
      {error ? <p role="alert" className="project-picker-error">{error}</p> : null}
      <ul className="project-folder-list" aria-label="Subfolders">
        {listing && !listing.entries.length ? <li className="project-picker-muted">No subfolders.</li> : null}
        {listing?.entries.map(entry => (
          <li key={entry.path}>
            <button type="button" onClick={() => onNavigate(entry.path)} title={entry.path}><Folder size={14} aria-hidden="true" /><span>{entry.name}</span></button>
          </li>
        ))}
      </ul>
    </div>
  );
}
