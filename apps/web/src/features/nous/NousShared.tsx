import { useCallback, useContext, useEffect, useState } from "react";
import { api } from "../../api.js";
import type { NousSharedFile } from "../../live-api.js";
import { fetchAllAgentFiles } from "../agent-files/agent-files-api.js";
import { formatUserTime } from "../date-time-settings/date-time-settings.js";
import { DockButton, DockIconButton, DockState } from "../dock-kit/DockKit.js";
import { AgentFileMentionContext } from "../terminal-pane/AgentFileLinks.js";
import { FileSymlink, X } from "../ui-theme/app-icons.js";

/**
 * Shared (operator request 31/10 00:31 BKK, plan clipboard:RQSrp1EczBbV): the Agent Files Nous shared with the operator for a while,
 * the same list the Nous app shows. A click opens the Agent Files preview; Remove ends only the share, never the Agent File.
 */
const POLL_MS = 20_000;
const messageOf = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

export function useSharedFiles(active: boolean) {
  const [files, setFiles] = useState<NousSharedFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setFiles(await api.nousSharedFiles()); setError(null); } catch (failure) { setError(messageOf(failure, "The shared files could not be loaded.")); }
  }, []);
  useEffect(() => {
    if (!active) return;
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, load]);
  const removed = useCallback((shareId: string) => setFiles((current) => current?.filter((file) => file.shareId !== shareId) ?? null), []);
  return { files, error, count: files?.length ?? 0, retry: load, removed };
}

export function NousShared({ files, error, onRetry, onRemoved }: { files: NousSharedFile[] | null; error: string | null; onRetry(): void; onRemoved(shareId: string): void }) {
  const links = useContext(AgentFileMentionContext);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const work = async (file: NousSharedFile, run: () => Promise<void>, fallback: string) => {
    setBusy(file.shareId); setProblem(null);
    try { await run(); } catch (failure) { setProblem(messageOf(failure, fallback)); } finally { setBusy(null); }
  };
  // The dock's Agent Files index opens it at once; a file shared since its last read is looked up by id.
  const open = (file: NousSharedFile) => work(file, async () => {
    const artifact = links?.artifact(`/api/artifacts/${encodeURIComponent(file.artifactId)}/download`)
      ?? (await fetchAllAgentFiles()).find((item) => item.id === file.artifactId);
    if (!artifact || !links) throw new Error(`${file.name} is no longer in Agent Files.`);
    links.open(artifact);
  }, `${file.name} could not be opened.`);
  const remove = (file: NousSharedFile) => work(file, async () => { await api.removeNousSharedFile(file.shareId); onRemoved(file.shareId); }, "The share could not be removed.");
  return (
    <div className="nous-decisions nous-shared" data-sensitive-masked="manual">
      {error ? <div><p role="alert">{error}</p><DockButton onClick={onRetry}>Retry</DockButton></div> : null}
      {problem ? <p role="alert">{problem}</p> : null}
      {files === null && !error ? <DockState kind="loading" title="Loading the shared files" /> : null}
      {files?.length === 0 ? <DockState kind="empty" icon={FileSymlink} title="Nothing shared"
        detail="Files Nous shares with you for a while, for example to approve them, appear here. Removing one ends only the share; the Agent File stays." /> : null}
      {files?.map((file) => (
        <article key={file.shareId} className="nous-shared-entry" aria-label={file.name}>
          <button type="button" className="nous-shared-open" disabled={busy === file.shareId} onClick={() => void open(file)} title={`Open ${file.name}`}>
            <span className="nous-shared-icon" aria-hidden="true"><FileSymlink /></span>
            <span className="nous-shared-name">{file.name}</span>
          </button>
          {file.note ? <p className="nous-shared-note">{file.note}</p> : null}
          <p className="nous-shared-meta">Shared until <time dateTime={file.expiresAt}>{formatUserTime(file.expiresAt)}</time>{file.folder ? ` · ${file.folder}` : ""}</p>
          <DockIconButton label={`Remove the share of ${file.name}`} icon={X} disabled={busy === file.shareId} onClick={() => void remove(file)} />
        </article>
      ))}
    </div>
  );
}
