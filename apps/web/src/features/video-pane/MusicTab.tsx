import { useState, type FormEvent } from "react";
import type { VideoAsset } from "@space/contracts";
import { api } from "../../api.js";
import type { VideoMusicResult } from "../../live-api.js";
import { Search, Trash2, Upload } from "../ui-theme/app-icons.js";
import { AssetMedia, formatDuration } from "./StudioView.js";

/** Music: the library's tracks with their credits, an upload of your own MP3/WAV, and a CC BY search whose tracks join the library with their attribution. */
export function MusicTab({ paneId, assets, onChanged }: { paneId: string; assets: VideoAsset[]; onChanged(): void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<VideoMusicResult[] | null>(null);
  const [label, setLabel] = useState("");
  const [credits, setCredits] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const tracks = assets.filter((asset) => asset.kind === "MUSIC");
  async function run(id: string, action: () => Promise<string | null>) {
    if (busy) return;
    setBusy(id);
    setMessage(null);
    try { const done = await action(); if (done) { setMessage(done); onChanged(); } }
    catch (error) { setMessage(error instanceof Error ? error.message : "That did not work."); }
    finally { setBusy(null); }
  }
  const search = (event: FormEvent) => {
    event.preventDefault();
    if (query.trim()) void run("search", async () => { setResults((await api.videoMusicSearch(paneId, { query: query.trim(), limit: 20 })).results); return null; });
  };
  const upload = (event: FormEvent) => {
    event.preventDefault();
    if (file) void run("upload", async () => {
      await api.uploadVideoMusic(paneId, file, { label: label.trim() || undefined, credits: credits.trim() || undefined });
      setFile(null); setLabel(""); setCredits("");
      return `Added ${file.name} to the library.`;
    });
  };
  return (
    <div className="vd-music" role="tabpanel" id="jc-panel-music" aria-labelledby="jc-tab-music">
      {tracks.length ? (
        <ul className="vd-music-list" aria-label="Music tracks">
          {tracks.map((track) => (
            <li key={track.id} className="jc-card vd-output">
              <strong>{track.label ?? track.description ?? "Track"}</strong>
              <AssetMedia artifactId={track.artifactId} mimeType={track.mimeType} label={track.label ?? "Track"} />
              <span className="jc-row-meta">{formatDuration(track.durationSec) || track.mimeType}</span>
              {track.credits ? <p className="vd-credits">Credits: {track.credits}</p> : null}
              <span className="vd-output-actions">
                <button type="button" className="jc-icon-button" aria-label="Remove from the library" title="Remove from the library" disabled={Boolean(busy)}
                  onClick={() => void run(track.id, async () => { await api.deleteVideoAsset(paneId, track.id); return "Removed from the library."; })}><Trash2 aria-hidden="true" /></button>
              </span>
            </li>
          ))}
        </ul>
      ) : <p className="jc-muted">No music yet. Upload a track of your own or find a CC BY one.</p>}
      <form className="jc-form" onSubmit={upload} aria-label="Upload music">
        <label className="jc-field"><span>Your own track (MP3 or WAV)</span>
          <input type="file" accept="audio/mpeg,audio/wav,.mp3,.wav" aria-label="Music file" disabled={Boolean(busy)} onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label>
        <div className="vd-row">
          <label className="jc-field"><span>Label</span><input value={label} maxLength={200} aria-label="Track label" onChange={(event) => setLabel(event.target.value)} /></label>
          <label className="jc-field"><span>Credits</span><input value={credits} maxLength={1000} placeholder="What the licence asks you to show" aria-label="Track credits" onChange={(event) => setCredits(event.target.value)} /></label>
        </div>
        <button type="submit" className="jc-button" disabled={!file || Boolean(busy)}><Upload aria-hidden="true" /> {busy === "upload" ? "Uploading…" : "Add to library"}</button>
      </form>
      <form className="jc-form" onSubmit={search} aria-label="Find CC BY music">
        <label className="jc-field"><span>Find CC BY music</span>
          <input value={query} maxLength={200} placeholder="upbeat electronic, calm piano…" aria-label="Music search" onChange={(event) => setQuery(event.target.value)} /></label>
        <button type="submit" className="jc-button" disabled={!query.trim() || Boolean(busy)}><Search aria-hidden="true" /> {busy === "search" ? "Searching…" : "Search"}</button>
      </form>
      {results ? results.length ? (
        <ul className="vd-results" aria-label="Music search results">
          {results.map((result) => (
            <li key={result.url} className="jc-card vd-output">
              <strong>{result.title}</strong>
              <span className="jc-row-meta">{result.artist ?? "Unknown artist"}{result.license ? ` · ${result.license}` : ""}</span>
              <p className="vd-credits">{result.attribution}</p>
              <button type="button" className="jc-button" disabled={Boolean(busy)}
                onClick={() => void run(result.url, async () => { await api.videoMusicFetch(paneId, { url: result.url, title: result.title, artist: result.artist ?? undefined, attribution: result.attribution }); return `Added “${result.title}” to the library with its credits.`; })}>
                {busy === result.url ? "Adding…" : "Add to library"}</button>
            </li>
          ))}
        </ul>
      ) : <p className="jc-muted">Nothing found for that.</p> : null}
      {message ? <p className="jc-message" role="status">{message}</p> : null}
    </div>
  );
}
