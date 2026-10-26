import { useMemo, useState } from "react";
import { VIDEO_ASSET_KINDS, type VideoAsset, type VideoAssetKind } from "@space/contracts";
import { api } from "../../api.js";
import { FileInfoDialog } from "../file-info/FileInfoDialog.js";
import { AgentFiles, Download, Info, Trash2 } from "../ui-theme/app-icons.js";
import { AssetMedia, deleteVideoFile, formatDuration, metaLine, saveToAgentFiles, videoAssetFileName } from "./StudioView.js";

const KIND_LABELS: Record<VideoAssetKind, string> = { OUTPUT: "Outputs", UPLOAD: "Uploads", RECORDING: "Recordings", NARRATION: "Narration", MUSIC: "Music" };
const KIND_ONE: Record<VideoAssetKind, string> = { OUTPUT: "Output", UPLOAD: "Upload", RECORDING: "Recording", NARRATION: "Narration", MUSIC: "Music" };

/** The library: every asset (a pinned Media artifact) by kind, with a frame or a player, Details, Download, Save to Agent Files and Delete. */
export function LibraryTab({ paneId, assets, onChanged }: { paneId: string; assets: VideoAsset[]; onChanged(): void }) {
  const [kind, setKind] = useState<VideoAssetKind | "">("");
  const [message, setMessage] = useState<string | null>(null);
  const [details, setDetails] = useState<VideoAsset | null>(null);
  const shown = useMemo(() => assets.filter((asset) => !kind || asset.kind === kind), [assets, kind]);
  async function act(action: () => Promise<string>) {
    setMessage(null);
    try { setMessage(await action()); onChanged(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "The file could not be changed."); }
  }
  return (
    <div className="vd-library" role="tabpanel" id="jc-panel-library" aria-labelledby="jc-tab-library">
      <label className="jc-field"><span>Kind</span>
        <select value={kind} aria-label="Filter by kind" onChange={(event) => setKind(event.target.value as VideoAssetKind | "")}>
          <option value="">All</option>
          {VIDEO_ASSET_KINDS.map((id) => <option key={id} value={id}>{KIND_LABELS[id]}</option>)}
        </select></label>
      {message ? <p className="jc-message" role="status">{message}</p> : null}
      {shown.length ? (
        <ul className="vd-library-grid" aria-label="Library files">
          {shown.map((asset) => {
            const label = asset.label ?? (metaLine(asset) || KIND_ONE[asset.kind]);
            return (
              <li key={asset.id} className="jc-card vd-library-item">
                {asset.mimeType.startsWith("video/") ? (
                  <span className="vd-tile-thumb">
                    {/* A frame, not a player (the Studio plays it): the poster, else the browser's first frame. */}
                    {asset.thumbnailArtifactId ? <img src={api.artifactFileUrl(asset.thumbnailArtifactId)} alt="" loading="lazy" />
                      : <video src={`${api.artifactFileUrl(asset.artifactId)}#t=0.5`} preload="metadata" muted playsInline tabIndex={-1} aria-hidden="true" />}
                    {asset.durationSec && asset.durationSec >= 0.5 ? <span className="vd-tile-time">{formatDuration(asset.durationSec)}</span> : null}
                  </span>
                ) : <AssetMedia artifactId={asset.artifactId} mimeType={asset.mimeType} label={label} />}
                <strong className="vd-library-title" title={label}>{label}</strong>
                <span className="jc-row-meta">{KIND_ONE[asset.kind]}{metaLine(asset) && metaLine(asset) !== label ? ` · ${metaLine(asset)}` : ""}</span>
                {asset.credits ? <p className="vd-credits">Credits: {asset.credits}</p> : null}
                <span className="vd-output-actions">
                  <button type="button" className="jc-icon-button" aria-label="Details" title="Details: what it shows, who made it, its metadata" onClick={() => setDetails(asset)}><Info aria-hidden="true" /></button>
                  <a className="jc-icon-button" href={api.artifactFileUrl(asset.artifactId)} download={videoAssetFileName(asset)} aria-label="Download" title="Download"><Download aria-hidden="true" /></a>
                  <button type="button" className="jc-icon-button" aria-label="Save to Agent Files" title="Save to Agent Files › Media / Video" onClick={() => void act(() => saveToAgentFiles(paneId, asset.artifactId))}><AgentFiles aria-hidden="true" /></button>
                  <button type="button" className="jc-icon-button danger" aria-label="Delete" title="Delete for good"
                    onClick={() => { if (window.confirm(`Delete “${label}” for good?`)) void act(() => deleteVideoFile(paneId, asset.artifactId, label)); }}><Trash2 aria-hidden="true" /></button>
                </span>
              </li>
            );
          })}
        </ul>
      ) : <p className="jc-muted jc-empty">No files yet.</p>}
      {details ? <FileInfoDialog artifactId={details.artifactId} filename={videoAssetFileName(details)} asset={details} onClose={() => setDetails(null)} /> : null}
    </div>
  );
}
