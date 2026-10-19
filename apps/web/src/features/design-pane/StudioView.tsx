import { useEffect, useMemo, useState } from "react";
import {
  DESIGN_ENGINE_LABELS, DESIGN_ENGINES, DESIGN_FORMATS, DESIGN_NETWORK_LABELS, DESIGN_NETWORKS, DESIGN_TEMPLATE_IDS, DESIGN_TEMPLATE_LABELS, designCustomFormatRef, resolveDesignFormat,
  type DesignAsset, type DesignBrandKit, type DesignEngine, type DesignPaneSettings, type DesignRequest, type DesignTemplateId, type Pane
} from "@space/contracts";
import { api } from "../../api.js";
import { Copy, Download, RefreshCw, Send } from "../ui-theme/app-icons.js";

export interface StudioViewProps {
  pane: Pane;
  settings: DesignPaneSettings;
  assets: DesignAsset[];
  brandKits: DesignBrandKit[];
  /** The request the operator opened from the Requests tab: deliveries go to its requester. */
  request: DesignRequest | null;
  onChanged(): void;
  onClearRequest(): void;
}

interface Fields { headline: string; subline: string; cta: string; primary: string; background: string }
const EMPTY_FIELDS: Fields = { headline: "", subline: "", cta: "", primary: "", background: "" };
const CUSTOM = "custom";

/** The template fields the renderer accepts: text, and colours only when the operator set them. */
function templateParams(fields: Fields): Record<string, unknown> {
  const colors = { ...(fields.primary ? { primary: fields.primary } : {}), ...(fields.background ? { background: fields.background } : {}) };
  return {
    ...(fields.headline.trim() ? { headline: fields.headline.trim() } : {}), ...(fields.subline.trim() ? { subline: fields.subline.trim() } : {}),
    ...(fields.cta.trim() ? { cta: fields.cta.trim() } : {}), ...(Object.keys(colors).length ? { colors } : {})
  };
}

/**
 * The Studio: a brief, a format (grouped by network, or a custom size), an engine, a brand kit and a template with its fields.
 * Templates render at once; an image engine generates the picture and composes it at the exact size; Motion asks this pane's
 * designer. Every result is a pinned Media asset; text edits re-render and "Also make" resizes without generating again.
 */
export function StudioView({ pane, settings, assets, brandKits, request, onChanged, onClearRequest }: StudioViewProps) {
  const [brief, setBrief] = useState("");
  const [formatId, setFormatId] = useState(settings.defaultFormatId.startsWith("custom-") ? CUSTOM : settings.defaultFormatId);
  const [custom, setCustom] = useState(() => {
    const format = resolveDesignFormat(settings.defaultFormatId);
    return { width: format?.width ?? 1080, height: format?.height ?? 1080 };
  });
  const [engine, setEngine] = useState<DesignEngine>(settings.defaultEngine);
  const [brandKitId, setBrandKitId] = useState(settings.brandKitId);
  const [templateId, setTemplateId] = useState<DesignTemplateId>(settings.defaultTemplateId);
  const [fields, setFields] = useState<Fields>(EMPTY_FIELDS);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [alsoMake, setAlsoMake] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // A request opened from the Requests tab fills the brief and its first format.
  useEffect(() => {
    if (!request) return;
    setBrief(request.brief);
    const first = request.formatIds[0];
    if (first) setFormatId(first.startsWith("custom-") ? CUSTOM : first);
    if (first?.startsWith("custom-")) { const format = resolveDesignFormat(first); if (format) setCustom({ width: format.width, height: format.height }); }
    if (request.engine) setEngine(request.engine);
    if (request.brandKitId) setBrandKitId(request.brandKitId);
  }, [request]);

  const formatRef = formatId === CUSTOM ? designCustomFormatRef(custom.width, custom.height) : formatId;
  const format = resolveDesignFormat(formatRef);
  const current = useMemo(() => assets.find((asset) => asset.id === currentId) ?? null, [assets, currentId]);
  const recent = useMemo(() => assets.filter((asset) => !request || asset.requestId === request.id).slice(0, 12), [assets, request]);

  async function run(label: string, action: () => Promise<DesignAsset | DesignAsset[] | null>) {
    if (busy) return;
    setBusy(label);
    setMessage(null);
    try {
      const result = await action();
      const made = Array.isArray(result) ? result[0] : result;
      if (made) setCurrentId(made.id);
      onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `${label} failed.`);
    } finally {
      setBusy(null);
    }
  }

  const make = () => void run("Make", async () => {
    if (!format) throw new Error("Pick a format, or a custom size of 64–4096 px per side.");
    const requestId = request?.id ?? null;
    if (engine === "MOTION") {
      if (!brief.trim()) throw new Error("Describe the motion piece in the brief.");
      await api.createDesignRequest(pane.id, { brief: brief.trim(), formatIds: [formatRef], engine: "MOTION", brandKitId });
      setMessage("The designer makes the motion piece in this pane; it appears in the Requests tab.");
      return null;
    }
    const params = templateParams(fields);
    if (engine === "TEMPLATE") return (await api.designRender(pane.id, { templateId, formatId: formatRef, params, brandKitId, requestId })).asset;
    if (!brief.trim()) throw new Error("Describe the picture in the brief.");
    const generated = (await api.designGenerate(pane.id, { engine, prompt: brief.trim(), formatId: formatRef, requestId })).asset;
    // The picture becomes the background of a template at the exact size, with the text as fields.
    return (await api.designRender(pane.id, { templateId: templateId === "gradient-headline" ? "photo-headline" : templateId, formatId: formatRef, params, backgroundAssetId: generated.id, brandKitId, requestId })).asset;
  });
  const reRender = () => current && void run("Update", async () => (await api.designVariants(pane.id, current.id, { params: templateParams(fields), requestId: request?.id ?? null })).assets);
  const resize = () => current && alsoMake.length && void run("Also make", async () => {
    const made = (await api.designVariants(pane.id, current.id, { formatIds: alsoMake, requestId: request?.id ?? null })).assets;
    setAlsoMake([]);
    return made;
  });
  const deliver = () => request && current && void run("Send", async () => {
    await api.deliverDesignRequest(pane.id, request.id, { assetIds: [current.id] });
    setMessage(`Sent to ${request.requester.label}.`);
    onClearRequest();
    return null;
  });

  const previewStyle = current ? { aspectRatio: `${current.width} / ${current.height}` } : format ? { aspectRatio: `${format.width} / ${format.height}` } : undefined;
  return (
    <div className="dz-studio" aria-label="Studio">
      {request ? (
        <div className="dz-request-banner" role="status">
          <span>Working on <strong>{request.requester.label}</strong>'s request</span>
          <button type="button" className="jc-button ghost" onClick={onClearRequest}>Close</button>
        </div>
      ) : null}
      <div className="dz-studio-grid">
        <div className="dz-controls jc-form">
          <label className="jc-field"><span>Brief</span>
            <textarea rows={3} value={brief} maxLength={4000} placeholder="What the graphic shows, its mood and what it is for" onChange={(event) => setBrief(event.target.value)} /></label>
          <label className="jc-field"><span>Format</span>
            <select value={formatId} onChange={(event) => setFormatId(event.target.value)} aria-label="Format">
              {DESIGN_NETWORKS.map((network) => (
                <optgroup key={network} label={DESIGN_NETWORK_LABELS[network]}>
                  {DESIGN_FORMATS.filter((entry) => entry.network === network).map((entry) => <option key={entry.id} value={entry.id}>{entry.label} · {entry.width}×{entry.height}</option>)}
                </optgroup>
              ))}
              <option value={CUSTOM}>Custom size…</option>
            </select></label>
          {formatId === CUSTOM ? (
            <div className="dz-custom-size">
              <label className="jc-field"><span>Width</span><input type="number" min={64} max={4096} value={custom.width} aria-label="Custom width" onChange={(event) => setCustom({ ...custom, width: Number(event.target.value) })} /></label>
              <label className="jc-field"><span>Height</span><input type="number" min={64} max={4096} value={custom.height} aria-label="Custom height" onChange={(event) => setCustom({ ...custom, height: Number(event.target.value) })} /></label>
            </div>
          ) : null}
          <div className="dz-row">
            <label className="jc-field"><span>Engine</span>
              <select value={engine} onChange={(event) => setEngine(event.target.value as DesignEngine)} aria-label="Engine">
                {DESIGN_ENGINES.map((id) => <option key={id} value={id}>{DESIGN_ENGINE_LABELS[id]}</option>)}
              </select></label>
            <label className="jc-field"><span>Brand kit</span>
              <select value={brandKitId} onChange={(event) => setBrandKitId(event.target.value)} aria-label="Brand kit">
                {brandKits.map((kit) => <option key={kit.id} value={kit.id}>{kit.name}{kit.builtIn ? " (built in)" : ""}</option>)}
              </select></label>
          </div>
          {engine !== "MOTION" ? (
            <>
              <label className="jc-field"><span>Template</span>
                <select value={templateId} onChange={(event) => setTemplateId(event.target.value as DesignTemplateId)} aria-label="Template">
                  {DESIGN_TEMPLATE_IDS.map((id) => <option key={id} value={id}>{DESIGN_TEMPLATE_LABELS[id]}</option>)}
                </select></label>
              <label className="jc-field"><span>Headline</span><input value={fields.headline} maxLength={140} onChange={(event) => setFields({ ...fields, headline: event.target.value })} /></label>
              <label className="jc-field"><span>Subline</span><input value={fields.subline} maxLength={280} onChange={(event) => setFields({ ...fields, subline: event.target.value })} /></label>
              <label className="jc-field"><span>Call to action</span><input value={fields.cta} maxLength={40} onChange={(event) => setFields({ ...fields, cta: event.target.value })} /></label>
              <div className="dz-row">
                <label className="jc-field"><span>Primary colour</span><input type="color" value={fields.primary || "#67d9f5"} aria-label="Primary colour" onChange={(event) => setFields({ ...fields, primary: event.target.value })} /></label>
                <label className="jc-field"><span>Background colour</span><input type="color" value={fields.background || "#0a0e24"} aria-label="Background colour" onChange={(event) => setFields({ ...fields, background: event.target.value })} /></label>
                {fields.primary || fields.background ? <button type="button" className="jc-button ghost" onClick={() => setFields({ ...fields, primary: "", background: "" })}>Brand colours</button> : null}
              </div>
            </>
          ) : <p className="jc-muted">Motion (MP4/GIF) is rendered by this pane's designer with HyperFrames: Make sends it the brief as a request.</p>}
          <div className="jc-actions">
            <button type="button" className="jc-button primary" disabled={Boolean(busy)} onClick={make}>{busy === "Make" ? "Making…" : engine === "MOTION" ? "Ask the designer" : "Make"}</button>
            {current?.templateId ? <button type="button" className="jc-button" disabled={Boolean(busy)} onClick={reRender} title="Render the current design again with the fields above"><RefreshCw aria-hidden="true" /> Update text</button> : null}
          </div>
          {message ? <p className="jc-message" role="status">{message}</p> : null}
        </div>
        <div className="dz-preview-column">
          <figure className="dz-preview" style={previewStyle} aria-label="Preview">
            {current ? (current.mimeType === "video/mp4"
              ? <video src={api.artifactFileUrl(current.artifactId)} controls muted playsInline />
              : <img src={api.artifactFileUrl(current.artifactId)} alt={current.label ?? `Design at ${current.width}×${current.height}`} />)
              : <figcaption className="jc-muted">{format ? `${format.label} · ${format.width}×${format.height}` : "Pick a format"}</figcaption>}
          </figure>
          {current ? (
            <div className="dz-preview-actions">
              <span className="jc-muted">{resolveDesignFormat(current.formatId)?.label ?? current.formatId} · {current.width}×{current.height} · in Media</span>
              <a className="jc-button ghost" href={api.agentFileDownloadUrl(current.artifactId)} download><Download aria-hidden="true" /> Download</a>
              {request ? <button type="button" className="jc-button primary" disabled={Boolean(busy)} onClick={deliver}><Send aria-hidden="true" /> Send to {request.requester.label}</button> : null}
            </div>
          ) : null}
          {current && current.mimeType !== "video/mp4" ? (
            <div className="dz-also-make">
              <label className="jc-field"><span>Also make</span>
                <select multiple value={alsoMake} aria-label="Also make in other formats" onChange={(event) => setAlsoMake([...event.target.selectedOptions].map((option) => option.value))}>
                  {DESIGN_FORMATS.filter((entry) => entry.id !== current.formatId).map((entry) => <option key={entry.id} value={entry.id}>{DESIGN_NETWORK_LABELS[entry.network]} · {entry.label} · {entry.width}×{entry.height}</option>)}
                </select></label>
              <button type="button" className="jc-button" disabled={Boolean(busy) || alsoMake.length === 0} onClick={resize}><Copy aria-hidden="true" /> {busy === "Also make" ? "Making…" : `Make ${alsoMake.length || ""} more`}</button>
            </div>
          ) : null}
          {recent.length ? (
            <ul className="dz-variants" aria-label="Variants">
              {recent.map((asset) => (
                <li key={asset.id}>
                  <button type="button" className={`dz-thumb${asset.id === currentId ? " selected" : ""}`} aria-pressed={asset.id === currentId} onClick={() => setCurrentId(asset.id)}
                    title={`${resolveDesignFormat(asset.formatId)?.label ?? asset.formatId} · ${asset.width}×${asset.height}`}>
                    {asset.mimeType === "video/mp4" ? <span className="dz-thumb-video">MP4</span> : <img src={api.artifactFileUrl(asset.artifactId)} alt="" loading="lazy" />}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </div>
  );
}
