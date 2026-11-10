import { useMemo, useState } from "react";
import { DESIGN_FORMATS, DESIGN_NETWORK_LABELS, DESIGN_NETWORKS, resolveDesignFormat, type DesignAsset, type DesignBrandKit, type DesignNetwork } from "@space/contracts";
import { api } from "../../api.js";
import { FileInfoDialog } from "../file-info/FileInfoDialog.js";
import { Download, Info, Paperclip, Trash2 } from "../ui-theme/app-icons.js";
import { designAssetFileName, designFormatLabel } from "./StudioView.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";

/** The library: every asset (a pinned Media artifact) with its versions, filtered by network, format or brand kit. */
export function LibraryTab({ paneId, assets, brandKits, onOpen, onChanged, onUploadFiles }: { paneId: string; assets: DesignAsset[]; brandKits: DesignBrandKit[]; onOpen(asset: DesignAsset): void; onChanged(): void; onUploadFiles(): void }) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [network, setNetwork] = useState<DesignNetwork | "">("");
  const [formatId, setFormatId] = useState("");
  const [brandKitId, setBrandKitId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [details, setDetails] = useState<DesignAsset | null>(null);
  const shown = useMemo(() => assets.filter((asset) => (!formatId || asset.formatId === formatId)
    && (!network || resolveDesignFormat(asset.formatId)?.network === network) && (!brandKitId || asset.brandKitId === brandKitId)), [assets, brandKitId, formatId, network]);
  const versions = (asset: DesignAsset) => assets.filter((other) => other.parentAssetId === asset.id).length;
  async function remove(asset: DesignAsset) {
    setMessage(null);
    try { await api.deleteDesignAsset(paneId, asset.id); setMessage(t("Removed from the library; its Media file expires in 7 days.")); onChanged(); }
    catch (error) { setMessage(error instanceof Error ? error.message : t("The design could not be removed.")); }
  }
  return (
    <div className="dz-library" role="tabpanel" id="jc-panel-library" aria-labelledby="jc-tab-library">
      <div className="dz-row dz-filters">
        <label className="jc-field"><span>{t("Network")}</span>
          <select value={network} aria-label={t("Filter by network")} onChange={(event) => { setNetwork(event.target.value as DesignNetwork | ""); setFormatId(""); }}>
            <option value="">{t("All")}</option>
            {DESIGN_NETWORKS.map((id) => <option key={id} value={id}>{t(DESIGN_NETWORK_LABELS[id])}</option>)}
          </select></label>
        <label className="jc-field"><span>{t("Format")}</span>
          <select value={formatId} aria-label={t("Filter by format")} onChange={(event) => setFormatId(event.target.value)}>
            <option value="">{t("All")}</option>
            {DESIGN_FORMATS.filter((entry) => !network || entry.network === network).map((entry) => <option key={entry.id} value={entry.id}>{t(entry.label)}</option>)}
          </select></label>
        <label className="jc-field"><span>{t("Brand kit")}</span>
          <select value={brandKitId} aria-label={t("Filter by brand kit")} onChange={(event) => setBrandKitId(event.target.value)}>
            <option value="">{t("All")}</option>
            {brandKits.map((kit) => <option key={kit.id} value={kit.id}>{kit.name}</option>)}
          </select></label>
        <button type="button" className="jc-button ghost" onClick={onUploadFiles} title={t("Upload files to the designer's CLI")}><Paperclip aria-hidden="true" /> {t("Upload files")}</button>
      </div>
      {shown.length ? (
        <ul className="dz-library-grid" aria-label={t("Designs")}>
          {shown.map((asset) => (
            <li key={asset.id} className="dz-library-item">
              <button type="button" className="dz-thumb" onClick={() => onOpen(asset)} title={t("Open in the Studio")}>
                {asset.mimeType === "video/mp4" ? <span className="dz-thumb-video">MP4</span> : <img src={api.artifactFileUrl(asset.artifactId)} alt={asset.label ?? ""} loading="lazy" />}
              </button>
              <span className="jc-row-meta">{designFormatLabel(t, asset.formatId)} · {asset.width}×{asset.height}{versions(asset) ? ` · ${t(versions(asset) === 1 ? "{count} version" : "{count} versions", { count: versions(asset) })}` : ""}</span>
              <span className="dz-library-actions">
                <button type="button" className="jc-icon-button" aria-label={t("Details")} title={t("Details: what it shows, who made it, its metadata")} onClick={() => setDetails(asset)}><Info aria-hidden="true" /></button>
                <a className="jc-icon-button" href={api.artifactFileUrl(asset.artifactId)} download={designAssetFileName(asset)} aria-label={t("Download")} title={t("Download")}><Download aria-hidden="true" /></a>
                <button type="button" className="jc-icon-button" aria-label={t("Remove from the library")} title={t("Remove from the library")} onClick={() => void remove(asset)}><Trash2 aria-hidden="true" /></button>
              </span>
            </li>
          ))}
        </ul>
      ) : <p className="jc-muted jc-empty">{t("No designs match.")}</p>}
      {message ? <p className="jc-message" role="status">{message}</p> : null}
      {details ? <FileInfoDialog artifactId={details.artifactId} filename={designAssetFileName(details)} asset={details} onClose={() => setDetails(null)} /> : null}
    </div>
  );
}
