import { useEffect, useMemo, useState } from "react";
import {
  DESIGN_BRIEF_MAX, DESIGN_COLOR_PRESETS, DESIGN_COLOR_PRESETS_MAX, DESIGN_ENGINE_LABELS, DESIGN_ENGINES, DESIGN_FORMATS, DESIGN_NETWORK_LABELS, DESIGN_NETWORKS, DESIGN_REQUEST_MAX_FORMATS, DESIGN_TEMPLATE_IDS, DESIGN_TEMPLATE_LABELS, designCustomFormatRef, resolveDesignFormat, SPACEAPP_BRAND_KIT,
  type DesignAsset, type DesignColorPreset, type DesignBrandKit, type DesignEngine, type DesignPaneSettings, type DesignRequest, type DesignTemplateId, type Pane
} from "@space/contracts";
import { api } from "../../api.js";
import { dispatchArtifactsUpdated } from "../../artifact-events.js";
import { FileInfoDialog } from "../file-info/FileInfoDialog.js";
import { icoFromImage } from "./ico.js";
import { AgentFiles, Copy, Crop, Download, Info, Paperclip, RefreshCw, Send, Trash2 } from "../ui-theme/app-icons.js";
import { DesignSnipEditor } from "./DesignSnipEditor.js";

/** The Agent Files folder "Save to Agent Files" copies a design into (shown as Graphics / Design). */
export const DESIGN_AGENT_FILES_FOLDER = "GRAPHICS/Design";
/** A design's file name for downloads and Agent Files copies. */
export function designAssetFileName(asset: Pick<DesignAsset, "formatId" | "mimeType">): string {
  return `design-${asset.formatId}.${asset.mimeType.split("/")[1]?.replace("jpeg", "jpg") ?? "png"}`;
}

export interface StudioViewProps {
  pane: Pane;
  settings: DesignPaneSettings;
  assets: DesignAsset[];
  brandKits: DesignBrandKit[];
  /** The request the operator opened from the Requests tab: deliveries go to its requester. */
  request: DesignRequest | null;
  onChanged(): void;
  onClearRequest(): void;
  /** Files for the designer (photos, logos, references) go to its CLI through the terminal's upload. */
  onUploadFiles(): void;
}

interface Fields { headline: string; subline: string; cta: string; primary: string; accent: string; background: string; text: string }
const EMPTY_FIELDS: Fields = { headline: "", subline: "", cta: "", primary: "", accent: "", background: "", text: "" };
/** The colours the templates use; an empty field keeps the brand kit's. */
const COLOR_KEYS = ["primary", "accent", "background", "text"] as const;
const COLOR_LABELS: Record<(typeof COLOR_KEYS)[number], string> = { primary: "Primary colour", accent: "Accent colour", background: "Background colour", text: "Text colour" };
const sameColors = (fields: Fields, preset: DesignColorPreset) => COLOR_KEYS.every((key) => fields[key].toLowerCase() === preset[key].toLowerCase());
const CUSTOM = "custom";

/** The template fields the renderer accepts: text, and colours only when the operator set them. */
function templateParams(fields: Fields): Record<string, unknown> {
  const colors = Object.fromEntries(COLOR_KEYS.filter((key) => fields[key]).map((key) => [key, fields[key]]));
  return {
    ...(fields.headline.trim() ? { headline: fields.headline.trim() } : {}), ...(fields.subline.trim() ? { subline: fields.subline.trim() } : {}),
    ...(fields.cta.trim() ? { cta: fields.cta.trim() } : {}), ...(Object.keys(colors).length ? { colors } : {})
  };
}

/**
 * The Studio: a brief, a format (grouped by network, or a custom size), an engine, a brand kit and a template with its fields.
 * Templates render at once; an image engine generates the picture and composes it at the exact size; Motion asks this pane's
 * designer. Every result is a pinned Media asset; text edits re-render; "Also make" lays a template out again at each size and asks
 * the designer to remake a picture (never a crop).
 */
export function StudioView({ pane, settings, assets, brandKits, request, onChanged, onClearRequest, onUploadFiles }: StudioViewProps) {
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
  const [editing, setEditing] = useState(false);
  const [details, setDetails] = useState(false);
  const [ownColors, setOwnColors] = useState<DesignColorPreset[]>([]);
  const [colorsName, setColorsName] = useState("");

  // The operator's own colour combinations live in user settings, shared by every Design pane.
  useEffect(() => {
    let live = true;
    api.userSettings().then((saved) => { if (live) setOwnColors(saved.designColorPresets ?? []); }).catch(() => undefined);
    return () => { live = false; };
  }, []);

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
  // A template lays itself out again at each size; a picture would only be cropped, so the designer remakes it per format.
  const resize = () => current && alsoMake.length && void run("Also make", async () => {
    const backgroundAssetId = (current.params as { backgroundAssetId?: string | null } | null)?.backgroundAssetId ?? null;
    if (current.templateId && !backgroundAssetId) {
      const made = (await api.designVariants(pane.id, current.id, { formatIds: alsoMake, requestId: request?.id ?? null })).assets;
      setAlsoMake([]);
      return made;
    }
    if (alsoMake.length > DESIGN_REQUEST_MAX_FORMATS) throw new Error(`Pick at most ${DESIGN_REQUEST_MAX_FORMATS} formats at once.`);
    const prompt = current.prompt ?? assets.find((asset) => asset.id === backgroundAssetId)?.prompt ?? null;
    const formats = alsoMake.map((id) => resolveDesignFormat(id)?.label ?? id).join(", ");
    await api.createDesignRequest(pane.id, {
      brief: `Remake the attached design for ${formats}: the same content and style, laid out again for each size, with a new picture made at that size wherever the original would have to be cropped or stretched.${prompt ? ` The picture's prompt was: ${prompt}` : ""}`.slice(0, DESIGN_BRIEF_MAX),
      formatIds: alsoMake, referenceArtifactIds: [current.artifactId], ...(current.brandKitId ? { brandKitId: current.brandKitId } : {})
    });
    setAlsoMake([]);
    setMessage("The designer remakes it for each format in this pane; the results appear in the Requests tab.");
    return null;
  });
  // A copy of the Media asset in Agent Files, so it is listed and downloadable with the room's other files.
  const saveToAgentFiles = () => current && void run("Save", async () => {
    const response = await fetch(api.artifactFileUrl(current.artifactId), { credentials: "same-origin" });
    if (!response.ok) throw new Error(`The design could not be read (${response.status}).`);
    const file = new File([await response.blob()], designAssetFileName(current), { type: current.mimeType });
    const { artifacts } = await api.uploadAgentFiles({ roomId: pane.roomId, files: [file], folder: DESIGN_AGENT_FILES_FOLDER });
    dispatchArtifactsUpdated(pane.roomId, artifacts);
    setMessage("Saved to Agent Files › Graphics / Design.");
    return null;
  });
  // A square design as a favicon / app icon file (16-256 px inside one .ico).
  const downloadIco = () => current && void run("Icon", async () => {
    const response = await fetch(api.artifactFileUrl(current.artifactId), { credentials: "same-origin" });
    if (!response.ok) throw new Error(`The design could not be read (${response.status}).`);
    const url = URL.createObjectURL(await icoFromImage(await response.blob()));
    Object.assign(document.createElement("a"), { href: url, download: `design-${current.formatId}.ico` }).click();
    URL.revokeObjectURL(url);
    return null;
  });
  const kitColors = (brandKits.find((kit) => kit.id === brandKitId) ?? SPACEAPP_BRAND_KIT).colors;
  const colorsSet = COLOR_KEYS.some((key) => fields[key]);
  const builtInColors = DESIGN_COLOR_PRESETS.find((preset) => colorsSet && sameColors(fields, preset));
  const yourColors = ownColors.find((preset) => colorsSet && sameColors(fields, preset));
  const colorsChoice = !colorsSet ? "" : yourColors ? `own:${yourColors.name}` : builtInColors ? `built-in:${builtInColors.name}` : "custom";
  const pickColors = (choice: string) => {
    const preset = choice.startsWith("own:") ? ownColors.find((entry) => `own:${entry.name}` === choice) : DESIGN_COLOR_PRESETS.find((entry) => `built-in:${entry.name}` === choice);
    setFields({ ...fields, ...Object.fromEntries(COLOR_KEYS.map((key) => [key, preset?.[key] ?? ""])) });
  };
  // Each change applies to the saved list read just now, so a failed load or another pane's save is never overwritten.
  async function storeOwnColors(change: (saved: DesignColorPreset[]) => DesignColorPreset[] | string, done: string) {
    try {
      const next = change((await api.userSettings()).designColorPresets ?? []);
      if (typeof next === "string") { setMessage(next); return; }
      const saved = await api.updateUserSettings({ designColorPresets: next });
      setOwnColors(saved.designColorPresets ?? next);
      setMessage(done);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The colours could not be saved.");
    }
  }
  // A saved combination keeps all four colours: the ones left empty take the brand kit's.
  const saveColors = () => {
    const name = colorsName.trim();
    if (!name) return;
    const preset = { name, ...Object.fromEntries(COLOR_KEYS.map((key) => [key, fields[key] || kitColors[key]])) } as DesignColorPreset;
    setColorsName("");
    void storeOwnColors((saved) => {
      const others = saved.filter((entry) => entry.name !== name);
      return others.length >= DESIGN_COLOR_PRESETS_MAX ? `You have ${DESIGN_COLOR_PRESETS_MAX} saved colour combinations: delete one first.` : [...others, preset];
    }, `Saved the colours “${name}”.`);
  };
  const deleteColors = () => yourColors && void storeOwnColors((saved) => saved.filter((entry) => entry.name !== yourColors.name), `Deleted the colours “${yourColors.name}”.`);
  // Same as the Library's Remove: the design leaves the library and its Media file expires in 7 days.
  const remove = () => current && void run("Delete", async () => {
    await api.deleteDesignAsset(pane.id, current.id);
    setCurrentId(null);
    setMessage("Deleted from the library; its Media file expires in 7 days.");
    return null;
  });
  const deliver = () => request && current && void run("Send", async () => {
    await api.deliverDesignRequest(pane.id, request.id, { assetIds: [current.id] });
    setMessage(`Sent to ${request.requester.label}.`);
    onClearRequest();
    return null;
  });

  const size = current ?? format;
  // The width is capped so a tall format fits 62vh with its ratio intact (a height cap alone cropped the image's bottom).
  const previewStyle = size ? { aspectRatio: `${size.width} / ${size.height}`, width: `min(100%, calc(62vh * ${size.width} / ${size.height}))` } : undefined;
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
            </select><small className="jc-muted">The size of the picture: each network's post, banner and story sizes, or your own.</small></label>
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
              </select><small className="jc-muted">The logo, colours and fonts the design uses.</small></label>
          </div>
          {engine !== "MOTION" ? (
            <>
              <label className="jc-field"><span>Template</span>
                <select value={templateId} onChange={(event) => setTemplateId(event.target.value as DesignTemplateId)} aria-label="Template">
                  {DESIGN_TEMPLATE_IDS.map((id) => <option key={id} value={id}>{DESIGN_TEMPLATE_LABELS[id]}</option>)}
                </select><small className="jc-muted">A ready layout that places your text and the logo; it re-lays out for every format.</small></label>
              <label className="jc-field"><span>Headline</span><input value={fields.headline} maxLength={140} aria-label="Headline" onChange={(event) => setFields({ ...fields, headline: event.target.value })} /><small className="jc-muted">The big title, a few words.</small></label>
              <label className="jc-field"><span>Subline</span><input value={fields.subline} maxLength={280} aria-label="Subline" onChange={(event) => setFields({ ...fields, subline: event.target.value })} /><small className="jc-muted">One smaller line under the title.</small></label>
              <label className="jc-field"><span>Call to action</span><input value={fields.cta} maxLength={40} aria-label="Call to action" onChange={(event) => setFields({ ...fields, cta: event.target.value })} /><small className="jc-muted">The button text, such as “Try it”.</small></label>
              <label className="jc-field"><span>Colours</span>
                <select value={colorsChoice} aria-label="Colours" onChange={(event) => pickColors(event.target.value)}>
                  <option value="">Brand kit colours</option>
                  {colorsChoice === "custom" ? <option value="custom" disabled>Custom colours</option> : null}
                  <optgroup label="Ready-made">{DESIGN_COLOR_PRESETS.map((preset) => <option key={preset.name} value={`built-in:${preset.name}`}>{preset.name}</option>)}</optgroup>
                  {ownColors.length ? <optgroup label="Yours">{ownColors.map((preset) => <option key={preset.name} value={`own:${preset.name}`}>{preset.name}</option>)}</optgroup> : null}
                </select><small className="jc-muted">A colour combination: ready-made ones and the ones you saved.</small></label>
              {[COLOR_KEYS.slice(0, 2), COLOR_KEYS.slice(2)].map((pair) => (
                <div className="dz-row" key={pair.join("-")}>
                  {pair.map((key) => (
                    <label key={key} className="jc-field"><span>{COLOR_LABELS[key]}</span>
                      <input type="color" value={(fields[key] || kitColors[key]).toLowerCase()} aria-label={COLOR_LABELS[key]} onChange={(event) => setFields({ ...fields, [key]: event.target.value })} /></label>
                  ))}
                </div>
              ))}
              <small className="jc-muted">Primary: the button, badges, links and the title's highlight. Accent: glows and gradients. Text: titles and lines. Brand kit colours brings the kit's back.</small>
              <div className="dz-row">
                <label className="jc-field"><span>Save these colours as</span>
                  <input value={colorsName} maxLength={40} placeholder="Name, e.g. Launch week" aria-label="Colour combination name" onChange={(event) => setColorsName(event.target.value)} /></label>
                <button type="button" className="jc-button" disabled={!colorsName.trim()} onClick={saveColors}>Save colours</button>
                {yourColors ? <button type="button" className="jc-button ghost" onClick={deleteColors}>Delete “{yourColors.name}”</button> : null}
              </div>
            </>
          ) : <p className="jc-muted">Motion (MP4/GIF) is rendered by this pane's designer with HyperFrames: Make sends it the brief as a request.</p>}
          <div className="jc-actions">
            <button type="button" className="jc-button primary" disabled={Boolean(busy)} onClick={make}>{busy === "Make" ? "Making…" : engine === "MOTION" ? "Ask the designer" : "Make"}</button>
            {current?.templateId ? <button type="button" className="jc-button" disabled={Boolean(busy)} onClick={reRender} title="Render the current design again with the fields above"><RefreshCw aria-hidden="true" /> Update text</button> : null}
            <button type="button" className="jc-button ghost" onClick={onUploadFiles} title="Upload files to the designer's CLI"><Paperclip aria-hidden="true" /> Upload files</button>
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
              {current.mimeType !== "video/mp4" ? <button type="button" className="jc-button ghost" disabled={Boolean(busy)} onClick={() => setEditing(true)}><Crop aria-hidden="true" /> Crop or annotate</button> : null}
              <a className="jc-button ghost" href={api.artifactFileUrl(current.artifactId)} download={designAssetFileName(current)}><Download aria-hidden="true" /> Download</a>
              {current.mimeType !== "video/mp4" && current.width === current.height ? <button type="button" className="jc-button ghost" disabled={Boolean(busy)} onClick={downloadIco} title="A favicon / app icon file with 16 to 256 px sizes"><Download aria-hidden="true" /> {busy === "Icon" ? "Making the icon…" : "Download .ico"}</button> : null}
              <button type="button" className="jc-button ghost" onClick={() => setDetails(true)} title="What it shows, who made it, its metadata"><Info aria-hidden="true" /> Details</button>
              <button type="button" className="jc-button ghost" disabled={Boolean(busy)} onClick={saveToAgentFiles}><AgentFiles aria-hidden="true" /> {busy === "Save" ? "Saving…" : "Save to Agent Files"}</button>
              <button type="button" className="jc-button ghost" disabled={Boolean(busy)} onClick={remove} aria-label="Delete this design" title="Delete this design from the library"><Trash2 aria-hidden="true" /> Delete</button>
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
      {details && current ? <FileInfoDialog artifactId={current.artifactId} filename={designAssetFileName(current)} asset={current} onClose={() => setDetails(false)} /> : null}
      {editing && current ? <DesignSnipEditor paneId={pane.id} asset={current} onClose={() => setEditing(false)}
        onSaved={(saved) => { setEditing(false); setCurrentId(saved.id); setMessage("Saved as a new version."); onChanged(); }} /> : null}
    </div>
  );
}
