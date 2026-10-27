import { useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import {
  DESIGN_NETWORK_LABELS, VIDEO_BRIEF_MAX, VIDEO_CAPTION_STYLES, VIDEO_FILTERS, VIDEO_FORMATS, VIDEO_REQUEST_MAX_SOURCES, VIDEO_TECHNIQUE_LABELS, VIDEO_TECHNIQUES, VIDEO_TIMELINE_MAX_OUTPUTS,
  VIDEO_TRANSITIONS, VIDEO_TTS_LANGUAGES, agentFilesFolderLabel, resolveVideoFormat, type Artifact, type DesignFormat, type Pane, type VideoAsset, type VideoCaptionStyle, type VideoFilter,
  type VideoPaneSettings, type VideoRequest, type VideoTechnique, type VideoTransition
} from "@space/contracts";
import { api } from "../../api.js";
import { FileInfoDialog } from "../file-info/FileInfoDialog.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { AgentFiles, Check, Download, Film, Info, Music2, Plus, Trash2, Upload } from "../ui-theme/app-icons.js";
import { VIDEO_STATUS_LABEL, formatLabels } from "./RequestsTab.js";

const EXTENSIONS: Record<string, string> = { "video/mp4": "mp4", "video/webm": "webm", "image/png": "png", "audio/mpeg": "mp3", "audio/wav": "wav" };
/** An asset's file name for downloads and Agent Files copies. */
export function videoAssetFileName(asset: Pick<VideoAsset, "formatId" | "mimeType" | "kind">): string {
  return `video-${asset.formatId ?? asset.kind.toLowerCase()}.${EXTENSIONS[asset.mimeType] ?? "mp4"}`;
}
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return "";
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
const displayNames = typeof Intl.DisplayNames === "function" ? new Intl.DisplayNames(["en"], { type: "language" }) : null;
export const languageName = (tag: string) => { try { return displayNames?.of(tag) ?? tag; } catch { return tag; } };
/** A length the file really has: a probe that read none (a WebM recording's header) says 0. */
const knownDuration = (seconds: number | null) => seconds !== null && seconds >= 0.5 ? seconds : null;
export const metaLine = (asset: VideoAsset) => [resolveVideoFormat(asset.formatId ?? "")?.label, asset.width && asset.height ? `${asset.width}×${asset.height}` : null, formatDuration(knownDuration(asset.durationSec)) || null].filter(Boolean).join(" · ");

/** The file as the browser plays it: a video with its poster, an audio track, or a still. */
export function AssetMedia({ artifactId, mimeType, posterArtifactId = null, label }: { artifactId: string; mimeType: string; posterArtifactId?: string | null; label?: string | null }) {
  const src = api.artifactFileUrl(artifactId);
  if (mimeType.startsWith("video/")) return <video controls preload="metadata" playsInline src={src} poster={posterArtifactId ? api.artifactFileUrl(posterArtifactId) : undefined} aria-label={label ?? "Video"} />;
  if (mimeType.startsWith("audio/")) return <audio controls preload="metadata" src={src} aria-label={label ?? "Audio"} />;
  return <img src={src} alt={label ?? ""} loading="lazy" />;
}

/** Copies a file into Agent Files › Media / Video on the server and answers the line the Studio and the Library show. */
export async function saveToAgentFiles(paneId: string, artifactId: string): Promise<string> {
  const saved = await api.saveVideoToAgentFiles(paneId, artifactId);
  return saved.alreadyThere ? `Already in Agent Files › ${agentFilesFolderLabel(saved.folder)}.` : `Saved to Agent Files › ${agentFilesFolderLabel(saved.folder)}.`;
}
/** Deletes a file for good (library and Media) and answers the line the Studio and the Library show. */
export async function deleteVideoFile(paneId: string, artifactId: string, label: string): Promise<string> {
  const deleted = await api.deleteVideoFile(paneId, artifactId);
  return deleted.keptInAgentFiles ? `Removed “${label}” from the Video library; the file stays in Agent Files.` : `Deleted “${label}”.`;
}

/** A file the Studio shows: a source to cut (an upload, a recording, a room Media file) or an output of a request. */
interface StudioItem { artifactId: string; label: string; mimeType: string; posterId: string | null; durationSec: number | null; width: number | null; height: number | null; asset: VideoAsset | null; output: boolean }
const mediaLabel = (artifact: Artifact) => (typeof artifact.metadata.originalFilename === "string" && artifact.metadata.originalFilename) || (artifact.kind === "AUDIO" || artifact.mimeType.startsWith("audio/") ? "Audio" : "Video");
const assetItem = (asset: VideoAsset, output: boolean): StudioItem => ({
  artifactId: asset.artifactId, label: output ? asset.label ?? resolveVideoFormat(asset.formatId ?? "")?.label ?? "Output" : asset.label ?? asset.description ?? asset.kind.toLowerCase(), mimeType: asset.mimeType,
  posterId: asset.thumbnailArtifactId, durationSec: asset.durationSec, width: asset.width, height: asset.height, asset, output
});
const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
/** "9:16" for the usual shapes, "1.91:1" for the others (1080×566). */
export function ratioText(width: number, height: number): string {
  const divisor = gcd(width, height);
  return width / divisor <= 21 && height / divisor <= 21 ? `${width / divisor}:${height / divisor}` : `${(width / height).toFixed(2).replace(/\.?0+$/, "")}:1`;
}
const itemMeta = (item: StudioItem, seconds: number | null) => [item.output ? null : item.asset ? (item.asset.kind === "RECORDING" ? "Recording" : "Upload") : "Room media",
  item.width && item.height ? `${item.width}×${item.height}` : null, formatDuration(seconds) || null].filter(Boolean).join(" · ");

const OPTION_LABELS: Record<string, string> = {
  auto: "Auto", bw: "Black & white", fadeblack: "Fade through black", fadewhite: "Fade through white", wipeleft: "Wipe left", wiperight: "Wipe right", slideup: "Slide up",
  slidedown: "Slide down", circleopen: "Circle open", smoothleft: "Smooth left", zoomin: "Zoom in"
};
export const optionLabel = (id: string) => OPTION_LABELS[id] ?? `${id[0]?.toUpperCase() ?? ""}${id.slice(1).replace(/-/g, " ")}`;
const TECHNIQUE_HINTS: Record<VideoTechnique, string> = {
  silence: "Cuts the pauses and dead air out of what is said.",
  scene: "Cuts where the picture changes from one shot to the next.",
  highlights: "Keeps the strongest moments of what is said.",
  manual: "The brief says where to cut."
};
/** The formats by network, in the order the catalogue lists them; each chip shows its shape and the part of its name after the network. */
const FORMAT_GROUPS = (() => {
  const groups = new Map<DesignFormat["network"], DesignFormat[]>();
  for (const format of VIDEO_FORMATS) groups.set(format.network, [...groups.get(format.network) ?? [], format]);
  return [...groups.entries()];
})();
const shortFormatLabel = (format: DesignFormat) => {
  const rest = format.label.replace(new RegExp(`^${DESIGN_NETWORK_LABELS[format.network].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`), "");
  return rest ? `${rest[0]!.toUpperCase()}${rest.slice(1)}` : format.label;
};

/** The formats by network: a chip per format with its shape, the part of its name after the network, and its ratio. */
export function FormatPicker({ label, value, onToggle, disabled = false }: { label: string; value: readonly string[]; onToggle(id: string): void; disabled?: boolean }) {
  return (
    <div className="vd-formats" role="group" aria-label={label}>
      {FORMAT_GROUPS.map(([network, formats]) => (
        <div key={network} className="vd-format-row">
          <span className="vd-format-network">{DESIGN_NETWORK_LABELS[network]}</span>
          <span className="vd-format-chips">
            {formats.map((format) => (
              <button key={format.id} type="button" role="checkbox" aria-checked={value.includes(format.id)} aria-label={format.label} className={`vd-format${value.includes(format.id) ? " selected" : ""}`}
                disabled={disabled} title={`${format.width}×${format.height}${format.maxDurationSec ? ` · up to ${format.maxDurationSec} s` : ""}`} onClick={() => onToggle(format.id)}>
                <span className="vd-ratio" style={{ aspectRatio: `${format.width} / ${format.height}` }} aria-hidden="true" />
                {shortFormatLabel(format)}<small>{ratioText(format.width, format.height)}</small>
              </button>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}

const select = <T extends string>(label: string, value: T, options: readonly T[], onChange: (next: T) => void, disabled: boolean) => (
  <label className="jc-field"><span>{label}</span>
    <select value={value} disabled={disabled} aria-label={label} onChange={(event) => onChange(event.target.value as T)}>{options.map((id) => <option key={id} value={id}>{optionLabel(id)}</option>)}</select></label>
);

/** A tile of the Sources or Outputs shelf: a frame of the file (its poster, else the browser's first frame), its length and name; sources have a pick check. */
function Tile({ item, current, pickOrder, onOpen, onPick }: { item: StudioItem; current: boolean; pickOrder: number; onOpen(): void; onPick?: () => void }) {
  const [seconds, setSeconds] = useState<number | null>(null);
  const duration = knownDuration(item.durationSec) ?? seconds;
  const format = item.asset?.formatId ? resolveVideoFormat(item.asset.formatId) : null;
  return (
    <li className="vd-tile" data-current={current ? "true" : undefined} data-picked={pickOrder ? "true" : undefined}>
      <button type="button" className="vd-tile-open" title={`Preview ${item.label}`} aria-current={current ? "true" : undefined} onClick={onOpen}>
        <span className="vd-tile-thumb">
          {item.posterId ? <img src={api.artifactFileUrl(item.posterId)} alt="" loading="lazy" />
            : item.mimeType.startsWith("audio/") ? <Music2 aria-hidden="true" />
            // The browser's first frame stands in for a poster the file never got (uploads, room Media).
            : <video src={`${api.artifactFileUrl(item.artifactId)}#t=0.5`} preload="metadata" muted playsInline tabIndex={-1} aria-hidden="true"
                onLoadedMetadata={(event) => setSeconds(knownDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : null))} />}
          {format ? <span className="vd-tile-tag">{ratioText(format.width, format.height)}</span> : null}
          {duration ? <span className="vd-tile-time">{formatDuration(duration)}</span> : null}
        </span>
        <span className="vd-tile-label">{item.label}</span>
      </button>
      {onPick ? (
        <button type="button" role="checkbox" aria-checked={pickOrder > 0} className="vd-tile-pick" aria-label={`Use ${item.label} in the video`}
          title={pickOrder ? `Source ${pickOrder} of the video: click to leave it out` : "Use in the video"} onClick={onPick}>{pickOrder ? pickOrder : <Plus aria-hidden="true" />}</button>
      ) : null}
    </li>
  );
}

export interface StudioViewProps {
  pane: Pane;
  settings: VideoPaneSettings;
  assets: VideoAsset[];
  requests: VideoRequest[];
  /** The room's Media videos and audio tracks. */
  media: Artifact[];
  /** The request the operator opened from the Requests tab, else the newest one is shown. */
  request: VideoRequest | null;
  onChanged(): void;
  onSelectRequest(request: VideoRequest | null): void;
  onFindMusic(): void;
}

/**
 * The Studio: a Sources shelf (uploads, recordings and the room's Media), the player with what can be done to the file on it
 * (use it, download, save to Agent Files, details, delete), the shown request's outputs, and the Make form beside them.
 */
export function StudioView({ pane, settings, assets, requests, media, request, onChanged, onSelectRequest, onFindMusic }: StudioViewProps) {
  const [brief, setBrief] = useState("");
  const [technique, setTechnique] = useState<VideoTechnique>(settings.technique);
  const [formatIds, setFormatIds] = useState<string[]>(settings.defaultFormatIds);
  const [transition, setTransition] = useState<VideoTransition>(settings.transition);
  const [filter, setFilter] = useState<VideoFilter>(settings.filter);
  const [captions, setCaptions] = useState<VideoCaptionStyle>(settings.captions);
  const [narrationOn, setNarrationOn] = useState(false);
  const [narrationLanguage, setNarrationLanguage] = useState(settings.narration.language);
  const [narrationVoice, setNarrationVoice] = useState(settings.narration.voice);
  const [narrationText, setNarrationText] = useState("");
  const [musicId, setMusicId] = useState("");
  const [maxDuration, setMaxDuration] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [fileMessage, setFileMessage] = useState<string | null>(null);
  const [details, setDetails] = useState<StudioItem | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const sources = useMemo(() => {
    // Files the library already has a place for (outputs, narration, music, posters) are not sources.
    const library = new Set(assets.flatMap((asset) => [asset.artifactId, asset.thumbnailArtifactId]).filter(Boolean));
    const seen = new Set<string>();
    const list: StudioItem[] = [];
    for (const asset of assets) if ((asset.kind === "UPLOAD" || asset.kind === "RECORDING") && !seen.has(asset.artifactId)) { seen.add(asset.artifactId); list.push(assetItem(asset, false)); }
    for (const artifact of media) if (!seen.has(artifact.id) && !library.has(artifact.id)) {
      seen.add(artifact.id);
      list.push({ artifactId: artifact.id, label: mediaLabel(artifact), mimeType: artifact.mimeType, posterId: null, durationSec: null, width: null, height: null, asset: null, output: false });
    }
    return list;
  }, [assets, media]);
  const music = useMemo(() => assets.filter((asset) => asset.kind === "MUSIC"), [assets]);
  const shown = useMemo(() => request ?? [...requests].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null, [request, requests]);
  const outputs = useMemo(() => (shown ? assets.filter((asset) => asset.kind === "OUTPUT" && asset.requestId === shown.id) : assets.filter((asset) => asset.kind === "OUTPUT").slice(0, 8))
    .map((asset) => assetItem(asset, true)), [assets, shown]);
  // The player shows what the operator opened; until then (or once it is deleted) the newest output, else the first source.
  const current = useMemo(() => [...outputs, ...sources].find((item) => item.artifactId === currentId) ?? outputs[0] ?? sources[0] ?? null, [currentId, outputs, sources]);
  const languages = useMemo(() => Object.keys(VIDEO_TTS_LANGUAGES).sort((left, right) => languageName(left).localeCompare(languageName(right))), []);
  const pickedItems = useMemo(() => selected.map((id) => sources.find((item) => item.artifactId === id)).filter((item): item is StudioItem => Boolean(item)), [selected, sources]);

  async function run(label: string, action: () => Promise<string>, show: (text: string | null) => void = setMessage) {
    if (busy) return;
    setBusy(label);
    show(null);
    try { show(await action()); onChanged(); }
    catch (error) { show(error instanceof Error ? error.message : `${label} failed.`); }
    finally { setBusy(null); }
  }
  const togglePick = (artifactId: string) => setSelected((current) => current.includes(artifactId) ? current.filter((id) => id !== artifactId)
    : current.length >= VIDEO_REQUEST_MAX_SOURCES ? current : [...current, artifactId]);
  const open = (item: StudioItem) => { setCurrentId(item.artifactId); setConfirming(null); setFileMessage(null); };
  const toggleFormat = (id: string) => setFormatIds((current) => current.includes(id) ? current.filter((entry) => entry !== id) : current.length >= VIDEO_TIMELINE_MAX_OUTPUTS ? current : [...current, id]);
  const upload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void run("Upload", async () => {
      const { asset } = await api.uploadVideoSource(pane.id, file, { label: file.name });
      setSelected((current) => current.includes(asset.artifactId) || current.length >= VIDEO_REQUEST_MAX_SOURCES ? current : [...current, asset.artifactId]);
      setCurrentId(asset.artifactId);
      return `Uploaded ${file.name}${asset.durationSec ? ` (${formatDuration(asset.durationSec)})` : ""}.`;
    }, setFileMessage);
  };
  const make = (event: FormEvent) => {
    event.preventDefault();
    void run("Make", async () => {
      if (!brief.trim()) throw new Error("Say what the video should be.");
      if (!formatIds.length) throw new Error("Pick at least one format.");
      const engines = VIDEO_TTS_LANGUAGES[narrationLanguage] ?? [];
      const seconds = Number.parseInt(maxDuration, 10);
      const created = await api.createVideoRequest(pane.id, {
        brief: brief.trim(), sources: selected.map((artifactId) => ({ artifactId })), formatIds,
        options: {
          technique, transition, filter, captions,
          // The pane's engine unless it does not speak the language: then the first one that does.
          ...(narrationOn ? { narration: { language: narrationLanguage, ...(narrationVoice.trim() ? { voice: narrationVoice.trim() } : {}), ...(narrationText.trim() ? { text: narrationText.trim() } : {}), ...(engines.length && !engines.includes(settings.narration.engine) ? { engine: engines[0] } : {}) } } : {}),
          ...(musicId ? { music: { artifactId: musicId } } : {}),
          ...(seconds > 0 ? { maxDurationSec: seconds } : {})
        }
      });
      onSelectRequest(created.request);
      return created.runStarted ? "Queued: the editor is working on it." : "Queued: the editor takes it at its next free prompt.";
    });
  };
  const approve = () => shown && void run("Approve", async () => { await api.approveVideoRequest(pane.id, shown.id); return `Delivered to ${shown.requester.label}.`; });
  const save = (item: StudioItem) => void run("Save", () => saveToAgentFiles(pane.id, item.artifactId), setFileMessage);
  const remove = (item: StudioItem) => void run("Delete", async () => {
    const done = await deleteVideoFile(pane.id, item.artifactId, item.label);
    setSelected((current) => current.filter((id) => id !== item.artifactId));
    setConfirming(null);
    setCurrentId(null);
    return done;
  }, setFileMessage);

  const currentPicked = current && !current.output ? selected.indexOf(current.artifactId) + 1 : 0;
  const portrait = Boolean(current?.width && current.height && current.height > current.width);
  return (
    <div className="vd-studio">
      {request ? (
        <div className="vd-request-banner" role="status">
          <span>Showing <strong>{request.requester.label}</strong>'s request: {request.brief.slice(0, 120)}</span>
          <button type="button" className="jc-button ghost" onClick={() => onSelectRequest(null)}>Back to the newest</button>
        </div>
      ) : null}
      <section className="vd-section vd-shelf" aria-label="Sources">
        <div className="vd-section-head">
          <h3>Sources</h3>
          <span className="jc-muted">{sources.length ? `${selected.length} of ${VIDEO_REQUEST_MAX_SOURCES} picked · click a video to preview it, + to use it` : "Upload a video to start"}</span>
          <button type="button" className="jc-button primary vd-upload" disabled={Boolean(busy)} onClick={() => fileInput.current?.click()}><Upload aria-hidden="true" /> {busy === "Upload" ? "Uploading…" : "Upload"}</button>
          <input ref={fileInput} type="file" hidden accept="video/*,audio/*" aria-label="Upload a video or audio file" onChange={upload} />
        </div>
        {sources.length ? (
          <ul className="vd-tiles" aria-label="Source files">
            {sources.map((item) => <Tile key={item.artifactId} item={item} current={current?.artifactId === item.artifactId} pickOrder={selected.indexOf(item.artifactId) + 1}
              onOpen={() => open(item)} onPick={() => togglePick(item.artifactId)} />)}
          </ul>
        ) : <p className="vd-empty">No videos in this room's Media yet.</p>}
      </section>
      <div className="vd-studio-grid">
        <div className="vd-stage">
          <figure className="vd-player" aria-label="Player" data-portrait={portrait ? "true" : undefined}>
            {current ? <AssetMedia key={current.artifactId} artifactId={current.artifactId} mimeType={current.mimeType} posterArtifactId={current.posterId} label={current.label} /> : (
              <figcaption className="vd-player-empty"><Film aria-hidden="true" /><span>Upload a video, or pick one from Sources, to preview it here.</span></figcaption>
            )}
          </figure>
          {current ? (
            <div className="vd-stage-bar" role="toolbar" aria-label="This video">
              <div className="vd-stage-title"><strong title={current.label}>{current.label}</strong><span className="jc-muted">{itemMeta(current, knownDuration(current.durationSec))}</span></div>
              <div className="vd-stage-actions">
                {!current.output ? (
                  <button type="button" className={`jc-button${currentPicked ? " selected" : ""}`} aria-pressed={currentPicked > 0} onClick={() => togglePick(current.artifactId)}>
                    {currentPicked ? <Check aria-hidden="true" /> : <Plus aria-hidden="true" />} {currentPicked ? `Source ${currentPicked}` : "Use in the video"}</button>
                ) : null}
                <a className="jc-button" href={api.artifactFileUrl(current.artifactId)} download={current.asset ? videoAssetFileName(current.asset) : current.label}><Download aria-hidden="true" /> Download</a>
                <button type="button" className="jc-button" disabled={Boolean(busy)} title="Copy into Agent Files › Media / Video" onClick={() => save(current)}><AgentFiles aria-hidden="true" /> {busy === "Save" ? "Saving…" : "Save to Agent Files"}</button>
                <button type="button" className="jc-icon-button" aria-label="Details" title="Details: what it shows, who made it, its metadata" onClick={() => setDetails(current)}><Info aria-hidden="true" /></button>
                <button type="button" className="jc-button danger" disabled={Boolean(busy)} onClick={() => setConfirming(current.artifactId)}><Trash2 aria-hidden="true" /> Delete</button>
              </div>
            </div>
          ) : null}
          {current && confirming === current.artifactId ? (
            <div className="vd-confirm" role="alertdialog" aria-label="Delete this file?">
              <span>Delete “{current.label}” for good? It leaves the Video library and the room's Media.</span>
              <button type="button" className="jc-button danger" disabled={Boolean(busy)} onClick={() => remove(current)}>{busy === "Delete" ? "Deleting…" : "Delete"}</button>
              <button type="button" className="jc-button ghost" onClick={() => setConfirming(null)}>Keep it</button>
            </div>
          ) : null}
          {fileMessage ? <p className="jc-message" role="status">{fileMessage}</p> : null}
          {current?.asset?.description || current?.asset?.credits ? (
            <div className="vd-stage-notes">
              {current.asset.description ? <p className="vd-description">{current.asset.description}</p> : null}
              {current.asset.credits ? <p className="vd-credits">Credits: {current.asset.credits}</p> : null}
            </div>
          ) : null}
          <section className="vd-section" aria-label="Outputs">
            <div className="vd-section-head">
              <h3>Outputs</h3>
              {shown ? (
                <span className="vd-status" role="status" aria-label="Request status">
                  <span className={`jc-pill status-${shown.status.toLowerCase()}`}>{VIDEO_STATUS_LABEL[shown.status]}</span>
                  <span className="jc-muted">{formatLabels(shown.formatIds)}{shown.message ? ` · ${shown.message}` : ""}</span>
                </span>
              ) : null}
              {shown?.status === "NEEDS_APPROVAL" ? <button type="button" className="jc-button primary" disabled={Boolean(busy)} onClick={approve}>Approve and deliver</button> : null}
            </div>
            {shown?.question && !shown.answer ? <p className="vd-question">The editor asks: {shown.question} <span className="jc-muted">(answer it in Requests)</span></p> : null}
            {outputs.length ? (
              <ul className="vd-tiles" aria-label="Output files">
                {outputs.map((item) => <Tile key={item.artifactId} item={item} current={current?.artifactId === item.artifactId} pickOrder={0} onOpen={() => open(item)} />)}
              </ul>
            ) : <p className="vd-empty">{shown ? "No outputs yet: the editor is on it." : "Finished videos appear here."}</p>}
          </section>
        </div>
        <form className="vd-make" aria-label="Make a video" onSubmit={make}>
          <h3>Make a video</h3>
          <label className="jc-field"><span>What should the video be?</span>
            <textarea value={brief} rows={3} maxLength={VIDEO_BRIEF_MAX} placeholder="A 30-second highlight of the demo for Shorts, upbeat, with the product name on screen." onChange={(event) => setBrief(event.target.value)} /></label>
          <p className="vd-picked">{pickedItems.length ? <>From {pickedItems.map((item, index) => <span key={item.artifactId} className="vd-picked-item" title={item.label}>{index + 1}. {item.label}</span>)}</>
            : <span className="jc-muted">No source picked: press + on a video in Sources.</span>}</p>
          <fieldset className="vd-group">
            <legend>Cut</legend>
            <div className="vd-segmented" role="radiogroup" aria-label="Technique">
              {VIDEO_TECHNIQUES.map((id) => (
                <button key={id} type="button" role="radio" aria-checked={technique === id} className={technique === id ? "selected" : undefined} onClick={() => setTechnique(id)}>{VIDEO_TECHNIQUE_LABELS[id]}</button>
              ))}
            </div>
            <p className="vd-hint">{TECHNIQUE_HINTS[technique]}</p>
          </fieldset>
          <fieldset className="vd-group">
            <legend>Formats <span className="jc-muted">{formatIds.length} of {VIDEO_TIMELINE_MAX_OUTPUTS}</span></legend>
            <FormatPicker label="Formats" value={formatIds} onToggle={toggleFormat} />
          </fieldset>
          <fieldset className="vd-group">
            <legend>Look</legend>
            <div className="vd-grid-2">
              {select("Transition", transition, VIDEO_TRANSITIONS, setTransition, Boolean(busy))}
              {select("Filter", filter, VIDEO_FILTERS, setFilter, Boolean(busy))}
              {select("Captions", captions, VIDEO_CAPTION_STYLES, setCaptions, Boolean(busy))}
              <label className="jc-field"><span>Longest (seconds)</span>
                <input type="number" min={1} max={3600} value={maxDuration} placeholder="Format's limit" aria-label="Longest duration in seconds" onChange={(event) => setMaxDuration(event.target.value)} /></label>
            </div>
          </fieldset>
          <fieldset className="vd-group">
            <legend>Sound</legend>
            <SpaceToggle compact label="Narration" detail="A voice-over spoken over the video." checked={narrationOn} onChange={setNarrationOn} />
            {narrationOn ? (
              <>
                <div className="vd-grid-2">
                  <label className="jc-field"><span>Language</span>
                    <select value={narrationLanguage} aria-label="Narration language" onChange={(event) => setNarrationLanguage(event.target.value)}>
                      {languages.map((tag) => <option key={tag} value={tag}>{languageName(tag)}</option>)}
                    </select></label>
                  <label className="jc-field"><span>Voice</span><input value={narrationVoice} maxLength={60} aria-label="Narration voice" onChange={(event) => setNarrationVoice(event.target.value)} /></label>
                </div>
                <label className="jc-field"><span>What is said</span>
                  <textarea value={narrationText} rows={3} maxLength={8000} placeholder="Leave empty and the editor writes it from the brief." aria-label="Narration text" onChange={(event) => setNarrationText(event.target.value)} /></label>
              </>
            ) : null}
            <div className="vd-music-row">
              <label className="jc-field"><span>Music</span>
                <select value={musicId} aria-label="Music" onChange={(event) => setMusicId(event.target.value)}>
                  <option value="">None</option>
                  {music.map((track) => <option key={track.id} value={track.artifactId}>{track.label ?? track.description ?? "Track"}</option>)}
                </select></label>
              <button type="button" className="jc-button ghost" onClick={onFindMusic}><Music2 aria-hidden="true" /> Find music</button>
            </div>
          </fieldset>
          <div className="vd-make-footer">
            {message ? <p className="jc-message" role="status">{message}</p> : null}
            <button type="submit" className="jc-button primary vd-make-button" disabled={Boolean(busy)}>{busy === "Make" ? "Queuing…" : "Make"}</button>
          </div>
        </form>
      </div>
      {details ? <FileInfoDialog artifactId={details.artifactId} filename={details.asset ? videoAssetFileName(details.asset) : details.label} asset={details.asset} onClose={() => setDetails(null)} /> : null}
    </div>
  );
}
