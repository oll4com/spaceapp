import { useEffect, useState } from "react";
import type { DotDeliverable, DotProfile, DotWorkspaceEntry } from "@space/contracts";
import { api } from "../../api.js";
import { Download, File, Folder } from "../ui-theme/app-icons.js";

const previewable = /\.(txt|md|csv|json|png|jpe?g|gif|webp|pdf|mp3|wav|mp4|webm)$/i;
export function dotWorkspaceFileUrl(dotId: string, path: string, download: boolean): string {
  return `/api/dots/${encodeURIComponent(dotId)}/workspace/file?path=${encodeURIComponent(path)}${download ? "&download=1" : ""}`;
}
function size(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function when(iso: string): string {
  try { return new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }); } catch { return iso; }
}

/** Browse the Dot's workspace, open or download files, and publish one to Agent Files as a new version. */
export function DotWorkspaceFiles({ dot, roomId, rootEntries, refreshKey, readFolder = api.dotWorkspace, readDeliverables = api.dotDeliverables,
  publish = api.publishDotDeliverable }: {
  dot: DotProfile; roomId: string | null; rootEntries: DotWorkspaceEntry[]; refreshKey: number;
  readFolder?: typeof api.dotWorkspace; readDeliverables?: typeof api.dotDeliverables; publish?: typeof api.publishDotDeliverable;
}) {
  const [folder, setFolder] = useState("");
  const [entries, setEntries] = useState<DotWorkspaceEntry[] | null>(null);
  const [deliverables, setDeliverables] = useState<DotDeliverable[] | null>(null);
  const [revision, setRevision] = useState(0);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!folder) { setEntries(null); return; }
    let current = true;
    void Promise.resolve().then(() => readFolder(dot.dotId, folder)).then((result) => { if (current && result.dotId === dot.dotId) setEntries(result.entries); })
      .catch(() => { if (current) { setNotice("This folder is unavailable."); setFolder(""); } });
    return () => { current = false; };
  }, [dot.dotId, folder, refreshKey, revision, readFolder]);
  useEffect(() => {
    let current = true;
    void Promise.resolve().then(() => readDeliverables(dot.dotId)).then((result) => {
      if (current && result.dotId === dot.dotId) setDeliverables(result.items.filter((item) => item.dotId === dot.dotId));
    }).catch(() => { if (current) setDeliverables(null); });
    return () => { current = false; };
  }, [dot.dotId, refreshKey, revision, readDeliverables]);
  const shown = folder ? entries : rootEntries;
  const pathOf = (name: string) => folder ? `${folder}/${name}` : name;
  async function publishFile(path: string) {
    if (!roomId || busyPath) return;
    setBusyPath(path); setNotice(null);
    try {
      const result = await publish(dot.dotId, { path, roomId });
      setNotice(result.unchanged ? `${result.deliverable.name} is unchanged; version ${result.deliverable.version} is already in Agent Files.`
        : `Published ${result.deliverable.name} as version ${result.deliverable.version} in Agent Files.`);
      setRevision((value) => value + 1);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The file could not be published.");
    } finally { setBusyPath(null); }
  }
  const groups = new Map<string, Array<DotDeliverable & { artifactId: string }>>();
  // Versions whose Agent File was deleted keep their number but have nothing to download.
  for (const item of (deliverables ?? []).filter((version): version is DotDeliverable & { artifactId: string } => version.artifactId !== null)) {
    groups.set(item.name, [...(groups.get(item.name) ?? []), item].sort((a, b) => b.version - a.version));
  }
  return <>
    {folder ? <nav className="dots-workspace-crumbs" aria-label="Workspace folder">
      <button type="button" onClick={() => setFolder("")}>Workspace</button>
      {folder.split("/").map((segment, index, all) => <span key={`${segment}:${index}`}> / <button type="button"
        onClick={() => setFolder(all.slice(0, index + 1).join("/"))} aria-current={index === all.length - 1 ? "page" : undefined}>{segment}</button></span>)}
    </nav> : null}
    {shown === null ? <p role="status">Loading folder…</p> : !shown.length ? <p>{folder ? "This folder is empty." : "The workspace is empty."}</p>
      : <ul className="dots-computer-files">{shown.map((entry) => {
        const path = pathOf(entry.name);
        return <li key={entry.name}>
          {entry.kind === "directory" ? <Folder aria-hidden="true" /> : <File aria-hidden="true" />}
          {entry.kind === "directory" ? <button type="button" className="dots-computer-file-name dots-workspace-folder" onClick={() => setFolder(path)}>{entry.name}</button>
            : <span className="dots-computer-file-name">{entry.name}</span>}
          <span className="dots-computer-file-meta">{size(entry.bytes)}{entry.bytes !== null ? " · " : ""}{when(entry.modifiedAt)}</span>
          {entry.kind === "file" ? <span className="dots-workspace-actions">
            {previewable.test(entry.name) ? <a href={dotWorkspaceFileUrl(dot.dotId, path, false)} target="_blank" rel="noopener noreferrer" aria-label={`Open ${entry.name}`}>Open</a> : null}
            <a href={dotWorkspaceFileUrl(dot.dotId, path, true)} download={entry.name} aria-label={`Download ${entry.name}`}>Download</a>
            {roomId ? <button type="button" disabled={busyPath !== null} aria-label={`Publish ${entry.name} to Agent Files`}
              onClick={() => void publishFile(path)}>{busyPath === path ? "Publishing…" : "Publish"}</button> : null}
          </span> : null}
        </li>;
      })}</ul>}
    {notice ? <p role="status">{notice}</p> : null}
    <h4>Deliverables</h4>
    <p className="dots-panel-hint">Files published to Agent Files. Publishing the same file again adds a new version; unchanged files are not published twice.</p>
    {deliverables === null ? <p>Deliverables unavailable.</p> : !groups.size ? <p>Nothing published yet.</p>
      : <ul className="dots-records">{[...groups.entries()].map(([name, versions]) => <li key={name}>
        <strong>{name}</strong>
        <span className="dots-deliverable-versions">{versions.map((version, index) => <a key={version.deliverableId} href={api.agentFileDownloadUrl(version.artifactId)}
          download aria-label={`Download ${name} version ${version.version}`}><Download aria-hidden="true" />v{version.version}{index === 0 ? " (latest)" : ""}</a>)}</span>
        <time dateTime={versions[0]!.createdAt}>{when(versions[0]!.createdAt)}{versions[0]!.publishedBy === "DOT" ? ` · requested by ${dot.name}` : ""}</time>
      </li>)}</ul>}
  </>;
}

/** Every published version of each file, newest file first (the Dot card's Show more). Only lists and downloads; it never publishes. */
export function DotOutputVersions({ dot, items }: { dot: DotProfile; items: DotDeliverable[] }) {
  const groups = new Map<string, DotDeliverable[]>();
  for (const item of items.filter((value) => value.dotId === dot.dotId)) groups.set(item.name, [...(groups.get(item.name) ?? []), item]);
  const files = [...groups.entries()].map(([name, versions]) => ({ name, versions: [...versions].sort((a, b) => b.version - a.version) }))
    .sort((a, b) => b.versions[0]!.createdAt.localeCompare(a.versions[0]!.createdAt));
  if (!files.length) return <p className="dots-info-empty">No outputs yet</p>;
  return <ul className="dots-output-files">{files.map(({ name, versions }) => <li key={name}>
    <strong>{name}</strong>
    <ul className="dots-output-versions">{versions.map((version, index) => <li key={version.deliverableId}>
      <span>Version {version.version}{index === 0 ? " (latest)" : ""}</span>
      <span className="dots-computer-file-meta">{size(version.byteSize)} · <time dateTime={version.createdAt}>{when(version.createdAt)}</time>
        {version.publishedBy === "DOT" ? ` · requested by ${dot.name}` : ""}</span>
      {/* A version whose Agent File was deleted keeps its number but has nothing to download. */}
      {version.artifactId ? <a href={api.agentFileDownloadUrl(version.artifactId)} download aria-label={`Download ${name} version ${version.version}`}>
        <Download aria-hidden="true" />Download</a> : <span className="dots-output-removed">Removed from Agent Files</span>}
    </li>)}</ul>
  </li>)}</ul>;
}
