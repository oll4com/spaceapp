import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { designCustomFormatRef, DESIGN_CUSTOM_MIN_PX, type DesignAsset } from "@space/contracts";
import { api } from "../../api.js";
import { SnipEditor, type SnipBusy, type SnipEdit } from "../snip-tool/SnipEditor.js";
import { exportSnip, type SnipFrame } from "../snip-tool/snip-image.js";
import "../snip-tool/snip-tool.css";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";

const LIBRARY = "library";

/** Crop or annotate a design with the snip editor; the result is a new version of the asset in the library (and Media). */
export function DesignSnipEditor({ paneId, asset, onSaved, onClose }: { paneId: string; asset: DesignAsset; onSaved(asset: DesignAsset): void; onClose(): void }) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [frame, setFrame] = useState<SnipFrame | null>(null);
  const [busy, setBusy] = useState<SnipBusy>(null);
  const [notice, setNotice] = useState("Crop or mark up the design; Save as a new version keeps the original.");
  const [alert, setAlert] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const image = new Image();
    image.src = api.artifactFileUrl(asset.artifactId);
    image.decode().then(() => { if (!cancelled) setFrame({ source: image, width: image.naturalWidth, height: image.naturalHeight }); },
      () => { if (!cancelled) setAlert(t("The design could not be opened for editing.")); });
    return () => { cancelled = true; };
  }, [asset.artifactId]);

  async function output(kind: "save" | "copy" | "download", edit: SnipEdit) {
    if (!frame || busy) return;
    setBusy(kind === "save" ? "send" : "export");
    setAlert(null);
    try {
      const blob = await exportSnip(frame, edit.crop, edit.marks);
      if (kind === "copy") { await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); setNotice("Copied the image."); return; }
      if (kind === "download") {
        const url = URL.createObjectURL(blob);
        const link = Object.assign(document.createElement("a"), { href: url, download: `${asset.formatId}.png` });
        link.click();
        URL.revokeObjectURL(url);
        return;
      }
      const whole = edit.crop.width === frame.width && edit.crop.height === frame.height;
      if (!whole && (edit.crop.width < DESIGN_CUSTOM_MIN_PX || edit.crop.height < DESIGN_CUSTOM_MIN_PX)) throw new Error(t("Keep at least {min} px per side.", { min: DESIGN_CUSTOM_MIN_PX }));
      const formatId = whole ? asset.formatId : designCustomFormatRef(edit.crop.width, edit.crop.height);
      const saved = await api.uploadDesignAsset(paneId, blob, { formatId, parentAssetId: asset.id, ...(asset.label ? { label: asset.label } : {}), ...(asset.requestId ? { requestId: asset.requestId } : {}) });
      onSaved(saved.asset);
    } catch (error) {
      setAlert(error instanceof Error ? error.message : t("The edit could not be saved."));
    } finally {
      setBusy(null);
    }
  }

  if (!frame) return alert ? createPortal(<div className="snip-editor" role="dialog" aria-label={t("Edit design")}><p className="snip-alert" role="alert">{alert}</p><button type="button" className="snip-text-btn" onClick={onClose}>{t("Close")}</button></div>, document.body) : null;
  return createPortal(
    <SnipEditor key={generation} frame={frame} initialCrop={{ x: 0, y: 0, width: frame.width, height: frame.height }} busy={busy} notice={t(notice)} alert={alert}
      destinations={[{ value: LIBRARY, label: t("Design library") }]} destination={LIBRARY} onDestinationChange={() => undefined}
      primaryLabel={t("Save as a new version")} primaryDisabled={false} allowChangeSource={false} trapFocus
      onPrimary={(edit) => void output("save", edit)} onCopy={(edit) => void output("copy", edit)} onSave={(edit) => void output("download", edit)}
      onRetake={() => setGeneration((value) => value + 1)} onChangeSource={() => undefined} onClose={onClose} />,
    document.body
  );
}
