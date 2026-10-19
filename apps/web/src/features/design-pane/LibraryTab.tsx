import { useMemo, useState } from "react";
import { DESIGN_FORMATS, DESIGN_NETWORK_LABELS, DESIGN_NETWORKS, resolveDesignFormat, type DesignAsset, type DesignBrandKit, type DesignNetwork } from "@space/contracts";
import { api } from "../../api.js";
import { Download, Trash2 } from "../ui-theme/app-icons.js";

/** The library: every asset (a pinned Media artifact) with its versions, filtered by network, format or brand kit. */
export function LibraryTab({ paneId, assets, brandKits, onOpen, onChanged }: { paneId: string; assets: DesignAsset[]; brandKits: DesignBrandKit[]; onOpen(asset: DesignAsset): void; onChanged(): void }) {
  const [network, setNetwork] = useState<DesignNetwork | "">("");
  const [formatId, setFormatId] = useState("");
  const [brandKitId, setBrandKitId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const shown = useMemo(() => assets.filter((asset) => (!formatId || asset.formatId === formatId)
    && (!network || resolveDesignFormat(asset.formatId)?.network === network) && (!brandKitId || asset.brandKitId === brandKitId)), [assets, brandKitId, formatId, network]);
  const versions = (asset: DesignAsset) => assets.filter((other) => other.parentAssetId === asset.id).length;
  async function remove(asset: DesignAsset) {
    setMessage(null);
    try { await api.deleteDesignAsset(paneId, asset.id); setMessage("Removed from the library; its Media file expires in 7 days."); onChanged(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "The design could not be removed."); }
  }
  return (
    <div className="dz-library" role="tabpanel" id="jc-panel-library" aria-labelledby="jc-tab-library">
      <div className="dz-row dz-filters">
        <label className="jc-field"><span>Network</span>
          <select value={network} aria-label="Filter by network" onChange={(event) => { setNetwork(event.target.value as DesignNetwork | ""); setFormatId(""); }}>
            <option value="">All</option>
            {DESIGN_NETWORKS.map((id) => <option key={id} value={id}>{DESIGN_NETWORK_LABELS[id]}</option>)}
          </select></label>
        <label className="jc-field"><span>Format</span>
          <select value={formatId} aria-label="Filter by format" onChange={(event) => setFormatId(event.target.value)}>
            <option value="">All</option>
            {DESIGN_FORMATS.filter((entry) => !network || entry.network === network).map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          </select></label>
        <label className="jc-field"><span>Brand kit</span>
          <select value={brandKitId} aria-label="Filter by brand kit" onChange={(event) => setBrandKitId(event.target.value)}>
            <option value="">All</option>
            {brandKits.map((kit) => <option key={kit.id} value={kit.id}>{kit.name}</option>)}
          </select></label>
      </div>
      {shown.length ? (
        <ul className="dz-library-grid" aria-label="Designs">
          {shown.map((asset) => (
            <li key={asset.id} className="dz-library-item">
              <button type="button" className="dz-thumb" onClick={() => onOpen(asset)} title="Open in the Studio">
                {asset.mimeType === "video/mp4" ? <span className="dz-thumb-video">MP4</span> : <img src={api.artifactFileUrl(asset.artifactId)} alt={asset.label ?? ""} loading="lazy" />}
              </button>
              <span className="jc-row-meta">{resolveDesignFormat(asset.formatId)?.label ?? asset.formatId} · {asset.width}×{asset.height}{versions(asset) ? ` · ${versions(asset)} version${versions(asset) === 1 ? "" : "s"}` : ""}</span>
              <span className="dz-library-actions">
                <a className="jc-icon-button" href={api.agentFileDownloadUrl(asset.artifactId)} download aria-label="Download" title="Download"><Download aria-hidden="true" /></a>
                <button type="button" className="jc-icon-button" aria-label="Remove from the library" title="Remove from the library" onClick={() => void remove(asset)}><Trash2 aria-hidden="true" /></button>
              </span>
            </li>
          ))}
        </ul>
      ) : <p className="jc-muted jc-empty">No designs match.</p>}
      {message ? <p className="jc-message" role="status">{message}</p> : null}
    </div>
  );
}
