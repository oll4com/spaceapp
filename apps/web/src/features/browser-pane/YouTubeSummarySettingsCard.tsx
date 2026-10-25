import { useEffect, useState } from "react";
import { YOUTUBE_DOWNLOAD_RESOLUTIONS, YOUTUBE_SUMMARY_MODELS, youtubeDownloadSettingsSchema, type YouTubeDownloadSettings } from "@space/contracts";
import { api } from "../../api.js";
import { fetchAllAgentFiles } from "../agent-files/agent-files-api.js";

/**
 * The YouTube pane's settings, in the pane and in Settings → Assistants & AI → YouTube: the Gemini model of "Summarize with AI",
 * and the Agent Files folder and resolution of "Download".
 */
export function YouTubeSettingsCard() {
  const [model, setModel] = useState<string | null>(null);
  const [download, setDownload] = useState<YouTubeDownloadSettings | null>(null);
  const [folders, setFolders] = useState<{ ids: string[]; label: (id: string) => string }>({ ids: [], label: (id) => id });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.userSettings().then((saved) => {
      if (!live) return;
      setModel(saved.youtubeSummaryModel ?? YOUTUBE_SUMMARY_MODELS[0].id);
      setDownload(youtubeDownloadSettingsSchema.parse(saved.youtubeDownload ?? {}));
    }).catch(() => { if (live) setError("Your settings could not load. Reopen Settings to try again."); });
    // The folders Agent Files knows; its module loads only here, never with the pane.
    Promise.all([fetchAllAgentFiles(), import("../agent-files/AgentFilesDock.js")]).then(([artifacts, dock]) => {
      if (live) setFolders({ ids: dock.knownAgentFileFolders(artifacts), label: dock.getFolderDisplayPath });
    }).catch(() => undefined);
    return () => { live = false; };
  }, []);

  async function save(patch: { youtubeSummaryModel?: string; youtubeDownload?: YouTubeDownloadSettings }, undo: () => void) {
    setError(null);
    try {
      await api.updateUserSettings(patch);
    } catch (cause) {
      undo();
      setError(cause instanceof Error ? cause.message : "The setting could not be saved. Try again.");
    }
  }
  function chooseModel(next: string) {
    const previous = model;
    setModel(next);
    void save({ youtubeSummaryModel: next }, () => setModel(previous));
  }
  function chooseDownload(next: YouTubeDownloadSettings) {
    const previous = download;
    setDownload(next);
    void save({ youtubeDownload: next }, () => setDownload(previous));
  }
  const folderIds = [...new Set([...(download ? [download.folder] : []), ...folders.ids])].sort((left, right) => left.localeCompare(right));

  return <section className="agent-settings-card settings-flat-card" aria-label="YouTube settings">
    {error ? <small role="alert">{error}</small> : null}
    <label className="settings-flat-row">
      <span className="settings-flat-row-copy">
        <strong>Summary model</strong>
        <small>Gemini on your Antigravity accounts in Space Gateway watches the video.</small>
      </span>
      <select aria-label="YouTube summary model" value={model ?? ""} disabled={model === null} onChange={(event) => chooseModel(event.target.value)}>
        {model === null ? <option value="">Loading…</option> : null}
        {YOUTUBE_SUMMARY_MODELS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
    </label>
    <label className="settings-flat-row">
      <span className="settings-flat-row-copy">
        <strong>Download folder</strong>
        <small>The Agent Files folder downloaded videos are saved in; the Video library lists them too.</small>
      </span>
      <select aria-label="Download folder" value={download?.folder ?? ""} disabled={download === null} onChange={(event) => download && chooseDownload({ ...download, folder: event.target.value })}>
        {download === null ? <option value="">Loading…</option> : null}
        {folderIds.map((id) => <option key={id} value={id}>{folders.label(id)}</option>)}
      </select>
    </label>
    <label className="settings-flat-row">
      <span className="settings-flat-row-copy">
        <strong>Download resolution</strong>
        <small>The tallest video Download saves; a video without that size comes in the next one below.</small>
      </span>
      <select aria-label="Download resolution" value={download?.maxHeight ?? ""} disabled={download === null} onChange={(event) => download && chooseDownload({ ...download, maxHeight: Number(event.target.value) })}>
        {download === null ? <option value="">Loading…</option> : null}
        {YOUTUBE_DOWNLOAD_RESOLUTIONS.map((option) => <option key={option.maxHeight} value={option.maxHeight}>{option.label}</option>)}
      </select>
    </label>
  </section>;
}
